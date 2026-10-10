-- Role de DDL do db-mcp: mcp_<db>_ddl, DONA do schema public do banco <db>.
-- Cria/altera tabelas no schema. NOSUPERUSER, NOCREATEDB, NOCREATEROLE. Idempotente.
-- Tabelas que ja existem continuam do dono anterior (ALTER nelas exige REASSIGN OWNED,
-- passo humano a parte). Tabelas que ela criar recebem grants automaticos para
-- mcp_<db>_rw / mcp_<db>_exec, se essas roles ja existirem.
--
-- Uso (conectado ao banco alvo como superuser):
--   psql -U postgres -d <db> -v db=<db> -v pw="$(cat <arquivo-600>)" -f create-ddl-role.sql
\set ON_ERROR_STOP on
\set QUIET on
\set role 'mcp_' :db '_ddl'

SELECT set_config('mcp.role', :'role', false) AS _r,
       set_config('mcp.db',   :'db',   false) AS _d,
       set_config('mcp.pw',   :'pw',   false) AS _p \gset

DO $$
DECLARE
  r  text := current_setting('mcp.role');
  d  text := current_setting('mcp.db');
  pw text := current_setting('mcp.pw');
  rw text := 'mcp_' || current_setting('mcp.db') || '_rw';
  ex text := 'mcp_' || current_setting('mcp.db') || '_exec';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', r, pw);
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', r, pw);
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', d, r);
  EXECUTE format('ALTER SCHEMA public OWNER TO %I', r);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', r, '60s');
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', r, '30s');

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rw) THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO %I', r, rw);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', r, rw);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ex) THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', r, ex);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', r, ex);
  END IF;
END
$$;

SELECT set_config('mcp.pw', '', false) AS _p \gset
\echo 'role' :role 'aplicada em' :db
