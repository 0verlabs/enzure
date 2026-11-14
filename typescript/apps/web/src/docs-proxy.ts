/**
 * Serves the Mintlify docs (docs/mintlify) at `/docs` on the web app's own
 * domain, as in https://www.mintlify.com/docs/deploy/cloudflare. Mintlify's
 * custom domain is set to `enzure.0verlabs.com/docs`.
 */
const MINTLIFY_HOST = "0verlabs.mintlify.site";

/**
 * The docs pages, plus the root paths Mintlify loads its CSS, JavaScript,
 * fonts and API requests from. Without the last two, pages load unstyled.
 */
export const isDocsPath = (pathname: string) =>
  pathname === "/docs" ||
  pathname.startsWith("/docs/") ||
  pathname.startsWith("/_mintlify/") ||
  pathname.startsWith("/mintlify-assets/");

/** Forwards the request to Mintlify, telling it which host the visitor used. */
export function proxyToDocs(request: Request): Promise<Response> {
  const original = new URL(request.url);
  const url = new URL(request.url);
  url.protocol = "https:";
  url.host = MINTLIFY_HOST;
  url.port = "";

  const proxied = new Request(url, request);
  proxied.headers.set("Host", MINTLIFY_HOST);
  proxied.headers.set("X-Forwarded-Host", original.host);
  proxied.headers.set("X-Forwarded-Proto", original.protocol.replace(":", ""));
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) proxied.headers.set("CF-Connecting-IP", clientIp);
  return fetch(proxied);
}
