import { NextResponse, type NextRequest } from "next/server";
import { decideRoute, HEADER, normalizeHost, resolveHost, stripInternalHeaders } from "@il/core";
import { protocol, rootDomain, tenantLookup } from "./lib/hosts.ts";

/**
 * Every request is resolved to exactly one tenant, the admin console or the
 * auth host before anything else runs. The rules live in @il/core
 * (resolveHost + decideRoute) and are unit-tested there; this file only
 * applies the decision. Next.js 16 runs the proxy on the Node.js runtime.
 */
export async function proxy(request: NextRequest) {
  const rawHost = request.headers.get("host");
  const resolution = await resolveHost(rawHost, rootDomain(), tenantLookup());
  const decision = decideRoute(
    resolution,
    { pathname: request.nextUrl.pathname, search: request.nextUrl.search },
    protocol(),
  );

  switch (decision.action) {
    case "respond":
      return statusResponse(decision.status, decision.page, decision.json);

    case "redirect":
      return NextResponse.redirect(decision.location, decision.status);

    case "next":
    case "rewrite": {
      // Clients can't send internal headers; only this proxy sets them.
      const headers = stripInternalHeaders(request.headers);
      for (const [k, v] of Object.entries(decision.headers)) headers.set(k, v);
      headers.set(HEADER.host, normalizeHost(rawHost)!);
      if (decision.action === "next") return NextResponse.next({ request: { headers } });
      const url = request.nextUrl.clone();
      url.pathname = decision.pathname;
      return NextResponse.rewrite(url, { request: { headers } });
    }
  }
}

function statusResponse(status: 403 | 404, page: "not_found" | "suspended", json: boolean) {
  if (json) {
    return NextResponse.json({ error: { code: page } }, { status });
  }
  const [title, body] =
    page === "suspended"
      ? ["Site unavailable", "This site has been suspended. If it's yours, contact support."]
      : ["Not found", "There's no site at this address."];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#1f2328;background:#f6f8fa}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#59636e}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export const config = {
  // Everything except build assets. Internal route trees must stay covered.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
