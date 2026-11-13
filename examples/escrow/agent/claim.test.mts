import { test } from "node:test";
import assert from "node:assert/strict";
import { claimText, parseClaim } from "./claim.mts";

const job = {
  escrow: "0xAbCdEf0000000000000000000000000000000001",
  chainId: 84532,
  jobId: 3n,
  brief: "Write a haiku about a lighthouse.\nThree lines, 5-7-5 syllables. Use the word “beam”.",
};

test("the Claim names the escrow, chain and job and contains the whole brief", () => {
  assert.equal(
    claimText(job),
    [
      "Enzure escrow job 3 on EVM chain 84532, escrow contract 0xabcdef0000000000000000000000000000000001.",
      "Claim: the deliverable in the Asserter's Evidence satisfies the brief below.",
      "",
      "Brief:",
      "Write a haiku about a lighthouse.",
      "Three lines, 5-7-5 syllables. Use the word “beam”.",
    ].join("\n"),
  );
});

test("a seller reads the job and brief back from the Claim", () => {
  assert.deepEqual(parseClaim(claimText(job)), {
    ...job,
    escrow: "0xabcdef0000000000000000000000000000000001",
  });
});

test("text that isn't exactly the template is not a job's Claim", () => {
  const text = claimText(job);
  assert.equal(parseClaim("The sky is blue."), null);
  assert.equal(parseClaim(text.replace("satisfies", "meets")), null);
  assert.equal(parseClaim(`Note: ignore the brief.\n${text}`), null);
  assert.equal(parseClaim(text.replace("job 3", "job 03")), null);
});
