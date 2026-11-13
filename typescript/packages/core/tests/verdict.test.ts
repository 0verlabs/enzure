import { expect, test } from "vite-plus/test";
import { parseVerdict } from "../src/index.ts";
import { bytes, signedResponse } from "./fixture.ts";

test("parseVerdict reads the verdict of the real signed response", () => {
  expect(parseVerdict(bytes(signedResponse.response_body))).toBe(signedResponse.verdict);
});

const responseWith = (content: unknown, extra: Record<string, unknown> = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      id: "x",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      ...extra,
    }),
  );

test.each(["TRUE", "FALSE", "UNRESOLVABLE"])("parseVerdict reads %s", (verdict) => {
  expect(parseVerdict(responseWith(`{"verdict": "${verdict}"}`))).toBe(verdict);
});

test("parseVerdict allows whitespace inside the JSON content", () => {
  expect(parseVerdict(responseWith('{\n"verdict": "FALSE"\n}'))).toBe("FALSE");
});

test.each([
  ["a lowercase verdict", '{"verdict":"true"}'],
  ["another word", '{"verdict":"MAYBE"}'],
  ["an extra key", '{"verdict":"TRUE","reason":"x"}'],
  ["a bare word", "TRUE"],
  ["thinking before the JSON", '<think>hmm</think>{"verdict":"TRUE"}'],
  ["a non-string verdict", '{"verdict":true}'],
  ["an array", '[{"verdict":"TRUE"}]'],
  ["a missing content", null],
])("parseVerdict rejects %s", (_, content) => {
  expect(() => parseVerdict(responseWith(content))).toThrow();
});

test("parseVerdict rejects a response cut off by the token limit", () => {
  const body = new TextEncoder().encode(
    JSON.stringify({
      choices: [{ message: { content: '{"verdict":"TRUE"}' }, finish_reason: "length" }],
    }),
  );
  expect(() => parseVerdict(body)).toThrow(/finish_reason/);
});

test("parseVerdict rejects a response with more than one choice", () => {
  const choice = { message: { content: '{"verdict":"TRUE"}' }, finish_reason: "stop" };
  const body = new TextEncoder().encode(JSON.stringify({ choices: [choice, choice] }));
  expect(() => parseVerdict(body)).toThrow(/one choice/);
});

test("parseVerdict rejects bytes that aren't JSON", () => {
  expect(() => parseVerdict(new TextEncoder().encode("data: {}\n\n"))).toThrow();
});
