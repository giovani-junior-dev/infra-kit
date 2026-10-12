#!/usr/bin/env bash
# Etapa 60: PG Back Web com banco próprio no pg-prod, sem porta publicada.
# Agenda o backup local diário do prod direto no banco do painel; R2 é opcional, pelo painel.
# shellcheck source=install/lib.sh
source "$(dirname "$0")/lib.sh"

STACKS_DIR="${STACKS_DIR:-$(cd "$(dirname "$0")/../stacks" && pwd)}"

require_root
load_env
require_var KIT_DOMAIN
step_done 50-postgres || fail "rode a etapa 50 antes" "$EXIT_PRECONDITION"

pg_prod() {
  docker exec -i "$(service_container pg-prod_postgres)" psql -v ON_ERROR_STOP=1 -qtAX -U postgres
}

create_random_secret pbw_encryption_key 32 || true

if ! docker secret inspect pbw_conn_string >/dev/null 2>&1; then
  if [ "$(echo "SELECT 1 FROM pg_roles WHERE rolname='pgbackweb'" | pg_prod)" = "1" ]; then
    fail "role pgbackweb existe mas o secret pbw_conn_string sumiu" "$EXIT_PRECONDITION"
  fi
  pw="$(openssl rand -hex 24)"
  printf "CREATE ROLE pgbackweb LOGIN PASSWORD '%s';\n" "$pw" | pg_prod
  printf 'postgresql://pgbackweb:%s@pg-prod_postgres:5432/pgbackweb?sslmode=disable' "$pw" \
    | docker secret create pbw_conn_string - >/dev/null
  unset pw
fi
if [ "$(echo "SELECT 1 FROM pg_database WHERE datname='pgbackweb'" | pg_prod)" != "1" ]; then
  echo "CREATE DATABASE pgbackweb OWNER pgbackweb;" | pg_prod
fi
register_consumer pbw_conn_string pgbackweb pgbackweb pgbackweb

docker stack deploy -c "$STACKS_DIR/pgbackweb.yml" pgbackweb >/dev/null
wait_service_running pgbackweb_pgbackweb
# Backup local diário do banco padrão do prod; bancos novos entram pelo
# new-project.sh grant <banco>@prod.
pbw_register_prod_db postgres

# Verificação
docker service inspect pgbackweb_pgbackweb >/dev/null || fail "serviço pgbackweb não subiu"
mark_done 60-backups
ok "etapa 60 concluída: https://pgbackweb.$KIT_DOMAIN"
log "backup local diário às 03:00 já agendado; destino R2 (opcional) no painel (docs/02-cloudflare.md)"
log "depois do 1º backup: install/ops/restore-test.sh --db <banco> --file <dump>"
