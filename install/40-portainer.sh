#!/usr/bin/env bash
# Etapa 40: Portainer CE + agent na infra_net, sem porta publicada.
# A senha inicial do admin é gerada aqui, vira Docker secret e aparece uma vez.
# shellcheck source=install/lib.sh
source "$(dirname "$0")/lib.sh"

STACKS_DIR="${STACKS_DIR:-$(cd "$(dirname "$0")/../stacks" && pwd)}"

require_root
load_env
require_var KIT_DOMAIN

NEW_PW=""
if ! docker secret inspect portainer_admin_pw >/dev/null 2>&1; then
  NEW_PW="$(openssl rand -base64 24 | tr -d '\n/+=')"
  printf '%s' "$NEW_PW" | docker secret create portainer_admin_pw - >/dev/null
fi
docker stack deploy -c "$STACKS_DIR/portainer.yml" portainer >/dev/null

# Verificação
docker service inspect portainer_portainer >/dev/null || fail "serviço portainer não subiu"
case "$(docker service inspect portainer_portainer --format '{{json .Endpoint.Ports}}')" in null|"[]") ;; *) false ;; esac \
  || fail "portainer com porta publicada (não deveria)"
mark_done 40-portainer
ok "etapa 40 concluída: https://portainer.$KIT_DOMAIN"

if [ -n "$NEW_PW" ]; then
  cat <<MSG

=====================================================================
 ATENÇÃO: senha inicial do Portainer mostrada UMA ÚNICA VEZ.
 Usuário: admin   Senha: $NEW_PW
 Guarde num gerenciador de senhas e troque no primeiro login.
 Editar uma stack pelo Portainer reaplica o arquivo inteiro: porta e
 secret precisam estar no arquivo (lição L2).
=====================================================================
MSG
fi
