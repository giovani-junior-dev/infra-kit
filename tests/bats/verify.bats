#!/usr/bin/env bats
# Partes puras do 90-verify.sh: JSON, detector de segredo, drift, parsers.

load helpers

setup() { load_step 90-verify.sh; }

@test "render_report: ok só quando todas passam; checks na ordem" {
  output="$({ json_check a true "d1" ""; json_check b true "d2" ""; } | render_report)"
  [ "$output" = '{"ok":true,"checks":[{"id":"a","ok":true,"detail":"d1","fix":""},{"id":"b","ok":true,"detail":"d2","fix":""}]}' ]
  out="$({ json_check a true x ""; json_check b false "porta 80" "feche"; } | render_report)"
  [ "$(jq -r .ok <<<"$out")" = "false" ]
  [ "$(jq -r '.checks[1].fix' <<<"$out")" = "feche" ]
}

@test "render_report: sem checagens não é ok" {
  [ "$(printf '' | render_report)" = '{"ok":false,"checks":[]}' ]
}

@test "json_check escapa aspas e acentos no detail" {
  out="$(json_check x false 'senha "vazou" à toa' 'troque')"
  [ "$(jq -r .detail <<<"$out")" = 'senha "vazou" à toa' ]
}

@test "env_secret_keys acusa PASSWORD/SECRET/TOKEN/KEY sem _FILE" {
  run env_secret_keys <<'ENV'
POSTGRES_PASSWORD=abc
POSTGRES_PASSWORD_FILE=/run/secrets/x
APPROVAL_SECRET=s
DB_MCP_TARGETS_KEY_FILE=/run/secrets/k
CF_TUNNEL_TOKEN=t
MCP_CONTROL_DATABASE_URL_PASSWORD_FILE=/run/secrets/y
TZ=America/Sao_Paulo
PBW_LISTEN_PORT=8085
ENV
  [ "$output" = $'POSTGRES_PASSWORD\nAPPROVAL_SECRET\nCF_TUNNEL_TOKEN' ]
}

@test "env_secret_keys: nada a acusar = saída vazia" {
  run env_secret_keys <<<'HOST=0.0.0.0'
  [ -z "$output" ]
}

@test "drift: igual não imprime nada" {
  e='{"ports":[],"env":["A","B"]}'
  [ -z "$(drift_compare "$e" "$e")" ]
}

@test "drift: porta publicada à mão e env faltando (lição L2)" {
  run drift_compare '{"ports":[],"env":["A","B"]}' '{"ports":["5432/tcp"],"env":["A","C"]}'
  [[ "$output" == *"porta 5432/tcp publicada fora do arquivo"* ]]
  [[ "$output" == *"env C fora do arquivo"* ]]
  [[ "$output" == *"env B do arquivo ausente no serviço"* ]]
}

@test "normalizadores: compose e service inspect chegam no mesmo formato" {
  compose='{"services":{"web":{"ports":[{"published":"8080","target":80,"protocol":"tcp"}],"environment":{"B":"2","A":null}}}}'
  inspect='[{"Endpoint":{"Spec":{"Ports":[{"PublishedPort":8080,"TargetPort":80,"Protocol":"tcp"}]}},"Spec":{"TaskTemplate":{"ContainerSpec":{"Env":["A=1","B=x=y"]}}}}]'
  e="$(expected_from_compose web <<<"$compose")"
  a="$(actual_from_inspect <<<"$inspect")"
  [ "$e" = '{"ports":["8080/tcp"],"env":["A","B"]}' ]
  [ "$e" = "$a" ]
}

@test "actual_from_inspect sem portas nem env" {
  [ "$(actual_from_inspect <<<'[{"Endpoint":{"Spec":{}},"Spec":{"TaskTemplate":{"ContainerSpec":{}}}}]')" = '{"ports":[],"env":[]}' ]
}

@test "sshd_value lê a opção efetiva" {
  out=$'port 2222\npermitrootlogin no\npasswordauthentication no'
  [ "$(sshd_value permitrootlogin <<<"$out")" = "no" ]
  [ "$(sshd_value port <<<"$out")" = "2222" ]
}

@test "ufw_open_ports junta v4 e v6 e ignora o resto" {
  run ufw_open_ports <<'UFW'
Status: active

To                         Action      From
--                         ------      ----
2222/tcp                   ALLOW       Anywhere
8080                       ALLOW       Anywhere
2222/tcp (v6)              ALLOW       Anywhere (v6)
UFW
  [ "$output" = $'2222\n8080' ]
}

@test "replicas_bad acusa 0/1 e serviço zerado" {
  run replicas_bad <<'LS'
pg-prod_postgres 1/1
db-mcp_db-mcp 0/1
portainer_agent 1/1
x_y 0/0
LS
  [ "$output" = $'db-mcp_db-mcp (0/1)\nx_y (0/0)' ]
}

@test "backup_problem: ok, falhou, velho e vazio" {
  [ -z "$(backup_problem 'success|3600')" ]
  [ "$(backup_problem 'failed|60')" = "último backup terminou com status failed" ]
  [ "$(backup_problem "success|$((30 * 3600))")" = "último backup tem 30 h (limite 26 h)" ]
  [ "$(backup_problem '')" = "nenhum backup encontrado" ]
}
