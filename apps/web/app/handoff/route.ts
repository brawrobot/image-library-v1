import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@il/auth";
import { createHandoff, HEADER, normalizeHost, resolveHost } from "@il/core";
import { getControlDb } from "@il/db";
import { protocol, rootDomain, tenantLookup } from "@/lib/hosts.ts";

/**
 * auth.<root>/handoff?to=<absolute URL on a tenant or the admin host>
 * First half of cross-host sign-in: sign in here if needed, then send the user
 * to the target host with a one-time token bound to that host.
 */
export async function GET(request: NextRequest) {
  if (request.headers.get(HEADER.hostKind) !== "auth") return new NextResponse(null, { status: 404 });

  let target: URL;
  try {
    target = new URL(request.nextUrl.searchParams.get("to") ?? "");
  } catch {
    return bad("Missing or invalid destination");
  }
  if (target.protocol !== `${protocol()}:`) return bad("Invalid destination");
  const targetHost = normalizeHost(target.host);
  // Only hosts this platform serves: no open redirect, no tokens sent elsewhere.
  const resolution = await resolveHost(targetHost, rootDomain(), tenantLookup());
  if (resolution.kind !== "tenant" && resolution.kind !== "admin") return bad("Unknown destination");

  const session = await auth();
  if (!session?.user?.id) {
    // Build from the browser's Host header: request.nextUrl carries the server's
    // own listen address (e.g. localhost:3000), not the platform host.
    const origin = `${protocol()}://${request.headers.get("host")}`;
    const back = `${origin}${request.nextUrl.pathname}${request.nextUrl.search}`;
    return NextResponse.redirect(`${origin}/api/auth/signin?callbackUrl=${encodeURIComponent(back)}`, 303);
  }

  const token = await createHandoff(getControlDb(), {
    userId: session.user.id,
    targetHost: targetHost!,
    returnTo: `${target.pathname}${target.search}`,
  });
  const callback = new URL("/auth/callback", target.origin);
  callback.searchParams.set("token", token);
  return NextResponse.redirect(callback, 303);
}

function bad(message: string) {
  return new NextResponse(message, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
}
