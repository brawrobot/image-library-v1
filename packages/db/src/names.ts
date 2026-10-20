const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertUuid(id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`Not a lowercase UUID: ${JSON.stringify(id)}`);
  return id;
}

function hex(tenantId: string): string {
  return assertUuid(tenantId).replaceAll("-", "");
}

/** Database holding one tenant's library: `tenant_<32 hex>` (39 chars, under Postgres' 63). */
export function tenantDbName(tenantId: string): string {
  return `tenant_${hex(tenantId)}`;
}

/**
 * The tenant's own login role: `t_<32 hex>`. The tenant migration's
 * current_tenant_id() parses the tenant id back out of this exact shape, so
 * don't change it without changing that function.
 */
export function tenantRoleName(tenantId: string): string {
  return `t_${hex(tenantId)}`;
}

/** Secret name stored in tenants.db_ref. */
export function tenantDbSecretName(tenantId: string): string {
  return `tenant-db/${assertUuid(tenantId)}`;
}

/** Identifiers above are built only from [a-z0-9_], but quote anyway. */
export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Same server and credentials as `url`, different database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
