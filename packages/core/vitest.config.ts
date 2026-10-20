import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Local runs read the repo-root .env; CI sets the variables directly.
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Integration tests share one Postgres cluster; run files one at a time.
    fileParallelism: false,
  },
});
