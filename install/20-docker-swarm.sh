#!/usr/bin/env bash
# Etapa 20 — Docker CE (repo oficial), rotação de log, Swarm, rede infra_net e
# bloqueio de entrada externa para containers na chain DOCKER-USER (lição L4:
# portas publicadas pelo Docker passam por fora do UFW).
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

export DEBIAN_FRONTEND=noninteractive
DOCKER_KEYRING=/etc/apt/keyrings/docker.asc
DOCKER_SOURCES=/etc/apt/sources.list.d/docker.sources
DAEMON_JSON=/etc/docker/daemon.json
RULES_BIN=/usr/local/sbin/infra-kit-docker-user
UNIT=infra-kit-docker-user.service
NETWORK=infra_net
CHAIN=INFRA-KIT-INGRESS

# Formato deb822 da doc oficial: docs.docker.com/engine/install/ubuntu/
render_docker_sources() {
  local codename="$1" arch="$2"
  cat <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${codename}
Components: stable
Architectures: ${arch}
Signed-By: ${DOCKER_KEYRING}
EOF
}

# log-opts precisam ser strings (docs.docker.com/engine/logging/drivers/json-file/).
render_daemon_json() {
  cat <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  }
}
EOF
}

# Interface e IP de saída a partir de `ip -4 route get 1.1.1.1`.
# Uso: route_field dev|src <saída>
route_field() {
  awk -v k="$1" '{for (i = 1; i < NF; i++) if ($i == k) {print $(i + 1); exit}}' <<<"$2"
}

# Script idempotente que o unit systemd roda após o docker. Usa uma chain
# própria (recriada a cada execução) e um único jump no topo da DOCKER-USER.
# Pacotes de conexões já estabelecidas passam; o resto que entra pela
# interface pública rumo a container cai.
render_rules_script() {
  local iface="$1"
  cat <<EOF
#!/bin/sh
# gerado pelo infra-kit (install/20-docker-swarm.sh) — não editar à mão
set -eu
for ipt in iptables ip6tables; do
  \$ipt -n -L DOCKER-USER >/dev/null 2>&1 || continue
  \$ipt -N ${CHAIN} 2>/dev/null || \$ipt -F ${CHAIN}
  \$ipt -A ${CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  \$ipt -A ${CHAIN} -j DROP
  \$ipt -C DOCKER-USER -i ${iface} -j ${CHAIN} 2>/dev/null ||
    \$ipt -I DOCKER-USER 1 -i ${iface} -j ${CHAIN}
done
EOF
}

render_unit() {
  cat <<EOF
[Unit]
Description=infra-kit: bloqueia entrada externa para containers (DOCKER-USER)
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${RULES_BIN}

[Install]
WantedBy=docker.service
EOF
}

install_docker() {
  if dpkg -s docker.io >/dev/null 2>&1; then
    fail "pacote docker.io do Ubuntu instalado; remova (apt-get remove docker.io) e rode de novo" "$EXIT_PRECONDITION"
  fi
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  if [ ! -s "$DOCKER_KEYRING" ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$DOCKER_KEYRING"
    chmod a+r "$DOCKER_KEYRING"
  fi
  local codename
  codename="$(sed -n 's/^UBUNTU_CODENAME=//p' /etc/os-release | tr -d '"')"
  if render_docker_sources "$codename" "$(dpkg --print-architecture)" | write_if_changed "$DOCKER_SOURCES"; then
    apt-get update -qq
  fi
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null
}

setup_daemon_json() {
  [ -f "$DAEMON_JSON" ] && ! render_daemon_json | cmp -s - "$DAEMON_JSON" &&
    cp -p "$DAEMON_JSON" "$DAEMON_JSON.infra-kit.bak" &&
    warn "daemon.json existente salvo em $DAEMON_JSON.infra-kit.bak"
  if render_daemon_json | write_if_changed "$DAEMON_JSON"; then
    systemctl restart docker
  fi
}

setup_swarm() {
  local route addr
  route="$(ip -4 route get 1.1.1.1)"
  addr="${KIT_ADVERTISE_ADDR:-$(route_field src "$route")}"
  if [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" != "active" ]; then
    docker swarm init --advertise-addr "$addr" >/dev/null
  fi
  if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
    docker network create --driver overlay --attachable "$NETWORK" >/dev/null
  fi
}

setup_docker_user() {
  local iface
  iface="${KIT_PUBLIC_IFACE:-$(route_field dev "$(ip -4 route get 1.1.1.1)")}"
  [ -n "$iface" ] || fail "não achei a interface pública; defina KIT_PUBLIC_IFACE" "$EXIT_CONFIG"
  set_env_var KIT_PUBLIC_IFACE "$iface"
  render_rules_script "$iface" | write_if_changed "$RULES_BIN" 755 || true
  if render_unit | write_if_changed "/etc/systemd/system/$UNIT"; then
    systemctl daemon-reload
  fi
  systemctl enable "$UNIT" >/dev/null
  systemctl restart "$UNIT"
}

verify() {
  local iface
  iface="$(sed -n 's/^KIT_PUBLIC_IFACE=//p' "$KIT_ENV")"
  docker version --format '{{.Server.Version}}' >/dev/null || fail "dockerd não responde" "$EXIT_FAIL"
  [ "$(docker info --format '{{.LoggingDriver}}')" = "json-file" ] || fail "log driver não é json-file" "$EXIT_FAIL"
  [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" = "active" ] || fail "swarm inativo" "$EXIT_FAIL"
  [ "$(docker network inspect -f '{{.Driver}} {{.Attachable}}' "$NETWORK")" = "overlay true" ] ||
    fail "$NETWORK não é overlay attachable" "$EXIT_FAIL"
  systemctl is-active --quiet "$UNIT" || fail "$UNIT inativo" "$EXIT_FAIL"
  iptables -C DOCKER-USER -i "$iface" -j "$CHAIN" || fail "jump para $CHAIN ausente na DOCKER-USER" "$EXIT_FAIL"
  iptables -C "$CHAIN" -j DROP || fail "regra DROP ausente em $CHAIN" "$EXIT_FAIL"
}

main() {
  require_root
  load_env
  install_docker
  setup_daemon_json
  setup_swarm
  setup_docker_user
  verify
  mark_done 20-docker-swarm
  ok "docker: CE $(docker version --format '{{.Server.Version}}'), swarm ativo, $NETWORK e DOCKER-USER prontos"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
