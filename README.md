# Image Library V1

Multi-tenant image library platform: global admin console plus tenant sites on subdomains and custom domains.
The design lives in the *Image Library Platform — Architecture & Plan* doc; this repo follows its phases.

**Status: Phase 0 (Foundations).** Gate: cross-tenant leak tests green, tenant resolves by host.

## Layout

```
apps/
  web/        Next.js 16 (App Router). proxy.ts resolves every request's host first.
  worker/     BullMQ consumers (Phase 0: nightly purge of deleted tenants)
packages/
  config/     tsconfig base, zod env schemas
  db/         SQL migrations (control + tenant), Prisma schemas, provisioning, tenant client cache
  auth/       Auth.js config, permissions and can()
  core/       host resolution, routing, sessions + cross-host hand-off, tenant API, tenant lifecycle
  storage/    object-storage key helpers (S3 client lands with uploads in Phase 1)
infra/        docker-compose (Postgres, PgBouncer, Redis, Mailpit), Postgres bootstrap
```

## How tenancy works

- **Control plane** (`platform` database): tenants, domains, users, sessions, memberships, roles,
  invitations, platform audit log, encrypted secrets.
- **One database per tenant** (`tenant_<id>`), with its own login role `t_<id>` that has `CONNECT`
  on that database only, and only DML rights there (it owns nothing, so it can't alter tables or turn off RLS).
- Inside each tenant database every table has `tenant_id` and **forced row-level security**.
  `current_tenant_id()` reads the tenant from the login role's own name, so request code never sets it and a
  session `SET` can't change it.
- `tenants.db_ref` names a secret holding the tenant's connection string (AES-256-GCM in the `secrets` table by
  default). On first connect the app checks the database's `tenant_meta` row matches, so a mis-wired secret fails
  instead of serving the wrong tenant.
- **Host resolution** (`packages/core/src/tenancy`): `admin.<root>` → console, `auth.<root>` → sign-in,
  `{slug}.<root>` → tenant, other hosts → verified custom domains, cached 60 s in Redis. The proxy strips any
  client-sent `x-il-*` headers and rewrites tenant pages to `/site/<tenantId>/…`.
- **Sessions are host-bound.** Sign in once on the auth host (Auth.js: magic link, Google, Microsoft); a one-time,
  60-second hand-off token carries the user to the tenant or admin host, which creates its own session.
- **API** (`/api/v1/*`): every route declares how it's leak-tested; the suite in
  `packages/core/test/api-leak.test.ts` runs every route with another tenant's ids and sessions.

Three roles exist per cluster, created by `infra/postgres/bootstrap.sql`:
`provisioner` (CREATEDB, CREATEROLE: migrations and provisioning), `platform_app` (the web app's control-plane
role, DML only) and `platform_ops` (read-only inside tenant databases, for the admin console).

## Running locally

Needs Node 22.12+, pnpm 10 and Docker.

```sh
pnpm install
cp .env.example .env
pnpm stack:up            # Postgres (bootstrapped on first start), PgBouncer, Redis, Mailpit
pnpm db:migrate          # control plane, then every tenant database
pnpm db:seed             # tenants acme + globex, super-admin admin@lvh.me
pnpm dev
```

Then open `http://acme.lvh.me:3000` (lvh.me resolves every subdomain to 127.0.0.1). Sign-in emails land in
Mailpit at `http://localhost:8025`. The admin console is at `http://admin.lvh.me:3000`.

Other commands:

| Command | What it does |
| --- | --- |
| `pnpm tenant:create --slug x --name "X" --owner a@b.com [--direct]` | Provision a tenant (database, role, roles, owner invitation) |
| `pnpm db:migrate [--concurrency 5] [--tenant <id>]` | Migrate control plane, then fan out to tenants that are behind; failures are reported and retried on rerun |
| `pnpm db:drift` | Fail if the Prisma schemas and SQL migrations disagree |
| `pnpm test` | Unit tests, plus isolation and leak tests when the database env vars are set |
| `pnpm typecheck`, `pnpm build` | Across the monorepo |

### Schema changes

SQL files in `packages/db/migrations/{control,tenant}/NNNN_name.sql` are the source of truth. Add a new numbered
file (never edit an applied one; the runner refuses), update the matching `prisma/*/schema.prisma`, and run
`pnpm db:drift`. Every new tenant table needs `tenant_id … DEFAULT current_tenant_id()` plus RLS; the isolation
suite fails if a table in a tenant database lacks forced RLS.

## Not in Phase 0 (by design)

Uploads, variants, search, albums UI (Phase 1); invitation acceptance, member management, 2FA, full console
(Phase 2); sharing, theming, custom-domain verification and TLS (Phase 3). `packages/ui` arrives with the
first real UI in Phase 1.
