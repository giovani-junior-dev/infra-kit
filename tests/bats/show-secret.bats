#!/usr/bin/env bats

@test "show-secret exige --mostrar e não chama o docker sem ele" {
  mkdir -p "$BATS_TEST_TMPDIR/bin"
  printf '#!/bin/sh\necho chamou >> "%s/docker.log"\n' "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/bin/docker"
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  PATH="$BATS_TEST_TMPDIR/bin:$PATH" run "$BATS_TEST_DIRNAME/../../install/ops/show-secret.sh" backup_reader_pw_prod
  [ "$status" -eq 2 ]
  [[ "$output" == *"--mostrar"* ]]
  [ ! -f "$BATS_TEST_TMPDIR/docker.log" ]
}

@test "show-secret recusa nome de secret inválido" {
  run "$BATS_TEST_DIRNAME/../../install/ops/show-secret.sh" 'x;rm' --mostrar
  [ "$status" -eq 2 ]
}
