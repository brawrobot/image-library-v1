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

# ── Real sign-in: magic link via Mailpit, hand-off to the tenant and admin hosts ──
R=(--resolve auth.yourapp.test:3000:127.0.0.1 --resolve acme.yourapp.test:3000:127.0.0.1
   --resolve globex.yourapp.test:3000:127.0.0.1 --resolve admin.yourapp.test:3000:127.0.0.1)
AUTH=http://auth.yourapp.test:3000

# sign_in <email> <destination URL> <cookie jar>: runs the whole flow, leaves the jar signed in on the destination.
sign_in() {
  local email=$1 dest=$2 jar=$3
  rm -f "$jar"
  curl -s "${R[@]}" -c "$jar" -b "$jar" "$AUTH/api/auth/csrf" > /tmp/csrf.json
  local csrf; csrf=$(jq -r .csrfToken /tmp/csrf.json)
  local post
  post=$(curl -s "${R[@]}" -c "$jar" -b "$jar" -o /tmp/signin.body -w '%{http_code} %{redirect_url}' \
    --data-urlencode "email=$email" --data-urlencode "csrfToken=$csrf" \
    --data-urlencode "callbackUrl=$AUTH/handoff?to=$(jq -rn --arg u "$dest" '$u|@uri')" \
    "$AUTH/api/auth/signin/nodemailer")
  echo "::notice title=Smoke debug: sign-in POST for $email::$post"
  local link=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    local id; id=$(curl -s "http://localhost:8025/api/v1/messages" | jq -r --arg e "$email" \
      '[.messages[] | select(any(.To[]; (.Address|ascii_downcase) == $e))][0].ID // empty')
    if [ -n "$id" ]; then
      link=$(curl -s "http://localhost:8025/api/v1/message/$id" | jq -r .Text | tr -d '\r' | grep -oE 'https?://[^ ]*callback/nodemailer[^ ]*' | head -1)
      break
    fi
    sleep 1
  done
  if [ -z "$link" ]; then
    echo "::error title=Smoke: magic link for $email::no sign-in email. Mailpit has $(curl -s http://localhost:8025/api/v1/messages | jq -c '[.messages[] | {to: [.To[].Address], subject: .Subject}]' | head -c 400)"
    fail=1; return
  fi
  echo "::notice title=Smoke debug: magic link host::$(echo "$link" | cut -d/ -f3)"
  # Follow redirects by hand so every hop is visible.
  local url=$link hops="" i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    local out; out=$(curl -s "${R[@]}" -c "$jar" -b "$jar" -o /tmp/smoke.final -w '%{http_code} %{redirect_url}' "$url")
    hops="$hops | ${out%% *} $(echo "$url" | cut -c1-90)"
    local next=${out#* }
    [ -z "$next" ] || [ "$next" = "$out" ] && break
    url=$next
  done
  echo "::notice title=Smoke debug: hops for $email::$hops"
  echo "::notice title=Smoke debug: cookies for $email::$(grep -v '^#' "$jar" | awk 'NF>=7 {print $1"="$6}' | tr '\n' ' ')"
}

sign_in owner@acme.test http://acme.yourapp.test:3000/ /tmp/acme.jar
check "magic-link sign-in lands on acme as Owner" 200 "Signed in as" "${R[@]}" -b /tmp/acme.jar http://acme.yourapp.test:3000/
grep -q "Owner" /tmp/smoke.body || { echo "::error title=Smoke: acme role::page doesn't show Owner"; fail=1; }
check "signed-in API call on acme"                200 '"role":"Owner"' "${R[@]}" -b /tmp/acme.jar http://acme.yourapp.test:3000/api/v1/me
check "acme session isn't valid on globex"        200 ">Sign in<"      "${R[@]}" -b /tmp/acme.jar http://globex.yourapp.test:3000/

sign_in admin@lvh.me http://admin.yourapp.test:3000/ /tmp/admin.jar
check "super-admin sees the admin console"        200 "Platform admin" "${R[@]}" -b /tmp/admin.jar http://admin.yourapp.test:3000/
check "tenant owner is refused the console"       200 "Not allowed"    "${R[@]}" -b /tmp/acme.jar -c /tmp/acme2.jar http://admin.yourapp.test:3000/ -L

echo "::notice title=Smoke tests::${passed} passed$([ $fail -ne 0 ] && echo ', some failed')"
exit $fail
