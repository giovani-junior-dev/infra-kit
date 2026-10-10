#!/usr/bin/env bash
# Etapa 30: túnel remoto, DNS e apps do Access pela API da Cloudflare.
# Uso: printf '%s' "$TOKEN" | sudo ./30-cloudflare.sh
# O API token chega pelo stdin e nunca vai para disco. Re-executar é seguro:
# tudo é buscado por nome antes de criar.
# shellcheck source=install/lib.sh
source "$(dirname "$0")/lib.sh"
# shellcheck source=install/lib-cf.sh
source "$(dirname "$0")/lib-cf.sh"

STACKS_DIR="${STACKS_DIR:-$(cd "$(dirname "$0")/../stacks" && pwd)}"
TUNNEL_NAME="${TUNNEL_NAME:-infra-kit}"
SERVICE_TOKEN_NAME="agente-1"

require_root
load_env
require_var KIT_DOMAIN KIT_OWNER_EMAIL KIT_CF_ACCOUNT_ID
command -v jq >/dev/null || { apt-get install -y -qq jq >/dev/null || fail "não consegui instalar o jq"; }

[ -t 0 ] && fail "passe o API token pelo stdin (printf '%s' \"\$TOKEN\" | $0)" "$EXIT_CONFIG"
IFS= read -r CF_API_TOKEN || true
[ -n "${CF_API_TOKEN:-}" ] || fail "API token vazio no stdin" "$EXIT_CONFIG"

# Origem de cada subdomínio: serviço do swarm na infra_net (stack_serviço).
PORTAINER_HOST="portainer.$KIT_DOMAIN"
PGBACKWEB_HOST="pgbackweb.$KIT_DOMAIN"
DBMCP_HOST="db-mcp.$KIT_DOMAIN"

log "túnel $TUNNEL_NAME"
TUNNEL_ID="$(cf_ensure_tunnel "$TUNNEL_NAME")"
[ -n "$TUNNEL_ID" ] || fail "túnel sem id"
set_env_var KIT_CF_TUNNEL_ID "$TUNNEL_ID"

cf_api PUT "/accounts/$KIT_CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$(cf_ingress_payload \
  "$PORTAINER_HOST=http://portainer_portainer:9000" \
  "$PGBACKWEB_HOST=http://pgbackweb_pgbackweb:8085" \
  "$DBMCP_HOST=http://db-mcp_db-mcp:8002")" >/dev/null
ok "ingress do túnel aplicado"

ZONE_ID="$(cf_zone_id "$KIT_DOMAIN")"
[ -n "$ZONE_ID" ] || fail "zona $KIT_DOMAIN não encontrada nesta conta da Cloudflare" "$EXIT_CONFIG"
for host in "$PORTAINER_HOST" "$PGBACKWEB_HOST" "$DBMCP_HOST"; do
  cf_ensure_cname "$ZONE_ID" "$host" "$TUNNEL_ID"
done
ok "DNS apontado para o túnel"

TEAM_DOMAIN="$(cf_api GET "/accounts/$KIT_CF_ACCOUNT_ID/access/organizations" | jq -r '.auth_domain // empty')"
[ -n "$TEAM_DOMAIN" ] || fail "Zero Trust não ativado na conta (veja docs/02-cloudflare.md)" "$EXIT_PRECONDITION"
set_env_var KIT_CF_TEAM_DOMAIN "$TEAM_DOMAIN"

# Service token: o secret só existe na resposta da criação.
NEW_TOKEN_JSON=""
TOKEN_ID="$(cf_find_service_token "$SERVICE_TOKEN_NAME")"
if [ -z "$TOKEN_ID" ]; then
  NEW_TOKEN_JSON="$(cf_api POST "/accounts/$KIT_CF_ACCOUNT_ID/access/service_tokens" \
    "$(jq -nc --arg n "$SERVICE_TOKEN_NAME" '{name: $n, duration: "8760h"}')")"
  TOKEN_ID="$(jq -r '.id' <<<"$NEW_TOKEN_JSON")"
fi
set_env_var KIT_CF_SERVICE_TOKEN_ID "$TOKEN_ID"

OWNER_POLICY="$(cf_ensure_policy "infra-kit dono" "$(cf_email_policy_payload "infra-kit dono" "$KIT_OWNER_EMAIL")")"
AGENT_POLICY="$(cf_ensure_policy "infra-kit $SERVICE_TOKEN_NAME" "$(cf_service_token_policy_payload "infra-kit $SERVICE_TOKEN_NAME" "$TOKEN_ID")")"

set_env_var KIT_CF_AUD_PORTAINER "$(cf_ensure_app "portainer" "$PORTAINER_HOST" "$OWNER_POLICY")"
set_env_var KIT_CF_AUD_PGBACKWEB "$(cf_ensure_app "pgbackweb" "$PGBACKWEB_HOST" "$OWNER_POLICY")"
set_env_var KIT_CF_AUD_DBMCP "$(cf_ensure_app "db-mcp" "$DBMCP_HOST" "$AGENT_POLICY")"
set_env_var KIT_CF_AUD_DBMCP_APPROVE "$(cf_ensure_app "db-mcp approve" "$DBMCP_HOST/approve" "$OWNER_POLICY")"
ok "apps do Access prontas"

if ! docker secret inspect cf_tunnel_token >/dev/null 2>&1; then
  cf_api GET "/accounts/$KIT_CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" | jq -j '.' \
    | docker secret create cf_tunnel_token - >/dev/null
fi
unset CF_API_TOKEN
docker stack deploy -c "$STACKS_DIR/cloudflared.yml" cloudflared >/dev/null

# Verificação
docker secret inspect cf_tunnel_token >/dev/null || fail "secret cf_tunnel_token ausente"
docker service inspect cloudflared_cloudflared >/dev/null || fail "serviço cloudflared não subiu"
mark_done 30-cloudflare
ok "etapa 30 concluída"

if [ -n "$NEW_TOKEN_JSON" ]; then
  cat <<EOF

=====================================================================
 ATENÇÃO: credencial do agente mostrada UMA ÚNICA VEZ.
 Copie agora para um gerenciador de senhas. A Cloudflare não mostra
 o secret de novo; se perder, apague o service token $SERVICE_TOKEN_NAME
 no painel e rode esta etapa outra vez.
   CF-Access-Client-Id:     $(jq -r '.client_id' <<<"$NEW_TOKEN_JSON")
   CF-Access-Client-Secret: $(jq -r '.client_secret' <<<"$NEW_TOKEN_JSON")
=====================================================================
EOF
fi
