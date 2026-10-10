#!/usr/bin/env bash
# Funções da API da Cloudflare usadas pela etapa 30. Separadas para teste (bats
# troca o curl por um mock). O token fica só em CF_API_TOKEN, em memória.
# Endpoints conferidos em developers.cloudflare.com/api (2026-10-10).

CF_API="${CF_API:-https://api.cloudflare.com/client/v4}"

# cf_api MÉTODO CAMINHO [CORPO_JSON] → imprime o .result; falha se success=false.
# O token vai por arquivo de config no stdin do curl, para não aparecer no ps.
cf_api() {
  local method="$1" path="$2" body="${3:-}" resp
  local args=(-sS -X "$method" -H "Content-Type: application/json" -K -)
  [ -n "$body" ] && args+=(--data "$body")
  resp="$(printf 'header = "Authorization: Bearer %s"\n' "$CF_API_TOKEN" \
          | curl "${args[@]}" "$CF_API$path")" || fail "falha de rede em $method $path"
  if [ "$(jq -r '.success' <<<"$resp")" != "true" ]; then
    fail "Cloudflare recusou $method $path: $(jq -c '.errors' <<<"$resp" 2>/dev/null || echo resposta inválida)"
  fi
  jq -c '.result' <<<"$resp"
}

# ---- builders de payload (puros) ----

cf_tunnel_payload() { jq -nc --arg n "$1" '{name: $n, config_src: "cloudflare"}'; }

# cf_ingress_payload "host=serviço" ... → config com httpHostHeader e catch-all 404
cf_ingress_payload() {
  local pair rules=()
  for pair in "$@"; do rules+=("${pair%%=*}" "${pair#*=}"); done
  printf '%s\n' "${rules[@]}" | jq -Rnc '
    [inputs] as $a
    | [range(0; $a|length; 2) | {hostname: $a[.], service: $a[.+1],
                                  originRequest: {httpHostHeader: $a[.]}}]
    | {config: {ingress: (. + [{service: "http_status:404"}])}}'
}

cf_cname_payload() {
  jq -nc --arg n "$1" --arg t "$2" '{type: "CNAME", name: $n, content: ($t + ".cfargotunnel.com"), proxied: true}'
}

cf_email_policy_payload() {
  jq -nc --arg n "$1" --arg e "$2" '{name: $n, decision: "allow", include: [{email: {email: $e}}]}'
}

cf_service_token_policy_payload() {
  jq -nc --arg n "$1" --arg t "$2" '{name: $n, decision: "non_identity", include: [{service_token: {token_id: $t}}]}'
}

cf_app_payload() {
  jq -nc --arg n "$1" --arg d "$2" --arg p "$3" \
    '{name: $n, domain: $d, type: "self_hosted", session_duration: "24h", policies: [{id: $p, precedence: 1}]}'
}

# ---- busca por nome antes de criar (idempotência) ----

# Imprime o id do túnel ativo com esse nome, ou nada.
cf_find_tunnel() {
  cf_api GET "/accounts/$KIT_CF_ACCOUNT_ID/cfd_tunnel?name=$1&is_deleted=false" | jq -r '.[0].id // empty'
}

cf_ensure_tunnel() {
  local id
  id="$(cf_find_tunnel "$1")"
  [ -n "$id" ] || id="$(cf_api POST "/accounts/$KIT_CF_ACCOUNT_ID/cfd_tunnel" "$(cf_tunnel_payload "$1")" | jq -r '.id')"
  printf '%s\n' "$id"
}

cf_zone_id() {
  cf_api GET "/zones?name=$1" | jq -r '.[0].id // empty'
}

# Cria ou corrige o CNAME proxied para o túnel.
cf_ensure_cname() {
  local zone="$1" name="$2" tunnel="$3" rec
  rec="$(cf_api GET "/zones/$zone/dns_records?type=CNAME&name=$name" | jq -c '.[0] // empty')"
  if [ -z "$rec" ]; then
    cf_api POST "/zones/$zone/dns_records" "$(cf_cname_payload "$name" "$tunnel")" >/dev/null
  elif [ "$(jq -r '.content' <<<"$rec")" != "$tunnel.cfargotunnel.com" ] || [ "$(jq -r '.proxied' <<<"$rec")" != "true" ]; then
    cf_api PATCH "/zones/$zone/dns_records/$(jq -r '.id' <<<"$rec")" "$(cf_cname_payload "$name" "$tunnel")" >/dev/null
  fi
}

# Imprime o id do service token com esse nome, ou nada.
cf_find_service_token() {
  cf_api GET "/accounts/$KIT_CF_ACCOUNT_ID/access/service_tokens?name=$1" \
    | jq -r --arg n "$1" 'map(select(.name == $n))[0].id // empty'
}

# Client ID do service token com esse nome (vira o claim common_name do JWT do
# Access; é a chave do agente no db-mcp). Não é segredo.
cf_service_token_client_id() {
  cf_api GET "/accounts/$KIT_CF_ACCOUNT_ID/access/service_tokens?name=$1"     | jq -r --arg n "$1" 'map(select(.name == $n))[0].client_id // empty'
}

# Política reutilizável: busca por nome; cria com o payload dado se não existir.
cf_ensure_policy() {
  local name="$1" payload="$2" id
  id="$(cf_api GET "/accounts/$KIT_CF_ACCOUNT_ID/access/policies" \
        | jq -r --arg n "$name" 'map(select(.name == $n))[0].id // empty')"
  [ -n "$id" ] || id="$(cf_api POST "/accounts/$KIT_CF_ACCOUNT_ID/access/policies" "$payload" | jq -r '.id')"
  printf '%s\n' "$id"
}

# App do Access: busca por domínio exato; cria se não existir. Imprime o aud.
cf_ensure_app() {
  local name="$1" domain="$2" policy="$3" app
  app="$(cf_api GET "/accounts/$KIT_CF_ACCOUNT_ID/access/apps?domain=$domain&exact=true" \
         | jq -c --arg d "$domain" 'map(select(.domain == $d))[0] // empty')"
  [ -n "$app" ] || app="$(cf_api POST "/accounts/$KIT_CF_ACCOUNT_ID/access/apps" "$(cf_app_payload "$name" "$domain" "$policy")")"
  jq -r '.aud' <<<"$app"
}
