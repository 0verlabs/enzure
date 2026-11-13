import { zValidator } from "@hono/zod-validator";
import { checkContent, isContentHash, MAX_CONTENT_BYTES } from "@enzure/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

/**
 * Hash-addressed storage for Claims and Evidence (ADR 0003).
 *
 * PUT /content/:hash stores the body only if its sha256 is :hash.
 * GET /content/:hash returns the stored bytes.
 */
const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin, c) => (c.env.ALLOWED_ORIGINS.includes(origin) ? origin : null),
    allowMethods: ["GET", "HEAD", "PUT"],
    allowHeaders: ["Content-Type"],
    maxAge: 86_400,
  }),
);

const contentParams = z.object({
  hash: z.string().refine(isContentHash, "Expected a sha256 as 64 lowercase hex characters."),
});

const validHash = zValidator("param", contentParams, (result, c) => {
  if (!result.success) {
    return c.json({ error: "invalid_hash", message: result.error.issues[0]?.message }, 400);
  }
});

// Cloudflare sets CF-Connecting-IP on every request, so clients can't choose their key.
const uploadRateLimit = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const key = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.UPLOAD_LIMITER.limit({ key });
  if (!success) {
    return c.json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
  }
  await next();
});

const tooLarge = { error: "too_large", maxSize: MAX_CONTENT_BYTES } as const;

app.put(
  "/content/:hash",
  uploadRateLimit,
  validHash,
  // Rejects by Content-Length before reading, and stops a streamed body at the cap.
  bodyLimit({ maxSize: MAX_CONTENT_BYTES, onError: (c) => c.json(tooLarge, 413) }),
  async (c) => {
    const { hash } = c.req.valid("param");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const check = await checkContent(hash, bytes);
    if (!check.ok) {
      return check.reason === "too_large"
        ? c.json(tooLarge, 413)
        : c.json({ error: check.reason, expected: check.expected, actual: check.actual }, 422);
    }
    // Content is fixed by its hash, so a stored copy is already this content.
    if (await c.env.CONTENT.head(hash)) {
      return c.json({ hash, size: bytes.byteLength }, 200);
    }
    // R2 checks the sha256 again on write.
    await c.env.CONTENT.put(hash, bytes, { sha256: hash });
    return c.json({ hash, size: bytes.byteLength }, 201);
  },
);

app.get("/content/:hash", validHash, async (c) => {
  const { hash } = c.req.valid("param");
  const object = await c.env.CONTENT.get(hash);
  if (object === null) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.body(object.body, 200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(object.size),
    // Content under a hash never changes.
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"${hash}"`,
    "X-Content-Type-Options": "nosniff",
  });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error(
    JSON.stringify({
      message: "unhandled error",
      method: c.req.method,
      path: c.req.path,
      error: err.message,
    }),
  );
  return c.json({ error: "internal_error" }, 500);
});

export default app;
