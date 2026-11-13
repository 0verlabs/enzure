// The buyer's side of the escrow demo.
//
//   node examples/escrow/agent/buyer.mts create-job --brief <text> | --brief-file <path>
//        --seller <payout address> --seller-near <account id> [--amount 1] [--deadline-secs 86400]
//   node examples/escrow/agent/buyer.mts dispute --assertion <id> --evidence <text> | --evidence-file <path>
//   node examples/escrow/agent/buyer.mts reclaim --job <id>
//   node examples/escrow/agent/buyer.mts job --job <id>
//
// create-job fills in the Claim template with this escrow, chain, job id and
// brief, uploads it to storage, approves the token and creates the funded job.
// dispute uploads the buyer's Evidence and disputes the seller's Assertion.
//
// Environment:
//   ESCROW_ADDRESS, EVM_RPC_URL (https://sepolia.base.org)
//   EVM_PRIVATE_KEY   the buyer on the EVM chain (create-job, reclaim)
//   ORACLE_ACCOUNT_ID, NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY   the buyer on NEAR (dispute)
//   STORAGE_URL (the deployed storage service), NEAR_NETWORK (testnet), NEAR_RPC_URL
//
// Progress goes to standard error; the result is one JSON line on standard output.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { putContent } from "../../../typescript/packages/core/src/index.ts";
import { claimText } from "./claim.mts";
import {
  ERC20_ABI,
  ESCROW_ABI,
  JOB_STATUS,
  env,
  escrowAddress,
  evm,
  evmTxLink,
  fail,
  near,
  nearAccountHash,
  run,
  storage,
  viem,
  type Hex,
} from "./lib.mts";

const [command, ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
  args: rest,
  options: {
    brief: { type: "string" },
    "brief-file": { type: "string" },
    seller: { type: "string" },
    "seller-near": { type: "string" },
    amount: { type: "string", default: "1" },
    "deadline-secs": { type: "string", default: "86400" },
    assertion: { type: "string" },
    evidence: { type: "string" },
    "evidence-file": { type: "string" },
    job: { type: "string" },
  },
});

const textArg = (inline: string | undefined, file: string | undefined, name: string): string => {
  if (inline !== undefined) return inline;
  if (file !== undefined) return readFileSync(file, "utf8");
  return fail(`Pass --${name} or --${name}-file`);
};

await run(async () => {
  switch (command) {
    case "create-job":
      return createJob();
    case "dispute":
      return dispute();
    case "reclaim":
      return reclaim();
    case "job":
      return showJob();
    default:
      fail("usage: buyer.mts create-job | dispute | reclaim | job (see the header of this file)");
  }
});

async function createJob() {
  const brief = textArg(args.brief, args["brief-file"], "brief");
  const seller = args.seller ?? fail("Pass --seller <payout address on the EVM chain>");
  if (!viem.isAddress(seller)) fail("--seller is not an EVM address");
  const sellerNear = args["seller-near"] ?? fail("Pass --seller-near <the seller's NEAR account id>");
  const escrow = escrowAddress();
  const { chainId, publicClient, walletClient } = await evm(env("EVM_PRIVATE_KEY"));
  const buyer = walletClient!.account.address;
  const read = { address: escrow, abi: ESCROW_ABI } as const;

  const token = await publicClient.readContract({ ...read, functionName: "token" });
  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
  ]);
  const amount = viem.parseUnits(args.amount!, decimals);
  const jobId = await publicClient.readContract({ ...read, functionName: "nextJobId" });

  const claim = claimText({ escrow, chainId, jobId, brief });
  const claimHash = await putContent(storage(), claim);
  console.error(`Claim for job ${jobId} uploaded as ${claimHash}`);

  const links: string[] = [];
  const send = async (label: string, hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") fail(`${label} reverted: ${hash}`);
    links.push(`${label}: ${evmTxLink(chainId, hash)}`);
    console.error(`${label}: ${evmTxLink(chainId, hash)}`);
  };
  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [buyer, escrow],
  });
  if (allowance < amount) {
    await send(
      `approve ${args.amount} ${symbol}`,
      await walletClient!.writeContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [escrow, amount],
      }),
    );
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(args["deadline-secs"]));
  const { request } = await publicClient.simulateContract({
    ...read,
    account: walletClient!.account,
    functionName: "createJob",
    args: [jobId, amount, seller, await nearAccountHash(sellerNear), `0x${claimHash}`, deadline],
  });
  await send(`createJob ${jobId}`, await walletClient!.writeContract(request));

  console.log(
    JSON.stringify({
      job_id: Number(jobId),
      escrow,
      chain_id: chainId,
      token,
      amount: amount.toString(),
      buyer,
      seller,
      seller_near: sellerNear,
      claim_hash: claimHash,
      deadline: Number(deadline),
      claim,
      links,
    }),
  );
}

async function dispute() {
  const oracle = env("ORACLE_ACCOUNT_ID");
  const assertionId = Number(args.assertion ?? fail("Pass --assertion <id>"));
  const evidence = textArg(args.evidence, args["evidence-file"], "evidence");
  const buyer = near(env("NEAR_ACCOUNT_ID"), env("NEAR_PRIVATE_KEY"));

  const assertion = await buyer.view<{ state: string; bond: string }>(oracle, "get_assertion", {
    assertion_id: assertionId,
  });
  if (assertion.state !== "asserted") fail(`Assertion ${assertionId} is ${assertion.state}`);
  const evidenceHash = await putContent(storage(), evidence);
  console.error(`Buyer's Evidence uploaded as ${evidenceHash}`);
  const storageDeposit = await buyer.view<string>(oracle, "dispute_storage_deposit");
  const { tx } = await buyer.call(
    oracle,
    "dispute",
    { assertion_id: assertionId, evidence_hash: evidenceHash },
    BigInt(assertion.bond) + BigInt(storageDeposit),
  );
  console.error(`dispute: ${tx}`);
  console.log(JSON.stringify({ assertion_id: assertionId, evidence_hash: evidenceHash, links: [`dispute: ${tx}`] }));
}

async function reclaim() {
  const jobId = BigInt(args.job ?? fail("Pass --job <id>"));
  const { chainId, publicClient, walletClient } = await evm(env("EVM_PRIVATE_KEY"));
  const { request } = await publicClient.simulateContract({
    address: escrowAddress(),
    abi: ESCROW_ABI,
    account: walletClient!.account,
    functionName: "reclaim",
    args: [jobId],
  });
  const hash = await walletClient!.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(`reclaim reverted: ${hash}`);
  console.log(JSON.stringify({ job_id: Number(jobId), links: [`reclaim: ${evmTxLink(chainId, hash)}`] }));
}

async function showJob() {
  const jobId = BigInt(args.job ?? fail("Pass --job <id>"));
  const { publicClient } = await evm();
  const escrow = escrowAddress();
  const job = await publicClient.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "getJob",
    args: [jobId],
  });
  const token = await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "token" });
  const balanceOf = (owner: Hex) =>
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
  console.log(
    JSON.stringify({
      job_id: Number(jobId),
      status: JOB_STATUS[job.status] ?? String(job.status),
      buyer: job.buyer,
      seller: job.seller,
      amount: job.amount.toString(),
      seller_near_hash: job.sellerNear,
      claim_hash: job.claimHash,
      deadline: Number(job.deadline),
      assertion_id: Number(job.assertionId),
      balances: {
        escrow: (await balanceOf(escrow)).toString(),
        buyer: (await balanceOf(job.buyer)).toString(),
        seller: (await balanceOf(job.seller)).toString(),
      },
    }),
  );
}
