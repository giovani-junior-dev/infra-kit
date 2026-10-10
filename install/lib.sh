#!/usr/bin/env bash
# Funções comuns das etapas do infra-kit. Uso: source "$(dirname "$0")/lib.sh"
# Contrato: toda etapa é idempotente, termina com a própria verificação e
# nunca imprime segredo. Segredos vão para Docker secrets, não para kit.env.
set -euo pipefail

KIT_DIR="${KIT_DIR:-/opt/infra-kit}"
KIT_ENV="${KIT_ENV:-$KIT_DIR/kit.env}"
KIT_STATE="${KIT_STATE:-$KIT_DIR/state}"

# Códigos de saída padronizados (a skill /infra:verificar lê estes valores).
readonly EXIT_OK=0 EXIT_FAIL=1 EXIT_CONFIG=2 EXIT_PRECONDITION=3

log()  { printf '[infra-kit] %s\n' "$*"; }
ok()   { printf '[ok] %s\n' "$*"; }
warn() { printf '[aviso] %s\n' "$*" >&2; }
fail() { printf '[falha] %s\n' "$1" >&2; exit "${2:-$EXIT_FAIL}"; }

load_env() {
  [ -f "$KIT_ENV" ] || fail "kit.env não encontrado em $KIT_ENV (rode o /infra:instalar)" "$EXIT_CONFIG"
  # shellcheck disable=SC1090
  set -a; . "$KIT_ENV"; set +a
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
