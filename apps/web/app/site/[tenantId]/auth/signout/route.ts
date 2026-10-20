import type { NextRequest } from "next/server";
import { HEADER } from "@il/core";
import { signOutHost } from "@/lib/signout.ts";

export async function POST(request: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  if (request.headers.get(HEADER.tenantId) !== (await params).tenantId) return new Response(null, { status: 404 });
  return signOutHost(request);
}
