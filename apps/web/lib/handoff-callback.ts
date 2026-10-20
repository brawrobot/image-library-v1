import "server-only";
import { NextResponse } from "next/server";
import { redeemHandoff, TENANT_SESSION_COOKIE } from "@il/core";
import { getControlDb } from "@il/db";
import { protocol } from "./hosts.ts";

/**
 * Second half of the cross-host sign-in: redeem the one-time token on the host
 * it was issued for and set that host's own session cookie.
 */
export async function completeHandoff(request: Request, host: string, displayHost: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const origin = `${protocol()}://${displayHost}`;
  if (!token) return NextResponse.redirect(`${origin}/`, 303);

  const session = await redeemHandoff(getControlDb(), { token, host });
  if (!session) {
    return new NextResponse("This sign-in link has expired or was already used. Go back and sign in again.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const res = NextResponse.redirect(`${origin}${session.returnTo}`, 303);
  res.cookies.set(TENANT_SESSION_COOKIE, session.sessionToken, {
    httpOnly: true,
    secure: protocol() === "https",
    sameSite: "lax",
    path: "/",
    expires: session.expires,
  });
  return res;
}
