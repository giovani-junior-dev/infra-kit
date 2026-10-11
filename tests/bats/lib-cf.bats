#!/usr/bin/env bats
# Lógica pura da etapa 30: payloads e busca-antes-de-criar com curl falso.

setup() {
  export KIT_DIR="$BATS_TEST_TMPDIR/kit" KIT_ENV="$BATS_TEST_TMPDIR/kit/kit.env"
  export KIT_CF_ACCOUNT_ID=acc1 CF_API_TOKEN=tok-secreto
  export MOCK_ROUTES="$BATS_TEST_TMPDIR/routes" MOCK_CALLS="$BATS_TEST_TMPDIR/calls"
  : > "$MOCK_ROUTES"; : > "$MOCK_CALLS"
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  # curl falso: registra "MÉTODO URL" e o stdin (config com o token);
  # responde a 1ª rota cujo "MÉTODO prefixo-da-URL" casar.
  cat > "$BATS_TEST_TMPDIR/bin/curl" <<'MOCK'
#!/usr/bin/env bash
method=GET url=""
while [ $# -gt 0 ]; do
  case "$1" in -X) method="$2"; shift 2 ;; -H|--data|-K) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
cat > "$MOCK_CALLS.stdin"
echo "$method $url" >> "$MOCK_CALLS"
while IFS='|' read -r m prefix body; do
  if [ "$m" = "$method" ] && [[ "$url" == *"$prefix"* ]]; then echo "$body"; exit 0; fi
done < "$MOCK_ROUTES"
echo '{"success":false,"errors":[{"message":"rota não mockada"}]}'
MOCK
  chmod +x "$BATS_TEST_TMPDIR/bin/curl"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
  source "$BATS_TEST_DIRNAME/../../install/lib.sh"
  source "$BATS_TEST_DIRNAME/../../install/lib-cf.sh"
  set +e
}

route() { printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$MOCK_ROUTES"; }

@test "ingress tem httpHostHeader igual ao hostname e termina no catch-all 404" {
  run cf_ingress_payload "a.ex.com=http://svc_a:9000" "b.ex.com=http://svc_b:8085"
  [ "$status" -eq 0 ]
  [ "$(jq -r '.config.ingress[0].originRequest.httpHostHeader' <<<"$output")" = "a.ex.com" ]
  [ "$(jq -r '.config.ingress[1].service' <<<"$output")" = "http://svc_b:8085" ]
  [ "$(jq -r '.config.ingress[-1].service' <<<"$output")" = "http_status:404" ]
  [ "$(jq '.config.ingress|length' <<<"$output")" -eq 3 ]
}

@test "payloads de túnel, CNAME, políticas e app" {
  [ "$(cf_tunnel_payload infra-kit)" = '{"name":"infra-kit","config_src":"cloudflare"}' ]
  run cf_cname_payload portainer.ex.com tid
  [ "$(jq -r '.content' <<<"$output")" = "tid.cfargotunnel.com" ]
  [ "$(jq -r '.proxied' <<<"$output")" = "true" ]
  run cf_email_policy_payload dono a@b.com
  [ "$(jq -c '.include' <<<"$output")" = '[{"email":{"email":"a@b.com"}}]' ]
  [ "$(jq -r '.decision' <<<"$output")" = "allow" ]
  run cf_service_token_policy_payload agente st1
  [ "$(jq -c '.include' <<<"$output")" = '[{"service_token":{"token_id":"st1"}}]' ]
  [ "$(jq -r '.decision' <<<"$output")" = "non_identity" ]
  run cf_app_payload db-mcp db-mcp.ex.com/approve p1
  [ "$(jq -r '.type' <<<"$output")" = "self_hosted" ]
  [ "$(jq -c '.policies' <<<"$output")" = '[{"id":"p1","precedence":1}]' ]
}

@test "túnel existente é reaproveitado, sem POST" {
  route GET "/accounts/acc1/cfd_tunnel?name=infra-kit&is_deleted=false" '{"success":true,"result":[{"id":"t-velho"}]}'
  run cf_ensure_tunnel infra-kit
  [ "$output" = "t-velho" ]
  ! grep -q '^POST' "$MOCK_CALLS"
}

@test "túnel ausente é criado" {
  route GET "/cfd_tunnel?name=" '{"success":true,"result":[]}'
  route POST "/accounts/acc1/cfd_tunnel" '{"success":true,"result":{"id":"t-novo"}}'
  run cf_ensure_tunnel infra-kit
  [ "$output" = "t-novo" ]
  grep -q '^POST .*/accounts/acc1/cfd_tunnel$' "$MOCK_CALLS"
}

@test "CNAME certo não é tocado; apontando para outro lugar é corrigido" {
  route GET "/zones/z1/dns_records?type=CNAME&name=ok.ex.com" '{"success":true,"result":[{"id":"r1","content":"t1.cfargotunnel.com","proxied":true}]}'
  route GET "/zones/z1/dns_records?type=CNAME&name=velho.ex.com" '{"success":true,"result":[{"id":"r2","content":"outro.com","proxied":true}]}'
  route PATCH "/zones/z1/dns_records/r2" '{"success":true,"result":{}}'
  cf_ensure_cname z1 ok.ex.com t1
  [ "$(grep -c -v '^GET' "$MOCK_CALLS")" -eq 0 ]
  cf_ensure_cname z1 velho.ex.com t1
  grep -q '^PATCH .*/dns_records/r2$' "$MOCK_CALLS"
}

@test "CNAME ausente é criado com POST" {
  route GET "/dns_records?type=CNAME" '{"success":true,"result":[]}'
  route POST "/zones/z1/dns_records" '{"success":true,"result":{}}'
  cf_ensure_cname z1 novo.ex.com t1
  grep -q '^POST .*/zones/z1/dns_records$' "$MOCK_CALLS"
}

@test "política e app existentes são reaproveitados pelo nome/domínio" {
  route GET "/access/policies" '{"success":true,"result":[{"id":"p-x","name":"outra"},{"id":"p-dono","name":"infra-kit dono"}]}'
  route GET "/access/apps?domain=portainer.ex.com&exact=true" '{"success":true,"result":[{"domain":"portainer.ex.com","aud":"aud-1"}]}'
  run cf_ensure_policy "infra-kit dono" '{}'
  [ "$output" = "p-dono" ]
  run cf_ensure_app portainer portainer.ex.com p-dono
  [ "$output" = "aud-1" ]
  ! grep -q '^POST' "$MOCK_CALLS"
}

@test "app ausente é criada e devolve o aud" {
  route GET "/access/apps?domain=" '{"success":true,"result":[]}'
  route POST "/accounts/acc1/access/apps" '{"success":true,"result":{"aud":"aud-novo"}}'
  run cf_ensure_app pgbackweb pgbackweb.ex.com p1
  [ "$output" = "aud-novo" ]
}

@test "service token busca pelo nome exato" {
  route GET "/access/service_tokens?name=agente-1" '{"success":true,"result":[{"id":"s0","name":"agente-10"},{"id":"s1","name":"agente-1"}]}'
  run cf_find_service_token agente-1
  [ "$output" = "s1" ]
}

@test "erro da API falha com a mensagem e o token não vai para argumento" {
  run cf_api GET /zones?name=ex.com
  [ "$status" -ne 0 ]
  [[ "$output" == *"rota não mockada"* ]]
  ! grep -q tok-secreto "$MOCK_CALLS"
  grep -q 'Bearer tok-secreto' "$MOCK_CALLS.stdin"
}

@test "client id do service token vem pelo nome exato" {
  route GET "/access/service_tokens?name=agente-1" \
    '{"success":true,"result":[{"name":"agente-10","client_id":"x.access"},{"name":"agente-1","id":"t1","client_id":"c1.access"}]}'
  run cf_service_token_client_id agente-1
  [ "$status" -eq 0 ]
  [ "$output" = "c1.access" ]
}

@test "cf_ingress_payload: @hostHeader troca o Host enviado (db-mcp aceita só loopback)" {
  run cf_ingress_payload "a.ex.com=http://svc_a:9000" "m.ex.com=http://svc_m:8002@127.0.0.1:8002"
  [ "$status" -eq 0 ]
  [ "$(jq -r '.config.ingress[0].originRequest.httpHostHeader' <<<"$output")" = "a.ex.com" ]
  [ "$(jq -r '.config.ingress[1].service' <<<"$output")" = "http://svc_m:8002" ]
  [ "$(jq -r '.config.ingress[1].originRequest.httpHostHeader' <<<"$output")" = "127.0.0.1:8002" ]
}
