// Tenant isolation at the database layer. Needs a bootstrapped cluster
// (infra/postgres/bootstrap.sql) and PROVISIONER_DATABASE_URL, CONTROL_DATABASE_URL,
// TENANT_DB_HOST and SECRETS_KEY in the environment.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createControlDb,
  createTenantDbCache,
  openTenantDb,
  tableSecretStore,
  tenantDbName,
  tenantDbSecretName,
  tenantRoleName,
  withDatabase,
  type ControlDb,
} from "../src/index.ts";
import { createTenantDatabase, dropTenantDatabase, migrateEverything, type ProvisionerConfig } from "../src/admin.ts";

const env = {
  provisionerUrl: process.env.PROVISIONER_DATABASE_URL!,
  controlUrl: process.env.CONTROL_DATABASE_URL!,
  tenantDbHost: process.env.TENANT_DB_HOST!,
  secretsKey: process.env.SECRETS_KEY!,
  opsPassword: process.env.OPS_DATABASE_PASSWORD ?? "platform_ops",
};
const haveDb = Boolean(env.provisionerUrl && env.controlUrl && env.tenantDbHost && env.secretsKey);

async function query<T extends Record<string, unknown>>(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Connection string the tenant's own role uses, read back from the secret store. */
async function tenantRuntimeUrl(provisioner: pg.Pool, tenantId: string) {
  const url = await tableSecretStore(provisioner, env.secretsKey).get(tenantDbSecretName(tenantId));
  if (!url) throw new Error("no secret");
  return url;
}

describe.skipIf(!haveDb)("tenant database isolation", () => {
  let provisioner: pg.Pool;
  let config: ProvisionerConfig;
  let control: ControlDb;
  const tenants: { id: string; slug: string }[] = [];
  let A: string;
  let B: string;
  let urlA: string;
  let urlB: string;

  async function addTenant(slug: string) {
    const [row] = (
      await provisioner.query<{ id: string }>(
        "INSERT INTO tenants (slug, name) VALUES ($1, $1) RETURNING id",
        [slug],
      )
    ).rows;
    const id = row!.id;
    tenants.push({ id, slug });
    const db = await createTenantDatabase(config, id);
    await provisioner.query(
      "UPDATE tenants SET status = 'active', db_ref = $2, schema_version = $3 WHERE id = $1",
      [id, db.dbRef, db.schemaVersion],
    );
    return id;
  }

  beforeAll(async () => {
    await migrateEverything({ provisionerUrl: env.provisionerUrl });
    provisioner = new pg.Pool({ connectionString: env.provisionerUrl, max: 3 });
    config = {
      provisionerUrl: env.provisionerUrl,
      tenantDbHost: env.tenantDbHost,
      secrets: tableSecretStore(provisioner, env.secretsKey),
    };
    control = createControlDb(env.controlUrl, 2);
    const run = randomUUID().slice(0, 8);
    A = await addTenant(`leak-a-${run}`);
    B = await addTenant(`leak-b-${run}`);
    urlA = await tenantRuntimeUrl(provisioner, A);
    urlB = await tenantRuntimeUrl(provisioner, B);

    await query(urlA, "INSERT INTO tags (name, slug) VALUES ('alpha', 'alpha')");
    await query(urlB, "INSERT INTO tags (name, slug) VALUES ('bravo', 'bravo')");
  }, 120_000);

  afterAll(async () => {
    await control?.$disconnect();
    for (const t of tenants) {
      await dropTenantDatabase(config, t.id).catch(() => {});
      await provisioner.query("DELETE FROM tenants WHERE id = $1", [t.id]);
    }
    await provisioner?.end();
  }, 60_000);

  it("names each database and role after its tenant", async () => {
    expect(new URL(urlA).pathname).toBe(`/${tenantDbName(A)}`);
    expect(decodeURIComponent(new URL(urlA).username)).toBe(tenantRoleName(A));
  });

  it("refuses a tenant's login on another tenant's database", async () => {
    const crossed = withDatabase(urlA, tenantDbName(B));
    await expect(query(crossed, "SELECT 1")).rejects.toThrow(/permission denied|CONNECT privilege/i);
  });

  it("refuses a tenant's login on the control-plane database", async () => {
    const platform = withDatabase(urlA, new URL(env.controlUrl).pathname.slice(1));
    await expect(query(platform, "SELECT 1")).rejects.toThrow(/permission denied|CONNECT privilege/i);
  });

  it("can't create anything in the maintenance database", async () => {
    // `postgres` holds no data and allows CONNECT by default; make sure it can't become a side channel.
    await expect(query(withDatabase(urlA, "postgres"), "CREATE TABLE leak (i int)")).rejects.toThrow(/permission denied/i);
  });

  it("only shows a tenant its own rows", async () => {
    expect(await query(urlA, "SELECT slug FROM tags ORDER BY slug")).toEqual([{ slug: "alpha" }]);
    expect(await query(urlB, "SELECT slug FROM tags ORDER BY slug")).toEqual([{ slug: "bravo" }]);
  });

  it("blocks writing a row that names another tenant (RLS)", async () => {
    await expect(
      query(urlA, "INSERT INTO tags (tenant_id, name, slug) VALUES ($1, 'x', 'x')", [B]),
    ).rejects.toThrow(/row-level security/i);
  });

  it("ignores a session SET of app.tenant_id from the tenant role", async () => {
    const client = new pg.Client({ connectionString: urlA });
    await client.connect();
    try {
      await client.query(`SET app.tenant_id = '${B}'`);
      const { rows: ids } = await client.query<{ id: string }>("SELECT current_tenant_id()::text AS id");
      expect(ids[0]!.id).toBe(A);
      const { rows } = await client.query<{ tenant_id: string }>(
        "INSERT INTO tags (name, slug) VALUES ('setter', 'setter') RETURNING tenant_id",
      );
      expect(rows[0]!.tenant_id).toBe(A);
    } finally {
      await client.end();
    }
  });

  it("hides rows with a foreign tenant_id even inside the tenant's own database", async () => {
    const provisionerToA = withDatabase(env.provisionerUrl, tenantDbName(A));
    const client = new pg.Client({ connectionString: provisionerToA });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL app.tenant_id = '${B}'`);
      await client.query("INSERT INTO tags (name, slug) VALUES ('stray', 'stray')");
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
    const visible = await query<{ slug: string }>(urlA, "SELECT slug FROM tags");
    expect(visible.map((r) => r.slug)).not.toContain("stray");
  });

  it("stops the tenant role from changing schema or disabling RLS", async () => {
    await expect(query(urlA, "ALTER TABLE tags DISABLE ROW LEVEL SECURITY")).rejects.toThrow(/must be owner/i);
    await expect(query(urlA, "CREATE TABLE side_channel (i int)")).rejects.toThrow(/permission denied/i);
    await expect(query(urlA, "SELECT * FROM schema_migrations")).rejects.toThrow(/permission denied/i);
  });

  it("forces RLS on every table in a tenant database", async () => {
    const rows = await query<{ relname: string }>(
      withDatabase(env.provisionerUrl, tenantDbName(A)),
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND c.relname <> 'schema_migrations'
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
    );
    expect(rows).toEqual([]);
  });

  it("lets the ops role read but not write tenant data", async () => {
    const ops = new URL(withDatabase(env.provisionerUrl, tenantDbName(B)));
    ops.username = "platform_ops";
    ops.password = env.opsPassword;
    const rows = await query<{ slug: string }>(ops.toString(), "SELECT slug FROM tags ORDER BY slug");
    expect(rows.map((r) => r.slug)).toContain("bravo");
    await expect(query(ops.toString(), "INSERT INTO tags (name, slug) VALUES ('o', 'o')")).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("opens a tenant client only when the database proves it is that tenant's", async () => {
    const db = await openTenantDb(A, { control, secretsKey: env.secretsKey, poolSize: 1 });
    expect((await db.tag.findMany({ select: { slug: true } })).map((t) => t.slug)).toContain("alpha");
    await db.$disconnect();

    // Point A's db_ref at B's connection secret: the identity check must refuse it.
    await provisioner.query("UPDATE tenants SET db_ref = $2 WHERE id = $1", [A, tenantDbSecretName(B)]);
    try {
      await expect(openTenantDb(A, { control, secretsKey: env.secretsKey, poolSize: 1 })).rejects.toThrow(
        /identity mismatch/,
      );
    } finally {
      await provisioner.query("UPDATE tenants SET db_ref = $2 WHERE id = $1", [A, tenantDbSecretName(A)]);
    }
  });

  it("caches one client per tenant and evicts on request", async () => {
    const cache = createTenantDbCache({ control, secretsKey: env.secretsKey, poolSize: 1 }, 5);
    const [a1, a2, b1] = await Promise.all([cache.get(A), cache.get(A), cache.get(B)]);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    cache.evict(A);
    expect(await cache.get(A)).not.toBe(a1);
    await cache.clear();
  });

  it("drops a tenant's database, role and secret on deprovision", async () => {
    const id = await addTenant(`leak-gone-${randomUUID().slice(0, 8)}`);
    await dropTenantDatabase(config, id);
    const dbs = await provisioner.query("SELECT 1 FROM pg_database WHERE datname = $1", [tenantDbName(id)]);
    const roles = await provisioner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [tenantRoleName(id)]);
    expect(dbs.rowCount).toBe(0);
    expect(roles.rowCount).toBe(0);
    expect(await config.secrets.get(tenantDbSecretName(id))).toBeNull();
  });

  it("records each tenant's schema version and skips up-to-date tenants", async () => {
    const report = await migrateEverything({ provisionerUrl: env.provisionerUrl, onlyTenantIds: [A, B] });
    expect(report.failed).toEqual([]);
    expect(report.migrated).toEqual([]);
    expect(report.upToDate).toBe(2);
    const rows = await provisioner.query<{ schema_version: number }>(
      "SELECT schema_version FROM tenants WHERE id = ANY($1::uuid[])",
      [[A, B]],
    );
    expect(rows.rows.every((r) => r.schema_version === report.tenantTarget)).toBe(true);
  });
});
