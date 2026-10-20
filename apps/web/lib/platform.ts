import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { HEADER } from "@il/core";
import { protocol } from "./hosts.ts";

export * from "./hosts.ts";

/** Tenant id and host the proxy resolved for this request; 404 if the proxy didn't. */
export async function requestTenant(expectedTenantId?: string) {
  const h = await headers();
  const tenantId = h.get(HEADER.tenantId);
  const host = h.get(HEADER.host);
  const kind = h.get(HEADER.hostKind);
  if (kind !== "tenant" || !tenantId || !host) notFound();
  // The route param must match what the proxy resolved from the Host header.
  if (expectedTenantId !== undefined && expectedTenantId !== tenantId) notFound();
  return { tenantId, host, origin: `${protocol()}://${h.get("host")}` };
}

export async function requestPlatformHost(kind: "admin" | "auth") {
  const h = await headers();
  if (h.get(HEADER.hostKind) !== kind) notFound();
  const host = h.get(HEADER.host);
  if (!host) notFound();
  return { host, origin: `${protocol()}://${h.get("host")}` };
}
