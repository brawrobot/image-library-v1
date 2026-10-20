-- Tenant database (`tenant_<id>`): one per tenant, the image library itself.
-- Runs as `provisioner` (the owner); the tenant's own login role only gets DML.
--
-- Isolation inside this database (the second guard behind per-tenant logins):
--   * every table carries tenant_id, defaulted from current_tenant_id()
--   * for the tenant's login role (`t_<32 hex>`), current_tenant_id() is read
--     from the role name itself, so request code never sets it and a session
--     `SET app.tenant_id` can't change it; other roles (the provisioner running
--     migrations) fall back to the `app.tenant_id` setting
--   * FORCE ROW LEVEL SECURITY: rows whose tenant_id differs are invisible and
--     can't be written, even by the table owner
--   * platform_ops gets a read-only policy for the admin console

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid AS $$
BEGIN
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

-- The tenant this connection acts for, or NULL when unknown.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT CASE
    WHEN current_user ~ '^t_[0-9a-f]{32}$' THEN substring(current_user FROM 3)::uuid
    ELSE NULLIF(current_setting('app.tenant_id', true), '')::uuid
  END
$$ LANGUAGE sql STABLE;

-- Single row identifying which tenant this database belongs to. The app checks
-- it on first connect, so a mis-wired connection string fails loudly.
CREATE TABLE tenant_meta (
  tenant_id  uuid        NOT NULL DEFAULT current_tenant_id(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_meta_pkey PRIMARY KEY (tenant_id)
);

CREATE TABLE assets (
  id             uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT current_tenant_id(),
  uploader_id    uuid        NOT NULL,
  storage_key    text        NOT NULL,
  filename       text        NOT NULL,
  mime           text        NOT NULL,
  bytes          bigint      NOT NULL DEFAULT 0,
  width          integer,
  height         integer,
  sha256         text        NOT NULL,
  status         text        NOT NULL DEFAULT 'uploading',
  title          text,
  description    text,
  alt_text       text,
  exif           jsonb,
  taken_at       timestamptz,
  blurhash       text,
  dominant_color text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT assets_pkey PRIMARY KEY (id),
  CONSTRAINT assets_status_check CHECK (status IN ('uploading', 'processing', 'ready', 'failed'))
);
CREATE UNIQUE INDEX assets_tenant_id_sha256_key ON assets (tenant_id, sha256);
CREATE INDEX assets_tenant_id_created_at_idx ON assets (tenant_id, created_at);
CREATE TRIGGER assets_updated_at BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE asset_variants (
  id          uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id   uuid        NOT NULL DEFAULT current_tenant_id(),
  asset_id    uuid        NOT NULL,
  kind        text        NOT NULL,
  format      text        NOT NULL,
  storage_key text        NOT NULL,
  width       integer     NOT NULL,
  height      integer     NOT NULL,
  bytes       bigint      NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_variants_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX asset_variants_asset_id_kind_format_key ON asset_variants (asset_id, kind, format);
ALTER TABLE asset_variants ADD CONSTRAINT asset_variants_asset_id_fkey
  FOREIGN KEY (asset_id) REFERENCES assets (id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE albums (
  id             uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT current_tenant_id(),
  parent_id      uuid,
  title          text        NOT NULL,
  slug           text        NOT NULL,
  cover_asset_id uuid,
  visibility     text        NOT NULL DEFAULT 'private',
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT albums_pkey PRIMARY KEY (id),
  CONSTRAINT albums_visibility_check CHECK (visibility IN ('private', 'tenant', 'public'))
);
CREATE UNIQUE INDEX albums_tenant_id_slug_key ON albums (tenant_id, slug);
CREATE INDEX albums_parent_id_idx ON albums (parent_id);
ALTER TABLE albums ADD CONSTRAINT albums_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES albums (id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE albums ADD CONSTRAINT albums_cover_asset_id_fkey
  FOREIGN KEY (cover_asset_id) REFERENCES assets (id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TRIGGER albums_updated_at BEFORE UPDATE ON albums
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE album_assets (
  album_id  uuid             NOT NULL,
  asset_id  uuid             NOT NULL,
  tenant_id uuid             NOT NULL DEFAULT current_tenant_id(),
  position  double precision NOT NULL,
  added_at  timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT album_assets_pkey PRIMARY KEY (album_id, asset_id)
);
CREATE INDEX album_assets_asset_id_idx ON album_assets (asset_id);
ALTER TABLE album_assets ADD CONSTRAINT album_assets_album_id_fkey
  FOREIGN KEY (album_id) REFERENCES albums (id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE album_assets ADD CONSTRAINT album_assets_asset_id_fkey
  FOREIGN KEY (asset_id) REFERENCES assets (id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE tags (
  id         uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id  uuid        NOT NULL DEFAULT current_tenant_id(),
  name       text        NOT NULL,
  slug       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX tags_tenant_id_slug_key ON tags (tenant_id, slug);

CREATE TABLE asset_tags (
  asset_id  uuid NOT NULL,
  tag_id    uuid NOT NULL,
  tenant_id uuid NOT NULL DEFAULT current_tenant_id(),
  CONSTRAINT asset_tags_pkey PRIMARY KEY (asset_id, tag_id)
);
CREATE INDEX asset_tags_tag_id_idx ON asset_tags (tag_id);
ALTER TABLE asset_tags ADD CONSTRAINT asset_tags_asset_id_fkey
  FOREIGN KEY (asset_id) REFERENCES assets (id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE asset_tags ADD CONSTRAINT asset_tags_tag_id_fkey
  FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE share_links (
  id             uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT current_tenant_id(),
  target_type    text        NOT NULL,
  target_id      uuid        NOT NULL,
  token          text        NOT NULL,
  password_hash  text,
  expires_at     timestamptz,
  allow_download boolean     NOT NULL DEFAULT false,
  show_exif      boolean     NOT NULL DEFAULT false,
  view_count     integer     NOT NULL DEFAULT 0,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  CONSTRAINT share_links_pkey PRIMARY KEY (id),
  CONSTRAINT share_links_target_type_check CHECK (target_type IN ('asset', 'album'))
);
CREATE UNIQUE INDEX share_links_token_key ON share_links (token);
CREATE INDEX share_links_target_type_target_id_idx ON share_links (target_type, target_id);

CREATE TABLE audit_log (
  id         uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id  uuid        NOT NULL DEFAULT current_tenant_id(),
  actor_id   uuid,
  action     text        NOT NULL,
  target     text,
  metadata   jsonb       NOT NULL DEFAULT '{}',
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_pkey PRIMARY KEY (id)
);
CREATE INDEX audit_log_created_at_idx ON audit_log (created_at);

CREATE TABLE jobs (
  id         uuid        NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id  uuid        NOT NULL DEFAULT current_tenant_id(),
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

-- ── Row-level security on every tenant table ─────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_meta', 'assets', 'asset_variants', 'albums', 'album_assets',
    'tags', 'asset_tags', 'share_links', 'audit_log', 'jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t);
    EXECUTE format('CREATE POLICY ops_read ON %I FOR SELECT TO platform_ops USING (true)', t);
  END LOOP;
END
$$;
