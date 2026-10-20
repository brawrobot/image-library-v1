/**
 * Named permissions. Code checks these, never role names, so tenants can later
 * define custom roles from the same vocabulary.
 *
 * `*.own` variants grant the base permission only on resources the user
 * uploaded or created (Contributor's "own only" in the architecture doc).
 */
export const PERMISSIONS = [
  "asset.view",
  "asset.upload",
  "asset.edit",
  "asset.edit.own",
  "asset.delete",
  "asset.delete.own",
  "asset.download_original",
  "album.manage",
  "share.create",
  "share.public_gallery",
  "member.manage",
  "site.settings",
  "tenant.delete",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Permissions that can be checked directly (the `.own` variants are implied by these). */
export type CheckablePermission = Exclude<Permission, `${string}.own`>;

const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

export type SystemRoleName = "Owner" | "Admin" | "Editor" | "Contributor" | "Viewer";

/**
 * Seeded on every tenant. Viewer's original downloads are off by default;
 * a tenant that allows them adds `asset.download_original` to its Viewer role.
 */
export const SYSTEM_ROLES: Record<SystemRoleName, readonly Permission[]> = {
  Owner: [
    "asset.view", "asset.upload", "asset.edit", "asset.delete", "asset.download_original",
    "album.manage", "share.create", "share.public_gallery", "member.manage", "site.settings",
    "tenant.delete",
  ],
  Admin: [
    "asset.view", "asset.upload", "asset.edit", "asset.delete", "asset.download_original",
    "album.manage", "share.create", "share.public_gallery", "member.manage", "site.settings",
  ],
  Editor: [
    "asset.view", "asset.upload", "asset.edit", "asset.delete", "asset.download_original",
    "album.manage", "share.create",
  ],
  Contributor: [
    "asset.view", "asset.upload", "asset.edit.own", "asset.delete.own", "asset.download_original",
  ],
  Viewer: ["asset.view"],
};

export const SYSTEM_ROLE_NAMES = Object.keys(SYSTEM_ROLES) as SystemRoleName[];

/** What a permission check needs to know about the caller. */
export interface Actor {
  userId: string;
  permissions: ReadonlySet<string> | readonly string[];
}

/** A resource with an owner, for `*.own` permissions. */
export interface OwnedResource {
  ownerId?: string | null;
}

function has(actor: Actor, permission: string): boolean {
  const p = actor.permissions;
  return Array.isArray(p) ? p.includes(permission) : (p as ReadonlySet<string>).has(permission);
}

/**
 * The single permission check used by server actions, route handlers and UI.
 * Pass the resource when one is involved so `*.own` grants can apply.
 */
export function can(
  actor: Actor | null | undefined,
  permission: CheckablePermission,
  resource?: OwnedResource,
): boolean {
  if (!actor) return false;
  if (has(actor, permission)) return true;
  const own = `${permission}.own`;
  return (
    PERMISSION_SET.has(own) &&
    has(actor, own) &&
    resource?.ownerId != null &&
    resource.ownerId === actor.userId
  );
}
