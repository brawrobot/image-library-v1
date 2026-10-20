import { cookies } from "next/headers";
import { loadTenantContext, TENANT_SESSION_COOKIE } from "@il/core";
import { getControlDb } from "@il/db";
import { requestTenant, signInUrl } from "@/lib/platform.ts";

export const dynamic = "force-dynamic";

/** Phase 0 placeholder: proves the host resolved to this tenant and who is signed in. */
export default async function TenantHome({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId, host, origin } = await requestTenant((await params).tenantId);
  const control = getControlDb();
  const tenant = await control.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true, slug: true, schemaVersion: true },
  });
  const ctx = await loadTenantContext(control, {
    tenantId,
    host,
    sessionToken: (await cookies()).get(TENANT_SESSION_COOKIE)?.value,
  });

  return (
    <main>
      <h1>{tenant.name}</h1>
      <p className="muted">
        Resolved from <code>{host}</code> to tenant <code>{tenant.slug}</code>
      </p>
      <div className="card">
        {ctx.user ? (
          <>
            <p>
              Signed in as <strong>{ctx.user.email}</strong>
              {ctx.membership ? ` · ${ctx.membership.roleName}` : " · not a member of this site"}
            </p>
            <form action="/auth/signout" method="post">
              <button type="submit">Sign out</button>
            </form>
          </>
        ) : (
          <p>
            <a href={signInUrl(origin)}>Sign in</a>
          </p>
        )}
      </div>
    </main>
  );
}
