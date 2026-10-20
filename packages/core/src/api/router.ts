import { can, type CheckablePermission } from "@il/auth/permissions";
import type { ControlDb, TenantDb } from "@il/db";
import { loadTenantContext, type TenantContext } from "../auth/context.ts";

/**
 * The tenant REST API (`/api/v1/*`). Route handlers in Next.js are a thin
 * shell around `dispatch`, which is what the cross-tenant leak tests exercise.
 *
 * Every route must say how it is leak-tested: which path params name a tenant
 * resource (the tests substitute another tenant's id and expect 404), or
 * `leak: "none"` with a reason. A route without the declaration doesn't type-check.
 */

export type ResourceKind = "asset" | "album" | "tag" | "share";

export type Access =
  /** Any active member of the tenant. */
  | { member: true }
  /** Active member with this permission. */
  | { permission: CheckablePermission };

export interface HandlerArgs {
  ctx: TenantContext & { actor: NonNullable<TenantContext["actor"]> };
  params: Record<string, string>;
  request: Request;
  db: () => Promise<TenantDb>;
}

export interface RouteDef {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** e.g. "/assets/:id" (relative to /api/v1). */
  path: string;
  access: Access;
  leak: { params: Partial<Record<string, ResourceKind>> } | { none: string };
  handler(args: HandlerArgs): Promise<Response>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const notFound = () => new ApiError(404, "not_found");

/** JSON with BigInt and Date support. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  return new Response(text, {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
  });
}

const errorBody = (code: string, message?: string) => ({ error: { code, ...(message ? { message } : {}) } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CompiledRoute {
  def: RouteDef;
  regex: RegExp;
  names: string[];
}

function compile(def: RouteDef): CompiledRoute {
  const names: string[] = [];
  const pattern = def.path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        names.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { def, regex: new RegExp(`^${pattern}/?$`), names };
}

export interface DispatchDeps {
  control: ControlDb;
  tenantDb: (tenantId: string) => Promise<TenantDb>;
}

export interface DispatchInput {
  request: Request;
  /** Path after /api/v1, starting with "/". */
  path: string;
  tenantId: string;
  host: string;
  sessionToken: string | null | undefined;
}

export function createRouter(routes: RouteDef[]) {
  const compiled = routes.map(compile);

  return {
    routes,
    async dispatch(input: DispatchInput, deps: DispatchDeps): Promise<Response> {
      try {
        const candidates = compiled
          .map((c) => ({ c, m: c.regex.exec(input.path) }))
          .filter((x): x is { c: CompiledRoute; m: RegExpExecArray } => x.m !== null);
        if (candidates.length === 0) throw notFound();
        const hit = candidates.find((x) => x.c.def.method === input.request.method);
        if (!hit) {
          return json(errorBody("method_not_allowed"), {
            status: 405,
            headers: { allow: candidates.map((x) => x.c.def.method).join(", ") },
          });
        }
        const params = Object.fromEntries(hit.c.names.map((n, i) => [n, decodeURIComponent(hit.m[i + 1]!)]));

        const ctx = await loadTenantContext(deps.control, input);
        if (!ctx.user) throw new ApiError(401, "unauthenticated");
        // Signed in, but not a member here: indistinguishable from "no such thing".
        if (!ctx.actor) throw notFound();
        const access = hit.c.def.access;
        if ("permission" in access && !can(ctx.actor, access.permission)) {
          throw new ApiError(403, "forbidden");
        }
        // Resource ids are UUIDs; anything else can't exist.
        const leak = hit.c.def.leak;
        if ("params" in leak) {
          for (const name of Object.keys(leak.params)) {
            if (!UUID.test(params[name] ?? "")) throw notFound();
          }
        }

        let db: Promise<TenantDb> | undefined;
        return await hit.c.def.handler({
          ctx: ctx as HandlerArgs["ctx"],
          params,
          request: input.request,
          db: () => (db ??= deps.tenantDb(input.tenantId)),
        });
      } catch (err) {
        if (err instanceof ApiError) {
          return json(errorBody(err.code, err.message !== err.code ? err.message : undefined), {
            status: err.status,
          });
        }
        console.error("api error", err);
        return json(errorBody("internal"), { status: 500 });
      }
    },
  };
}
