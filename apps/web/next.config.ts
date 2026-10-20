import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Local dev reads the repo-root .env (Next only looks in apps/web by default).
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No root .env: CI and production set real environment variables.
}

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@il/auth", "@il/config", "@il/core", "@il/db", "@il/storage"],
  serverExternalPackages: ["pg", "ioredis"],
  poweredByHeader: false,
};

export default config;
