// pnpm db:migrate [--concurrency 5] [--tenant <id> ...]
// Migrates the control plane, then fans out to every tenant database behind.
import { parseArgs } from "node:util";
import { provisionerEnvSchema, readEnv } from "@il/config/env";
import { migrateEverything } from "../src/admin.ts";

const { values } = parseArgs({
  options: {
    concurrency: { type: "string", default: "5" },
    tenant: { type: "string", multiple: true },
  },
});

const env = readEnv(provisionerEnvSchema);
const report = await migrateEverything({
  provisionerUrl: env.PROVISIONER_DATABASE_URL,
  concurrency: Number(values.concurrency),
  ...(values.tenant ? { onlyTenantIds: values.tenant } : {}),
  log: console.log,
});

if (report.failed.length) {
  console.error(`\n${report.failed.length} tenant(s) failed; rerun to retry them.`);
  process.exit(1);
}
