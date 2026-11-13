import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    // The storage service's CORS list allows https://enzure-web.<subdomain>.workers.dev.
    name: "enzure-web",
    compatibilityDate: "2026-11-13",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "@tanstack/react-start/server-entry",
    workersDev: true,
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
    },
  },
});
