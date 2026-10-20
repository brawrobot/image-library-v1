#!/usr/bin/env bash
# End-to-end check of host resolution through the built Next.js server.
# Expects: databases migrated and seeded (acme, globex) plus a tenant "frozen", ROOT_DOMAIN=yourapp.test,
# and `next start` listening on :3000.
set -uo pipefail

BASE=http://127.0.0.1:3000
fail=0

# check <description> <expected status> <grep pattern or ""> <curl args...>
check() {
  local desc=$1 want=$2 pattern=$3; shift 3
  local status
  status=$(curl -s -o /tmp/smoke.body -w '%{http_code}' "$@")
  if [ "$status" != "$want" ]; then
    echo "::error title=Smoke: ${desc}::expected HTTP ${want}, got ${status}: $(head -c 300 /tmp/smoke.body | tr '\n' ' ')"
    fail=1; return
  fi
  if [ -n "$pattern" ] && ! grep -q -- "$pattern" /tmp/smoke.body; then
    echo "::error title=Smoke: ${desc}::HTTP ${status} but body lacks '${pattern}': $(head -c 300 /tmp/smoke.body | tr '\n' ' ')"
    fail=1; return
  fi
  echo "ok  ${desc} (${status})"
  passed=$((passed + 1))
}
passed=0

# A tenant suspended before anything has looked it up (host lookups are cached for 60 s).
psql "$PROVISIONER_DATABASE_URL" -qc "update tenants set status='suspended' where slug='frozen'"
ACME_ID=$(psql "$PROVISIONER_DATABASE_URL" -tAc "select id from tenants where slug='acme'")
GLOBEX_ID=$(psql "$PROVISIONER_DATABASE_URL" -tAc "select id from tenants where slug='globex'")

check "acme subdomain resolves to Acme"        200 "Acme Ltd"           -H "Host: acme.yourapp.test" "$BASE/"
check "globex subdomain resolves to Globex"    200 "Globex Corporation" -H "Host: globex.yourapp.test" "$BASE/"
check "host match is case-insensitive"         200 "Acme Ltd"           -H "Host: ACME.yourapp.test" "$BASE/"
check "unknown subdomain is 404"               404 "no site"            -H "Host: nobody.yourapp.test" "$BASE/"
check "unknown custom domain is 404"           404 ""                   -H "Host: photos.example.com" "$BASE/"
check "reserved subdomain is 404"              404 ""                   -H "Host: www.yourapp.test" "$BASE/"
check "nested subdomain is 404"                404 ""                   -H "Host: x.acme.yourapp.test" "$BASE/"
check "spoofed tenant header is ignored"       200 "Acme Ltd"           -H "Host: acme.yourapp.test" -H "x-il-tenant-id: ${GLOBEX_ID}" "$BASE/"
check "internal path can't reach other tenant" 404 ""                   -H "Host: acme.yourapp.test" "$BASE/site/${GLOBEX_ID}"
check "tenant API needs a session"             401 "unauthenticated"    -H "Host: acme.yourapp.test" "$BASE/api/v1/me"
check "Auth.js isn't served on tenant hosts"   404 ""                   -H "Host: acme.yourapp.test" "$BASE/api/auth/providers"
check "Auth.js is served on the auth host"     200 ""                   -H "Host: auth.yourapp.test" "$BASE/api/auth/providers"
check "tenant API isn't served on auth host"   404 ""                   -H "Host: auth.yourapp.test" "$BASE/api/v1/me"
check "admin console sends you to sign in"     307 ""                   -H "Host: admin.yourapp.test" "$BASE/"
check "hand-off refuses foreign destinations"  400 ""                   -H "Host: auth.yourapp.test" "$BASE/handoff?to=https%3A%2F%2Fevil.example%2F"

check "suspended tenant shows suspended page"  403 "suspended"          -H "Host: frozen.yourapp.test" "$BASE/"
check "suspended tenant's API is closed"       403 "suspended"          -H "Host: frozen.yourapp.test" "$BASE/api/v1/me"

echo "::notice title=Smoke tests::${passed} passed$([ $fail -ne 0 ] && echo ', some failed')"
exit $fail
