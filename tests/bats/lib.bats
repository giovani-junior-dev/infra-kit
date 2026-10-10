#!/usr/bin/env bats

setup() {
  export KIT_DIR="$BATS_TEST_TMPDIR/kit"
  export KIT_ENV="$KIT_DIR/kit.env"
  export KIT_STATE="$KIT_DIR/state"
  source "$BATS_TEST_DIRNAME/../../install/lib.sh"
  set +e  # lib liga errexit; bats controla falhas
}

@test "load_env falha com código 2 quando kit.env não existe" {
  run load_env
  [ "$status" -eq 2 ]
  [[ "$output" == *"kit.env não encontrado"* ]]
}

@test "set_env_var cria e atualiza sem duplicar, com permissão 600" {
  set_env_var KIT_DOMAIN a.com
  set_env_var KIT_DOMAIN b.com
  [ "$(grep -c '^KIT_DOMAIN=' "$KIT_ENV")" -eq 1 ]
  grep -q '^KIT_DOMAIN=b.com$' "$KIT_ENV"
  [ "$(stat -c %a "$KIT_ENV")" = "600" ]
}

@test "load_env + require_var aceita variável preenchida" {
  set_env_var KIT_DOMAIN a.com
  load_env
  run require_var KIT_DOMAIN
  [ "$status" -eq 0 ]
}

@test "require_var falha com código 2 e nomeia a variável vazia" {
  set_env_var KIT_DOMAIN a.com
  load_env
  run require_var KIT_DOMAIN KIT_OWNER_EMAIL
  [ "$status" -eq 2 ]
  [[ "$output" == *"KIT_OWNER_EMAIL"* ]]
}

@test "mark_done e step_done marcam etapa concluída" {
  run step_done 10-base
  [ "$status" -ne 0 ]
  mark_done 10-base
  run step_done 10-base
  [ "$status" -eq 0 ]
}
