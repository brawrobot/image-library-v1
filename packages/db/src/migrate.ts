import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

export type MigrationTarget = "control" | "tenant";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const MIGRATIONS_ROOT = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Migrations on disk, in order. Files are `NNNN_name.sql`. */
export async function loadMigrations(target: MigrationTarget): Promise<Migration[]> {
  const dir = path.join(MIGRATIONS_ROOT, target);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!match) throw new Error(`Bad migration filename: ${target}/${file}`);
    const sql = await readFile(path.join(dir, file), "utf8");
    migrations.push({
      version: Number(match[1]),
      name: match[2]!,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`${target} migrations must be numbered 0001, 0002, … without gaps`);
  });
  return migrations;
}

export function latestVersion(migrations: Migration[]): number {
  return migrations.at(-1)?.version ?? 0;
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    integer     NOT NULL,
    name       text        NOT NULL,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schema_migrations_pkey PRIMARY KEY (version)
  )`;

export interface MigrateResult {
  applied: number[];
  version: number;
}

/**
 * Apply pending migrations to one database, each in its own transaction.
 * Refuses to run if an already-applied migration file was edited.
 * `before` runs inside each transaction first (used to set app.tenant_id).
 */
export async function migrateDatabase(
  connectionString: string,
  migrations: Migration[],
  opts: { before?: string } = {},
): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(LEDGER);
    // One migrator per database at a time.
    await client.query("SELECT pg_advisory_lock(727274)");
    const { rows } = await client.query<{ version: number; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const [version, checksum] of done) {
      const m = migrations.find((x) => x.version === version);
      if (!m) throw new Error(`Database has migration ${version}, which is missing on disk`);
      if (m.checksum !== checksum) throw new Error(`Migration ${version}_${m.name} was edited after it was applied`);
    }
    const applied: number[] = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await client.query("BEGIN");
      try {
        if (opts.before) await client.query(opts.before);
        await client.query(m.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [m.version, m.name, m.checksum],
        );
        await client.query("COMMIT");
        applied.push(m.version);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return { applied, version: latestVersion(migrations) };
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    await client.end();
  }
}
