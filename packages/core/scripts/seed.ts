// pnpm db:seed [--admin you@example.com]
// Dev data: two tenants (acme, globex) with direct owners, and a super-admin.
import { parseArgs } from "node:util";
import { createTenant, tenantAdminDepsFromEnv, TenantError } from "../src/admin.ts";

const { values } = parseArgs({ options: { admin: { type: "string", default: "admin@lvh.me" } } });
const deps = tenantAdminDepsFromEnv();
try {
  await deps.control.query(
    `INSERT INTO users (email, is_super_admin) VALUES ($1, true)
     ON CONFLICT (email) DO UPDATE SET is_super_admin = true`,
    [values.admin.toLowerCase()],
  );
  console.log(`super-admin: ${values.admin}`);
  for (const [slug, name] of [["acme", "Acme Ltd"], ["globex", "Globex Corporation"]] as const) {
    try {
      const t = await createTenant(deps, { slug, name, owner: { email: `owner@${slug}.test`, mode: "direct" } });
      console.log(`tenant ${t.slug}: ${t.id} (owner owner@${slug}.test)`);
    } catch (err) {
      if (err instanceof TenantError && err.code === "slug_taken") console.log(`tenant ${slug}: already exists`);
      else throw err;
    }
  }
} finally {
  await deps.close();
}
