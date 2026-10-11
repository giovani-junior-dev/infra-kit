#!/usr/bin/env bats
# Partes puras da etapa 70: SQL do agente e comando do Claude Code.

load helpers

setup() { load_step 70-db-mcp.sh; }

@test "SQL do agente é idempotente e sem alvos" {
  run render_agent_sql abc123.access agente-1
  [ "$status" -eq 0 ]
  [ "$output" = "INSERT INTO agents (client_id, name, targets) VALUES ('abc123.access', 'agente-1', '{}') ON CONFLICT (client_id) DO NOTHING;" ]
}

@test "client id com aspas ou espaço é recusado (sem SQL injection)" {
  run render_agent_sql "x'); DROP TABLE agents;--" agente-1
  [ "$status" -ne 0 ]
  [ -z "$output" ]
  run render_agent_sql "a b" agente-1
  [ "$status" -ne 0 ]
}

@test "comando do claude mcp add tem o id e só placeholder no secret" {
  run render_mcp_add_command ex.com abc123.access
  [[ "$output" == *"claude mcp add --scope user --transport http db-mcp https://db-mcp.ex.com/mcp"* ]]
  [[ "$output" == *'--header "CF-Access-Client-Id: abc123.access"'* ]]
  [[ "$output" == *'--header "CF-Access-Client-Secret: <COLE_AQUI_O_CLIENT_SECRET>"'* ]]
}

@test "stack db-mcp: segredos só por _FILE e sem ports" {
  f="$BATS_TEST_DIRNAME/../../stacks/db-mcp.yml"
  run grep -qE '^\s+ports:' "$f"
  [ "$status" -eq 1 ]
  keys="$(sed -n 's/^      \([A-Z_]*\):.*/\1=/p' "$f")"
  [ -z "$(env_secret_keys_from_70 <<<"$keys")" ]
}

env_secret_keys_from_70() {
  source "$BATS_TEST_DIRNAME/../../install/90-verify.sh"; set +e
  env_secret_keys
}

@test "version_from_tag: tag de release vira versão da imagem" {
  [ "$(version_from_tag v0.9.0-rc1)" = "0.9.0-rc1" ]
  [ "$(version_from_tag v1.2.3)" = "1.2.3" ]
  [ -z "$(version_from_tag main)" ]
  [ -z "$(version_from_tag "")" ]
}
