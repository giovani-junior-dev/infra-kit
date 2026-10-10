#!/usr/bin/env bash
# Restore de teste: pega o último dump, restaura num banco temporário no
# pg-homolog, compara a quantidade de tabelas com o banco de origem no pg-prod
# e apaga o temporário. Backup que nunca foi restaurado não é backup.
#
# Uso: restore-test.sh --db <banco_no_prod> [--file <dump>]
#  sem --file: baixa o mais recente do R2 (KIT_R2_ENDPOINT/KIT_R2_BUCKET no
#  kit.env; credenciais em R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY só no ambiente).
# Formatos: .zip (padrão do PG Back Web, contém dump.sql), .sql, .sql.gz, .dump.
# shellcheck source=install/lib.sh
source "$(dirname "$0")/../lib.sh"

DB="" FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    *) fail "argumento desconhecido: $1" "$EXIT_CONFIG" ;;
  esac
done
[[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "use --db <nome> (minúsculas, dígitos e _)" "$EXIT_CONFIG"

require_root
load_env

WORK="$(mktemp -d)"
TMP_DB="restore_test_$(date +%s)"
# PSQL_USER=backup_reader nas leituras do prod: o socket local do container não
# pede senha, mas a sessão roda com os privilégios só de leitura da role.
psql_in() { docker exec -i "$(service_container "$1_postgres")" psql -v ON_ERROR_STOP=1 -qtAX -U "${PSQL_USER:-postgres}" -d "${2:-postgres}"; }
cleanup() {
  echo "DROP DATABASE IF EXISTS $TMP_DB;" | psql_in pg-homolog >/dev/null 2>&1 || warn "não apaguei $TMP_DB no pg-homolog"
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ -z "$FILE" ]; then
  require_var KIT_R2_ENDPOINT KIT_R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
  aws() {
    # -e sem valor herda do ambiente: as chaves não aparecem no ps
    AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
      docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
      -e AWS_DEFAULT_REGION=auto -v "$WORK:/work" amazon/aws-cli:2.37.12 --endpoint-url "$KIT_R2_ENDPOINT" "$@"
  }
  key="$(aws s3 ls "s3://$KIT_R2_BUCKET/" --recursive | sort | tail -n1 | awk '{print $4}')"
  [ -n "$key" ] || fail "nenhum dump no bucket $KIT_R2_BUCKET"
  aws s3 cp "s3://$KIT_R2_BUCKET/$key" "/work/$(basename "$key")" >/dev/null
  FILE="$WORK/$(basename "$key")"
fi
[ -f "$FILE" ] || fail "dump não encontrado: $FILE" "$EXIT_CONFIG"
log "restaurando $(basename "$FILE") em pg-homolog/$TMP_DB"

echo "CREATE DATABASE $TMP_DB;" | psql_in pg-homolog
cid="$(service_container pg-homolog_postgres)"
case "$FILE" in
  *.zip)    unzip -p "$FILE" '*.sql' | psql_in pg-homolog "$TMP_DB" >/dev/null ;;
  *.sql.gz) gunzip -c "$FILE" | psql_in pg-homolog "$TMP_DB" >/dev/null ;;
  *.sql)    psql_in pg-homolog "$TMP_DB" < "$FILE" >/dev/null ;;
  *.dump)   docker exec -i "$cid" pg_restore --no-owner -U postgres -d "$TMP_DB" < "$FILE" ;;
  *) fail "formato não suportado: $FILE" "$EXIT_CONFIG" ;;
esac

COUNT_SQL="SELECT count(*) FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema');"
restored="$(echo "$COUNT_SQL" | psql_in pg-homolog "$TMP_DB")"
source_n="$(echo "$COUNT_SQL" | PSQL_USER=backup_reader psql_in pg-prod "$DB")"
[ "$restored" = "$source_n" ] || fail "restore com $restored tabelas; $DB no prod tem $source_n"
ok "restore de teste: $restored tabelas, igual ao prod ($DB)"
