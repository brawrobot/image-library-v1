// pnpm tenant:create --slug acme --name "Acme Ltd" --owner you@example.com [--direct]
//   --direct  make the owner an active member now instead of sending an invitation
import { parseArgs } from "node:util";
import { hostEnvSchema, readEnv } from "@il/config/env";
import { createTenant, tenantAdminDepsFromEnv } from "../src/admin.ts";
import { parseRootDomain, tenantHost } from "../src/tenancy/host.ts";

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    name: { type: "string" },
    owner: { type: "string" },
    direct: { type: "boolean", default: false },
  },
});
if (!values.slug || !values.owner) {
  console.error('Usage: pnpm tenant:create --slug acme --name "Acme Ltd" --owner you@example.com [--direct]');
  process.exit(2);
}

const deps = tenantAdminDepsFromEnv();
try {
  const t = await createTenant(deps, {
    slug: values.slug,
    name: values.name ?? values.slug,
    owner: { email: values.owner, mode: values.direct ? "direct" : "invite" },
  });
  const hostEnv = readEnv(hostEnvSchema);
  const host = tenantHost({ slug: t.slug, primaryHost: null }, parseRootDomain(hostEnv.ROOT_DOMAIN));
  console.log(`Created tenant ${t.slug} (${t.id})`);
  console.log(`  site:  ${hostEnv.PUBLIC_PROTOCOL}://${host}/`);
  if (t.invitationToken) {
    console.log(`  owner invitation token (accept flow lands in Phase 2): ${t.invitationToken}`);
  } else {
    console.log(`  owner ${values.owner} is an active Owner`);
  }
} finally {
  await deps.close();
}
