import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

const BASE = "https://storage.test";

const CLAIM = new TextEncoder().encode("Alice delivered the logo described in the brief.");
const CLAIM_HASH = "92a68687cda219c63223154d2855c33635f7bd32dbbd67942b8484334ceca6a0";

function uploadFrom(clientIp: string): Promise<Response> {
  return exports.default.fetch(`${BASE}/content/${CLAIM_HASH}`, {
    method: "PUT",
    body: CLAIM,
    headers: { "CF-Connecting-IP": clientIp },
  });
}

describe("rate limiting", () => {
  it("stops a client that uploads too often, without blocking other clients", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 100 && !statuses.includes(429); i++) {
      statuses.push((await uploadFrom("198.51.100.1")).status);
    }

    expect(statuses).toContain(429);
    expect(statuses.slice(0, 10).every((status) => status === 200 || status === 201)).toBe(true);

    expect([200, 201]).toContain((await uploadFrom("198.51.100.2")).status);
  });
});
