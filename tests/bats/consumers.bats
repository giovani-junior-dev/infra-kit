#!/usr/bin/env bats

setup() {
  export KIT_DIR="$BATS_TEST_TMPDIR/kit"
  source "$BATS_TEST_DIRNAME/../../install/lib.sh"
  set +e
}

@test "register_consumer cria o arquivo 600 com o consumidor" {
  register_consumer mcp_admin_pw_prod db-mcp db-mcp mcp_admin
  [ "$(stat -c %a "$KIT_DIR/consumers.json")" = "600" ]
  [ "$(jq -c '.consumers' "$KIT_DIR/consumers.json")" = \
    '[{"secret":"mcp_admin_pw_prod","stack":"db-mcp","service":"db-mcp","role":"mcp_admin"}]' ]
}

@test "register_consumer não duplica e acumula consumidores diferentes" {
  register_consumer s1 db-mcp db-mcp r1
  register_consumer s1 db-mcp db-mcp r1
  register_consumer s1 app web r1
  register_consumer s2 pgbackweb pgbackweb r2
  [ "$(jq '.consumers|length' "$KIT_DIR/consumers.json")" -eq 3 ]
  [ "$(jq -r '[.consumers[]|select(.secret=="s1")|.stack]|join(",")' "$KIT_DIR/consumers.json")" = "app,db-mcp" ]
}
