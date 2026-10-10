#!/usr/bin/env bash
# Etapa 50: Postgres prod e homolog, roles mcp_admin e banco mcp_control.
# Senhas geradas aqui direto para Docker secrets; nunca impressas (lições L1, L9).
# Re-deploy com o mesmo arquivo não reinicia o Postgres.
# shellcheck source=install/lib.sh
source "$(dirname "$0")/lib.sh"

STACKS_DIR="${STACKS_DIR:-$(cd "$(dirname "$0")/../stacks" && pwd)}"

require_root
load_env

# psql como superuser via socket local do container (sem senha em argumento).
pg_sql() {
  local cid
  cid="$(service_container "$1_postgres")"
  [ -n "$cid" ] || fail "container de $1_postgres não está rodando"
  docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -qtAX -U postgres -d "${2:-postgres}"
}

wait_ready() {
  local cid
  for _ in $(seq 1 60); do
    cid="$(service_container "$1_postgres")"
    if [ -n "$cid" ] && docker exec "$cid" pg_isready -U postgres >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  fail "$1 não ficou pronto em 120 s"
}

# Cria a role com senha nova se ainda não existir. A senha vai pelo stdin do
# psql e para o secret; nunca para argumento de processo nem para a tela.
ensure_role() {
  local stack="$1" role="$2" attrs="$3" secret="$4" pw
  if [ "$(echo "SELECT 1 FROM pg_roles WHERE rolname='$role'" | pg_sql "$stack")" = "1" ]; then
    docker secret inspect "$secret" >/dev/null 2>&1 \
      || fail "role $role existe em $stack mas o secret $secret sumiu; use ops/rotate" "$EXIT_PRECONDITION"
    return 0
  fi
  docker secret inspect "$secret" >/dev/null 2>&1 \
    && fail "secret $secret existe mas a role $role não; apague o secret e rode de novo" "$EXIT_PRECONDITION"
  pw="$(openssl rand -hex 24)"
  printf "CREATE ROLE %s LOGIN %s PASSWORD '%s';\n" "$role" "$attrs" "$pw" | pg_sql "$stack"
  printf '%s' "$pw" | docker secret create "$secret" - >/dev/null
}

for env in prod homolog; do
  create_random_secret "pg_${env}_superuser_pw" 32 || true
  docker stack deploy -c "$STACKS_DIR/pg-$env.yml" "pg-$env" >/dev/null
done
wait_ready pg-prod
wait_ready pg-homolog

ensure_role pg-prod mcp_admin "CREATEDB CREATEROLE NOSUPERUSER" mcp_admin_pw_prod
ensure_role pg-homolog mcp_admin "CREATEDB CREATEROLE NOSUPERUSER" mcp_admin_pw_homolog
ensure_role pg-prod mcp_control_rw "NOSUPERUSER NOCREATEDB NOCREATEROLE" mcp_control_rw_pw
if [ "$(echo "SELECT 1 FROM pg_database WHERE datname='mcp_control'" | pg_sql pg-prod)" != "1" ]; then
  echo "CREATE DATABASE mcp_control OWNER mcp_control_rw;" | pg_sql pg-prod
fi

register_consumer mcp_admin_pw_prod db-mcp db-mcp mcp_admin
register_consumer mcp_admin_pw_homolog db-mcp db-mcp mcp_admin
register_consumer mcp_control_rw_pw db-mcp db-mcp mcp_control_rw

# Verificação
for env in prod homolog; do
  docker service inspect "pg-${env}_postgres" --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}' \
    | grep -q 'POSTGRES_PASSWORD=' && fail "pg-$env com senha em texto na env (lição L1)"
  [ "$(echo "SELECT rolsuper FROM pg_roles WHERE rolname='mcp_admin'" | pg_sql "pg-$env")" = "f" ] \
    || fail "mcp_admin em pg-$env não pode ser superuser"
done
mark_done 50-postgres
ok "etapa 50 concluída"
