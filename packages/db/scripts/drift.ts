// pnpm db:drift
// Builds throwaway control and tenant databases from the SQL migrations, then
// asks Prisma whether its schema files describe the same tables. Exits 1 with
// the SQL difference if they don't, so the typed client can't drift from the
// real schema.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { provisionerEnvSchema, readEnv } from "@il/config/env";
import { loadMigrations, migrateDatabase } from "../src/migrate.ts";
import { quoteIdent, withDatabase } from "../src/names.ts";

const env = readEnv(provisionerEnvSchema);
const suffix = `${process.pid}`;
const targets = [
  { target: "control", db: `drift_control_${suffix}`, schema: "prisma/control/schema.prisma" },
  {
    target: "tenant",
    db: `drift_tenant_${suffix}`,
    schema: "prisma/tenant/schema.prisma",
    before: "SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000'",
  },
] as const;

const admin = new pg.Client({ connectionString: env.PROVISIONER_DATABASE_URL });
await admin.connect();
let drifted = false;
try {
  for (const t of targets) {
    await admin.query(`CREATE DATABASE ${quoteIdent(t.db)}`);
    const url = withDatabase(env.PROVISIONER_DATABASE_URL, t.db);
    await migrateDatabase(url, await loadMigrations(t.target), "before" in t ? { before: t.before } : {});

    const result = spawnSync(
      "prisma",
      ["migrate", "diff", "--from-url", url, "--to-schema-datamodel", t.schema, "--script", "--exit-code"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, CONTROL_DATABASE_URL: url, TENANT_DATABASE_URL: url },
      },
    );
    if (result.status === 0) {
      console.log(`✓ ${t.target}: Prisma schema matches migrations`);
    } else {
      drifted = true;
      console.error(`✗ ${t.target}: Prisma schema differs from migrations (exit ${result.status}).`);
      console.error("  SQL that would make the database match the Prisma schema:\n");
      console.error(result.stdout || result.stderr);
    }
  }
} finally {
  for (const t of targets) {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(t.db)} WITH (FORCE)`).catch(() => {});
  }
  await admin.end();
}
process.exit(drifted ? 1 : 0);
