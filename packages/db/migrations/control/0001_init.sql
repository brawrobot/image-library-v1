-- Control-plane database (`platform`): tenants, identity and tenant access.
-- Runs as `provisioner`. Constraint and index names follow Prisma's
-- conventions so `pnpm db:drift` can diff this against prisma/control.

CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid AS $$
BEGIN
  -- 48-bit unix ms timestamp over a random v4 uuid, then flip version 4 -> 7.
  RETURN encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
        PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
        FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid;
END
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- ── Tenants ──────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id             uuid        NOT NULL DEFAULT uuid_generate_v7(),
  slug           text        NOT NULL,
  name           text        NOT NULL,
  status         text        NOT NULL DEFAULT 'provisioning',
  theme          jsonb       NOT NULL DEFAULT '{}',
  settings       jsonb       NOT NULL DEFAULT '{}',
  -- Name of the secret holding this tenant's runtime connection string.
  db_ref         text,
  -- Highest tenant migration applied to this tenant's database.
  schema_version integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT tenants_pkey PRIMARY KEY (id),
  CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  CONSTRAINT tenants_status_check CHECK (status IN ('provisioning', 'active', 'suspended', 'deleted'))
);
CREATE UNIQUE INDEX tenants_slug_key ON tenants (slug);
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE domains (
  id                 uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id          uuid        NOT NULL,
  hostname           text        NOT NULL,
  verification_token text        NOT NULL,
  verified_at        timestamptz,
  is_primary         boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domains_pkey PRIMARY KEY (id),
  CONSTRAINT domains_hostname_lowercase CHECK (hostname = lower(hostname))
);
CREATE UNIQUE INDEX domains_hostname_key ON domains (hostname);
CREATE INDEX domains_tenant_id_idx ON domains (tenant_id);
ALTER TABLE domains ADD CONSTRAINT domains_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Identity (Auth.js adapter tables) ────────────────────────────────────

CREATE TABLE users (
  id             uuid        NOT NULL DEFAULT uuid_generate_v7(),
  email          text        NOT NULL,
  email_verified timestamptz,
  name           text,
  avatar_url     text,
  is_super_admin boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE accounts (
  id                  uuid    NOT NULL DEFAULT uuid_generate_v7(),
  user_id             uuid    NOT NULL,
  type                text    NOT NULL,
  provider            text    NOT NULL,
  provider_account_id text    NOT NULL,
  refresh_token       text,
  access_token        text,
  expires_at          integer,
  token_type          text,
  scope               text,
  id_token            text,
  session_state       text,
  CONSTRAINT accounts_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX accounts_provider_provider_account_id_key ON accounts (provider, provider_account_id);
CREATE INDEX accounts_user_id_idx ON accounts (user_id);
ALTER TABLE accounts ADD CONSTRAINT accounts_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE;

-- Sessions are host-scoped: Auth.js sessions live on the auth host; each
-- tenant host gets its own session row via the one-time hand-off.
CREATE TABLE sessions (
  id            uuid        NOT NULL DEFAULT uuid_generate_v7(),
  session_token text        NOT NULL,
  user_id       uuid        NOT NULL,
  expires       timestamptz NOT NULL,
  host          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX sessions_session_token_key ON sessions (session_token);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
ALTER TABLE sessions ADD CONSTRAINT sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE verification_tokens (
  identifier text        NOT NULL,
  token      text        NOT NULL,
  expires    timestamptz NOT NULL,
  CONSTRAINT verification_tokens_pkey PRIMARY KEY (identifier, token)
);

-- One-time tokens that carry a signed-in user from the auth host to a tenant host.
CREATE TABLE handoff_tokens (
  token_hash  text        NOT NULL,
  user_id     uuid        NOT NULL,
  target_host text        NOT NULL,
  return_to   text        NOT NULL DEFAULT '/',
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handoff_tokens_pkey PRIMARY KEY (token_hash)
);
CREATE INDEX handoff_tokens_user_id_idx ON handoff_tokens (user_id);
ALTER TABLE handoff_tokens ADD CONSTRAINT handoff_tokens_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Tenant access ────────────────────────────────────────────────────────

CREATE TABLE roles (
  id          uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id   uuid        NOT NULL,
  name        text        NOT NULL,
  permissions text[]      NOT NULL DEFAULT '{}',
  is_system   boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX roles_tenant_id_name_key ON roles (tenant_id, name);
-- Lets memberships and invitations require their role to be from the same tenant.
CREATE UNIQUE INDEX roles_id_tenant_id_key ON roles (id, tenant_id);
ALTER TABLE roles ADD CONSTRAINT roles_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE memberships (
  id         uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id  uuid        NOT NULL,
  user_id    uuid        NOT NULL,
  role_id    uuid        NOT NULL,
  status     text        NOT NULL DEFAULT 'invited',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_pkey PRIMARY KEY (id),
  CONSTRAINT memberships_status_check CHECK (status IN ('invited', 'active'))
);
CREATE UNIQUE INDEX memberships_tenant_id_user_id_key ON memberships (tenant_id, user_id);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);
ALTER TABLE memberships ADD CONSTRAINT memberships_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE memberships ADD CONSTRAINT memberships_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_id_tenant_id_fkey
  FOREIGN KEY (role_id, tenant_id) REFERENCES roles (id, tenant_id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE invitations (
  id          uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id   uuid        NOT NULL,
  email       text        NOT NULL,
  role_id     uuid        NOT NULL,
  token_hash  text        NOT NULL,
  invited_by  uuid,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX invitations_token_hash_key ON invitations (token_hash);
CREATE INDEX invitations_tenant_id_idx ON invitations (tenant_id);
ALTER TABLE invitations ADD CONSTRAINT invitations_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_id_tenant_id_fkey
  FOREIGN KEY (role_id, tenant_id) REFERENCES roles (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Platform audit, jobs, secrets ────────────────────────────────────────

CREATE TABLE audit_log (
  id         uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id  uuid,
  actor_id   uuid,
  action     text        NOT NULL,
  target     text,
  metadata   jsonb       NOT NULL DEFAULT '{}',
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_pkey PRIMARY KEY (id)
);
CREATE INDEX audit_log_tenant_id_created_at_idx ON audit_log (tenant_id, created_at);

CREATE TABLE jobs (
  id         uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id  uuid,
  type       text        NOT NULL,
  payload    jsonb       NOT NULL DEFAULT '{}',
  status     text        NOT NULL DEFAULT 'queued',
  attempts   integer     NOT NULL DEFAULT 0,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_pkey PRIMARY KEY (id)
);
CREATE INDEX jobs_status_created_at_idx ON jobs (status, created_at);
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Dev/default secret store: values encrypted with AES-256-GCM (SECRETS_KEY).
-- Swap for AWS Secrets Manager / Vault in production without schema changes elsewhere.
CREATE TABLE secrets (
  name       text        NOT NULL,
  value_enc  text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT secrets_pkey PRIMARY KEY (name)
);
CREATE TRIGGER secrets_updated_at BEFORE UPDATE ON secrets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Audit log is append-only for the app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app;
REVOKE UPDATE, DELETE ON audit_log FROM platform_app;
REVOKE ALL ON secrets FROM platform_app;
GRANT SELECT ON secrets TO platform_app;
