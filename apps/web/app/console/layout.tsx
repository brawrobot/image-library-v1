import type { ReactNode } from "react";
import { requireSuperAdmin } from "@/lib/admin.ts";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const gate = await requireSuperAdmin();
  if ("denied" in gate) {
    return (
      <main>
        <h1>Not allowed</h1>
        <p className="muted">{gate.denied.email} isn&apos;t a platform administrator.</p>
      </main>
    );
  }
  return children;
}
