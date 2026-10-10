#!/usr/bin/env bash
# Troca a senha do superuser postgres de pg-prod ou pg-homolog (lições L1, L5).
# Uso: sudo install/ops/rotate-superuser.sh <prod|homolog> [--sim | --dry-run]
#   sem flag   mostra o plano e pede --sim (nada muda)
#   --dry-run  só mostra o plano (nada muda)
#   --sim      executa
#
# Secrets do swarm são imutáveis: a senha nova vira um secret versionado
# (<nome>_vN) montado no MESMO caminho (/run/secrets/<nome base>), então
# POSTGRES_PASSWORD_FILE e os consumidores não mudam de configuração.
# Padrão de rotação da doc do Docker (--secret-rm + --secret-add com target).
# O secret antigo fica para rollback; apague-o depois de conferir tudo.
# shellcheck source=install/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# Consumidores que guardam a senha fora do swarm (ex.: painel do PG Back Web).
MANUAL_SERVICES="painel"

usage() {
  echo "uso: rotate-superuser.sh <prod|homolog> [--sim | --dry-run]" >&2
}

# Uso: parse_args "$@" → imprime "<env> <plan|run|dry-run>"; inválido sai com 2.
parse_args() {
  local env="${1:-}" mode
  if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then usage; return "$EXIT_CONFIG"; fi
  case "$env" in prod|homolog) ;; *) usage; return "$EXIT_CONFIG" ;; esac
  case "${2:-}" in
    "")        mode=plan ;;
    --sim)     mode=run ;;
    --dry-run) mode=dry-run ;;
    *)         usage; return "$EXIT_CONFIG" ;;
  esac
  echo "$env $mode"
}

# Próximo nome versionado. Uso: next_secret_name <atual> <secrets existentes, 1 por linha>
# A versão é a maior já existente + 1 (nunca reaproveita nome, mesmo após rollback).
next_secret_name() {
  local base="${1%_v[0-9]*}" max=1 name n
  [[ "$1" =~ _v([0-9]+)$ ]] && max="${BASH_REMATCH[1]}"
  while IFS= read -r name; do
    [[ "$name" =~ ^${base}_v([0-9]+)$ ]] || continue
    n="${BASH_REMATCH[1]}"
    [ "$n" -gt "$max" ] && max="$n"
  done <<<"$2"
  echo "${base}_v$((max + 1))"
}

# Uso: consumers_for <consumers.json> <secret> → "stack<TAB>serviço<TAB>role" por linha.
consumers_for() {
  [ -s "$1" ] || return 0
  jq -r --arg s "$2" '.consumers[] | select(.secret == $s) | [.stack, .service, .role] | @tsv' "$1"
}

is_manual_consumer() {
  [[ " $MANUAL_SERVICES " == *" $1 "* ]]
}

# Uso: render_plan <env> <secret atual> <secret novo> <saída do consumers_for>
render_plan() {
  local env="$1" cur="$2" new="$3" consumers="$4" stack service role auto="" manual=""
  while IFS=$'\t' read -r stack service role; do
    [ -n "$stack" ] || continue
    if is_manual_consumer "$service"; then
      manual+="   - $stack/$service (role $role): atualize a senha à mão"$'\n'
    else
      auto+="   - ${stack}_${service} (role $role): troca o secret e reinicia"$'\n'
    fi
  done <<<"$consumers"
  cat <<EOF
Plano de troca da senha do superuser em pg-$env:
 1. gerar a senha nova no servidor (nunca aparece na tela)
 2. criar o secret $cur -> $new
 3. ALTER ROLE postgres pelo socket local do container
 4. atualizar pg-${env}_postgres para ler $new
    ATENÇÃO: o Postgres reinicia, fica 10 a 30 s fora do ar
 5. consumidores no swarm:
EOF
  if [ -z "$auto$manual" ]; then
    echo "   nenhum consumidor registrado em consumers.json"
  else
    printf '%s' "$auto"
    [ -z "$manual" ] || printf '    MANUAL (fora do swarm):\n%s' "$manual"
  fi
  echo " 6. o secret $cur fica guardado para voltar atrás; apague depois de conferir"
}

pg_service() { echo "pg-${1}_postgres"; }

# Secret montado em <serviço> no caminho <target>. Uso: mounted_secret <serviço> <target>
mounted_secret() {
  docker service inspect "$1" \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{.SecretName}}{{"\t"}}{{.File.Name}}{{"\n"}}{{end}}' \
    | awk -F'\t' -v t="$2" '$2 == t {print $1; exit}'
}

# Caminho (target) em que <serviço> monta <secret>.
secret_target() {
  docker service inspect "$1" \
    --format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{.SecretName}}{{"\t"}}{{.File.Name}}{{"\n"}}{{end}}' \
    | awk -F'\t' -v s="$2" '$1 == s {print $2; exit}'
}

swap_secret() {
  local svc="$1" cur="$2" new="$3" target="$4"
  docker service update --quiet --detach=false \
    --secret-rm "$cur" --secret-add "source=$new,target=$target" "$svc" >/dev/null
}

# Serviço convergiu: update concluído e todas as réplicas desejadas rodando.
wait_converged() {
  local svc="$1" state running desired
  for _ in $(seq 1 45); do
    state="$(docker service inspect "$svc" --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}')"
    running="$(docker service ps "$svc" --filter desired-state=running --format '{{.CurrentState}}' | grep -c '^Running' || true)"
    desired="$(docker service inspect "$svc" --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}1{{end}}')"
    case "$state" in rollback*|paused) return 1 ;; esac
    if [ "$running" -ge "$desired" ] && [ "${state:-completed}" = completed ]; then return 0; fi
    sleep 2
  done
  return 1
}

wait_pg_ready() {
  local cid
  for _ in $(seq 1 60); do
    cid="$(service_container "$1")"
    if [ -n "$cid" ] && docker exec "$cid" pg_isready -U postgres >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

rename_consumers() {
  local tmp
  [ -s "$KIT_CONSUMERS" ] || return 0
  tmp="$(mktemp)"
  jq --arg c "$1" --arg n "$2" '.consumers |= map(if .secret == $c then .secret = $n else . end)' \
    "$KIT_CONSUMERS" > "$tmp"
  mv "$tmp" "$KIT_CONSUMERS"
  chmod 600 "$KIT_CONSUMERS"
}

do_rotate() {
  local env="$1" cur="$2" new="$3" consumers="$4" base="$5"
  local svc cid pw stack service role csvc target failed=()
  svc="$(pg_service "$env")"
  cid="$(service_container "$svc")"
  [ -n "$cid" ] || fail "$svc não está rodando neste nó" "$EXIT_PRECONDITION"

  pw="$(openssl rand -hex 32)"
  printf '%s' "$pw" | docker secret create "$new" - >/dev/null
  # hex não tem aspas: literal seguro. Vai pelo stdin, nunca em argumento.
  if ! printf "ALTER ROLE postgres PASSWORD '%s';\n" "$pw" \
      | docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -qtAX -U postgres >/dev/null; then
    unset pw
    docker secret rm "$new" >/dev/null 2>&1 || true
    fail "ALTER ROLE falhou; nada mudou (secret $new removido)"
  fi
  unset pw
  ok "senha trocada no banco; secret $new criado"

  log "atualizando $svc (Postgres reinicia agora)"
  swap_secret "$svc" "$cur" "$new" "$base" || fail "update de $svc falhou; a senha nova já vale: rode de novo com --sim para reaplicar"
  wait_pg_ready "$svc" || fail "$svc não voltou em 120 s; veja: docker service ps $svc"
  set_env_var "KIT_PG_${env^^}_SUPERUSER_SECRET" "$new"
  ok "$svc lendo $new"

  while IFS=$'\t' read -r stack service role; do
    [ -n "$stack" ] || continue
    is_manual_consumer "$service" && continue
    csvc="${stack}_${service}"
    target="$(secret_target "$csvc" "$cur")"
    if [ -z "$target" ]; then
      warn "$csvc não monta $cur (consumers.json desatualizado?); pulei"
      failed+=("$csvc"); continue
    fi
    log "atualizando $csvc"
    if swap_secret "$csvc" "$cur" "$new" "$target" && wait_converged "$csvc"; then
      ok "$csvc reconectou com $new"
    else
      warn "$csvc não convergiu; veja: docker service ps $csvc"
      failed+=("$csvc")
    fi
  done <<<"$consumers"
  rename_consumers "$cur" "$new"

  while IFS=$'\t' read -r stack service role; do
    [ -n "$stack" ] && is_manual_consumer "$service" &&
      warn "MANUAL: atualize a senha de $role em $stack/$service (sudo install/ops/show-secret.sh $new --mostrar)"
  done <<<"$consumers"
  log "secret antigo $cur mantido para rollback. Tudo certo? docker secret rm $cur"
  [ "${#failed[@]}" -eq 0 ] || fail "consumidores com problema: ${failed[*]}"
  ok "troca de senha de pg-$env concluída"
}

main() {
  local args env mode base svc cur new consumers
  args="$(parse_args "$@")" || exit "$EXIT_CONFIG"
  read -r env mode <<<"$args"
  [ "$mode" = run ] && require_root
  load_env
  command -v jq >/dev/null || fail "jq não instalado" "$EXIT_PRECONDITION"

  base="pg_${env}_superuser_pw"
  svc="$(pg_service "$env")"
  cur="$(mounted_secret "$svc" "$base")"
  [ -n "$cur" ] || fail "$svc não monta nenhum secret em /run/secrets/$base" "$EXIT_PRECONDITION"
  new="$(next_secret_name "$cur" "$(docker secret ls --format '{{.Name}}')")"
  consumers="$(consumers_for "$KIT_CONSUMERS" "$cur")"

  render_plan "$env" "$cur" "$new" "$consumers"
  case "$mode" in
    dry-run) return 0 ;;
    plan)    echo; log "nada mudou. Para executar: $0 $env --sim"; return "$EXIT_CONFIG" ;;
  esac
  do_rotate "$env" "$cur" "$new" "$consumers" "$base"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
