import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Where tenant connection strings live. `tenants.db_ref` holds a secret name;
 * only this interface resolves it. The default implementation stores values
 * encrypted in the control-plane `secrets` table; a production deployment can
 * swap in AWS Secrets Manager or Vault behind the same interface.
 */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Anything with pg's `query(text, values)` shape: a Pool, Client or PoolClient. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

const ALG = "aes-256-gcm";
const VERSION = "v1";

function keyFrom(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes of hex");
  return key;
}

/** `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
export function encryptSecret(plaintext: string, hexKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, keyFrom(hexKey), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptSecret(sealed: string, hexKey: string): string {
  const [version, iv, tag, ct] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error("Malformed secret");
  const decipher = createDecipheriv(ALG, keyFrom(hexKey), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/** Secret store backed by the control-plane `secrets` table. */
export function tableSecretStore(db: Queryable, hexKey: string): SecretStore {
  keyFrom(hexKey);
  return {
    async get(name) {
      const { rows } = await db.query<{ value_enc: string }>(
        "SELECT value_enc FROM secrets WHERE name = $1",
        [name],
      );
      const row = rows[0];
      return row ? decryptSecret(row.value_enc, hexKey) : null;
    },
    async put(name, value) {
      await db.query(
        `INSERT INTO secrets (name, value_enc) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET value_enc = EXCLUDED.value_enc`,
        [name, encryptSecret(value, hexKey)],
      );
    },
    async delete(name) {
      await db.query("DELETE FROM secrets WHERE name = $1", [name]);
    },
  };
}
