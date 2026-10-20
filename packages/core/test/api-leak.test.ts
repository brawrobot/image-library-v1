// Cross-tenant leak tests for the tenant API. For every registered route:
//   * tenant B's resource ids, requested by tenant A's member on A's host → 404
//   * A's member, holding a real session on B's host but no membership → 404
//   * A's session cookie replayed on B's host → 401 (sessions are host-bound)
//   * no session → 401
// A new route is covered automatically; one whose resource kind has no
// fixture here fails the suite until a fixture is added.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlDb, createTenantDbCache, type ControlDb, type TenantDbCache } from "@il/db";
import { dropTenantDatabase, migrateEverything } from "@il/db/admin";
import { routes, apiRouter } from "../src/api/routes.ts";
import type { ResourceKind, RouteDef } from "../src/api/router.ts";
import { createHandoff, redeemHandoff } from "../src/auth/sessions.ts";
import { createTenant, tenantAdminDepsFromEnv } from "../src/admin.ts";

const haveDb = Boolean(
  process.env.PROVISIONER_DATABASE_URL && process.env.CONTROL_DATABASE_URL && process.env.SECRETS_KEY && process.env.TENANT_DB_HOST,
);

type Fixture = Partial<Record<ResourceKind, string>>;
interface Side {
  id: string;
  host: string;
  ownerId: string;
  /** Owner's session on this tenant's own host. */
  session: string;
  resources: Fixture;
}

function fill(path: string, values: Record<string, string>): string {
  return path.replace(/:([a-zA-Z]+)/g, (_, name: string) => values[name] ?? "missing");
}

function paramsFor(route: RouteDef, fixture: Fixture): Record<string, string> {
  if (!("params" in route.leak)) return {};
  return Object.fromEntries(
    Object.entries(route.leak.params).map(([param, kind]) => {
      const id = fixture[kind!];
      if (!id) throw new Error(`No leak-test fixture for resource kind "${kind}" (route ${route.method} ${route.path})`);
      return [param, id];
    }),
  );
}

describe.skipIf(!haveDb)("tenant API cross-tenant leaks", () => {
  const deps = haveDb ? tenantAdminDepsFromEnv() : (undefined as never);
  let control: ControlDb;
  let tenantDbs: TenantDbCache;
  let A: Side;
  let B: Side;
  let aOnBSession: string;
  const createdTenants: string[] = [];
  const createdUsers: string[] = [];

  async function call(route: RouteDef, side: { id: string; host: string }, session: string | null, params: Record<string, string>) {
    const path = fill(route.path, params);
    return apiRouter.dispatch(
      {
        request: new Request(`https://${side.host}/api/v1${path}`, { method: route.method }),
        path,
        tenantId: side.id,
        host: side.host,
        sessionToken: session,
      },
      { control, tenantDb: (id) => tenantDbs.get(id) },
    );
  }

  async function makeSide(label: string): Promise<Side> {
    const run = randomUUID().slice(0, 8);
    const slug = `api-${label}-${run}`;
    const email = `owner-${label}-${run}@leak.test`;
    const t = await createTenant(deps, { slug, name: slug, owner: { email, mode: "direct" } });
    createdTenants.push(t.id);
    createdUsers.push(t.ownerUserId!);
    const host = `${slug}.yourapp.test`;

    const db = await tenantDbs.get(t.id);
    const asset = await db.asset.create({
      data: {
        uploaderId: t.ownerUserId!,
        storageKey: `tenants/${t.id}/originals/x`,
        filename: `${label}.jpg`,
        mime: "image/jpeg",
        sha256: `sha-${label}-${run}`,
        status: "ready",
      },
    });
    const tag = await db.tag.create({ data: { name: `tag-${label}`, slug: `tag-${label}` } });

    const handoff = await createHandoff(control, { userId: t.ownerUserId!, targetHost: host });
    const session = await redeemHandoff(control, { token: handoff, host });
    return { id: t.id, host, ownerId: t.ownerUserId!, session: session!.sessionToken, resources: { asset: asset.id, tag: tag.id } };
  }

  beforeAll(async () => {
    await migrateEverything({ provisionerUrl: process.env.PROVISIONER_DATABASE_URL! });
    control = createControlDb(process.env.CONTROL_DATABASE_URL!, 3);
    tenantDbs = createTenantDbCache({ control, secretsKey: process.env.SECRETS_KEY!, poolSize: 2 });
    A = await makeSide("a");
    B = await makeSide("b");
    // A's owner, signed in on B's host (e.g. following a share link) but not a member of B.
    const handoff = await createHandoff(control, { userId: A.ownerId, targetHost: B.host });
    aOnBSession = (await redeemHandoff(control, { token: handoff, host: B.host }))!.sessionToken;
  }, 180_000);

  afterAll(async () => {
    await tenantDbs?.clear();
    await control?.$disconnect();
    for (const id of createdTenants) {
      await dropTenantDatabase(deps, id).catch(() => {});
      await deps.control.query("DELETE FROM tenants WHERE id = $1", [id]);
    }
    if (createdUsers.length) await deps.control.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUsers]);
    await deps.close();
  }, 60_000);

  it("has routes to test", () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  describe.each(routes.map((r) => [`${r.method} ${r.path}`, r] as const))("%s", (_name, route) => {
    it("works for a member on their own tenant (so the 404s below mean something)", async () => {
      if (route.method !== "GET") return;
      const res = await call(route, A, A.session, paramsFor(route, A.resources));
      expect(res.status).toBe(200);
    });

    it("returns 404 for another tenant's resource ids", async () => {
      if (!("params" in route.leak)) return;
      const res = await call(route, A, A.session, paramsFor(route, B.resources));
      expect(res.status).toBe(404);
    });

    it("returns 404 to a signed-in non-member on another tenant's host", async () => {
      const res = await call(route, B, aOnBSession, paramsFor(route, B.resources));
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(B.resources.asset!);
    });

    it("rejects a session cookie replayed on another tenant's host", async () => {
      const res = await call(route, B, A.session, paramsFor(route, B.resources));
      expect(res.status).toBe(401);
    });

    it("requires a session", async () => {
      const res = await call(route, A, null, paramsFor(route, A.resources));
      expect(res.status).toBe(401);
    });
  });

  it("never lists another tenant's assets", async () => {
    const list = routes.find((r) => r.method === "GET" && r.path === "/assets")!;
    const body = (await (await call(list, A, A.session, {})).json()) as { data: { id: string }[] };
    const ids = body.data.map((a) => a.id);
    expect(ids).toContain(A.resources.asset);
    expect(ids).not.toContain(B.resources.asset);
  });

  it("returns 403 to a member whose role lacks the permission", async () => {
    const { rows: [role] } = await deps.control.query<{ id: string }>(
      "INSERT INTO roles (tenant_id, name, permissions) VALUES ($1, 'No access', '{}') RETURNING id",
      [A.id],
    );
    const { rows: [user] } = await deps.control.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`noaccess-${randomUUID().slice(0, 8)}@leak.test`],
    );
    createdUsers.push(user!.id);
    await deps.control.query(
      "INSERT INTO memberships (tenant_id, user_id, role_id, status) VALUES ($1, $2, $3, 'active')",
      [A.id, user!.id, role!.id],
    );
    const session = (await redeemHandoff(control, {
      token: await createHandoff(control, { userId: user!.id, targetHost: A.host }),
      host: A.host,
    }))!.sessionToken;
    const assets = routes.find((r) => r.path === "/assets")!;
    expect((await call(assets, A, session, {})).status).toBe(403);
  });

  it("treats malformed resource ids as not found", async () => {
    const one = routes.find((r) => r.path === "/assets/:id")!;
    expect((await call(one, A, A.session, { id: "../../etc" })).status).toBe(404);
  });

  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    const res = await apiRouter.dispatch(
      { request: new Request(`https://${A.host}/api/v1/nope`), path: "/nope", tenantId: A.id, host: A.host, sessionToken: A.session },
      { control, tenantDb: (id) => tenantDbs.get(id) },
    );
    expect(res.status).toBe(404);
    const wrong = await apiRouter.dispatch(
      { request: new Request(`https://${A.host}/api/v1/me`, { method: "DELETE" }), path: "/me", tenantId: A.id, host: A.host, sessionToken: A.session },
      { control, tenantDb: (id) => tenantDbs.get(id) },
    );
    expect(wrong.status).toBe(405);
  });
});

describe.skipIf(!haveDb)("hand-off tokens", () => {
  let control: ControlDb;
  let userId: string;

  beforeAll(async () => {
    await migrateEverything({ provisionerUrl: process.env.PROVISIONER_DATABASE_URL! });
    control = createControlDb(process.env.CONTROL_DATABASE_URL!, 2);
    userId = (await control.user.create({ data: { email: `handoff-${randomUUID().slice(0, 8)}@leak.test` } })).id;
  });

  afterAll(async () => {
    await control.user.delete({ where: { id: userId } });
    await control.$disconnect();
  });

  it("are single use", async () => {
    const token = await createHandoff(control, { userId, targetHost: "a.yourapp.test" });
    expect(await redeemHandoff(control, { token, host: "a.yourapp.test" })).not.toBeNull();
    expect(await redeemHandoff(control, { token, host: "a.yourapp.test" })).toBeNull();
  });

  it("only work on the host they were issued for", async () => {
    const token = await createHandoff(control, { userId, targetHost: "a.yourapp.test" });
    expect(await redeemHandoff(control, { token, host: "b.yourapp.test" })).toBeNull();
  });

  it("expire", async () => {
    const token = await createHandoff(control, { userId, targetHost: "a.yourapp.test" });
    await control.handoffToken.updateMany({ where: { userId, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await redeemHandoff(control, { token, host: "a.yourapp.test" })).toBeNull();
  });

  it("never carry an off-site return path", async () => {
    for (const evil of ["https://evil.com", "//evil.com", "/\\evil.com"]) {
      const token = await createHandoff(control, { userId, targetHost: "a.yourapp.test", returnTo: evil });
      expect((await redeemHandoff(control, { token, host: "a.yourapp.test" }))!.returnTo).toBe("/");
    }
  });
});
