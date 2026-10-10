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
