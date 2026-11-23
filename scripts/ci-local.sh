#!/usr/bin/env bash
# Local CI: clean install, typecheck, integration tests, production build.
# Tests need a Redis REST endpoint: UPSTASH_REDIS_REST_URL/TOKEN in .env.local,
# or `docker compose up -d` and the SRH values from docker-compose.yml.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
echo "ci-local: all green"
