import { HEADER } from "@il/core";
import { completeHandoff } from "@/lib/handoff-callback.ts";

export async function GET(request: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const host = request.headers.get(HEADER.host);
  if (request.headers.get(HEADER.tenantId) !== tenantId || !host) return new Response(null, { status: 404 });
  return completeHandoff(request, host, request.headers.get("host")!);
}
