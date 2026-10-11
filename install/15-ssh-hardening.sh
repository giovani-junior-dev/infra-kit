#!/usr/bin/env bash
# Etapa 15 — SSH só por chave, sem root, porta configurável, UFW. Lição L3.
#
# Trava anti-lockout em 3 tempos:
#   1. sem argumento: aplica com o sshd escutando na 22 E na porta nova (22 aberta
#      no UFW), grava o marcador
#      state/15-ssh-hardening.pending e imprime o comando de teste;
#   2. o chamador abre uma NOVA conexão com esse comando;
#   3a. funcionou → `15-ssh-hardening.sh --confirm` tira a 22 do sshd e do UFW e conclui;
#   3b. falhou    → `15-ssh-hardening.sh --rollback` remove o drop-in e volta ao SSH antigo.
# Sessões abertas não caem em nenhum dos passos. Se ninguém confirmar em
# 10 min (ex.: o chamador perdeu toda conexão), um timer systemd roda o
# --rollback sozinho; o --confirm cancela esse timer.
#
# ATENÇÃO: o usuário admin tem sudo sem senha (etapa 10), então a chave SSH
# dele equivale à chave de root do servidor. Guarde-a com senha (passphrase)
# e nunca a copie para outra máquina ou repositório.
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DROPIN=/etc/ssh/sshd_config.d/00-infra-kit.conf
PENDING_NAME=15-ssh-hardening.pending
ROLLBACK_UNIT=infra-kit-ssh-rollback
ROLLBACK_DELAY=10min

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
# Uso: render_sshd_dropin <porta> <usuario> [porta_extra]. A porta extra (22)
# só existe enquanto o hardening está pendente: se o provedor bloquear a porta
# nova, o aluno ainda entra pela 22 com a chave.
render_sshd_dropin() {
  local port="$1" user="$2" extra="${3:-}"
  cat <<EOF
# gerado pelo infra-kit (install/15-ssh-hardening.sh)
Port ${port}
${extra:+Port ${extra}
}PermitRootLogin no
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

# Argumentos do systemd-run que agenda o rollback automático, um por linha.
# Uso: rollback_timer_args <caminho absoluto deste script>
rollback_timer_args() {
  printf '%s
' "--on-active=${ROLLBACK_DELAY}" "--unit=${ROLLBACK_UNIT}" "$1" --rollback
}

# Reaplicar substitui o timer anterior (unit transitória não aceita nome repetido).
schedule_rollback() {
  local args=()
  cancel_rollback
  systemctl reset-failed "${ROLLBACK_UNIT}.service" >/dev/null 2>&1 || true
  mapfile -t args < <(rollback_timer_args "$(readlink -f "$0")")
  systemd-run "${args[@]}" >/dev/null
}

cancel_rollback() {
  systemctl stop "${ROLLBACK_UNIT}.timer" >/dev/null 2>&1 || true
}

# Ubuntu 24.04 e 26.04 ativam o sshd por socket: a porta vem do sshd_config via
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

effective() { ensure_sshd_privsep_dir; sshd -T 2>/dev/null | awk -v k="$1" '$1 == k {print $2; exit}'; }
effective_ports() { ensure_sshd_privsep_dir; sshd -T 2>/dev/null | awk '$1 == "port" {print $2}'; }

check_admin_key() {
  local keys
  keys="$(getent passwd "$KIT_ADMIN_USER" | cut -d: -f6)/.ssh/authorized_keys"
  [ -s "$keys" ] || fail "$KIT_ADMIN_USER sem chave em $keys: rode a etapa 10 antes (evita lockout)" "$EXIT_PRECONDITION"
}

# Uso: pending_extra_port → imprime 22 enquanto o hardening não foi confirmado.
pending_extra_port() {
  step_done 15-ssh-hardening || [ "$KIT_SSH_PORT" = "22" ] || echo 22
}

setup_ufw() {
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  [ -z "$(pending_extra_port)" ] || ufw allow 22/tcp >/dev/null   # até o --confirm
  ufw allow "${KIT_SSH_PORT}/tcp" >/dev/null
  ufw --force enable >/dev/null
}

do_apply() {
  check_admin_key
  setup_ufw                            # porta liberada ANTES de mudar o sshd
  local tmp changed=0
  mkdir -p "$KIT_STATE"
  tmp="$(mktemp)"
  render_sshd_dropin "$KIT_SSH_PORT" "$KIT_ADMIN_USER" "$(pending_extra_port)" > "$tmp"
  if ! [ -f "$DROPIN" ] || ! cmp -s "$tmp" "$DROPIN"; then
    [ -f "$DROPIN" ] && cp -p "$DROPIN" "$KIT_STATE/00-infra-kit.conf.prev"
    install -m 644 "$tmp" "$DROPIN"
    changed=1
  fi
  rm -f "$tmp"
  ensure_sshd_privsep_dir
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
  schedule_rollback
  local host="${KIT_SERVER_HOST:-$(hostname -I | awk '{print $1}')}"
  log "Teste agora numa NOVA conexão (não feche esta):"
  render_test_command "$KIT_ADMIN_USER" "$host" "$KIT_SSH_PORT"
  log "Funcionou → $0 --confirm   ·   Falhou → $0 --rollback"
  warn "sem --confirm em ${ROLLBACK_DELAY}, o rollback roda sozinho (${ROLLBACK_UNIT}.timer)"
}

do_confirm() {
  [ -f "$KIT_STATE/$PENDING_NAME" ] || step_done 15-ssh-hardening ||
    fail "nada para confirmar: rode a etapa sem argumento antes" "$EXIT_PRECONDITION"
  verify_sshd
  cancel_rollback
  local tmp
  tmp="$(mktemp)"
  render_sshd_dropin "$KIT_SSH_PORT" "$KIT_ADMIN_USER" > "$tmp"
  if ! cmp -s "$tmp" "$DROPIN"; then
    install -m 644 "$tmp" "$DROPIN"
    ensure_sshd_privsep_dir; sshd -t || { rm -f "$tmp"; fail "sshd -t recusou a configuração final; NÃO feche esta sessão" "$EXIT_FAIL"; }
    apply_sshd
  fi
  rm -f "$tmp"
  [ "$KIT_SSH_PORT" = "22" ] || ufw delete allow 22/tcp >/dev/null 2>&1 || true
  rm -f "$KIT_STATE/$PENDING_NAME"
  mark_done 15-ssh-hardening
  ok "ssh: hardening confirmado; só a porta $KIT_SSH_PORT aberta no UFW"
}

do_rollback() {
  # Só o .timer: quando roda pelo timer, parar o .service mataria este processo.
  cancel_rollback
  ufw allow 22/tcp >/dev/null 2>&1 || true
  if [ -f "$KIT_STATE/00-infra-kit.conf.prev" ]; then
    install -m 644 "$KIT_STATE/00-infra-kit.conf.prev" "$DROPIN"
  else
    rm -f "$DROPIN"
  fi
  ensure_sshd_privsep_dir; sshd -t || fail "sshd -t falhou após o rollback; NÃO feche esta sessão" "$EXIT_FAIL"
  apply_sshd
  rm -f "$KIT_STATE/$PENDING_NAME" "$KIT_STATE/15-ssh-hardening.done"
  ok "ssh: rollback feito; configuração anterior em uso"
}

verify_sshd() {
  grep -qx "$KIT_SSH_PORT" <<<"$(effective_ports)" || fail "sshd efetivo não está na porta $KIT_SSH_PORT" "$EXIT_FAIL"
  [ "$(effective permitrootlogin)" = "no" ] || fail "PermitRootLogin efetivo não é no" "$EXIT_FAIL"
  [ "$(effective passwordauthentication)" = "no" ] || fail "PasswordAuthentication efetivo não é no" "$EXIT_FAIL"
  [ "$(effective kbdinteractiveauthentication)" = "no" ] || fail "KbdInteractiveAuthentication efetivo não é no" "$EXIT_FAIL"
  [ -n "$(ss -ltnH "sport = :$KIT_SSH_PORT")" ] || fail "nada escutando na porta $KIT_SSH_PORT" "$EXIT_FAIL"
  grep -qE "^${KIT_SSH_PORT}/tcp +ALLOW" <<<"$(ufw status)" || fail "UFW sem regra para $KIT_SSH_PORT/tcp" "$EXIT_FAIL"
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
