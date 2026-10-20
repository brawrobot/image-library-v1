import pg from "pg";
import { provisionerEnvSchema, readEnv } from "@il/config/env";
import { tableSecretStore } from "@il/db";
import type { TenantAdminDeps } from "./lifecycle.ts";

/** Provisioner-role dependencies from the environment. Call `close()` when done. */
export function tenantAdminDepsFromEnv(): TenantAdminDeps & { close(): Promise<void> } {
  const env = readEnv(provisionerEnvSchema);
  const control = new pg.Pool({ connectionString: env.PROVISIONER_DATABASE_URL, max: 3 });
  return {
    control,
    provisionerUrl: env.PROVISIONER_DATABASE_URL,
    tenantDbHost: env.TENANT_DB_HOST,
    secrets: tableSecretStore(control, env.SECRETS_KEY),
    close: () => control.end(),
  };
}
