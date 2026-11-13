import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

// Bundle core from source, so tests and builds don't need core built first.
const core = fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url));

export default defineConfig({
  // `cf build` and `cf dev` build the Worker (src/worker.ts) with the bindings from cloudflare.config.ts.
  // The tests are plain Node tests of the configuration, so they skip it.
  plugins: process.env.VITEST ? [] : [cloudflare()],
  resolve: { alias: { "@enzure/core": core } },
  // `vp pack` builds the local Node runner (src/main.ts) into dist/main.mjs.
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
