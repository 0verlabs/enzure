import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { isDocsPath, proxyToDocs } from "./docs-proxy";

// The Worker's entry: docs paths go to Mintlify, everything else to the app.
export default createServerEntry({
  fetch(request) {
    if (isDocsPath(new URL(request.url).pathname)) return proxyToDocs(request);
    return handler.fetch(request);
  },
});
