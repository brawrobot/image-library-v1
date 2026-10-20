/**
 * Host → destination resolution. Pure: the tenant lookups are injected so this
 * runs the same in the proxy, in route handlers and in tests.
 *
 *   admin.<root>        → admin console
 *   auth.<root>         → central sign-in (Auth.js) and hand-off
 *   {slug}.<root>       → tenant by slug
 *   anything else       → tenant by verified custom domain
 *   unknown             → not_found;  suspended tenant → suspended
 */

export type TenantStatus = "provisioning" | "active" | "suspended" | "deleted";

export interface TenantRef {
  id: string;
  slug: string;
  status: TenantStatus;
  /** Primary custom domain, if one is set; the slug host redirects to it. */
  primaryHost: string | null;
}

export interface TenantLookup {
  bySlug(slug: string): Promise<TenantRef | null>;
  /** Verified custom domains only. */
  byHostname(hostname: string): Promise<TenantRef | null>;
}

export type HostResolution =
  | { kind: "admin" }
  | { kind: "auth" }
  | { kind: "tenant"; tenant: TenantRef; via: "subdomain" | "custom_domain" }
  | { kind: "suspended"; tenant: TenantRef }
  | { kind: "not_found"; reason: "unknown_host" | "reserved" | "malformed" };

/** Subdomains of the root that are never tenant slugs. */
export const RESERVED_SUBDOMAINS = new Set([
  "admin", "auth", "api", "app", "cdn", "cname", "www", "mail", "status", "static", "assets", "_acme-challenge",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SUBDOMAINS.has(slug);
}

export interface RootDomain {
  /** Hostname without port, e.g. "yourapp.com" or "lvh.me". */
  hostname: string;
  /** Port the platform is served on in dev, if any (only matters for building URLs). */
  port: string | null;
}

/** Parse ROOT_DOMAIN ("yourapp.com" or "lvh.me:3000"). */
export function parseRootDomain(value: string): RootDomain {
  const host = normalizeHost(value);
  if (!host) throw new Error(`Invalid ROOT_DOMAIN: ${value}`);
  const [, port] = value.trim().toLowerCase().split(":");
  return { hostname: host, port: port && /^\d+$/.test(port) ? port : null };
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Lowercase, strip port and trailing dot, and reject anything that isn't a
 * plausible DNS name (IP literals, userinfo, empty labels). Returns null when
 * the Host header can't be trusted at all.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  if (host.length === 0 || host.length > 300) return null;
  if (host.startsWith("[")) return null; // IPv6 literal
  if (/[@/\\?#\s]/.test(host)) return null;
  const colon = host.lastIndexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.some((l) => !LABEL.test(l))) return null;
  return host;
}

export async function resolveHost(
  rawHost: string | null | undefined,
  root: RootDomain,
  lookup: TenantLookup,
): Promise<HostResolution> {
  const host = normalizeHost(rawHost);
  if (!host) return { kind: "not_found", reason: "malformed" };

  if (host === `admin.${root.hostname}`) return { kind: "admin" };
  if (host === `auth.${root.hostname}`) return { kind: "auth" };
  if (host === root.hostname || host === `www.${root.hostname}`) {
    // The marketing site isn't part of this app yet.
    return { kind: "not_found", reason: "reserved" };
  }

  let tenant: TenantRef | null;
  let via: "subdomain" | "custom_domain";
  const suffix = `.${root.hostname}`;
  if (host.endsWith(suffix)) {
    const sub = host.slice(0, -suffix.length);
    // Only one level: a.b.<root> is never a tenant.
    if (sub.includes(".")) return { kind: "not_found", reason: "unknown_host" };
    if (isReservedSlug(sub)) return { kind: "not_found", reason: "reserved" };
    tenant = await lookup.bySlug(sub);
    via = "subdomain";
  } else {
    tenant = await lookup.byHostname(host);
    via = "custom_domain";
  }

  if (!tenant) return { kind: "not_found", reason: "unknown_host" };
  switch (tenant.status) {
    case "active":
      return { kind: "tenant", tenant, via };
    case "suspended":
      return { kind: "suspended", tenant };
    default:
      return { kind: "not_found", reason: "unknown_host" };
  }
}

/** The canonical public host for a tenant: its primary custom domain, else its subdomain. */
export function tenantHost(tenant: Pick<TenantRef, "slug" | "primaryHost">, root: RootDomain): string {
  if (tenant.primaryHost) return tenant.primaryHost;
  return `${tenant.slug}.${root.hostname}${root.port ? `:${root.port}` : ""}`;
}

export function platformHost(sub: "admin" | "auth", root: RootDomain): string {
  return `${sub}.${root.hostname}${root.port ? `:${root.port}` : ""}`;
}
