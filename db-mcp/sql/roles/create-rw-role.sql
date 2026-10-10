-- Role de escrita dos agentes: mcp_<db>_rw. SELECT/INSERT/UPDATE + sequences.
-- SEM DELETE, SEM TRUNCATE, SEM DDL (sem CREATE no schema, nao e dona de nenhuma tabela).
-- Idempotente: cria se nao existe, senao atualiza senha e reaplica grants/limites.
--
-- Uso (conectado ao banco alvo como superuser, ex. dentro do container postgres_postgres):
--   psql -U postgres -d loja_hml -v db=loja_hml -v pw="$(cat <arquivo-600>)" \
--        -f create-rw-role.sql
-- A senha entra SO pela variavel :pw (gerada no servidor com openssl rand -hex 24, fora do repo).
\set ON_ERROR_STOP on
\set QUIET on
\set role 'mcp_' :db '_rw'

-- Passa as variaveis psql para o bloco DO via GUC de sessao (\gset evita imprimir a senha).
SELECT set_config('mcp.role', :'role', false) AS _r,
       set_config('mcp.db',   :'db',   false) AS _d,
       set_config('mcp.pw',   :'pw',   false) AS _p \gset

DO $$
DECLARE
  r  text := current_setting('mcp.role');
  d  text := current_setting('mcp.db');
  pw text := current_setting('mcp.pw');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', r, pw);
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', r, pw);
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', d, r);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);
  EXECUTE format('REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO %I', r);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', r);

  -- Tabelas/sequences criadas depois (migrations rodam como o superuser que executa este script).
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO %I', r);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', r);

  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', r, '15s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', r, '30s');
END
$$;

SELECT set_config('mcp.pw', '', false) AS _p \gset
\echo 'role' :role 'aplicada em' :db
