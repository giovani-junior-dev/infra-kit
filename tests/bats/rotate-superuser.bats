#!/usr/bin/env bats

load helpers

setup() {
  load_step ops/rotate-superuser.sh
}

@test "parse_args aceita env e um modo" {
  [ "$(parse_args prod)" = "prod plan" ]
  [ "$(parse_args homolog --sim)" = "homolog run" ]
  [ "$(parse_args prod --dry-run)" = "prod dry-run" ]
}

@test "parse_args recusa env desconhecido e argumento extra" {
  run parse_args staging
  [ "$status" -eq 2 ]
  run parse_args prod --sim --dry-run
  [ "$status" -eq 2 ]
  run parse_args
  [ "$status" -eq 2 ]
}

@test "next_secret_name começa em _v2 a partir do nome base" {
  [ "$(next_secret_name pg_prod_superuser_pw '')" = "pg_prod_superuser_pw_v2" ]
}

@test "next_secret_name segue a maior versão existente, não só a atual" {
  existing=$'pg_prod_superuser_pw\npg_prod_superuser_pw_v2\npg_prod_superuser_pw_v5\noutro_v9'
  [ "$(next_secret_name pg_prod_superuser_pw_v2 "$existing")" = "pg_prod_superuser_pw_v6" ]
}

@test "next_secret_name não confunde prefixo parecido" {
  existing=$'pg_prod_superuser_pw_v3\npg_prod_superuser_pw_old_v8'
  [ "$(next_secret_name pg_prod_superuser_pw_v3 "$existing")" = "pg_prod_superuser_pw_v4" ]
}

@test "consumers_for lista stack, serviço e role só do secret pedido" {
  f="$BATS_TEST_TMPDIR/c.json"
  cat > "$f" <<'EOF'
{"consumers":[
 {"secret":"pg_prod_superuser_pw","stack":"app","service":"web","role":"postgres"},
 {"secret":"pg_prod_superuser_pw","stack":"pgbackweb","service":"painel","role":"postgres"},
 {"secret":"mcp_admin_pw_prod","stack":"db-mcp","service":"db-mcp","role":"mcp_admin"}]}
EOF
  run consumers_for "$f" pg_prod_superuser_pw
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = $'app\tweb\tpostgres' ]
  [ "${lines[1]}" = $'pgbackweb\tpainel\tpostgres' ]
  [ "${#lines[@]}" -eq 2 ]
}

@test "consumers_for sem arquivo devolve vazio sem erro" {
  run consumers_for "$BATS_TEST_TMPDIR/nao-existe.json" x
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "is_manual_consumer: painel é manual, serviço comum não" {
  is_manual_consumer painel
  ! is_manual_consumer web
}

@test "render_plan mostra aviso de reinício, versões e separa manuais" {
  consumers=$'app\tweb\tpostgres\npgbackweb\tpainel\tpostgres'
  run render_plan prod pg_prod_superuser_pw pg_prod_superuser_pw_v2 "$consumers"
  [ "$status" -eq 0 ]
  [[ "$output" == *"pg-prod_postgres"* ]]
  [[ "$output" == *"pg_prod_superuser_pw -> pg_prod_superuser_pw_v2"* ]]
  [[ "$output" == *"10 a 30 s"* ]]
  [[ "$output" == *"app_web"* ]]
  [[ "$output" == *"MANUAL"*"pgbackweb/painel"* ]]
}

@test "render_plan sem consumidores diz isso" {
  run render_plan homolog pg_homolog_superuser_pw pg_homolog_superuser_pw_v2 ""
  [[ "$output" == *"nenhum consumidor"* ]]
}

@test "sem --sim: mostra o plano e não muda nada" {
  mkdir -p "$BATS_TEST_TMPDIR/bin" "$BATS_TEST_TMPDIR/kit"
  cat > "$BATS_TEST_TMPDIR/bin/docker" <<EOF
#!/bin/sh
echo "\$*" >> "$BATS_TEST_TMPDIR/docker.log"
case "\$1 \$2" in
  "service inspect") printf 'pg_prod_superuser_pw\tpg_prod_superuser_pw\n' ;;
  "secret ls") echo pg_prod_superuser_pw ;;
esac
EOF
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  printf 'KIT_DOMAIN=x\n' > "$BATS_TEST_TMPDIR/kit/kit.env"
  for mode in "" --dry-run; do
    KIT_DIR="$BATS_TEST_TMPDIR/kit" ROTATE_SKIP_ROOT=1 PATH="$BATS_TEST_TMPDIR/bin:$PATH" \
      run "$BATS_TEST_DIRNAME/../../install/ops/rotate-superuser.sh" prod $mode
    [[ "$output" == *"pg_prod_superuser_pw_v2"* ]]
  done
  ! grep -qE 'secret create|service update|exec' "$BATS_TEST_TMPDIR/docker.log"
}
