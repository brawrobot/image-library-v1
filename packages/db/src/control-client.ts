import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@il-generated/control";
import { controlDbEnvSchema, readEnv } from "@il/config/env";

export type ControlDb = PrismaClient;
export * as ControlTypes from "@il-generated/control";

const globalForControl = globalThis as unknown as { __ilControlDb?: ControlDb };

export function createControlDb(connectionString: string, poolSize = 10): ControlDb {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, max: poolSize }) });
}

/**
 * The app's control-plane client (`platform_app` role). One per process; kept
 * on globalThis so Next.js dev reloads don't leak connection pools.
 */
export function getControlDb(): ControlDb {
  if (!globalForControl.__ilControlDb) {
    const env = readEnv(controlDbEnvSchema);
    globalForControl.__ilControlDb = createControlDb(env.CONTROL_DATABASE_URL);
  }
  return globalForControl.__ilControlDb;
}
