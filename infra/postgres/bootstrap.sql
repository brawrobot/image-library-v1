-- Cluster bootstrap. Run once per Postgres cluster as a superuser (or the
-- managed-service admin user). Creates the three platform roles and the
-- control-plane database; everything after this runs as `provisioner`.
--
--   provisioner   CREATEDB + CREATEROLE. Owns the control-plane schema and every
--                 tenant database; runs migrations and provisioning. Never used
--                 by request-serving code.
--   platform_app  The web app's control-plane role: DML on control tables only.
--   platform_ops  Read-only role the admin console uses to look inside tenant
--                 databases. Granted CONNECT per tenant database at provisioning.
--
-- Passwords come from psql variables so the same file serves dev and CI:
--   psql -v provisioner_pw=... -v app_pw=... -v ops_pw=... -f bootstrap.sql

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE provisioner LOGIN CREATEDB CREATEROLE PASSWORD %L', :'provisioner_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'provisioner') \gexec

SELECT format('CREATE ROLE platform_app LOGIN PASSWORD %L', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') \gexec

SELECT format('CREATE ROLE platform_ops LOGIN PASSWORD %L', :'ops_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_ops') \gexec

-- Lets DROP DATABASE ... WITH (FORCE) end open tenant/ops connections.
GRANT pg_signal_backend TO provisioner;

SELECT 'CREATE DATABASE platform OWNER provisioner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'platform') \gexec

-- Nobody connects to the control plane unless granted. Tenant roles never are.
REVOKE CONNECT ON DATABASE platform FROM PUBLIC;
GRANT CONNECT ON DATABASE platform TO platform_app;

-- Tenant roles must not be able to reach databases created from template1 by
-- default either; provisioning revokes PUBLIC CONNECT on each tenant database.
\connect platform
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO provisioner;
GRANT USAGE ON SCHEMA public TO platform_app;
