import { type NextRequest } from "next/server";
import { apiRouter, HEADER, json, TENANT_SESSION_COOKIE } from "@il/core";
import { getControlDb, getTenantDb } from "@il/db";

/** Thin shell: the proxy has already resolved the tenant; @il/core does the rest. */
async function handle(request: NextRequest) {
  const tenantId = request.headers.get(HEADER.tenantId);
  const host = request.headers.get(HEADER.host);
  if (request.headers.get(HEADER.hostKind) !== "tenant" || !tenantId || !host) {
    return json({ error: { code: "not_found" } }, { status: 404 });
  }
  const path = request.nextUrl.pathname.replace(/^\/api\/v1/, "") || "/";
  return apiRouter.dispatch(
    {
      request,
      path,
      tenantId,
      host,
      sessionToken: request.cookies.get(TENANT_SESSION_COOKIE)?.value,
    },
    { control: getControlDb(), tenantDb: getTenantDb },
  );
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
