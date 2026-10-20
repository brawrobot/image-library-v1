import { describe, expect, it } from "vitest";
import {
  normalizeHost,
  parseRootDomain,
  resolveHost,
  tenantHost,
  type TenantLookup,
  type TenantRef,
} from "../src/tenancy/host.ts";

const root = parseRootDomain("yourapp.com");
const acme: TenantRef = { id: "11111111-1111-7111-8111-111111111111", slug: "acme", status: "active", primaryHost: null };
const globex: TenantRef = { id: "22222222-2222-7222-8222-222222222222", slug: "globex", status: "active", primaryHost: "photos.globex.com" };
const frozen: TenantRef = { id: "33333333-3333-7333-8333-333333333333", slug: "frozen", status: "suspended", primaryHost: null };
const gone: TenantRef = { id: "44444444-4444-7444-8444-444444444444", slug: "gone", status: "deleted", primaryHost: null };
const fresh: TenantRef = { id: "55555555-5555-7555-8555-555555555555", slug: "fresh", status: "provisioning", primaryHost: null };

const lookup: TenantLookup & { calls: string[] } = {
  calls: [],
  async bySlug(slug) {
    this.calls.push(`slug:${slug}`);
    return [acme, globex, frozen, gone, fresh].find((t) => t.slug === slug) ?? null;
  },
  async byHostname(host) {
    this.calls.push(`host:${host}`);
    return host === "photos.globex.com" ? globex : host === "frozen.example.org" ? frozen : null;
  },
};

describe("normalizeHost", () => {
  it.each([
    ["Acme.YourApp.com", "acme.yourapp.com"],
    ["acme.yourapp.com:3000", "acme.yourapp.com"],
    ["acme.yourapp.com.", "acme.yourapp.com"],
    ["  photos.globex.com  ", "photos.globex.com"],
  ])("%s → %s", (raw, expected) => expect(normalizeHost(raw)).toBe(expected));

  it.each([
    [null], [""], ["[::1]:3000"], ["user@acme.yourapp.com"], ["acme.yourapp.com/evil"], ["a..b.com"],
    ["-acme.yourapp.com"], ["acme.yourapp.com:abc"], ["acme_x.yourapp.com"], ["x".repeat(64) + ".com"],
  ])("rejects %s", (raw) => expect(normalizeHost(raw)).toBeNull());
});

describe("resolveHost", () => {
  it("routes the admin and auth hosts", async () => {
    expect(await resolveHost("admin.yourapp.com", root, lookup)).toEqual({ kind: "admin" });
    expect(await resolveHost("AUTH.yourapp.com:443", root, lookup)).toEqual({ kind: "auth" });
  });

  it("resolves a tenant by subdomain", async () => {
    expect(await resolveHost("acme.yourapp.com", root, lookup)).toEqual({ kind: "tenant", tenant: acme, via: "subdomain" });
  });

  it("resolves a tenant by verified custom domain", async () => {
    expect(await resolveHost("photos.globex.com", root, lookup)).toEqual({ kind: "tenant", tenant: globex, via: "custom_domain" });
  });

  it("returns not_found for unknown hosts", async () => {
    expect(await resolveHost("nobody.yourapp.com", root, lookup)).toMatchObject({ kind: "not_found", reason: "unknown_host" });
    expect(await resolveHost("unverified.example.com", root, lookup)).toMatchObject({ kind: "not_found" });
  });

  it("never looks up reserved subdomains or the apex as tenants", async () => {
    lookup.calls.length = 0;
    for (const h of ["www.yourapp.com", "cdn.yourapp.com", "api.yourapp.com", "yourapp.com"]) {
      expect(await resolveHost(h, root, lookup)).toMatchObject({ kind: "not_found", reason: "reserved" });
    }
    expect(lookup.calls).toEqual([]);
  });

  it("doesn't treat nested subdomains as tenants", async () => {
    lookup.calls.length = 0;
    expect(await resolveHost("x.acme.yourapp.com", root, lookup)).toMatchObject({ kind: "not_found" });
    expect(lookup.calls).toEqual([]);
  });

  it("doesn't match a lookalike apex", async () => {
    // evilyourapp.com must go down the custom-domain path, not the subdomain path.
    lookup.calls.length = 0;
    await resolveHost("acme.evilyourapp.com", root, lookup);
    expect(lookup.calls).toEqual(["host:acme.evilyourapp.com"]);
  });

  it("reports suspended tenants on either host type", async () => {
    expect(await resolveHost("frozen.yourapp.com", root, lookup)).toEqual({ kind: "suspended", tenant: frozen });
    expect(await resolveHost("frozen.example.org", root, lookup)).toEqual({ kind: "suspended", tenant: frozen });
  });

  it("hides deleted and still-provisioning tenants", async () => {
    expect(await resolveHost("gone.yourapp.com", root, lookup)).toMatchObject({ kind: "not_found" });
    expect(await resolveHost("fresh.yourapp.com", root, lookup)).toMatchObject({ kind: "not_found" });
  });

  it("rejects malformed Host headers", async () => {
    expect(await resolveHost("acme.yourapp.com@evil.com", root, lookup)).toMatchObject({ kind: "not_found", reason: "malformed" });
  });
});

describe("tenantHost", () => {
  it("prefers the primary custom domain", () => {
    expect(tenantHost(globex, root)).toBe("photos.globex.com");
    expect(tenantHost(acme, root)).toBe("acme.yourapp.com");
    expect(tenantHost(acme, parseRootDomain("lvh.me:3000"))).toBe("acme.lvh.me:3000");
  });
});
