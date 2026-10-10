#!/usr/bin/env bats
load helpers

setup() { load_step 00-preflight.sh; }

os_release() { printf 'ID=%s\nVERSION_ID="%s"\n' "$1" "$2" > "$BATS_TEST_TMPDIR/os"; }

@test "check_os aceita Ubuntu 24.04" {
  os_release ubuntu 24.04
  run check_os "$BATS_TEST_TMPDIR/os"
  [ "$status" -eq 0 ]
}

@test "check_os recusa outro sistema com código 3" {
  os_release ubuntu 22.04
  run check_os "$BATS_TEST_TMPDIR/os"
  [ "$status" -eq 3 ]
  [[ "$output" == *"Ubuntu 24.04"* ]]
}

@test "check_resources aborta com 1 vCPU" {
  run check_resources 1 8000 80
  [ "$status" -eq 3 ]
}

@test "check_resources aborta com disco pequeno" {
  run check_resources 2 8000 20
  [ "$status" -eq 3 ]
}

@test "check_resources só avisa com RAM abaixo de 4 GB" {
  run check_resources 2 1900 40
  [ "$status" -eq 0 ]
  [[ "$output" == *"recomendado 4 GB"* ]]
}

@test "ns_is_cloudflare: só NS da Cloudflare passa" {
  run ns_is_cloudflare $'ada.ns.cloudflare.com.\nbob.ns.cloudflare.com.'
  [ "$status" -eq 0 ]
  run ns_is_cloudflare $'ada.ns.cloudflare.com.\nns1.registro.br.'
  [ "$status" -ne 0 ]
  run ns_is_cloudflare ""
  [ "$status" -ne 0 ]
}
