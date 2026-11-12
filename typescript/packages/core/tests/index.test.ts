import { expect, test } from "vite-plus/test";
import { packageName } from "../src/index.ts";

test("packageName returns the core package name", () => {
  expect(packageName()).toBe("@enzure/core");
});
