#!/usr/bin/env bash
# Etapa 15 — SSH só por chave, sem root, porta configurável, UFW. Lição L3.
#
# Trava anti-lockout em 3 tempos:
#   1. sem argumento: aplica, deixa a porta 22 aberta no UFW, grava o marcador
#      state/15-ssh-hardening.pending e imprime o comando de teste;
#   2. o chamador abre uma NOVA conexão com esse comando;
#   3a. funcionou → `15-ssh-hardening.sh --confirm` fecha a 22 e conclui;
#   3b. falhou    → `15-ssh-hardening.sh --rollback` remove o drop-in e volta ao SSH antigo.
# Sessões abertas não caem em nenhum dos passos.
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DROPIN=/etc/ssh/sshd_config.d/00-infra-kit.conf
PENDING_NAME=15-ssh-hardening.pending

usage() {
  cat <<'EOF'
uso: 15-ssh-hardening.sh [--confirm | --rollback | --help]
  (sem argumento)  aplica o hardening e imprime o comando de teste
  --confirm        nova conexão testada: fecha a porta 22 e conclui a etapa
  --rollback       remove o hardening e volta ao SSH anterior
EOF
}

# Uso: parse_args "$@" → imprime apply|confirm|rollback|help; argumento inválido sai com 2.
parse_args() {
  [ "$#" -le 1 ] || { usage >&2; return "$EXIT_CONFIG"; }
  case "${1:-}" in
    "")          echo apply ;;
    --confirm)   echo confirm ;;
    --rollback)  echo rollback ;;
    -h|--help)   echo help ;;
    *)           usage >&2; return "$EXIT_CONFIG" ;;
  esac
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# O drop-in 00- vence os arquivos do cloud-init: no sshd o 1º valor lido vale.
render_sshd_dropin() {
  local port="$1" user="$2"
  cat <<EOF
# gerado pelo infra-kit (install/15-ssh-hardening.sh)
Port ${port}
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers ${user}
EOF
}

# Uso: render_test_command <usuario> <host> <porta>
render_test_command() {
  printf 'ssh -p %s -o PreferredAuthentications=publickey -o PasswordAuthentication=no -o StrictHostKeyChecking=accept-new %s@%s sudo -n true\n' "$3" "$1" "$2"
}

# Ubuntu 24.04 ativa o sshd por socket: a porta vem do sshd_config via
# sshd-socket-generator e só muda com daemon-reload + restart do ssh.socket
# (debian/README.Debian do pacote openssh no Ubuntu noble).
apply_sshd() {
  if systemctl is-enabled --quiet ssh.socket 2>/dev/null; then
    systemctl daemon-reload
    systemctl restart ssh.socket
  else
    systemctl restart ssh.service
  fi
}

effective() { sshd -T 2>/dev/null | awk -v k="$1" '$1 == k {print $2; exit}'; }

check_admin_key() {
  local keys
  keys="$(getent passwd "$KIT_ADMIN_USER" | cut -d: -f6)/.ssh/authorized_keys"
  [ -s "$keys" ] || fail "$KIT_ADMIN_USER sem chave em $keys: rode a etapa 10 antes (evita lockout)" "$EXIT_PRECONDITION"
}

setup_ufw() {
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null          # fica até o --confirm (sessão atual)
  ufw allow "${KIT_SSH_PORT}/tcp" >/dev/null
  ufw --force enable >/dev/null
}

do_apply() {
  check_admin_key
  setup_ufw                            # porta liberada ANTES de mudar o sshd
  local tmp changed=0
  mkdir -p "$KIT_STATE"
  tmp="$(mktemp)"
  render_sshd_dropin "$KIT_SSH_PORT" "$KIT_ADMIN_USER" > "$tmp"
  if ! [ -f "$DROPIN" ] || ! cmp -s "$tmp" "$DROPIN"; then
    [ -f "$DROPIN" ] && cp -p "$DROPIN" "$KIT_STATE/00-infra-kit.conf.prev"
    install -m 644 "$tmp" "$DROPIN"
    changed=1
  fi
  rm -f "$tmp"
  if ! sshd -t; then
    do_rollback
    fail "sshd -t recusou a configuração; nada foi recarregado" "$EXIT_FAIL"
  fi
  [ "$changed" -eq 1 ] && apply_sshd
  verify_sshd
  if step_done 15-ssh-hardening && [ "$changed" -eq 0 ]; then
    ok "ssh: hardening já aplicado e confirmado"
    return 0
  fi
  mkdir -p "$KIT_STATE"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$KIT_STATE/$PENDING_NAME"
  local host="${KIT_SERVER_HOST:-$(hostname -I | awk '{print $1}')}"
  log "Teste agora numa NOVA conexão (não feche esta):"
  render_test_command "$KIT_ADMIN_USER" "$host" "$KIT_SSH_PORT"
  log "Funcionou → $0 --confirm   ·   Falhou → $0 --rollback"
}

do_confirm() {
  [ -f "$KIT_STATE/$PENDING_NAME" ] || step_done 15-ssh-hardening ||
    fail "nada para confirmar: rode a etapa sem argumento antes" "$EXIT_PRECONDITION"
  verify_sshd
  [ "$KIT_SSH_PORT" = "22" ] || ufw delete allow 22/tcp >/dev/null 2>&1 || true
  rm -f "$KIT_STATE/$PENDING_NAME"
  mark_done 15-ssh-hardening
  ok "ssh: hardening confirmado; só a porta $KIT_SSH_PORT aberta no UFW"
}

do_rollback() {
  ufw allow 22/tcp >/dev/null 2>&1 || true
  if [ -f "$KIT_STATE/00-infra-kit.conf.prev" ]; then
    install -m 644 "$KIT_STATE/00-infra-kit.conf.prev" "$DROPIN"
  else
    rm -f "$DROPIN"
  fi
  sshd -t || fail "sshd -t falhou após o rollback; NÃO feche esta sessão" "$EXIT_FAIL"
  apply_sshd
  rm -f "$KIT_STATE/$PENDING_NAME" "$KIT_STATE/15-ssh-hardening.done"
  ok "ssh: rollback feito; configuração anterior em uso"
}

verify_sshd() {
  [ "$(effective port)" = "$KIT_SSH_PORT" ] || fail "sshd efetivo não está na porta $KIT_SSH_PORT" "$EXIT_FAIL"
  [ "$(effective permitrootlogin)" = "no" ] || fail "PermitRootLogin efetivo não é no" "$EXIT_FAIL"
  [ "$(effective passwordauthentication)" = "no" ] || fail "PasswordAuthentication efetivo não é no" "$EXIT_FAIL"
  [ "$(effective kbdinteractiveauthentication)" = "no" ] || fail "KbdInteractiveAuthentication efetivo não é no" "$EXIT_FAIL"
  ss -ltnH "sport = :$KIT_SSH_PORT" | grep -q . || fail "nada escutando na porta $KIT_SSH_PORT" "$EXIT_FAIL"
  ufw status | grep -qE "^${KIT_SSH_PORT}/tcp +ALLOW" || fail "UFW sem regra para $KIT_SSH_PORT/tcp" "$EXIT_FAIL"
}

main() {
  local action
  action="$(parse_args "$@")"
  [ "$action" = help ] && { usage; return 0; }
  require_root
  load_env
  require_var KIT_SSH_PORT KIT_ADMIN_USER
  valid_port "$KIT_SSH_PORT" || fail "KIT_SSH_PORT=$KIT_SSH_PORT inválida" "$EXIT_CONFIG"
  "do_$action"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
