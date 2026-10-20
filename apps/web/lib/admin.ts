import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TENANT_SESSION_COOKIE, userForHostSession, type SessionUser } from "@il/core";
import { getControlDb } from "@il/db";
import { requestPlatformHost, signInUrl } from "./platform.ts";

/**
 * Admin console gate: a live session on the admin host belonging to a
 * super-admin. Signed-out visitors go through the central sign-in.
 * (Required TOTP for super-admins lands with 2FA in Phase 2.)
 */
export async function requireSuperAdmin(): Promise<{ user: SessionUser; host: string } | { denied: SessionUser }> {
  const { host, origin } = await requestPlatformHost("admin");
  const user = await userForHostSession(getControlDb(), {
    sessionToken: (await cookies()).get(TENANT_SESSION_COOKIE)?.value,
    host,
  });
  if (!user) redirect(signInUrl(origin));
  if (!user.isSuperAdmin) return { denied: user };
  return { user, host };
}
