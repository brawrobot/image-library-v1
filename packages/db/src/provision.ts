import { randomBytes } from "node:crypto";
import pg from "pg";
import { loadMigrations, migrateDatabase, type Migration } from "./migrate.ts";
import {
  quoteIdent,
  quoteLiteral,
  tenantDbName,
  tenantDbSecretName,
  tenantRoleName,
  withDatabase,
} from "./names.ts";
import type { SecretStore } from "./secrets.ts";

export interface ProvisionerConfig {
  /** Connection string for the `provisioner` role (any database on the cluster). */
  provisionerUrl: string;
  /** host:port that runtime tenant connection strings point at (PgBouncer). */
  tenantDbHost: string;
  secrets: SecretStore;
  /** Pool size each app instance opens per tenant. */
  tenantPoolSize?: number;
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Grants the tenant role DML on every table, ops read-only. Idempotent; run after each migration batch. */
async function applyGrants(tenantUrl: string, role: string): Promise<void> {
  const r = quoteIdent(role);
  await withClient(tenantUrl, async (c) => {
    await c.query(`
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${r}, platform_ops;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r};
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO platform_ops;
      -- The migration ledger is the provisioner's business only.
      REVOKE ALL ON schema_migrations FROM ${r}, platform_ops;
    `);
  });
}

/** Apply pending tenant migrations to one tenant database. Returns its schema version. */
export async function migrateTenantDatabase(
  provisionerUrl: string,
  tenantId: string,
  migrations?: Migration[],
): Promise<number> {
  const all = migrations ?? (await loadMigrations("tenant"));
  const url = withDatabase(provisionerUrl, tenantDbName(tenantId));
  const result = await migrateDatabase(url, all, {
    before: `SET LOCAL app.tenant_id = ${quoteLiteral(tenantId)}`,
  });
  await applyGrants(url, tenantRoleName(tenantId));
  return result.version;
}

export interface ProvisionedDatabase {
  dbName: string;
  roleName: string;
  dbRef: string;
  schemaVersion: number;
}

/**
 * Create a tenant's database and login role, migrate it, and store its
 * connection string. On any failure the half-built database and role are
 * dropped again, so a retry starts clean.
 */
export async function createTenantDatabase(
  config: ProvisionerConfig,
  tenantId: string,
): Promise<ProvisionedDatabase> {
  const dbName = tenantDbName(tenantId);
  const roleName = tenantRoleName(tenantId);
  const dbRef = tenantDbSecretName(tenantId);
  const password = randomBytes(24).toString("hex");
  const db = quoteIdent(dbName);
  const role = quoteIdent(roleName);

  try {
    await withClient(config.provisionerUrl, async (c) => {
      await c.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD ${quoteLiteral(password)}`);
      // CREATE DATABASE can't run inside a transaction block, so one statement per call.
      await c.query(`CREATE DATABASE ${db}`);
      await c.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
      await c.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}, platform_ops`);
    });

    const tenantUrl = withDatabase(config.provisionerUrl, dbName);
    await withClient(tenantUrl, async (c) => {
      await c.query(`
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public
          GRANT SELECT ON TABLES TO platform_ops;
      `);
    });

    const schemaVersion = await migrateTenantDatabase(config.provisionerUrl, tenantId);

    await withClient(tenantUrl, async (c) => {
      await c.query("BEGIN");
      await c.query(`SET LOCAL app.tenant_id = ${quoteLiteral(tenantId)}`);
      await c.query("INSERT INTO tenant_meta DEFAULT VALUES ON CONFLICT DO NOTHING");
      await c.query("COMMIT");
    });

    const runtime = new URL(`postgresql://${config.tenantDbHost}/${dbName}`);
    runtime.username = roleName;
    runtime.password = password;
    await config.secrets.put(dbRef, runtime.toString());

    return { dbName, roleName, dbRef, schemaVersion };
  } catch (err) {
    await dropTenantDatabase(config, tenantId).catch(() => {});
    throw err;
  }
}

/** Drop a tenant's database, role and connection secret. Irreversible. */
export async function dropTenantDatabase(config: ProvisionerConfig, tenantId: string): Promise<void> {
  const db = quoteIdent(tenantDbName(tenantId));
  const role = quoteIdent(tenantRoleName(tenantId));
  await withClient(config.provisionerUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await c.query(`DROP ROLE IF EXISTS ${role}`);
  });
  await config.secrets.delete(tenantDbSecretName(tenantId));
}
