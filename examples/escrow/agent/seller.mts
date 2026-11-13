// The seller agent: takes an escrow job, does the work with NEAR AI and asks
// the oracle to confirm it, so the escrow pays it without a human.
//
//   node examples/escrow/agent/seller.mts --job <id> [--liveness 60] [--bond-yocto <n>] [--off-brief]
//
// 1. Reads the job from the escrow and checks it is funded and names this seller.
// 2. Downloads the job's Claim from storage, checks its hash, and checks it is
//    the escrow's Claim template for this escrow, chain and job; takes the brief from it.
// 3. Produces the deliverable from the brief with NEAR AI.
// 4. Uploads the deliverable as Evidence.
// 5. Posts the Assertion of exactly that Claim with a bond and an EVM Hook to the escrow.
//
// --off-brief makes the agent deliberately do another task (a rhyme about cats)
// instead of the brief, to demo a refund.
//
// Environment:
//   ESCROW_ADDRESS, EVM_RPC_URL (https://sepolia.base.org)
//   ORACLE_ACCOUNT_ID
//   SELLER_NEAR_ACCOUNT_ID, SELLER_NEAR_PRIVATE_KEY   the seller on NEAR, the Asserter
//   NEARAI_API_KEY, NEAR_AI_URL (https://cloud-api.near.ai/v1), SELLER_MODEL (Qwen/Qwen3.8-27B)
//   STORAGE_URL (the deployed storage service), NEAR_NETWORK (testnet), NEAR_RPC_URL
//
// Progress goes to standard error; the result is one JSON line on standard output.

import { parseArgs } from "node:util";
import { NEAR_AI_URL, fetchContent, putContent } from "../../../typescript/packages/core/src/index.ts";
import { parseClaim } from "./claim.mts";
import {
  ESCROW_ABI,
  JOB_STATUS,
  env,
  escrowAddress,
  evm,
  fail,
  near,
  nearAccountHash,
  run,
  storage,
} from "./lib.mts";

const { values: args } = parseArgs({
  options: {
    job: { type: "string" },
    liveness: { type: "string", default: "60" },
    "bond-yocto": { type: "string", default: "1000000000000000000000000" },
    "off-brief": { type: "boolean", default: false },
  },
});

await run(async () => {
  const jobId = BigInt(args.job ?? fail("Pass --job <id>"));
  const oracle = env("ORACLE_ACCOUNT_ID");
  const sellerAccount = env("SELLER_NEAR_ACCOUNT_ID");
  const seller = near(sellerAccount, env("SELLER_NEAR_PRIVATE_KEY"));
  const escrow = escrowAddress();
  const { chainId, publicClient } = await evm();

  // 1. The job.
  const job = await publicClient.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: "getJob",
    args: [jobId],
  });
  if (JOB_STATUS[job.status] !== "funded") fail(`Job ${jobId} is ${JOB_STATUS[job.status]}, not funded`);
  if (job.sellerNear !== (await nearAccountHash(sellerAccount))) {
    fail(`Job ${jobId} is for another seller's NEAR account, not ${sellerAccount}`);
  }

  // 2. The Claim and its brief.
  const claimHash = job.claimHash.slice(2);
  const fetched = await fetchContent(storage(), claimHash);
  if (fetched.status !== "match") fail(`The Claim ${claimHash} is ${fetched.status} in storage`);
  const claim = parseClaim(fetched.text);
  if (claim === null || claim.escrow !== escrow || claim.chainId !== chainId || claim.jobId !== jobId) {
    fail(`The Claim of job ${jobId} is not this escrow's Claim template for job ${jobId} on chain ${chainId}`);
  }
  console.error(`Job ${jobId}: ${job.amount} token units for the brief:\n${claim.brief}\n`);

  // 3. The deliverable.
  const deliverable = await produce(claim.brief, args["off-brief"]!);
  console.error(`Deliverable:\n${deliverable}\n`);

  // 4. The Evidence.
  const evidenceHash = await putContent(storage(), deliverable);
  console.error(`Deliverable uploaded as Evidence ${evidenceHash}`);

  // 5. The Assertion, with an EVM Hook to the escrow.
  const receiver = (
    await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "receiver" })
  ).toLowerCase();
  const bond = BigInt(args["bond-yocto"]!);
  const storageDeposit = await seller.view<string>(oracle, "assertion_storage_deposit", { hooks: 1 });
  const { value: assertionId, tx } = await seller.call<number>(
    oracle,
    "assert_claim",
    {
      claim_hash: claimHash,
      evidence_hash: evidenceHash,
      bond: bond.toString(),
      liveness: Number(args.liveness),
      hooks: [{ evm: { chain_id: chainId, receiver, consumer: escrow } }],
    },
    bond + BigInt(storageDeposit),
  );
  if (typeof assertionId !== "number") fail(`assert_claim returned no Assertion id: ${tx}`);
  console.error(`assert_claim: Assertion ${assertionId}, ${tx}`);

  console.log(
    JSON.stringify({
      job_id: Number(jobId),
      assertion_id: assertionId,
      asserter: sellerAccount,
      claim_hash: claimHash,
      evidence_hash: evidenceHash,
      deliverable,
      hook: { chain_id: chainId, receiver, consumer: escrow },
      links: [`assert_claim: ${tx}`],
    }),
  );
});

/** Asks NEAR AI for the deliverable. Off-brief, the agent works on another task instead of the brief. */
async function produce(brief: string, offBrief: boolean): Promise<string> {
  const task = offBrief ? "Write a two-line rhyme about cats." : brief;
  const response = await fetch(`${process.env.NEAR_AI_URL || NEAR_AI_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("NEARAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.SELLER_MODEL || "Qwen/Qwen3.8-27B",
      messages: [
        {
          role: "system",
          content:
            "You are a freelance agent. Produce exactly the deliverable the brief asks for, following every requirement. Reply with the deliverable only, no commentary.",
        },
        { role: "user", content: task },
      ],
      temperature: 0.7,
      max_tokens: 800,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!response.ok) fail(`NEAR AI: HTTP ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) fail(`NEAR AI returned no deliverable: ${JSON.stringify(body)}`);
  return text;
}
