import { z } from "zod";

/**
 * Environment schemas. Each consumer parses only the slice it needs, so the
 * worker doesn't demand Auth.js secrets and unit tests don't demand a database.
 */

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string");

const hexKey32 = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "must be 32 bytes of hex (64 characters)");

export const hostEnvSchema = z.object({
  /** Apex the platform lives under, optionally with a port for local dev (e.g. "lvh.me:3000"). */
  ROOT_DOMAIN: z.string().min(1),
  PUBLIC_PROTOCOL: z.enum(["http", "https"]).default("https"),
});

export const controlDbEnvSchema = z.object({
  CONTROL_DATABASE_URL: postgresUrl,
  SECRETS_KEY: hexKey32,
});

export const provisionerEnvSchema = z.object({
  PROVISIONER_DATABASE_URL: postgresUrl,
  /** host:port written into tenant connection strings (PgBouncer in production). */
  TENANT_DB_HOST: z.string().min(1),
  SECRETS_KEY: hexKey32,
  OPS_DATABASE_PASSWORD: z.string().min(1).optional(),
});

export const redisEnvSchema = z.object({
  REDIS_URL: z.string().optional(),
});

export const authEnvSchema = z.object({
  AUTH_SECRET: z.string().min(16),
  EMAIL_SERVER: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: z.string().optional(),
});

export type HostEnv = z.infer<typeof hostEnvSchema>;
export type ControlDbEnv = z.infer<typeof controlDbEnvSchema>;
export type ProvisionerEnv = z.infer<typeof provisionerEnvSchema>;
export type AuthEnv = z.infer<typeof authEnvSchema>;

/** Parse a slice of process.env, throwing one readable error listing every problem. */
export function readEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  // Treat empty strings as unset so `.env` placeholders like `AUTH_GOOGLE_ID=` behave.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return result.data;
}
