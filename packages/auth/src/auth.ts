import NextAuth, { type DefaultSession, type NextAuthConfig } from "next-auth";
import type { Provider } from "next-auth/providers";
import Nodemailer from "next-auth/providers/nodemailer";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { authEnvSchema, readEnv } from "@il/config/env";
import { getControlDb } from "@il/db";

/**
 * Auth.js runs on the auth host only (auth.<root>). Its database sessions live
 * in the control plane; tenant hosts get their own sessions via the hand-off
 * in @il/core. Providers switch on when their env vars are present.
 */
function buildConfig(): NextAuthConfig {
  const env = readEnv(authEnvSchema);
  const control = getControlDb();

  const providers: Provider[] = [];
  if (env.EMAIL_SERVER) {
    providers.push(Nodemailer({ server: env.EMAIL_SERVER, from: env.EMAIL_FROM ?? "no-reply@localhost" }));
  }
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    providers.push(Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET }));
  }
  if (env.AUTH_MICROSOFT_ENTRA_ID_ID && env.AUTH_MICROSOFT_ENTRA_ID_SECRET) {
    providers.push(
      MicrosoftEntraID({
        clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID,
        clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
        ...(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER ? { issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER } : {}),
      }),
    );
  }

  return {
    secret: env.AUTH_SECRET,
    trustHost: true,
    // The generated client lives outside @prisma/client, so its type differs nominally.
    adapter: PrismaAdapter(control as unknown as Parameters<typeof PrismaAdapter>[0]),
    session: { strategy: "database", maxAge: 30 * 24 * 60 * 60 },
    providers,
    callbacks: {
      /**
       * Invite-only until the signup-mode setting lands in Phase 2: a person can
       * sign in if they already have an account or a live invitation.
       */
      async signIn({ user }) {
        const email = user.email?.toLowerCase();
        if (!email) return false;
        const existing = await control.user.findUnique({ where: { email }, select: { id: true } });
        if (existing) return true;
        const invite = await control.invitation.findFirst({
          where: { email, acceptedAt: null, expiresAt: { gt: new Date() } },
          select: { id: true },
        });
        return Boolean(invite);
      },
      async session({ session, user }) {
        const row = await control.user.findUnique({ where: { id: user.id }, select: { isSuperAdmin: true } });
        return {
          ...session,
          user: { ...session.user, id: user.id, isSuperAdmin: row?.isSuperAdmin ?? false },
        };
      },
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => buildConfig());

declare module "next-auth" {
  interface Session {
    user: { id: string; isSuperAdmin: boolean } & DefaultSession["user"];
  }
}
