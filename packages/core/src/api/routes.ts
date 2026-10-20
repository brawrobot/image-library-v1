import { createRouter, json, notFound, type RouteDef } from "./router.ts";

/**
 * Phase 0 routes: enough surface to prove isolation end to end. Phase 1 adds
 * uploads, albums and tags here, and the leak suite picks them up automatically.
 */
export const routes: RouteDef[] = [
  {
    method: "GET",
    path: "/me",
    access: { member: true },
    leak: { none: "returns only the caller's own membership in the host's tenant" },
    async handler({ ctx }) {
      return json({
        user: { id: ctx.user!.id, email: ctx.user!.email, name: ctx.user!.name },
        tenantId: ctx.tenantId,
        role: ctx.membership!.roleName,
        permissions: [...ctx.membership!.permissions].sort(),
      });
    },
  },
  {
    method: "GET",
    path: "/assets",
    access: { permission: "asset.view" },
    leak: { none: "lists the host tenant's own database only" },
    async handler({ db }) {
      const assets = await (await db()).asset.findMany({
        where: { deletedAt: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        select: { id: true, title: true, filename: true, mime: true, status: true, width: true, height: true, createdAt: true },
      });
      return json({ data: assets });
    },
  },
  {
    method: "GET",
    path: "/assets/:id",
    access: { permission: "asset.view" },
    leak: { params: { id: "asset" } },
    async handler({ db, params }) {
      const asset = await (await db()).asset.findFirst({
        where: { id: params.id!, deletedAt: null },
        include: { variants: true, tags: { include: { tag: true } } },
      });
      if (!asset) throw notFound();
      return json({ data: asset });
    },
  },
  {
    method: "GET",
    path: "/tags",
    access: { permission: "asset.view" },
    leak: { none: "lists the host tenant's own database only" },
    async handler({ db }) {
      const tags = await (await db()).tag.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } });
      return json({ data: tags });
    },
  },
  {
    method: "GET",
    path: "/tags/:id",
    access: { permission: "asset.view" },
    leak: { params: { id: "tag" } },
    async handler({ db, params }) {
      const tag = await (await db()).tag.findUnique({ where: { id: params.id! } });
      if (!tag) throw notFound();
      return json({ data: tag });
    },
  },
];

export const apiRouter = createRouter(routes);
