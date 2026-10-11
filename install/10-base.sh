#!/usr/bin/env bash
# Etapa 10 — base do sistema: atualizações, updates de segurança automáticos,
# fail2ban, chrony, fuso, swap e o usuário administrador com chave SSH.
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SWAPFILE=/swapfile
export DEBIAN_FRONTEND=noninteractive
APT_OPTS=(-y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# Swap em MB conforme a RAM (lição L8: build OOM em VPS pequena). Uso: swap_size_mb <mem_mb>
swap_size_mb() {
  if [ "$1" -lt 4096 ]; then echo 4096; else echo 2048; fi
}

# Aceita só uma linha de chave pública OpenSSH. Uso: valid_pubkey "<chave>"
valid_pubkey() {
  local key="$1"
  [ "$(printf '%s' "$key" | wc -l)" -eq 0 ] &&
    [[ "$key" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\ [A-Za-z0-9+/=]+(\ .*)?$ ]]
}

# Nome de usuário Linux válido e diferente de root. Uso: valid_username <nome>
valid_username() {
  [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [ "$1" != "root" ]
}

# Updates automáticos. O 50unattended-upgrades padrão do Ubuntu já restringe
# as origens a -security; aqui só ligamos o agendamento diário.
render_auto_upgrades() {
  cat <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
}

# Jail do sshd. Cobre a porta 22 e a porta final para valer antes e depois da etapa 15.
render_fail2ban_jail() {
  local port="$1"
  cat <<EOF
# gerado pelo infra-kit (install/10-base.sh)
[sshd]
enabled = true
backend = systemd
port = 22,${port}
EOF
}

render_sudoers() {
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$1"
}

install_packages() {
  apt-get update -qq
  apt-get full-upgrade "${APT_OPTS[@]}"
  apt-get install "${APT_OPTS[@]}" unattended-upgrades fail2ban python3-systemd chrony ufw sudo unzip
}

setup_auto_upgrades() {
  render_auto_upgrades | write_if_changed /etc/apt/apt.conf.d/20auto-upgrades || true
  systemctl enable --now unattended-upgrades >/dev/null
}

setup_fail2ban() {
  if render_fail2ban_jail "$KIT_SSH_PORT" | write_if_changed /etc/fail2ban/jail.d/00-infra-kit.local; then
    systemctl enable fail2ban >/dev/null
    systemctl restart fail2ban
  else
    systemctl enable --now fail2ban >/dev/null
  fi
}

setup_time() {
  local tz="${KIT_TZ:-America/Sao_Paulo}"
  [ -f "/usr/share/zoneinfo/$tz" ] || fail "fuso KIT_TZ=$tz não existe" "$EXIT_CONFIG"
  [ "$(timedatectl show -p Timezone --value)" = "$tz" ] || timedatectl set-timezone "$tz"
  systemctl enable --now chrony >/dev/null
}

setup_swap() {
  if [ -n "$(swapon --show --noheadings)" ]; then
    log "swap já existe; mantida"
    return 0
  fi
  local mem_mb
  mem_mb="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)"
  [ -f "$SWAPFILE" ] || fallocate -l "$(swap_size_mb "$mem_mb")M" "$SWAPFILE"
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE" >/dev/null
  swapon "$SWAPFILE"
  ensure_line "$SWAPFILE none swap sw 0 0" /etc/fstab
}

setup_admin_user() {
  local user="$KIT_ADMIN_USER" home ssh_dir
  valid_username "$user" || fail "KIT_ADMIN_USER=$user inválido (minúsculas, sem root)" "$EXIT_CONFIG"
  valid_pubkey "$KIT_ADMIN_PUBKEY" || fail "KIT_ADMIN_PUBKEY não é uma chave pública OpenSSH de uma linha" "$EXIT_CONFIG"
  id "$user" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$user" >/dev/null
  usermod -aG sudo "$user"
  # Sem senha (login só por chave), então o sudo não pode pedir senha.
  local sudoers="/etc/sudoers.d/90-infra-kit-$user" tmp
  tmp="$(mktemp)"
  render_sudoers "$user" > "$tmp"
  visudo -cqf "$tmp" || fail "sudoers gerado inválido" "$EXIT_FAIL"
  write_if_changed "$sudoers" 440 < "$tmp" || true
  rm -f "$tmp"
  home="$(getent passwd "$user" | cut -d: -f6)"
  ssh_dir="$home/.ssh"
  install -d -m 700 -o "$user" -g "$user" "$ssh_dir"
  ensure_line "$KIT_ADMIN_PUBKEY" "$ssh_dir/authorized_keys"
  chown "$user:$user" "$ssh_dir/authorized_keys"
  chmod 600 "$ssh_dir/authorized_keys"
}

verify() {
  local tz="${KIT_TZ:-America/Sao_Paulo}"
  grep -q -- '-security' /etc/apt/apt.conf.d/50unattended-upgrades ||
    fail "unattended-upgrades sem a origem -security" "$EXIT_FAIL"
  systemctl is-active --quiet fail2ban || fail "fail2ban parado" "$EXIT_FAIL"
  fail2ban-client status sshd >/dev/null || fail "jail sshd do fail2ban inativa" "$EXIT_FAIL"
  systemctl is-active --quiet chrony || fail "chrony parado" "$EXIT_FAIL"
  [ "$(timedatectl show -p Timezone --value)" = "$tz" ] || fail "fuso diferente de $tz" "$EXIT_FAIL"
  [ -n "$(swapon --show --noheadings)" ] || fail "sem swap ativa" "$EXIT_FAIL"
  grep -qw sudo <<<"$(id -nG "$KIT_ADMIN_USER")" || fail "$KIT_ADMIN_USER fora do grupo sudo" "$EXIT_FAIL"
  grep -qxF "$KIT_ADMIN_PUBKEY" "$(getent passwd "$KIT_ADMIN_USER" | cut -d: -f6)/.ssh/authorized_keys" ||
    fail "chave pública ausente em authorized_keys" "$EXIT_FAIL"
}

main() {
  require_root
  load_env
  require_var KIT_ADMIN_USER KIT_ADMIN_PUBKEY KIT_SSH_PORT
  install_packages
  setup_auto_upgrades
  setup_fail2ban
  setup_time
  setup_swap
  setup_admin_user
  verify
  mark_done 10-base
  ok "base: sistema atualizado, fail2ban, chrony, swap e usuário $KIT_ADMIN_USER prontos"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
