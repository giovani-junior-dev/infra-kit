-- Cria o banco mcp_control, a role mcp_control_rw (usada pelo app db-mcp) e aplica schema.sql.
-- Idempotente. Rodar de dentro desta pasta (\ir resolve schema.sql relativo a este arquivo).
--
-- Uso (como superuser):
--   psql -U postgres -d postgres -v pw="$(cat <arquivo-600>)" -f create-control-db.sql
\set ON_ERROR_STOP on
\set QUIET on

SELECT 'CREATE DATABASE mcp_control'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'mcp_control') \gexec

SELECT set_config('mcp.pw', :'pw', false) AS _p \gset

DO $$
DECLARE
  pw text := current_setting('mcp.pw');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_control_rw') THEN
    EXECUTE format('CREATE ROLE mcp_control_rw LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', pw);
  ELSE
    EXECUTE format('ALTER ROLE mcp_control_rw LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', pw);
  END IF;
  ALTER ROLE mcp_control_rw SET statement_timeout = '15s';
END
$$;

SELECT set_config('mcp.pw', '', false) AS _p \gset

\connect mcp_control
\ir schema.sql

-- App le e grava pedidos, auditoria, alvos e migrations. Sem DDL. DELETE so em migrations
-- (mirror descarta as migrations hml do banco recriado; 004-control-migrations-delete.sql).
GRANT CONNECT ON DATABASE mcp_control TO mcp_control_rw;
GRANT USAGE ON SCHEMA public TO mcp_control_rw;
REVOKE CREATE ON SCHEMA public FROM mcp_control_rw;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO mcp_control_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mcp_control_rw;
GRANT DELETE ON TABLE migrations TO mcp_control_rw;
\echo 'mcp_control pronto'
