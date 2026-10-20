#!/usr/bin/env bash
# docker-entrypoint-initdb.d hook: runs bootstrap.sql once, on first start.
set -euo pipefail
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname postgres \
  -v provisioner_pw="${PROVISIONER_PASSWORD:-provisioner}" \
  -v app_pw="${PLATFORM_APP_PASSWORD:-platform_app}" \
  -v ops_pw="${PLATFORM_OPS_PASSWORD:-platform_ops}" \
  -f /bootstrap/bootstrap.sql
