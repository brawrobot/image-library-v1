import { LRUCache } from "lru-cache";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@il-generated/tenant";
import { controlDbEnvSchema, readEnv } from "@il/config/env";
import { decryptSecret } from "./secrets.ts";
import { getControlDb, type ControlDb } from "./control-client.ts";

export type TenantDb = PrismaClient;
export * as TenantTypes from "@il-generated/tenant";

export class TenantDbError extends Error {
  constructor(
    message: string,
    readonly tenantId: string,
  ) {
    super(message);
    this.name = "TenantDbError";
  }
}

export interface TenantDbDeps {
  control: ControlDb;
  secretsKey: string;
  /** Connections each app instance opens per tenant (PgBouncer multiplexes them). */
  poolSize?: number;
}

export function createTenantDb(connectionString: string, poolSize = 5): TenantDb {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, max: poolSize }) });
}

/**
 * Open a tenant's database and prove it is that tenant's: the login role must
 * map to `tenantId` and the database's tenant_meta row must agree. A secret
 * pointing at the wrong database fails here instead of serving wrong data.
 */
export async function openTenantDb(tenantId: string, deps: TenantDbDeps): Promise<TenantDb> {
  const tenant = await deps.control.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true, dbRef: true },
  });
  if (!tenant) throw new TenantDbError("Unknown tenant", tenantId);
  if (tenant.status === "deleted" || tenant.status === "provisioning" || !tenant.dbRef) {
    throw new TenantDbError(`Tenant database not available (status ${tenant.status})`, tenantId);
  }
  const secret = await deps.control.secret.findUnique({ where: { name: tenant.dbRef } });
  if (!secret) throw new TenantDbError("Tenant connection secret missing", tenantId);

  const db = createTenantDb(decryptSecret(secret.valueEnc, deps.secretsKey), deps.poolSize);
  try {
    const rows = await db.$queryRaw<{ actor: string | null; meta: string | null }[]>`
      SELECT current_tenant_id()::text AS actor,
             (SELECT tenant_id::text FROM tenant_meta LIMIT 1) AS meta`;
    const row = rows[0];
    if (row?.actor !== tenantId || row?.meta !== tenantId) {
      throw new TenantDbError(
        `Tenant database identity mismatch (role ${row?.actor ?? "none"}, meta ${row?.meta ?? "none"})`,
        tenantId,
      );
    }
    return db;
  } catch (err) {
    await db.$disconnect().catch(() => {});
    throw err;
  }
}

export interface TenantDbCache {
  get(tenantId: string): Promise<TenantDb>;
  evict(tenantId: string): void;
  clear(): Promise<void>;
  readonly size: number;
}

/** LRU of open tenant clients; least-recently-used tenants are disconnected. */
export function createTenantDbCache(deps: TenantDbDeps, max = 200): TenantDbCache {
  const cache = new LRUCache<string, Promise<TenantDb>>({
    max,
    dispose: (pending) => {
      pending.then((db) => db.$disconnect()).catch(() => {});
    },
  });
  return {
    get(tenantId) {
      let pending = cache.get(tenantId);
      if (!pending) {
        pending = openTenantDb(tenantId, deps);
        // Don't cache failures: the next request retries.
        pending.catch(() => {
          if (cache.peek(tenantId) === pending) cache.delete(tenantId);
        });
        cache.set(tenantId, pending);
      }
      return pending;
    },
    evict(tenantId) {
      cache.delete(tenantId);
    },
    async clear() {
      const all = [...cache.values()];
      cache.clear();
      await Promise.allSettled(all.map((p) => p.then((db) => db.$disconnect())));
    },
    get size() {
      return cache.size;
    },
  };
}

const globalForTenants = globalThis as unknown as { __ilTenantDbs?: TenantDbCache };

/** The process-wide tenant client cache. */
export function tenantDbs(): TenantDbCache {
  if (!globalForTenants.__ilTenantDbs) {
    const env = readEnv(controlDbEnvSchema);
    globalForTenants.__ilTenantDbs = createTenantDbCache({
      control: getControlDb(),
      secretsKey: env.SECRETS_KEY,
    });
  }
  return globalForTenants.__ilTenantDbs;
}

/** Shorthand for `tenantDbs().get(tenantId)`. */
export function getTenantDb(tenantId: string): Promise<TenantDb> {
  return tenantDbs().get(tenantId);
}
