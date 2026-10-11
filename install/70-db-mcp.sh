#!/usr/bin/env bash
# Etapa 70: db-mcp no ar (stack db-mcp na infra_net, sem porta) e agente-1
# cadastrado. Segredos gerados aqui direto para Docker secrets, nunca impressos
# (lições L1, L9). Termina mostrando o `claude mcp add` para o aluno, com o
# secret do service token como placeholder: o valor real só o aluno tem.
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STACKS_DIR="${STACKS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../stacks" && pwd)}"
STACK=db-mcp
SERVICE=db-mcp_db-mcp
AGENT_NAME=agente-1
HEALTH_IMAGE="${KIT_HEALTH_IMAGE:-busybox:1.37}"

# Client ID do Access: "<hex>.access". Validado antes de ir para o SQL.
valid_client_id() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]; }

# SQL idempotente do cadastro do agente (sem alvos: a skill libera depois).
render_agent_sql() {
  local client_id="$1" name="$2"
  valid_client_id "$client_id" || return 1
  printf "INSERT INTO agents (client_id, name, targets) VALUES ('%s', '%s', '{}') ON CONFLICT (client_id) DO NOTHING;\n" \
    "$client_id" "$name"
}

# Comando que o aluno roda na máquina dele. O secret fica como placeholder.
render_mcp_add_command() {
  local domain="$1" client_id="$2"
  cat <<EOF
claude mcp add --scope user --transport http db-mcp https://db-mcp.${domain}/mcp \\
  --header "CF-Access-Client-Id: ${client_id}" \\
  --header "CF-Access-Client-Secret: <COLE_AQUI_O_CLIENT_SECRET>"
EOF
}

pg_prod() {
  local cid
  cid="$(service_container pg-prod_postgres)"
  [ -n "$cid" ] || fail "container de pg-prod_postgres não está rodando"
  docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -qtAX -U postgres -d "${1:-postgres}"
}

# A imagem do db-mcp acompanha a release do kit: tag v0.9.0-rc1 → imagem 0.9.0-rc1.
# Uso: version_from_tag <tag> → versão sem o "v"; vazio se não for tag de release.
version_from_tag() {
  [[ "${1:-}" =~ ^v([0-9]+\.[0-9]+\.[0-9]+.*)$ ]] && printf '%s
' "${BASH_REMATCH[1]}"
  return 0
}

# GET /health pela overlay, de um container descartável na infra_net.
health_via_overlay() {
  local body
  body="$(docker run --rm --network infra_net "$HEALTH_IMAGE" \
    wget -qO- -T 5 --header "Host: 127.0.0.1:8002" "http://$SERVICE:8002/health" 2>/dev/null)" || return 1
  grep -q '"ok":true' <<<"$body"
}

wait_healthy() {
  local cid status
  for _ in $(seq 1 90); do
    cid="$(service_container "$SERVICE")"
    if [ -n "$cid" ]; then
      status="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)"
      [ "$status" = "healthy" ] && return 0
    fi
    sleep 2
  done
  fail "db-mcp não ficou saudável em 180 s; veja: docker service logs $SERVICE --tail 50"
}

main() {
  require_root
  load_env
  require_var KIT_DOMAIN KIT_OWNER_EMAIL KIT_CF_TEAM_DOMAIN KIT_CF_AUD_DBMCP KIT_CF_AUD_DBMCP_APPROVE \
    KIT_CF_SERVICE_TOKEN_CLIENT_ID
  step_done 30-cloudflare || fail "rode a etapa 30 antes" "$EXIT_PRECONDITION"
  step_done 50-postgres || fail "rode a etapa 50 antes" "$EXIT_PRECONDITION"
  valid_client_id "$KIT_CF_SERVICE_TOKEN_CLIENT_ID" \
    || fail "KIT_CF_SERVICE_TOKEN_CLIENT_ID inválido no kit.env" "$EXIT_CONFIG"
  if [ -z "${KIT_DBMCP_VERSION:-}" ]; then
    KIT_DBMCP_VERSION="$(version_from_tag "$(git -C "$(dirname "$0")/.." describe --tags --exact-match 2>/dev/null)")"
    [ -n "$KIT_DBMCP_VERSION" ] || fail "o kit não está numa tag de release: defina KIT_DBMCP_VERSION no kit.env" "$EXIT_CONFIG"
    set_env_var KIT_DBMCP_VERSION "$KIT_DBMCP_VERSION"
  fi
  export KIT_DBMCP_VERSION

  local s
  for s in mcp_admin_pw_prod mcp_admin_pw_homolog mcp_control_rw_pw; do
    docker secret inspect "$s" >/dev/null 2>&1 || fail "secret $s ausente; rode a etapa 50" "$EXIT_PRECONDITION"
  done
  create_random_secret dbmcp_approval_secret 32 || true
  create_random_secret dbmcp_targets_key 32 || true   # 64 hex; perder = perder os DSNs da tabela targets

  register_consumer dbmcp_approval_secret "$STACK" "$STACK" approval
  register_consumer dbmcp_targets_key "$STACK" "$STACK" targets

  docker stack deploy --with-registry-auth -c "$STACKS_DIR/db-mcp.yml" "$STACK" >/dev/null
  wait_healthy

  # A tabela agents nasce nas migrations do boot do db-mcp: cadastro só depois.
  render_agent_sql "$KIT_CF_SERVICE_TOKEN_CLIENT_ID" "$AGENT_NAME" | pg_prod mcp_control

  # Verificação
  grep -qE '"(APPROVAL_SECRET|DB_MCP_TARGETS_KEY)=' \
    <<<"$(docker service inspect "$SERVICE" --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}')" \
    && fail "db-mcp com segredo em texto na env (lição L1)"
  [ "$(printf "SELECT name FROM agents WHERE client_id='%s'\n" "$KIT_CF_SERVICE_TOKEN_CLIENT_ID" | pg_prod mcp_control)" = "$AGENT_NAME" ] \
    || fail "agente $AGENT_NAME não ficou cadastrado em mcp_control.agents"
  health_via_overlay || fail "db-mcp não responde /health pela infra_net"
  mark_done 70-db-mcp
  ok "etapa 70 concluída: https://db-mcp.$KIT_DOMAIN"

  cat <<EOF

Na SUA máquina (não no servidor), conecte o Claude Code ao db-mcp. Troque
<COLE_AQUI_O_CLIENT_SECRET> pelo Client Secret gravado pela etapa 30 em
$KIT_DIR/agente-1.secret (leia com: sudo cat $KIT_DIR/agente-1.secret):

$(render_mcp_add_command "$KIT_DOMAIN" "$KIT_CF_SERVICE_TOKEN_CLIENT_ID")

Depois confira:  claude mcp get db-mcp
EOF
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
