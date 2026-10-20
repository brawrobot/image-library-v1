/**
 * Object storage keys. Every key a tenant touches lives under
 * `tenants/{tenantId}/`, and assertTenantKey() is the check the upload and
 * download paths run before signing anything. The S3 client and presigning
 * arrive with uploads in Phase 1.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuid(value: string, what: string): string {
  if (!UUID.test(value)) throw new Error(`${what} must be a lowercase UUID`);
  return value;
}

export const VARIANT_KINDS = ["thumb", "small", "medium", "large"] as const;
export const VARIANT_FORMATS = ["webp", "avif"] as const;
export type VariantKind = (typeof VARIANT_KINDS)[number];
export type VariantFormat = (typeof VARIANT_FORMATS)[number];

export function tenantPrefix(tenantId: string): string {
  return `tenants/${uuid(tenantId, "tenantId")}/`;
}

export function originalKey(tenantId: string, assetId: string): string {
  return `${tenantPrefix(tenantId)}originals/${uuid(assetId, "assetId")}`;
}

export function variantKey(tenantId: string, assetId: string, kind: VariantKind, format: VariantFormat): string {
  if (!VARIANT_KINDS.includes(kind)) throw new Error(`Unknown variant kind: ${kind}`);
  if (!VARIANT_FORMATS.includes(format)) throw new Error(`Unknown variant format: ${format}`);
  return `${tenantPrefix(tenantId)}variants/${uuid(assetId, "assetId")}/${kind}.${format}`;
}

/** Throws unless `key` is a normalised key inside this tenant's prefix. */
export function assertTenantKey(tenantId: string, key: string): string {
  const prefix = tenantPrefix(tenantId);
  if (!key.startsWith(prefix) || key.length === prefix.length) {
    throw new Error("Storage key is outside the tenant's prefix");
  }
  const rest = key.slice(prefix.length);
  if (rest.split("/").some((seg) => seg === "" || seg === "." || seg === "..") || /[\\\0]/.test(rest)) {
    throw new Error("Storage key is not normalised");
  }
  return key;
}
