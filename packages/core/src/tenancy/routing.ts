import type { HostResolution } from "./host.ts";

/**
 * What the Next.js proxy does with a request once its host is resolved.
 * Pure, so every rule below is unit-tested without a server.
 *
 * Internal route trees (never reachable directly, because every host's paths
 * are either prefixed or allow-listed):
 *   /site/[tenantId]/…   tenant library UI, public gallery, share pages
 *   /console/…           admin console
 *   /auth-site/…         central sign-in pages
 */

export const INTERNAL_HEADER_PREFIX = "x-il-";
export const HEADER = {
  hostKind: "x-il-host-kind",
  tenantId: "x-il-tenant-id",
  tenantSlug: "x-il-tenant-slug",
  host: "x-il-host",
} as const;

export const TENANT_PREFIX = "/site";
export const ADMIN_PREFIX = "/console";
export const AUTH_PREFIX = "/auth-site";

export type ProxyDecision =
  | { action: "rewrite"; pathname: string; headers: Record<string, string> }
  | { action: "next"; headers: Record<string, string> }
  | { action: "redirect"; location: string; status: 308 }
  | { action: "respond"; status: 403 | 404; page: "not_found" | "suspended"; json: boolean };

const isApi = (p: string) => p === "/api" || p.startsWith("/api/");
const under = (p: string, prefix: string) => p === prefix || p.startsWith(`${prefix}/`);

function notFound(pathname: string): ProxyDecision {
  return { action: "respond", status: 404, page: "not_found", json: isApi(pathname) };
}

export function decideRoute(
  resolution: HostResolution,
  url: { pathname: string; search: string },
  protocol: "http" | "https",
): ProxyDecision {
  const { pathname } = url;

  switch (resolution.kind) {
    case "not_found":
      return notFound(pathname);

    case "suspended":
      return { action: "respond", status: 403, page: "suspended", json: isApi(pathname) };

    case "admin": {
      const headers = { [HEADER.hostKind]: "admin" };
      if (under(pathname, "/api/admin")) return { action: "next", headers };
      if (isApi(pathname)) return notFound(pathname);
      return { action: "rewrite", pathname: `${ADMIN_PREFIX}${pathname === "/" ? "" : pathname}`, headers };
    }

    case "auth": {
      const headers = { [HEADER.hostKind]: "auth" };
      if (under(pathname, "/api/auth") || pathname === "/handoff") return { action: "next", headers };
      if (isApi(pathname)) return notFound(pathname);
      return { action: "rewrite", pathname: `${AUTH_PREFIX}${pathname === "/" ? "" : pathname}`, headers };
    }

    case "tenant": {
      const { tenant, via } = resolution;
      // One canonical host: the subdomain redirects to the primary custom domain.
      if (via === "subdomain" && tenant.primaryHost) {
        return {
          action: "redirect",
          location: `${protocol}://${tenant.primaryHost}${pathname}${url.search}`,
          status: 308,
        };
      }
      const headers = {
        [HEADER.hostKind]: "tenant",
        [HEADER.tenantId]: tenant.id,
        [HEADER.tenantSlug]: tenant.slug,
      };
      if (under(pathname, "/api/v1")) return { action: "next", headers };
      if (isApi(pathname)) return notFound(pathname);
      return {
        action: "rewrite",
        pathname: `${TENANT_PREFIX}/${tenant.id}${pathname === "/" ? "" : pathname}`,
        headers,
      };
    }
  }
}

/** Drop every internal header a client sent, so only the proxy can set them. */
export function stripInternalHeaders(headers: Headers): Headers {
  const clean = new Headers(headers);
  for (const name of [...clean.keys()]) {
    if (name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX)) clean.delete(name);
  }
  return clean;
}
