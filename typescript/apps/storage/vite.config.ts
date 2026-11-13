import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Tests run inside the Workers runtime with the bindings from cloudflare.config.ts.
  plugins: [process.env.VITEST ? cloudflareTest({ config: true }) : cloudflare()],
  resolve: {
    // Bundle core from source, so tests and builds don't need core built first.
    alias: {
      "@enzure/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
