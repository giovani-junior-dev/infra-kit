#!/usr/bin/env bash
# Etapa 00 — confere se o servidor serve para o kit. Só lê; não muda nada,
# exceto instalar o dig (bind9-dnsutils) se faltar.
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MIN_CPUS=2
MIN_DISK_GB=35   # VPS "40 GB" reporta ~38 GB úteis em /
REC_MEM_MB=3500  # VPS "4 GB" reporta ~3.8 GB em MemTotal

# Lê um os-release e confirma Ubuntu 24.04. Uso: check_os [arquivo]
check_os() {
  local file="${1:-/etc/os-release}" id version
  id="$(sed -n 's/^ID=//p' "$file" | tr -d '"')"
  version="$(sed -n 's/^VERSION_ID=//p' "$file" | tr -d '"')"
  [ "$id" = "ubuntu" ] && [ "$version" = "24.04" ] ||
    fail "sistema ${id:-?} ${version:-?} não suportado: o kit só roda em Ubuntu 24.04" "$EXIT_PRECONDITION"
}

# Avalia recursos. Uso: check_resources <cpus> <mem_mb> <disk_gb>
# CPU ou disco abaixo do mínimo abortam; RAM abaixo do recomendado só avisa.
check_resources() {
  local cpus="$1" mem_mb="$2" disk_gb="$3"
  [ "$cpus" -ge "$MIN_CPUS" ] || fail "$cpus vCPU; mínimo $MIN_CPUS" "$EXIT_PRECONDITION"
  [ "$disk_gb" -ge "$MIN_DISK_GB" ] || fail "${disk_gb} GB de disco em /; mínimo 40 GB" "$EXIT_PRECONDITION"
  if [ "$mem_mb" -lt "$REC_MEM_MB" ]; then
    warn "${mem_mb} MB de RAM; recomendado 4 GB ou mais. Postgres e builds podem faltar memória (a etapa 10 cria swap)."
  fi
}

# Confere se os NS da zona são da Cloudflare. Uso: ns_is_cloudflare <saída do dig +short NS>
ns_is_cloudflare() {
  local ns="$1"
  [ -n "$ns" ] || return 1
  ! grep -vqiE '\.ns\.cloudflare\.com\.?$' <<<"$ns"
}

check_domain() {
  local domain="$1" ns
  command -v dig >/dev/null || apt-get install -y -qq bind9-dnsutils >/dev/null
  ns="$(dig +short NS "$domain" || true)"
  ns_is_cloudflare "$ns" ||
    fail "o domínio $domain não usa os nameservers da Cloudflare (achado: ${ns:-nenhum}). Veja docs/02-cloudflare.md" "$EXIT_PRECONDITION"
}

main() {
  require_root
  load_env
  require_var KIT_DOMAIN
  check_os
  check_resources "$(nproc)" \
    "$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)" \
    "$(df -BG --output=size / | tail -1 | tr -dc '0-9')"
  check_domain "$KIT_DOMAIN"
  mark_done 00-preflight
  ok "preflight: Ubuntu 24.04, recursos e DNS da Cloudflare conferidos"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
