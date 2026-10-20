// Host plumbing shared by the proxy and server code (no request APIs here,
// so the proxy can import it).
import Redis from "ioredis";
import { hostEnvSchema, readEnv } from "@il/config/env";
import {
  cachedTenantLookup,
  memoryHostCache,
  parseRootDomain,
  platformHost,
  redisHostCache,
  type HostCache,
  type RootDomain,
  type TenantLookup,
} from "@il/core";
import { getControlDb } from "@il/db";

const g = globalThis as unknown as { __ilHostCache?: HostCache; __ilLookup?: TenantLookup };

export function rootDomain(): RootDomain {
  return parseRootDomain(readEnv(hostEnvSchema).ROOT_DOMAIN);
}

export function protocol(): "http" | "https" {
  return readEnv(hostEnvSchema).PUBLIC_PROTOCOL;
}

export function hostCache(): HostCache {
  if (!g.__ilHostCache) {
    const url = process.env.REDIS_URL;
    g.__ilHostCache = url
      ? redisHostCache(new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false }))
      : memoryHostCache();
  }
  return g.__ilHostCache;
}

export function tenantLookup(): TenantLookup {
  g.__ilLookup ??= cachedTenantLookup(getControlDb(), hostCache());
  return g.__ilLookup;
}

/** Absolute URL on a platform host, e.g. platformUrl("auth", "/handoff?to=…"). */
export function platformUrl(sub: "admin" | "auth", path: string): string {
  return `${protocol()}://${platformHost(sub, rootDomain())}${path}`;
}

/** Sign-in link that returns the user to `returnTo` on the current host. */
export function signInUrl(currentOrigin: string, returnTo = "/"): string {
  return platformUrl("auth", `/handoff?to=${encodeURIComponent(new URL(returnTo, currentOrigin).toString())}`);
}

