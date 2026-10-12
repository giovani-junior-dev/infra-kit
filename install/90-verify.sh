#!/usr/bin/env bash
# Etapa 90: checagem completa do servidor. Só lê; não muda nada.
# Contrato (a skill /infra:verificar lê): um único objeto JSON no stdout
#   {"ok":bool,"checks":[{"id":"...","ok":bool,"detail":"...","fix":"..."}]}
# detail/fix em PT-BR simples. Saída 0 se tudo ok, 1 se algo falhou.
# Funções puras (render, detector de segredo, drift) separadas para o bats.
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STACKS_DIR="${STACKS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../stacks" && pwd)}"
HEALTH_IMAGE="${KIT_HEALTH_IMAGE:-busybox:1.37}"
BACKUP_MAX_AGE_S=$((26 * 3600))
CHECKS_FILE=""

# ---- funções puras ----

# Uma linha JSON por checagem.
json_check() {
  jq -nc --arg id "$1" --argjson ok "$2" --arg detail "$3" --arg fix "$4" \
    '{id: $id, ok: $ok, detail: $detail, fix: $fix}'
}

# JSONL de checagens no stdin → objeto final.
render_report() {
  jq -sc '{ok: (length > 0 and all(.[]; .ok)), checks: .}'
}

# Linhas KEY=VALUE no stdin → chaves com cara de segredo em texto puro.
env_secret_keys() {
  local line key
  while IFS= read -r line; do
    key="${line%%=*}"
    [ -n "$key" ] || continue
    [[ "$key" =~ (PASSWORD|SECRET|TOKEN|KEY) ]] || continue
    [[ "$key" == *_FILE ]] && continue
    printf '%s\n' "$key"
  done
}

# Valor efetivo de uma opção na saída do `sshd -T` (stdin).
sshd_value() { awk -v k="$1" '$1 == k {print $2; exit}'; }

# Saída do `ufw status` (stdin) → portas liberadas, uma por linha, sem repetir.
ufw_open_ports() {
  awk '$2 == "ALLOW" || ($2 == "(v6)" && $3 == "ALLOW") {sub(/ \(v6\)/, ""); split($1, p, "/"); print p[1]}' | sort -u
}

# `docker compose config --format json` (stdin) → {ports, env} normalizados do serviço.
expected_from_compose() {
  jq -c --arg s "$1" '.services[$s] | {
    ports: [(.ports // [])[] | "\(.published)/\(.protocol // "tcp")"] | sort,
    env: ((.environment // {}) | keys | sort)}'
}

# `docker service inspect` (stdin, array) → {ports, env} normalizados.
actual_from_inspect() {
  jq -c '.[0] | {
    ports: [(.Endpoint.Spec.Ports // [])[] | "\(.PublishedPort)/\(.Protocol)"] | sort,
    env: [(.Spec.TaskTemplate.ContainerSpec.Env // [])[] | split("=")[0]] | sort}'
}

# drift_compare <esperado> <em_uso> → diferenças em texto (vazio = sem drift).
drift_compare() {
  jq -rn --argjson e "$1" --argjson a "$2" '
    ($a.ports - $e.ports | map("porta \(.) publicada fora do arquivo"))
    + ($e.ports - $a.ports | map("porta \(.) do arquivo não está publicada"))
    + ($a.env - $e.env | map("env \(.) fora do arquivo"))
    + ($e.env - $a.env | map("env \(.) do arquivo ausente no serviço"))
    | .[]'
}

# Linhas "nome atual/desejado" (docker service ls) → serviços fora do ar.
replicas_bad() {
  awk '{split($2, r, "/"); if (r[1] != r[2] || r[2] == 0) print $1 " (" $2 ")"}'
}

# "status|idade_em_segundos" do último backup → vazio se ok, senão o motivo.
# 2º argumento: idade em segundos do agendamento ativo mais antigo (vazio = nenhum).
# Sem execução ainda, agendamento com menos de 26 h não é problema.
backup_problem() {
  local status="${1%%|*}" age="${1#*|}" sched="${2:-}"
  if [ -z "$1" ] && [ -n "$sched" ] && [ "$sched" -le "$BACKUP_MAX_AGE_S" ]; then return 0
  elif [ -z "$1" ]; then echo "nenhum backup encontrado"
  elif [ "$status" != "success" ]; then echo "último backup terminou com status $status"
  elif [ "$age" -gt "$BACKUP_MAX_AGE_S" ]; then echo "último backup tem $((age / 3600)) h (limite 26 h)"
  fi
}

# ---- registro ----

add_check() { json_check "$@" >> "$CHECKS_FILE"; }
pass() { add_check "$1" true "$2" ""; }
flunk() { add_check "$1" false "$2" "$3"; }

# ---- checagens (leem o servidor) ----

check_ssh() {
  local out v
  ensure_sshd_privsep_dir 2>/dev/null || true
  out="$(sshd -T 2>/dev/null || true)"
  if [ -z "$out" ]; then
    flunk ssh.config "não consegui ler a configuração do SSH (sshd -T)" "rode como root: sudo bash install/90-verify.sh"
    return
  fi
  v="$(sshd_value permitrootlogin <<<"$out")"
  if [ "$v" = "no" ]; then pass ssh.root_login "login de root desligado"
  else flunk ssh.root_login "login de root está '$v'" "rode de novo a etapa 15 (install/15-ssh-hardening.sh)"; fi
  v="$(sshd_value passwordauthentication <<<"$out")"
  if [ "$v" = "no" ]; then pass ssh.password "login por senha desligado"
  else flunk ssh.password "login por senha está '$v'" "rode de novo a etapa 15"; fi
  v="$(sshd_value kbdinteractiveauthentication <<<"$out")"
  if [ "$v" = "no" ]; then pass ssh.kbd_interactive "login interativo desligado"
  else flunk ssh.kbd_interactive "login interativo está '$v'" "rode de novo a etapa 15"; fi
  v="$(sshd_value port <<<"$out")"
  if [ "$v" = "${KIT_SSH_PORT:-}" ]; then pass ssh.port "SSH na porta $v"
  else flunk ssh.port "SSH na porta '$v', esperado '${KIT_SSH_PORT:-}'" "rode de novo a etapa 15"; fi
}

check_ufw() {
  local out ports
  out="$(ufw status 2>/dev/null || true)"
  if ! grep -q '^Status: active' <<<"$out"; then
    flunk ufw.active "firewall (UFW) desligado" "rode de novo a etapa 15"
    return
  fi
  ports="$(ufw_open_ports <<<"$out" | paste -sd, -)"
  if [ "$ports" = "${KIT_SSH_PORT:-}" ]; then pass ufw.active "UFW ativo, só a porta $ports aberta"
  else flunk ufw.active "UFW ativo com portas abertas: ${ports:-nenhuma}; esperado só ${KIT_SSH_PORT:-}" \
    "feche as outras com: sudo ufw delete allow <porta>/tcp"; fi
}

check_docker_user() {
  if iptables -C DOCKER-USER -i "${KIT_PUBLIC_IFACE:-}" -j INFRA-KIT-INGRESS 2>/dev/null; then
    pass docker_user.jump "bloqueio de entrada para containers ativo (DOCKER-USER)"
  else
    flunk docker_user.jump "sem o bloqueio na DOCKER-USER: containers podem ficar expostos" \
      "sudo systemctl restart infra-kit-docker-user (ou rode de novo a etapa 20)"
  fi
}

check_published_ports() {
  local list
  list="$(docker service ls -q | xargs -r docker service inspect \
    | jq -r '.[] | select((.Endpoint.Spec.Ports // []) | length > 0)
             | "\(.Spec.Name): \([.Endpoint.Spec.Ports[] | "\(.PublishedPort)/\(.Protocol)"] | join(","))"' \
    | paste -sd';' -)"
  if [ -z "$list" ]; then pass swarm.published_ports "nenhum serviço com porta publicada"
  else flunk swarm.published_ports "serviços com porta aberta: $list" \
    "tire o bloco ports: do arquivo da stack e faça o deploy de novo"; fi
}

check_env_secrets() {
  local svc keys bad=()
  for svc in $(docker service ls --format '{{.Name}}'); do
    keys="$(docker service inspect "$svc" --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
      | env_secret_keys | paste -sd, -)"
    [ -z "$keys" ] || bad+=("$svc: $keys")
  done
  if [ "${#bad[@]}" -eq 0 ]; then pass secrets.env_plaintext "nenhuma senha em texto puro na env dos serviços"
  else flunk secrets.env_plaintext "senha em texto na env: $(IFS=';'; echo "${bad[*]}")" \
    "troque por Docker secret e variável *_FILE no arquivo da stack (lição L1)"; fi
}

check_drift() {
  local file stack compose svc expected actual diff d
  local deployed
  deployed="$(docker stack ls --format '{{.Name}}')"
  for file in "$STACKS_DIR"/*.yml; do
    stack="$(basename "$file" .yml)"
    grep -qxF "$stack" <<<"$deployed" || continue
    if ! compose="$(docker compose -f "$file" config --format json 2>/dev/null)"; then
      flunk "drift.$stack" "não consegui ler $file" "confira o arquivo com: docker compose -f $file config"
      continue
    fi
    diff=""
    for svc in $(jq -r '.services | keys[]' <<<"$compose"); do
      expected="$(expected_from_compose "$svc" <<<"$compose")"
      if ! actual="$(docker service inspect "${stack}_${svc}" 2>/dev/null | actual_from_inspect)"; then
        diff+="serviço ${stack}_${svc} não existe; "
        continue
      fi
      d="$(drift_compare "$expected" "$actual" | sed "s/^/${svc}: /" | paste -sd';' -)"
      [ -z "$d" ] || diff+="$d; "
    done
    if [ -z "$diff" ]; then pass "drift.$stack" "stack $stack igual ao arquivo"
    else flunk "drift.$stack" "stack $stack diferente do arquivo: $diff" \
      "reaplique o arquivo: docker stack deploy -c $file $stack (lição L2)"; fi
  done
}

check_replicas() {
  local bad
  bad="$(docker service ls --format '{{.Name}} {{.Replicas}}' | replicas_bad | paste -sd, -)"
  if [ -z "$bad" ]; then pass services.replicas "todos os serviços rodando"
  else flunk services.replicas "serviços fora do ar: $bad" "veja o motivo com: docker service ps <serviço> --no-trunc"; fi
}

check_backup() {
  local cid row problem sched=""
  cid="$(service_container pg-prod_postgres)"
  if [ -z "$cid" ]; then
    flunk backup.latest "Postgres de produção fora do ar; não deu para ler os backups" "rode de novo a etapa 50"
    return
  fi
  # backup_reader pelo socket local do container: só leitura, sem senha em argumento.
  row="$(docker exec -i "$cid" psql -qtAX -U backup_reader -d pgbackweb -c \
    "SELECT status || '|' || extract(epoch FROM now() - coalesce(finished_at, started_at))::bigint
       FROM executions WHERE status <> 'running' ORDER BY started_at DESC LIMIT 1" 2>/dev/null)" || {
    flunk backup.latest "não consegui ler o histórico do PG Back Web" "confira a etapa 60 e o painel https://pgbackweb.${KIT_DOMAIN:-}"
    return
  }
  if [ -z "$row" ]; then
    sched="$(docker exec -i "$cid" psql -qtAX -U backup_reader -d pgbackweb -c \
      "SELECT extract(epoch FROM now() - min(created_at))::bigint FROM backups WHERE is_active" 2>/dev/null)"
  fi
  problem="$(backup_problem "$row" "$sched")"
  if [ -z "$problem" ] && [ -z "$row" ]; then pass backup.latest "backup diário agendado; o 1º roda às 03:00"
  elif [ -z "$problem" ]; then pass backup.latest "último backup ok, feito há menos de 26 h"
  else flunk backup.latest "$problem" "abra https://pgbackweb.${KIT_DOMAIN:-}, confira a agenda diária e rode \"Run backup now\""; fi
}

check_dbmcp_health() {
  local body
  body="$(docker run --rm --network infra_net "$HEALTH_IMAGE" \
    wget -qO- -T 5 --header "Host: 127.0.0.1:8002" http://db-mcp_db-mcp:8002/health 2>/dev/null)"
  if grep -q '"ok":true' <<<"$body"; then
    pass dbmcp.health "db-mcp respondendo"
  else
    flunk dbmcp.health "db-mcp não responde /health" "veja: docker service logs db-mcp_db-mcp --tail 50 (ou rode de novo a etapa 70)"
  fi
}

# /ready do cloudflared (--metrics na stack) só dá 200 com conexão ativa com a Cloudflare.
check_tunnel() {
  if docker run --rm --network infra_net "$HEALTH_IMAGE" \
       wget -qO- -T 5 http://cloudflared_cloudflared:2000/ready >/dev/null 2>&1; then
    pass cloudflared.connected "túnel da Cloudflare conectado"
  else
    flunk cloudflared.connected "túnel da Cloudflare desconectado" \
      "veja: docker service logs cloudflared_cloudflared --tail 50 (ou rode de novo a etapa 30)"
  fi
}

main() {
  set +e   # uma checagem que quebra vira item vermelho, nunca aborta o JSON
  CHECKS_FILE="$(mktemp)"
  trap 'rm -f "$CHECKS_FILE"' EXIT
  if [ -f "$KIT_ENV" ]; then   # sem kit.env, as checagens acusam
    set -a
    # shellcheck disable=SC1090
    . "$KIT_ENV"
    set +a
  fi
  check_ssh
  check_ufw
  check_docker_user
  check_published_ports
  check_env_secrets
  check_drift
  check_replicas
  check_backup
  check_dbmcp_health
  check_tunnel
  local report
  report="$(render_report < "$CHECKS_FILE")"
  printf '%s\n' "$report"
  [ "$(jq -r .ok <<<"$report")" = "true" ]
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
