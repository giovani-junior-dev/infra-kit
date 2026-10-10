#!/usr/bin/env bash
# Mostra o valor de um Docker secret, só quando pedido explicitamente.
# Uso: sudo install/ops/show-secret.sh <secret> --mostrar
# O swarm não devolve o valor de um secret pela CLI; um serviço temporário
# monta o secret, imprime e é removido em seguida.
# shellcheck source=install/lib.sh
source "$(dirname "$0")/../lib.sh"

NAME="${1:-}"
[[ "$NAME" =~ ^[a-z0-9_]+$ ]] && [ "${2:-}" = "--mostrar" ] \
  || fail "uso: $0 <secret> --mostrar  (o valor aparece na tela; ninguém olhando?)" "$EXIT_CONFIG"

require_root
docker secret inspect "$NAME" >/dev/null 2>&1 || fail "secret $NAME não existe" "$EXIT_CONFIG"

SVC="show-secret-$$"
trap 'docker service rm "$SVC" >/dev/null 2>&1 || true' EXIT
docker service create --detach --quiet --name "$SVC" --secret "$NAME" \
  --restart-condition none alpine:3.22 cat "/run/secrets/$NAME" >/dev/null
for _ in $(seq 1 30); do
  state="$(docker service ps "$SVC" --format '{{.CurrentState}}' | head -n1)"
  case "$state" in Complete*) break ;; Failed*|Rejected*) fail "serviço temporário falhou: $state" ;; esac
  sleep 1
done
docker service logs --raw "$SVC" 2>/dev/null
echo
