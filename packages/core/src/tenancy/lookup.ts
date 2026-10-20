import type { ControlDb } from "@il/db";
import type { TenantLookup, TenantRef, TenantStatus } from "./host.ts";

/** Small key/value cache with TTLs: Redis in production, memory in dev and tests. */
export interface HostCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
}

export const HOST_CACHE_TTL_SECONDS = 60;
/** Unknown hosts are cached briefly so a scan can't hammer the database. */
export const HOST_CACHE_MISS_TTL_SECONDS = 10;

const slugKey = (slug: string) => `il:host:slug:${slug}`;
const domainKey = (hostname: string) => `il:host:domain:${hostname}`;

export function memoryHostCache(now: () => number = Date.now): HostCache {
  const store = new Map<string, { value: string; expires: number }>();
  return {
    async get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expires <= now()) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    async set(key, value, ttl) {
      store.set(key, { value, expires: now() + ttl * 1000 });
      if (store.size > 10_000) store.delete(store.keys().next().value!);
    },
    async del(keys) {
      for (const k of keys) store.delete(k);
    },
  };
}

/** Minimal slice of an ioredis client. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export function redisHostCache(redis: RedisLike): HostCache {
  return {
    get: (key) => redis.get(key),
    async set(key, value, ttl) {
      await redis.set(key, value, "EX", ttl);
    },
    async del(keys) {
      if (keys.length) await redis.del(...keys);
    },
  };
}

type TenantRow = {
  id: string;
  slug: string;
  status: string;
  domains: { hostname: string }[];
};

function toRef(row: TenantRow): TenantRef {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status as TenantStatus,
    primaryHost: row.domains[0]?.hostname ?? null,
  };
}

const tenantSelect = {
  id: true,
  slug: true,
  status: true,
  domains: {
    where: { isPrimary: true, verifiedAt: { not: null } },
    select: { hostname: true },
    take: 1,
  },
} as const;

/** Host → tenant lookups against the control plane, cached for 60 s. */
export function cachedTenantLookup(control: ControlDb, cache: HostCache): TenantLookup {
  async function cached(key: string, load: () => Promise<TenantRef | null>) {
    try {
      const hit = await cache.get(key);
      if (hit !== null) return JSON.parse(hit) as TenantRef | null;
    } catch {
      // A cache outage degrades to direct lookups, never to failed requests.
    }
    const value = await load();
    cache
      .set(key, JSON.stringify(value), value ? HOST_CACHE_TTL_SECONDS : HOST_CACHE_MISS_TTL_SECONDS)
      .catch(() => {});
    return value;
  }

  return {
    bySlug: (slug) =>
      cached(slugKey(slug), async () => {
        const row = await control.tenant.findUnique({ where: { slug }, select: tenantSelect });
        return row ? toRef(row) : null;
      }),
    byHostname: (hostname) =>
      cached(domainKey(hostname), async () => {
        const domain = await control.domain.findFirst({
          where: { hostname, verifiedAt: { not: null } },
          select: { tenant: { select: tenantSelect } },
        });
        return domain ? toRef(domain.tenant) : null;
      }),
  };
}

/** Call after any change to a tenant's slug, status or domains. */
export async function bustHostCache(
  cache: HostCache,
  change: { slugs?: string[]; hostnames?: string[] },
): Promise<void> {
  await cache.del([...(change.slugs ?? []).map(slugKey), ...(change.hostnames ?? []).map(domainKey)]);
}
