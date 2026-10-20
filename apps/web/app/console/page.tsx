import { getControlDb } from "@il/db";

export const dynamic = "force-dynamic";

/** Phase 0 console: tenant list with status and schema version. Full console is Phase 2. */
export default async function ConsoleHome() {
  const tenants = await getControlDb().tenant.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, slug: true, name: true, status: true, schemaVersion: true, createdAt: true },
  });
  // Newest version any tenant has reached; anything lower means a migration fan-out failed for it.
  const target = Math.max(0, ...tenants.map((t) => t.schemaVersion));

  return (
    <main>
      <h1>Platform admin</h1>
      <p className="muted">
        {tenants.length} tenant{tenants.length === 1 ? "" : "s"} · newest tenant schema v{target}
      </p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Slug</th>
              <th>Name</th>
              <th>Status</th>
              <th>Schema</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id}>
                <td>
                  <code>{t.slug}</code>
                </td>
                <td>{t.name}</td>
                <td>{t.status}</td>
                <td>{t.schemaVersion < target ? `v${t.schemaVersion} (behind)` : `v${t.schemaVersion}`}</td>
                <td>{t.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
