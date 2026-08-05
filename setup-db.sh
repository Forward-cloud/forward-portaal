#!/usr/bin/env bash
set -e

DB_USER="forward"
DB_PASS="ForwardDB2026Secret"
DB_NAME="forward"

echo "== 1. Officieel postgres-image ophalen =="
docker pull postgres:16-alpine

echo "== 2. Eventuele oude container opruimen =="
docker rm -f forward-db 2>/dev/null || true

echo "== 3. Database starten =="
docker run -d \
  --name forward-db \
  --restart unless-stopped \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$DB_PASS" \
  -e POSTGRES_DB="$DB_NAME" \
  -v forward-db-data:/var/lib/postgresql/data \
  postgres:16-alpine

echo "== 4. Aansluiten op alle Docker-netwerken =="
for n in $(docker network ls --format '{{.Name}}' | grep -Ev '^(bridge|host|none)$'); do
  docker network connect "$n" forward-db 2>/dev/null || true
done

echo "== 5. Wachten tot de database klaar is =="
for i in $(seq 1 40); do
  if docker exec forward-db pg_isready -U "$DB_USER" >/dev/null 2>&1; then
    echo ">>> Database is KLAAR <<<"
    break
  fi
  sleep 2
done

echo
echo "=========================================="
docker ps --filter name=forward-db --format 'Status: {{.Status}}'
echo "=========================================="
