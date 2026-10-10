#!/usr/bin/env bats
load helpers

setup() { load_step 20-docker-swarm.sh; }

@test "render_docker_sources segue o formato deb822 da doc oficial" {
  run render_docker_sources noble amd64
  [[ "$output" == *"Suites: noble"* ]]
  [[ "$output" == *"Architectures: amd64"* ]]
  [[ "$output" == *"Signed-By: /etc/apt/keyrings/docker.asc"* ]]
}

@test "render_daemon_json: rotação 20m x 5 como strings" {
  run render_daemon_json
  [[ "$output" == *'"max-size": "20m"'* ]]
  [[ "$output" == *'"max-file": "5"'* ]]
}

@test "route_field extrai interface e IP de origem" {
  r="1.1.1.1 via 203.0.113.1 dev eth0 src 203.0.113.10 uid 0"
  [ "$(route_field dev "$r")" = eth0 ]
  [ "$(route_field src "$r")" = 203.0.113.10 ]
}

@test "render_rules_script: estabelecida passa, resto da interface pública cai" {
  run render_rules_script eth0
  [[ "$output" == *"--ctstate ESTABLISHED,RELATED -j RETURN"* ]]
  [[ "$output" == *"-A INFRA-KIT-INGRESS -j DROP"* ]]
  [[ "$output" == *"-I DOCKER-USER 1 -i eth0 -j INFRA-KIT-INGRESS"* ]]
  # idempotente: só insere o jump quando -C não acha
  [[ "$output" == *"-C DOCKER-USER -i eth0 -j INFRA-KIT-INGRESS"* ]]
}

@test "render_rules_script gera sh válido" {
  render_rules_script eth0 > "$BATS_TEST_TMPDIR/r.sh"
  sh -n "$BATS_TEST_TMPDIR/r.sh"
}

@test "render_unit roda depois do docker e acompanha o restart dele" {
  run render_unit
  [[ "$output" == *"After=docker.service"* ]]
  [[ "$output" == *"PartOf=docker.service"* ]]
  [[ "$output" == *"WantedBy=docker.service"* ]]
  [[ "$output" == *"ExecStart=/usr/local/sbin/infra-kit-docker-user"* ]]
}
