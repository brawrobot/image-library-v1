import { describe, expect, it } from "vitest";
import { assertTenantKey, originalKey, tenantPrefix, variantKey } from "../src/keys.ts";

const A = "01a15984-7f0a-7ac8-b653-d810181d56e1";
const B = "01a15984-9c41-727d-b9a1-aee671852223";
const asset = "01a15990-0000-7000-8000-000000000001";

describe("storage keys", () => {
  it("prefixes every key with the tenant", () => {
    expect(originalKey(A, asset)).toBe(`tenants/${A}/originals/${asset}`);
    expect(variantKey(A, asset, "thumb", "webp")).toBe(`tenants/${A}/variants/${asset}/thumb.webp`);
  });

  it("rejects ids that aren't UUIDs", () => {
    expect(() => tenantPrefix("../etc")).toThrow();
    expect(() => originalKey(A, "x/../../y")).toThrow();
  });

  it("accepts a tenant's own keys only", () => {
    expect(assertTenantKey(A, originalKey(A, asset))).toBeTruthy();
    expect(() => assertTenantKey(A, originalKey(B, asset))).toThrow(/outside/);
    expect(() => assertTenantKey(A, `tenants/${A}`)).toThrow(/outside/);
    expect(() => assertTenantKey(A, `tenants/${A}/`)).toThrow(/outside/);
  });

  it("rejects traversal and odd segments inside the prefix", () => {
    for (const rest of ["../" + B + "/originals/x", "a//b", "./a", "a\\b"]) {
      expect(() => assertTenantKey(A, `tenants/${A}/${rest}`)).toThrow();
    }
  });
});
