import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

const BASE = "https://storage.test";

// The web app's local dev origin, listed in ALLOWED_ORIGINS.
const WEB_APP = "http://localhost:3000";

// sha256("Alice delivered the logo described in the brief.")
const CLAIM_HASH = "92a68687cda219c63223154d2855c33635f7bd32dbbd67942b8484334ceca6a0";

function preflight(origin: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/content/${CLAIM_HASH}`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
  });
}

describe("CORS", () => {
  it("lets the web app upload from a browser", async () => {
    const res = await preflight(WEB_APP);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(WEB_APP);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
    expect(res.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain(
      "content-type",
    );
  });

  it("lets the web app read responses", async () => {
    const res = await exports.default.fetch(`${BASE}/content/${CLAIM_HASH}`, {
      headers: { Origin: WEB_APP },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(WEB_APP);
  });

  it("does not allow other origins", async () => {
    const res = await preflight("https://evil.example");

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
