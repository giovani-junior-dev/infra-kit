#!/usr/bin/env bats

load helpers

setup() {
  load_step ops/new-project.sh
}

@test "valid_ref aceita nome@hml e nome@prod" {
  valid_ref loja@hml
  valid_ref loja_2@prod
}

@test "valid_ref recusa env, nome e injeção" {
  ! valid_ref loja
  ! valid_ref loja@dev
  ! valid_ref 2loja@hml
  ! valid_ref "loja'; DROP TABLE agents;--@hml"
  ! valid_ref Loja@hml
}

@test "app_secret_name: app_<banco>_<env>_dsn" {
  [ "$(app_secret_name loja@hml)" = "app_loja_hml_dsn" ]
  [ "$(app_secret_name minha_loja@prod)" = "app_minha_loja_prod_dsn" ]
}

@test "render_grant_sql não duplica o alvo e filtra pelo client_id" {
  run render_grant_sql loja@hml abc123.access
  [[ "$output" == *"array_append(targets, 'loja@hml')"* ]]
  [[ "$output" == *"client_id = 'abc123.access'"* ]]
  [[ "$output" == *"NOT ('loja@hml' = ANY(targets))"* ]]
}

@test "valid_agent recusa aspas" {
  valid_agent agente-1
  ! valid_agent "a'b"
}

@test "render_app_stack monta o secret como DATABASE_URL_FILE na infra_net" {
  run render_app_stack loja@prod
  [[ "$output" == *"DATABASE_URL_FILE: /run/secrets/app_loja_prod_dsn"* ]]
  [[ "$output" == *"infra_net: { external: true }"* ]]
  [[ "$output" == *"app_loja_prod_dsn: { external: true }"* ]]
  [[ "$output" != *"ports:"* ]]
}

@test "parse_args: comandos e erro de uso" {
  [ "$(parse_args grant loja@hml)" = "grant loja@hml " ]
  [ "$(parse_args grant loja@hml abc.access)" = "grant loja@hml abc.access" ]
  [ "$(parse_args app-secret loja@prod)" = "app-secret loja@prod" ]
  run parse_args grant loja
  [ "$status" -eq 2 ]
  run parse_args apagar loja@hml
  [ "$status" -eq 2 ]
}
