import type { ReactNode } from "react";
import { requestTenant } from "@/lib/platform.ts";

/** Tenant tree: only renders when the proxy resolved this exact tenant from the Host header. */
export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  await requestTenant((await params).tenantId);
  return children;
}
