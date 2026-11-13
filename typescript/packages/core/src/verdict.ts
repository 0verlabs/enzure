import { VERDICTS, type Verdict } from "./ai-request.ts";

/**
 * Reads the AI Verdict from the raw bytes of a non-streamed chat completion.
 *
 * The parse is strict, so it accepts only what the oracle contract accepts:
 * exactly one choice that finished normally, whose content is a JSON object
 * with a single `verdict` key holding TRUE, FALSE or UNRESOLVABLE. Anything
 * else throws.
 */
export function parseVerdict(responseBody: Uint8Array): Verdict {
  const response: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(responseBody),
  );
  const choices = isObject(response) ? response.choices : undefined;
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw new Error("response must have exactly one choice");
  }

  const [choice] = choices;
  if (!isObject(choice) || choice.finish_reason !== "stop") {
    throw new Error("response choice must have finish_reason stop");
  }
  const content = isObject(choice.message) ? choice.message.content : undefined;
  if (typeof content !== "string") {
    throw new Error("response message has no text content");
  }

  const answer: unknown = JSON.parse(content);
  if (!isObject(answer) || Object.keys(answer).length !== 1) {
    throw new Error('content must be a JSON object with only a "verdict" key');
  }
  const verdict = answer.verdict;
  if (!VERDICTS.includes(verdict as Verdict)) {
    throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
  }
  return verdict as Verdict;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
