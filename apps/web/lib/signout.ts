import "server-only";
import { NextResponse } from "next/server";
import { endHostSession, TENANT_SESSION_COOKIE } from "@il/core";
import { getControlDb } from "@il/db";
import { protocol } from "./hosts.ts";

/** End this host's session only; the auth host and other hosts keep theirs. */
export async function signOutHost(request: Request & { cookies: { get(name: string): { value: string } | undefined } }) {
  const token = request.cookies.get(TENANT_SESSION_COOKIE)?.value;
  if (token) await endHostSession(getControlDb(), token);
  const res = NextResponse.redirect(`${protocol()}://${request.headers.get("host")}/`, 303);
  res.cookies.delete(TENANT_SESSION_COOKIE);
  return res;
}
