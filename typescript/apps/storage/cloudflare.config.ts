import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "enzure-storage",
    compatibilityDate: "2026-11-13",
    entrypoint,
    workersDev: true,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: true },
    },
    env: {
      CONTENT: bindings.r2({ name: "enzure-content" }),
      // Per client IP. Workers rate limits are counted per Cloudflare location.
      UPLOAD_LIMITER: bindings.rateLimit({
        namespace: "3001",
        simple: { limit: 30, period: 60 },
      }),
      // Origins of the web app (ticket #13) that may call the service from a browser.
      ALLOWED_ORIGINS: bindings.json([
        "http://localhost:3000",
        "http://localhost:5173",
        "https://enzure-web.luckzivanius.workers.dev",
      ]),
    },
  },
});
