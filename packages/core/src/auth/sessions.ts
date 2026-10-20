import { createHash, randomBytes } from "node:crypto";
import type { ControlDb } from "@il/db";

/**
 * Sessions across hosts. Cookies are host-scoped, so a custom domain can't see
 * a cookie set on auth.<root>. Sign-in happens once on the auth host (Auth.js);
 * a one-time hand-off token then carries the user to the tenant host, which
 * creates its own session row bound to that host and sets its own cookie.
 */

export const TENANT_SESSION_COOKIE = "il_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const HANDOFF_TTL_SECONDS = 60;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");

/** Only same-site relative paths survive; anything else becomes "/". */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

export async function createHandoff(
  control: ControlDb,
  input: { userId: string; targetHost: string; returnTo?: string | null },
): Promise<string> {
  const raw = token();
  await control.handoffToken.create({
    data: {
      tokenHash: sha256(raw),
      userId: input.userId,
      targetHost: input.targetHost,
      returnTo: safeReturnTo(input.returnTo),
      expiresAt: new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000),
    },
  });
  return raw;
}

export interface HostSession {
  sessionToken: string;
  expires: Date;
  returnTo: string;
}

/**
 * Redeem a hand-off token on the host it was issued for. Single use: the
 * conditional update means two concurrent redemptions can't both succeed.
 */
export async function redeemHandoff(
  control: ControlDb,
  input: { token: string; host: string },
): Promise<HostSession | null> {
  const tokenHash = sha256(input.token);
  const now = new Date();
  const claimed = await control.handoffToken.updateMany({
    where: { tokenHash, targetHost: input.host, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) return null;
  const handoff = await control.handoffToken.findUniqueOrThrow({ where: { tokenHash } });

  const sessionToken = token();
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await control.session.create({
    data: { sessionToken, userId: handoff.userId, expires, host: input.host },
  });
  return { sessionToken, expires, returnTo: handoff.returnTo };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  isSuperAdmin: boolean;
}

/** The user behind a tenant-host session cookie, if it is live and belongs to this host. */
export async function userForHostSession(
  control: ControlDb,
  input: { sessionToken: string | null | undefined; host: string },
): Promise<SessionUser | null> {
  if (!input.sessionToken) return null;
  const session = await control.session.findUnique({
    where: { sessionToken: input.sessionToken },
    select: {
      expires: true,
      host: true,
      user: { select: { id: true, email: true, name: true, isSuperAdmin: true } },
    },
  });
  if (!session || session.expires <= new Date() || session.host !== input.host) return null;
  return session.user;
}

export async function endHostSession(control: ControlDb, sessionToken: string): Promise<void> {
  await control.session.deleteMany({ where: { sessionToken } });
}
