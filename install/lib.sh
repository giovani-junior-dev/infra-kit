#!/usr/bin/env bash
# Funções comuns das etapas do infra-kit. Uso: source "$(dirname "$0")/lib.sh"
# Contrato: toda etapa é idempotente, termina com a própria verificação e
# nunca imprime segredo. Segredos vão para Docker secrets, não para kit.env.
set -euo pipefail

KIT_DIR="${KIT_DIR:-/opt/infra-kit}"
KIT_ENV="${KIT_ENV:-$KIT_DIR/kit.env}"
KIT_STATE="${KIT_STATE:-$KIT_DIR/state}"

# Códigos de saída padronizados (a skill /infra:verificar lê estes valores).
# shellcheck disable=SC2034  # usados pelas etapas que fazem source desta lib
readonly EXIT_OK=0 EXIT_FAIL=1 EXIT_CONFIG=2 EXIT_PRECONDITION=3

log()  { printf '[infra-kit] %s\n' "$*"; }
ok()   { printf '[ok] %s\n' "$*"; }
warn() { printf '[aviso] %s\n' "$*" >&2; }
fail() { printf '[falha] %s\n' "$1" >&2; exit "${2:-$EXIT_FAIL}"; }

load_env() {
  [ -f "$KIT_ENV" ] || fail "kit.env não encontrado em $KIT_ENV (rode o /infra:instalar)" "$EXIT_CONFIG"
  set -a
  # shellcheck disable=SC1090
  . "$KIT_ENV"
  set +a
}

require_var() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || fail "variável $name vazia no kit.env" "$EXIT_CONFIG"
  done
}

step_done() { [ -f "$KIT_STATE/$1.done" ]; }

mark_done() {
  mkdir -p "$KIT_STATE"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$KIT_STATE/$1.done"
}

# Grava/atualiza uma chave não secreta no kit.env sem duplicar a linha.
set_env_var() {
  local key="$1" value="$2"
  mkdir -p "$(dirname "$KIT_ENV")"
  touch "$KIT_ENV"; chmod 600 "$KIT_ENV"
  if grep -q "^${key}=" "$KIT_ENV"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$KIT_ENV"
  else
    printf '%s=%s\n' "$key" "$value" >> "$KIT_ENV"
  fi
}

require_root() { [ "$(id -u)" -eq 0 ] || fail "rode como root (sudo)" "$EXIT_PRECONDITION"; }

# Registro de quem consome cada credencial (lição L5). A rotação de senha
# percorre esta lista para atualizar todo mundo. Uso:
#   register_consumer <secret> <stack> <serviço> <role>
KIT_CONSUMERS="${KIT_CONSUMERS:-$KIT_DIR/consumers.json}"
register_consumer() {
  local secret="$1" stack="$2" service="$3" role="$4" tmp
  command -v jq >/dev/null || fail "jq não instalado" "$EXIT_PRECONDITION"
  mkdir -p "$(dirname "$KIT_CONSUMERS")"
  [ -s "$KIT_CONSUMERS" ] || printf '{"consumers":[]}\n' > "$KIT_CONSUMERS"
  tmp="$(mktemp)"
  jq --arg secret "$secret" --arg stack "$stack" --arg service "$service" --arg role "$role" '
    .consumers |= (map(select(.secret != $secret or .stack != $stack or .service != $service))
                   + [{secret: $secret, stack: $stack, service: $service, role: $role}]
                   | sort_by(.secret, .stack, .service))
  ' "$KIT_CONSUMERS" > "$tmp"
  mv "$tmp" "$KIT_CONSUMERS"
  chmod 600 "$KIT_CONSUMERS"
}

# Cria um Docker secret com valor aleatório gerado aqui, sem imprimir.
# Retorna 0 se criou, 1 se já existia (secrets do swarm são imutáveis).
create_random_secret() {
  local name="$1" bytes="${2:-32}"
  if docker secret inspect "$name" >/dev/null 2>&1; then return 1; fi
  openssl rand -hex "$bytes" | tr -d '\n' | docker secret create "$name" - >/dev/null
}

# Id do container da task em execução de um serviço do swarm (nó local).
service_container() {
  docker ps -q --filter "label=com.docker.swarm.service.name=$1" --filter status=running | head -n1
}

# Grava stdin em <arquivo> só se o conteúdo mudou. Retorna 0 se gravou, 1 se já
# estava igual — é o guard de idempotência das etapas (reload só quando muda).
write_if_changed() {
  local path="$1" mode="${2:-644}" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"; return 1
  fi
  mkdir -p "$(dirname "$path")"
  chmod "$mode" "$tmp"
  mv "$tmp" "$path"
}

# Acrescenta <linha> a <arquivo> se ela ainda não existir (linha inteira).
ensure_line() {
  local line="$1" path="$2"
  touch "$path"
  grep -qxF -- "$line" "$path" || printf '%s\n' "$line" >> "$path"
}

# Espera o serviço Swarm ter todas as réplicas rodando (o 1º pull pode demorar).
# Uso: wait_service_running <servico> [segundos, padrão 300]
wait_service_running() {
  local svc="$1" limit="${2:-300}" waited=0 reps
  while [ "$waited" -lt "$limit" ]; do
    reps="$(docker service ls --filter "name=$svc" --format '{{.Name}} {{.Replicas}}' | awk -v s="$svc" '$1 == s {print $2}')"
    if [ -n "$reps" ] && replicas_complete "$reps"; then return 0; fi
    sleep 5; waited=$((waited + 5))
  done
  fail "serviço $svc não ficou de pé em ${limit}s: veja 'docker service ps $svc --no-trunc'" "$EXIT_FAIL"
}

# Uso: replicas_complete "1/1" → 0 se rodando == desejado e desejado > 0.
replicas_complete() {
  local cur="${1%%/*}" want="${1#*/}"
  want="${want%% *}"
  [ "$want" -gt 0 ] 2>/dev/null && [ "$cur" = "$want" ]
}

# sshd -t/-T recusam rodar sem o diretório de privsep (/run/sshd). Com o sshd
# ativado por socket, ele some quando o ssh.service para (RuntimeDirectory),
# e o -T volta vazio. Uso: ensure_sshd_privsep_dir (antes de sshd -t ou -T).
ensure_sshd_privsep_dir() {
  install -d -m 0755 "${SSHD_PRIVSEP_DIR:-/run/sshd}"
}
