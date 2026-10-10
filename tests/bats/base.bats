#!/usr/bin/env bats
load helpers

setup() { load_step 10-base.sh; }

@test "swap_size_mb: 4 GB abaixo de 4 GB de RAM, 2 GB acima" {
  [ "$(swap_size_mb 1900)" = 4096 ]
  [ "$(swap_size_mb 3800)" = 4096 ]
  [ "$(swap_size_mb 8000)" = 2048 ]
}

@test "valid_pubkey aceita ed25519 com comentário" {
  run valid_pubkey "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB5x aluno@pc"
  [ "$status" -eq 0 ]
}

@test "valid_pubkey recusa tipo desconhecido, vazio e várias linhas" {
  run valid_pubkey "ssh-dss AAAAB3 velho"
  [ "$status" -ne 0 ]
  run valid_pubkey ""
  [ "$status" -ne 0 ]
  run valid_pubkey $'ssh-ed25519 AAAA a\nssh-ed25519 BBBB b'
  [ "$status" -ne 0 ]
}

@test "valid_username recusa root e nomes inválidos" {
  run valid_username deploy;  [ "$status" -eq 0 ]
  run valid_username root;    [ "$status" -ne 0 ]
  run valid_username 'a b';   [ "$status" -ne 0 ]
  run valid_username Deploy;  [ "$status" -ne 0 ]
}

@test "render_fail2ban_jail cobre a 22 e a porta final" {
  run render_fail2ban_jail 2222
  [[ "$output" == *"port = 22,2222"* ]]
  [[ "$output" == *"enabled = true"* ]]
}

@test "render_auto_upgrades liga update e unattended-upgrade" {
  run render_auto_upgrades
  [[ "$output" == *'Unattended-Upgrade "1"'* ]]
}

@test "render_sudoers: NOPASSWD só para o usuário admin" {
  [ "$(render_sudoers deploy)" = "deploy ALL=(ALL) NOPASSWD:ALL" ]
}

@test "ensure_line não duplica (fstab, authorized_keys)" {
  f="$BATS_TEST_TMPDIR/fstab"
  ensure_line "/swapfile none swap sw 0 0" "$f"
  ensure_line "/swapfile none swap sw 0 0" "$f"
  [ "$(grep -c swapfile "$f")" -eq 1 ]
}

@test "write_if_changed grava com o modo, depois detecta conteúdo igual" {
  f="$BATS_TEST_TMPDIR/sub/a.conf"
  rc=0; echo x | write_if_changed "$f" 600 || rc=$?
  [ "$rc" -eq 0 ]
  [ "$(stat -c %a "$f")" = "600" ]
  rc=0; echo x | write_if_changed "$f" || rc=$?
  [ "$rc" -eq 1 ]
  rc=0; echo y | write_if_changed "$f" || rc=$?
  [ "$rc" -eq 0 ]
  [ "$(cat "$f")" = y ]
}
