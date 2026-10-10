#!/usr/bin/env bash
# Passos do dono que o db-mcp não faz pelo agente (de propósito):
#   grant <banco>@<env> [client_id] libera o alvo para o agente (mcp_control.agents;
#                                  padrão: KIT_CF_SERVICE_TOKEN_CLIENT_ID do kit.env)
#   app-secret <banco>@<env>       grava a connection string da role _rw num
#                                  Docker secret app_<banco>_<env>_dsn, para o app
# Uso: sudo install/ops/new-project.sh grant loja@hml
#      sudo install/ops/new-project.sh app-secret loja@prod
# A connection string nunca aparece na tela: sai decifrada de dentro do
# container do db-mcp direto para o `docker secret create`.
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

DBMCP_SERVICE="${DBMCP_SERVICE:-db-mcp_db-mcp}"

usage() {
  cat >&2 <<'EOF'
uso: new-project.sh grant <banco>@<hml|prod> [client_id]   (padrão: KIT_CF_SERVICE_TOKEN_CLIENT_ID)
     new-project.sh app-secret <banco>@<hml|prod>
EOF
}

valid_ref() { [[ "$1" =~ ^[a-z][a-z0-9_]{1,40}@(hml|prod)$ ]]; }
valid_agent() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]; }

# Uso: parse_args "$@" → "grant <ref> <agente>" | "app-secret <ref>"; inválido sai com 2.
parse_args() {
  case "${1:-}" in
    grant)
      if ! { [ "$#" -ge 2 ] && [ "$#" -le 3 ] && valid_ref "$2" && valid_agent "${3:-padrao}"; }; then
        usage; return "$EXIT_CONFIG"
      fi
      echo "grant $2 ${3:-}" ;;
    app-secret)
      if ! { [ "$#" -eq 2 ] && valid_ref "$2"; }; then usage; return "$EXIT_CONFIG"; fi
      echo "app-secret $2" ;;
    *) usage; return "$EXIT_CONFIG" ;;
  esac
}

app_secret_name() { echo "app_${1%@*}_${1#*@}_dsn"; }

# Entradas já validadas (valid_ref/valid_agent): sem aspas possíveis.
render_grant_sql() {
  printf "UPDATE agents SET targets = array_append(targets, '%s') WHERE client_id = '%s' AND NOT ('%s' = ANY(targets));\n" "$1" "$2" "$1"
  printf "SELECT count(*) FROM agents WHERE client_id = '%s' AND '%s' = ANY(targets);\n" "$2" "$1"
}

# Exemplo de stack do app conectando no banco pela infra_net (Q-E).
render_app_stack() {
  local secret
  secret="$(app_secret_name "$1")"
  cat <<EOF
# stacks/meu-app.yml — deploy: docker stack deploy -c stacks/meu-app.yml meu-app
# Seu app lê a connection string do arquivo em DATABASE_URL_FILE.
services:
  web:
    image: ghcr.io/voce/meu-app:1.0.0
    environment:
      DATABASE_URL_FILE: /run/secrets/$secret
    secrets: [$secret]
    networks: [infra_net]
    deploy:
      replicas: 1

secrets:
  $secret: { external: true }

networks:
  infra_net: { external: true }
EOF
}

control_sql() {
  local cid
  cid="$(service_container pg-prod_postgres)"
  [ -n "$cid" ] || fail "pg-prod_postgres não está rodando" "$EXIT_PRECONDITION"
  docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -qtAX -U postgres -d mcp_control
}

do_grant() {
  local ref="$1" agent="$2" n
  n="$(render_grant_sql "$ref" "$agent" | control_sql | tail -n1)"
  [ "$n" = "1" ] || fail "agente $agent não existe em mcp_control.agents (rode a etapa 70)" "$EXIT_PRECONDITION"
  ok "$agent pode usar $ref"
}

# Decifra dentro do container do db-mcp, que já tem a chave como secret.
decrypt_in_dbmcp() {
  local cid
  cid="$(service_container "$DBMCP_SERVICE")"
  [ -n "$cid" ] || fail "$DBMCP_SERVICE não está rodando" "$EXIT_PRECONDITION"
  docker exec -i "$cid" node --input-type=module -e '
    import { readFileSync } from "node:fs"
    import { parseKey, decryptSecret } from "/app/dist/crypto.js"
    const f = process.env.DB_MCP_TARGETS_KEY_FILE
    const key = f ? readFileSync(f, "utf8").trim() : process.env.DB_MCP_TARGETS_KEY
    process.stdout.write(decryptSecret(readFileSync(0, "utf8").trim(), parseKey(key ?? "")))'
}

do_app_secret() {
  local ref="$1" name enc
  name="$(app_secret_name "$ref")"
  if docker secret inspect "$name" >/dev/null 2>&1; then
    ok "secret $name já existe"
  else
    enc="$(printf "SELECT dsn_rw_enc FROM targets WHERE name = '%s' AND env = '%s';\n" "${ref%@*}" "${ref#*@}" | control_sql)"
    [ -n "$enc" ] || fail "alvo $ref não existe: crie com db_create_database / db_promote_project" "$EXIT_PRECONDITION"
    printf '%s' "$enc" | decrypt_in_dbmcp | docker secret create "$name" - >/dev/null \
      || fail "não consegui decifrar o DSN de $ref"
    ok "secret $name criado (role mcp_${ref%@*}_rw)"
  fi
  log "exemplo de stack do app:"
  render_app_stack "$ref"
}

main() {
  local args cmd ref agent
  args="$(parse_args "$@")" || exit "$EXIT_CONFIG"
  read -r cmd ref agent <<<"$args"
  require_root
  case "$cmd" in
    grant)
      if [ -z "$agent" ]; then
        load_env
        require_var KIT_CF_SERVICE_TOKEN_CLIENT_ID
        agent="$KIT_CF_SERVICE_TOKEN_CLIENT_ID"
        valid_agent "$agent" || fail "KIT_CF_SERVICE_TOKEN_CLIENT_ID inválido" "$EXIT_CONFIG"
      fi
      do_grant "$ref" "$agent" ;;
    app-secret) do_app_secret "$ref" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
