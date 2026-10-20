import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ROLE_NAMES, SYSTEM_ROLES } from "@il/auth/permissions";
import { createControlDb, tenantDbName, type ControlDb } from "@il/db";
import { migrateEverything } from "@il/db/admin";
import {
  createTenant,
  purgeDeletedTenants,
  restoreTenant,
  softDeleteTenant,
  tenantAdminDepsFromEnv,
  TenantError,
  validateSlug,
} from "../src/admin.ts";
import { cachedTenantLookup, memoryHostCache } from "../src/tenancy/lookup.ts";
import { parseRootDomain, resolveHost } from "../src/tenancy/host.ts";

describe("validateSlug", () => {
  it.each(["acme", "a", "acme-photo-2", "0"])("accepts %s", (s) => expect(() => validateSlug(s)).not.toThrow());
  it.each(["", "-acme", "acme-", "Acme", "ac_me", "a".repeat(64), "admin", "www", "cdn"])("rejects %s", (s) =>
    expect(() => validateSlug(s)).toThrow(TenantError),
  );
});

const haveDb = Boolean(process.env.PROVISIONER_DATABASE_URL && process.env.CONTROL_DATABASE_URL && process.env.SECRETS_KEY);

describe.skipIf(!haveDb)("tenant lifecycle", () => {
  const deps = haveDb ? tenantAdminDepsFromEnv() : (undefined as never);
  let control: ControlDb;
  const root = parseRootDomain("yourapp.test");
  const slug = `life-${randomUUID().slice(0, 8)}`;
  let tenantId: string;

  const dbExists = async () =>
    (await deps.control.query("SELECT 1 FROM pg_database WHERE datname = $1", [tenantDbName(tenantId)])).rowCount === 1;
  // Fresh cache each time so resolution reflects the current row.
  const resolve = () => resolveHost(`${slug}.yourapp.test`, root, cachedTenantLookup(control, memoryHostCache()));

  beforeAll(async () => {
    await migrateEverything({ provisionerUrl: process.env.PROVISIONER_DATABASE_URL! });
    control = createControlDb(process.env.CONTROL_DATABASE_URL!, 2);
  });

  afterAll(async () => {
    await control.$disconnect();
    await deps.close();
  });

  it("creates the tenant, its database, the system roles and an owner invitation", async () => {
    const t = await createTenant(deps, { slug, name: "Lifecycle Ltd", owner: { email: `Owner@${slug}.test` } });
    tenantId = t.id;
    expect(t.invitationToken).toBeTruthy();
    expect(t.ownerUserId).toBeNull();
    expect(await dbExists()).toBe(true);

    const roles = await control.role.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
    expect(roles.map((r) => r.name).sort()).toEqual([...SYSTEM_ROLE_NAMES].sort());
    for (const r of roles) expect(r.permissions).toEqual([...SYSTEM_ROLES[r.name as keyof typeof SYSTEM_ROLES]]);

    const invite = await control.invitation.findFirstOrThrow({ where: { tenantId } });
    expect(invite.email).toBe(`owner@${slug}.test`);
    expect(invite.roleId).toBe(t.roleIds.Owner);

    const tenant = await control.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.status).toBe("active");
    expect(tenant.schemaVersion).toBeGreaterThan(0);
    expect(await resolve()).toMatchObject({ kind: "tenant", tenant: { id: tenantId } });
  });

  it("refuses a duplicate slug and leaves nothing behind", async () => {
    const before = await deps.control.query("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'tenant_%'");
    await expect(createTenant(deps, { slug, name: "Dup", owner: { email: "x@y.test" } })).rejects.toMatchObject({
      code: "slug_taken",
    });
    const after = await deps.control.query("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'tenant_%'");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("stops resolving on soft delete, and comes back on restore", async () => {
    await softDeleteTenant(deps, tenantId);
    expect(await resolve()).toMatchObject({ kind: "not_found" });
    expect(await dbExists()).toBe(true);
    await restoreTenant(deps, tenantId);
    expect(await resolve()).toMatchObject({ kind: "tenant" });
  });

  it("purges the database only after the 30-day restore window", async () => {
    await softDeleteTenant(deps, tenantId);
    expect(await purgeDeletedTenants(deps)).not.toContain(tenantId);
    expect(await dbExists()).toBe(true);

    const later = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(await purgeDeletedTenants(deps, later)).toContain(tenantId);
    expect(await dbExists()).toBe(false);
    expect(await control.tenant.findUnique({ where: { id: tenantId } })).toBeNull();
    expect(await control.role.count({ where: { tenantId } })).toBe(0);
  });
});
