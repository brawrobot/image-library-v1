import pg from "pg";
import { latestVersion, loadMigrations, migrateDatabase } from "./migrate.ts";
import { migrateTenantDatabase } from "./provision.ts";

export interface FanoutReport {
  control: { applied: number[]; version: number };
  tenantTarget: number;
  migrated: { tenantId: string; slug: string; version: number }[];
  failed: { tenantId: string; slug: string; error: string }[];
  upToDate: number;
}

/**
 * Migrate the control plane, then every live tenant database that is behind,
 * `concurrency` at a time. A failing tenant is reported and left at its old
 * version; the others carry on, and rerunning retries just the failures.
 */
export async function migrateEverything(opts: {
  provisionerUrl: string;
  concurrency?: number;
  onlyTenantIds?: string[];
  log?: (line: string) => void;
}): Promise<FanoutReport> {
  const log = opts.log ?? (() => {});
  const control = await migrateDatabase(opts.provisionerUrl, await loadMigrations("control"));
  log(`control: ${control.applied.length ? `applied ${control.applied.join(", ")}` : "up to date"} (v${control.version})`);

  const tenantMigrations = await loadMigrations("tenant");
  const target = latestVersion(tenantMigrations);
  const pool = new pg.Pool({ connectionString: opts.provisionerUrl, max: 2 });
  const report: FanoutReport = { control, tenantTarget: target, migrated: [], failed: [], upToDate: 0 };
  try {
    const { rows } = await pool.query<{ id: string; slug: string; schema_version: number }>(
      `SELECT id, slug, schema_version FROM tenants
       WHERE status IN ('active', 'suspended') AND db_ref IS NOT NULL
         AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
       ORDER BY created_at`,
      [opts.onlyTenantIds ?? null],
    );
    const behind = rows.filter((t) => t.schema_version < target);
    report.upToDate = rows.length - behind.length;
    log(`tenants: ${behind.length} behind v${target}, ${report.upToDate} up to date`);

    const concurrency = Math.max(1, opts.concurrency ?? 5);
    for (let i = 0; i < behind.length; i += concurrency) {
      const batch = behind.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (t) => {
          try {
            const version = await migrateTenantDatabase(opts.provisionerUrl, t.id, tenantMigrations);
            await pool.query("UPDATE tenants SET schema_version = $2 WHERE id = $1", [t.id, version]);
            report.migrated.push({ tenantId: t.id, slug: t.slug, version });
            log(`  ✓ ${t.slug} → v${version}`);
          } catch (err) {
            const error = (err as Error).message;
            report.failed.push({ tenantId: t.id, slug: t.slug, error });
            log(`  ✗ ${t.slug}: ${error}`);
          }
        }),
      );
    }
  } finally {
    await pool.end();
  }
  return report;
}
