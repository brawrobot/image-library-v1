import { describe, expect, it } from "vitest";
import type { HostResolution, TenantRef } from "../src/tenancy/host.ts";
import { decideRoute, HEADER, stripInternalHeaders } from "../src/tenancy/routing.ts";

const acme: TenantRef = { id: "11111111-1111-7111-8111-111111111111", slug: "acme", status: "active", primaryHost: null };
const globex: TenantRef = { id: "22222222-2222-7222-8222-222222222222", slug: "globex", status: "active", primaryHost: "photos.globex.com" };

const tenant = (t: TenantRef, via: "subdomain" | "custom_domain" = "subdomain"): HostResolution => ({ kind: "tenant", tenant: t, via });
const go = (r: HostResolution, pathname: string, search = "") => decideRoute(r, { pathname, search }, "https");

describe("tenant hosts", () => {
  it("rewrites pages into the tenant's internal tree and tags the request", () => {
    expect(go(tenant(acme), "/")).toEqual({
      action: "rewrite",
      pathname: `/site/${acme.id}`,
      headers: { [HEADER.hostKind]: "tenant", [HEADER.tenantId]: acme.id, [HEADER.tenantSlug]: "acme" },
    });
    expect(go(tenant(acme), "/a/summer")).toMatchObject({ pathname: `/site/${acme.id}/a/summer` });
  });

  it("passes the tenant API through with the tenant header", () => {
    expect(go(tenant(acme), "/api/v1/assets")).toMatchObject({ action: "next", headers: { [HEADER.tenantId]: acme.id } });
  });

  it("keeps Auth.js and admin APIs off tenant hosts", () => {
    expect(go(tenant(acme), "/api/auth/signin")).toMatchObject({ action: "respond", status: 404, json: true });
    expect(go(tenant(acme), "/api/admin/tenants")).toMatchObject({ action: "respond", status: 404 });
  });

  it("can't reach another tenant's internal tree by path", () => {
    // A request for /site/<globex id> on acme's host lands inside acme's own tree.
    expect(go(tenant(acme), `/site/${globex.id}`)).toMatchObject({ pathname: `/site/${acme.id}/site/${globex.id}` });
    expect(go(tenant(acme), "/console")).toMatchObject({ pathname: `/site/${acme.id}/console` });
  });

  it("redirects the subdomain to the primary custom domain, keeping path and query", () => {
    expect(go(tenant(globex), "/a/summer", "?page=2")).toEqual({
      action: "redirect",
      location: "https://photos.globex.com/a/summer?page=2",
      status: 308,
    });
    expect(go(tenant(globex, "custom_domain"), "/a/summer")).toMatchObject({ action: "rewrite" });
  });
});

describe("platform hosts", () => {
  it("rewrites the admin host into the console tree", () => {
    expect(go({ kind: "admin" }, "/tenants")).toMatchObject({ action: "rewrite", pathname: "/console/tenants" });
    expect(go({ kind: "admin" }, "/api/admin/tenants")).toMatchObject({ action: "next" });
    expect(go({ kind: "admin" }, "/api/v1/assets")).toMatchObject({ action: "respond", status: 404 });
  });

  it("serves Auth.js and the hand-off on the auth host only", () => {
    expect(go({ kind: "auth" }, "/api/auth/callback/google")).toMatchObject({ action: "next" });
    expect(go({ kind: "auth" }, "/handoff")).toMatchObject({ action: "next" });
    expect(go({ kind: "auth" }, "/")).toMatchObject({ action: "rewrite", pathname: "/auth-site" });
    expect(go({ kind: "auth" }, "/api/v1/assets")).toMatchObject({ action: "respond", status: 404 });
    expect(go({ kind: "auth" }, `/site/${acme.id}`)).toMatchObject({ pathname: `/auth-site/site/${acme.id}` });
  });

  it("serves 404 and suspended pages", () => {
    expect(go({ kind: "not_found", reason: "unknown_host" }, "/")).toEqual({ action: "respond", status: 404, page: "not_found", json: false });
    expect(go({ kind: "suspended", tenant: acme }, "/api/v1/me")).toEqual({ action: "respond", status: 403, page: "suspended", json: true });
  });
});

describe("stripInternalHeaders", () => {
  it("removes spoofed internal headers and keeps the rest", () => {
    const h = stripInternalHeaders(
      new Headers({ "X-IL-Tenant-Id": acme.id, "x-il-host-kind": "admin", cookie: "a=b", host: "x" }),
    );
    expect(h.get(HEADER.tenantId)).toBeNull();
    expect(h.get(HEADER.hostKind)).toBeNull();
    expect(h.get("cookie")).toBe("a=b");
  });
});
