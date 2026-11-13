// The escrow demo's Claim template. The buyer fills it in and uploads it;
// the seller reads the job and brief back from it and asserts exactly it.
// Naming the escrow, chain and job stops a seller from collecting a job with
// an unrelated true statement, and the brief is what the AI judges against.

export interface JobClaim {
  /** The escrow contract, `0x` and 40 hex characters (written lowercase). */
  escrow: string;
  chainId: number;
  jobId: bigint;
  /** The full brief, as the buyer wrote it. */
  brief: string;
}

const HEADER =
  /^Enzure escrow job ([1-9][0-9]*) on EVM chain ([1-9][0-9]*), escrow contract (0x[0-9a-f]{40})\.\n/;
const STATEMENT = "Claim: the deliverable in the Asserter's Evidence satisfies the brief below.";

/** The Claim for a job. */
export function claimText({ escrow, chainId, jobId, brief }: JobClaim): string {
  return [
    `Enzure escrow job ${jobId} on EVM chain ${chainId}, escrow contract ${escrow.toLowerCase()}.`,
    STATEMENT,
    "",
    "Brief:",
    brief,
  ].join("\n");
}

/** The job a Claim is for, or null if the text isn't exactly the template filled in. */
export function parseClaim(text: string): JobClaim | null {
  const header = HEADER.exec(text);
  if (header === null) return null;
  const rest = text.slice(header[0].length);
  const prefix = `${STATEMENT}\n\nBrief:\n`;
  if (!rest.startsWith(prefix)) return null;
  const claim: JobClaim = {
    escrow: header[3]!,
    chainId: Number(header[2]),
    jobId: BigInt(header[1]!),
    brief: rest.slice(prefix.length),
  };
  return claimText(claim) === text ? claim : null;
}
