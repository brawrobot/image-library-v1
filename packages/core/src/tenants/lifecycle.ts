import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { SYSTEM_ROLES, SYSTEM_ROLE_NAMES } from "@il/auth/permissions";
import { createTenantDatabase, dropTenantDatabase, type ProvisionerConfig } from "@il/db/admin";
import { isReservedSlug } from "../tenancy/host.ts";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const INVITATION_TTL_DAYS = 7;
export const RESTORE_WINDOW_DAYS = 30;

export class TenantError extends Error {
  constructor(
    readonly code: "invalid_slug" | "slug_taken" | "not_found" | "invalid_state",
    message: string,
  ) {
    super(message);
    this.name = "TenantError";
  }
}

export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new TenantError("invalid_slug", "Slugs are 1–63 lowercase letters, digits and hyphens, not starting or ending with a hyphen");
  }
  if (isReservedSlug(slug)) throw new TenantError("invalid_slug", `"${slug}" is reserved`);
}

export interface TenantAdminDeps extends ProvisionerConfig {
  /** Pool on the control-plane database as `provisioner`. */
  control: pg.Pool;
}

export interface CreateTenantInput {
  slug: string;
  name: string;
  owner: {
    email: string;
    /** "invite" (default) sends an invitation; "direct" makes them Owner now (seeding, tests). */
    mode?: "invite" | "direct";
  };
  actorId?: string | null;
}

export interface CreatedTenant {
  id: string;
  slug: string;
  ownerUserId: string | null;
  /** Raw invitation token to email to the owner (mode "invite" only). */
  invitationToken: string | null;
  roleIds: Record<string, string>;
}

/**
 * Create a tenant end to end: control-plane row, its own database and login
 * role (migrated), default roles, then the owner as a member or invitee.
 * If anything fails, the tenant row and any half-built database are removed.
 */
export async function createTenant(deps: TenantAdminDeps, input: CreateTenantInput): Promise<CreatedTenant> {
  const slug = input.slug.trim().toLowerCase();
  validateSlug(slug);
  const email = input.owner.email.trim().toLowerCase();

  let tenantId: string;
  try {
    const { rows } = await deps.control.query<{ id: string }>(
      "INSERT INTO tenants (slug, name, status) VALUES ($1, $2, 'provisioning') RETURNING id",
      [slug, input.name.trim()],
    );
    tenantId = rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new TenantError("slug_taken", `"${slug}" is taken`);
    throw err;
  }

  try {
    const db = await createTenantDatabase(deps, tenantId);

    const client = await deps.control.connect();
    try {
      await client.query("BEGIN");
      const roleIds: Record<string, string> = {};
      for (const name of SYSTEM_ROLE_NAMES) {
        const { rows } = await client.query<{ id: string }>(
          "INSERT INTO roles (tenant_id, name, permissions, is_system) VALUES ($1, $2, $3, true) RETURNING id",
          [tenantId, name, [...SYSTEM_ROLES[name]]],
        );
        roleIds[name] = rows[0]!.id;
      }

      let ownerUserId: string | null = null;
      let invitationToken: string | null = null;
      if ((input.owner.mode ?? "invite") === "direct") {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (email) VALUES ($1)
           ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
          [email],
        );
        ownerUserId = rows[0]!.id;
        await client.query(
          "INSERT INTO memberships (tenant_id, user_id, role_id, status) VALUES ($1, $2, $3, 'active')",
          [tenantId, ownerUserId, roleIds.Owner],
        );
      } else {
        invitationToken = randomBytes(32).toString("base64url");
        await client.query(
          `INSERT INTO invitations (tenant_id, email, role_id, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
          [
            tenantId,
            email,
            roleIds.Owner,
            createHash("sha256").update(invitationToken).digest("hex"),
            input.actorId ?? null,
            INVITATION_TTL_DAYS,
          ],
        );
      }

      await client.query(
        "UPDATE tenants SET status = 'active', db_ref = $2, schema_version = $3 WHERE id = $1",
        [tenantId, db.dbRef, db.schemaVersion],
      );
      await client.query(
        "INSERT INTO audit_log (tenant_id, actor_id, action, target, metadata) VALUES ($1, $2, 'tenant.create', $3, $4)",
        [tenantId, input.actorId ?? null, `tenant:${tenantId}`, { slug, owner: email }],
      );
      await client.query("COMMIT");
      return { id: tenantId, slug, ownerUserId, invitationToken, roleIds };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    await dropTenantDatabase(deps, tenantId).catch(() => {});
    await deps.control.query("DELETE FROM tenants WHERE id = $1", [tenantId]).catch(() => {});
    throw err;
  }
}

/** Soft delete: the tenant stops resolving at once; its database is kept for the restore window. */
export async function softDeleteTenant(deps: TenantAdminDeps, tenantId: string, actorId?: string | null) {
  const { rowCount } = await deps.control.query(
    "UPDATE tenants SET status = 'deleted', deleted_at = now() WHERE id = $1 AND status <> 'deleted'",
    [tenantId],
  );
  if (!rowCount) throw new TenantError("not_found", "No live tenant with that id");
  await deps.control.query(
    "INSERT INTO audit_log (tenant_id, actor_id, action, target) VALUES ($1, $2, 'tenant.delete', $3)",
    [tenantId, actorId ?? null, `tenant:${tenantId}`],
  );
}

export async function restoreTenant(deps: TenantAdminDeps, tenantId: string, actorId?: string | null) {
  const { rowCount } = await deps.control.query(
    `UPDATE tenants SET status = 'active', deleted_at = NULL
     WHERE id = $1 AND status = 'deleted' AND deleted_at > now() - make_interval(days => $2)`,
    [tenantId, RESTORE_WINDOW_DAYS],
  );
  if (!rowCount) throw new TenantError("invalid_state", "Tenant isn't deleted, or its restore window has passed");
  await deps.control.query(
    "INSERT INTO audit_log (tenant_id, actor_id, action, target) VALUES ($1, $2, 'tenant.restore', $3)",
    [tenantId, actorId ?? null, `tenant:${tenantId}`],
  );
}

/** Drop the databases of tenants deleted more than 30 days ago. Run nightly by the worker. */
export async function purgeDeletedTenants(deps: TenantAdminDeps, now = new Date()): Promise<string[]> {
  const { rows } = await deps.control.query<{ id: string }>(
    `SELECT id FROM tenants
     WHERE status = 'deleted' AND deleted_at < $1::timestamptz - make_interval(days => $2)`,
    [now.toISOString(), RESTORE_WINDOW_DAYS],
  );
  const purged: string[] = [];
  for (const { id } of rows) {
    await dropTenantDatabase(deps, id);
    // Memberships, roles, domains and invitations cascade with the tenant row.
    await deps.control.query("DELETE FROM tenants WHERE id = $1", [id]);
    await deps.control.query(
      "INSERT INTO audit_log (tenant_id, action, target) VALUES ($1, 'tenant.purge', $2)",
      [id, `tenant:${id}`],
    );
    purged.push(id);
  }
  return purged;
}
