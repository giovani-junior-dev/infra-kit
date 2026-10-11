#!/usr/bin/env bats
load helpers

setup() { load_step 15-ssh-hardening.sh; }

@test "parse_args: sem argumento aplica" {
  [ "$(parse_args)" = apply ]
}

@test "parse_args: --confirm, --rollback e --help" {
  [ "$(parse_args --confirm)" = confirm ]
  [ "$(parse_args --rollback)" = rollback ]
  [ "$(parse_args -h)" = help ]
}

@test "parse_args recusa argumento desconhecido ou extra com código 2" {
  run parse_args --force
  [ "$status" -eq 2 ]
  run parse_args --confirm --rollback
  [ "$status" -eq 2 ]
}

@test "render_sshd_dropin: porta, sem root, sem senha, AllowUsers" {
  run render_sshd_dropin 2222 deploy
  [[ "$output" == *$'\nPort 2222\n'* ]]
  [[ "$output" == *"PermitRootLogin no"* ]]
  [[ "$output" == *"PasswordAuthentication no"* ]]
  [[ "$output" == *"KbdInteractiveAuthentication no"* ]]
  [[ "$output" == *"AllowUsers deploy"* ]]
}

@test "render_test_command abre conexão nova só por chave na porta nova" {
  run render_test_command deploy 203.0.113.10 2222
  [ "$output" = "ssh -p 2222 -o PreferredAuthentications=publickey -o PasswordAuthentication=no -o StrictHostKeyChecking=accept-new deploy@203.0.113.10 sudo -n true" ]
}

@test "valid_port" {
  run valid_port 2222;  [ "$status" -eq 0 ]
  run valid_port 0;     [ "$status" -ne 0 ]
  run valid_port 70000; [ "$status" -ne 0 ]
  run valid_port abc;   [ "$status" -ne 0 ]
}

@test "rollback_timer_args agenda o --rollback em 10 min com unit fixa" {
  run rollback_timer_args /opt/infra-kit/install/15-ssh-hardening.sh
  [ "$output" = $'--on-active=10min\n--unit=infra-kit-ssh-rollback\n/opt/infra-kit/install/15-ssh-hardening.sh\n--rollback' ]
}

@test "rollback_timer_args preserva caminho com espaço como um argumento só" {
  mapfile -t args < <(rollback_timer_args "/opt/meu kit/15-ssh-hardening.sh")
  [ "${#args[@]}" -eq 4 ]
  [ "${args[2]}" = "/opt/meu kit/15-ssh-hardening.sh" ]
}

@test "o --rollback agendado é aceito pelo parse_args" {
  mapfile -t args < <(rollback_timer_args /x)
  [ "$(parse_args "${args[3]}")" = rollback ]
}

@test "render_sshd_dropin pendente escuta na porta nova e na 22" {
  run render_sshd_dropin 2222 deploy 22
  [ "$(grep -c '^Port ' <<<"$output")" -eq 2 ]
  [[ "$output" == *"Port 2222"* ]]
  [[ "$output" == *"Port 22"$'\n'* ]]
}

@test "render_sshd_dropin final tem só a porta nova" {
  run render_sshd_dropin 2222 deploy
  [ "$(grep -c '^Port ' <<<"$output")" -eq 1 ]
  [ "$(grep -c '^$' <<<"$output")" -eq 0 ]
}

@test "pending_extra_port: 22 até confirmar, nada depois" {
  export KIT_STATE="$BATS_TEST_TMPDIR/state" KIT_SSH_PORT=2222
  run pending_extra_port
  [ "$output" = "22" ]
  mark_done 15-ssh-hardening
  run pending_extra_port
  [ -z "$output" ]
}

@test "pending_extra_port: porta 22 configurada não duplica" {
  export KIT_STATE="$BATS_TEST_TMPDIR/state" KIT_SSH_PORT=22
  run pending_extra_port
  [ -z "$output" ]
}
