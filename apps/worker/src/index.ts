import { Queue, Worker, type Job } from "bullmq";
import { purgeDeletedTenants, tenantAdminDepsFromEnv } from "@il/core/admin";

/**
 * Background worker. Phase 0 runs the nightly cleanup only; process-asset,
 * zip and domain-verify consumers join in Phases 1 and 3.
 */

export const QUEUES = {
  cleanup: "cleanup",
} as const;

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}),
  ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {}),
  maxRetriesPerRequest: null,
};

const deps = tenantAdminDepsFromEnv();

async function runCleanup(job: Job) {
  if (job.name === "purge-deleted-tenants") {
    const purged = await purgeDeletedTenants(deps);
    return { purged };
  }
  throw new Error(`Unknown cleanup job: ${job.name}`);
}

const cleanupQueue = new Queue(QUEUES.cleanup, { connection });
await cleanupQueue.upsertJobScheduler(
  "nightly-purge-deleted-tenants",
  { pattern: "0 3 * * *", tz: "Europe/London" },
  { name: "purge-deleted-tenants", opts: { removeOnComplete: 100, removeOnFail: 500 } },
);

const workers = [new Worker(QUEUES.cleanup, runCleanup, { connection, concurrency: 1 })];
for (const w of workers) {
  w.on("completed", (job, result) => console.log(`[${w.name}] ${job.name} done`, result));
  w.on("failed", (job, err) => console.error(`[${w.name}] ${job?.name} failed:`, err.message));
}
console.log(`worker up: ${workers.map((w) => w.name).join(", ")}`);

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  await cleanupQueue.close();
  await deps.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
