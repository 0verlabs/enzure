import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// Bundle core from source, so tests and builds don't need core built first.
const core = fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@enzure/core": core } },
  pack: {
    entry: ["src/main.ts"],
    platform: "node",
    alias: { "@enzure/core": core },
    // Core and its own dependencies go into the bundle; near-kit, viem and zod stay in node_modules.
    deps: {
      alwaysBundle: ["@enzure/core"],
      onlyBundle: ["@noble/hashes", "@noble/curves"],
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
