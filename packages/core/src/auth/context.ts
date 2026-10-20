import type { Actor } from "@il/auth/permissions";
import type { ControlDb } from "@il/db";
import { userForHostSession, type SessionUser } from "./sessions.ts";

export interface Membership {
  roleId: string;
  roleName: string;
  permissions: ReadonlySet<string>;
}

/** Who is asking, on which tenant. Built once per request from host + cookie. */
export interface TenantContext {
  tenantId: string;
  host: string;
  user: SessionUser | null;
  /** Active membership in *this* tenant, or null (signed out, invited only, or another tenant's user). */
  membership: Membership | null;
  /** For can(): present only for active members. */
  actor: Actor | null;
}

export async function membershipFor(
  control: ControlDb,
  tenantId: string,
  userId: string,
): Promise<Membership | null> {
  const m = await control.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { status: true, role: { select: { id: true, name: true, permissions: true } } },
  });
  if (!m || m.status !== "active") return null;
  return { roleId: m.role.id, roleName: m.role.name, permissions: new Set(m.role.permissions) };
}

export async function loadTenantContext(
  control: ControlDb,
  input: { tenantId: string; host: string; sessionToken: string | null | undefined },
): Promise<TenantContext> {
  const user = await userForHostSession(control, { sessionToken: input.sessionToken, host: input.host });
  const membership = user ? await membershipFor(control, input.tenantId, user.id) : null;
  return {
    tenantId: input.tenantId,
    host: input.host,
    user,
    membership,
    actor: user && membership ? { userId: user.id, permissions: membership.permissions } : null,
  };
}
