#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

if [ "$POSTGRES_USER" != "renivet_ci" ] || [ "$POSTGRES_DB" != "renivet_ci" ]; then
  echo 'REN2-109 profile only accepts the disposable renivet_ci role and database.' >&2
  exit 2
fi

export PGPASSWORD="$POSTGRES_PASSWORD"
/usr/local/bin/docker-entrypoint.sh postgres &
postgres_pid=$!

cleanup() {
  status=$?
  trap - EXIT INT TERM
  su-exec postgres pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
  wait "$postgres_pid" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM

until pg_isready -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" >/dev/null 2>&1; do
  if ! kill -0 "$postgres_pid" 2>/dev/null; then
    wait "$postgres_pid"
    echo 'Disposable PostgreSQL did not start.' >&2
    exit 1
  fi
  sleep 1
done

export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
export RENIVET_TEST_DATABASE_URL="$DATABASE_URL"
export RENIVET_LOAD_PROFILE=1
export RENIVET_LOAD_PROFILE_REQUIRE_LIMITS=1

npm run db:migrate
node scripts/ren2-109-load-profile.cjs
node --test tests/brand-access-schema.integration.cjs tests/brand-access.integration.test.cjs \
  tests/w2/import-preview.integration.test.cjs tests/w2/media-zip-import.integration.test.cjs \
  tests/w2/product-media.integration.test.cjs tests/w2/product-read.integration.test.cjs

remaining=$(psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname LIKE 'ren2_109_%'")
if [ "$remaining" != "0" ]; then
  echo 'REN2-109 temporary profile databases remain after the run.' >&2
  exit 1
fi
