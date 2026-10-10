-- Role administrativa do db-mcp: mcp_admin. LOGIN, CREATEDB, CREATEROLE, NOSUPERUSER.
-- Usada so pelo executor de db_create_database (aprovado pelo dono). Idempotente.
--
-- Uso (como superuser):
--   psql -U postgres -d postgres -v pw="$(cat <arquivo-600>)" -f create-admin-role.sql
\set ON_ERROR_STOP on
\set QUIET on

SELECT set_config('mcp.pw', :'pw', false) AS _p \gset

DO $$
DECLARE
  pw text := current_setting('mcp.pw');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_admin') THEN
    EXECUTE format('CREATE ROLE mcp_admin LOGIN NOSUPERUSER CREATEDB CREATEROLE PASSWORD %L', pw);
  ELSE
    EXECUTE format('ALTER ROLE mcp_admin LOGIN NOSUPERUSER CREATEDB CREATEROLE PASSWORD %L', pw);
  END IF;
  ALTER ROLE mcp_admin SET statement_timeout = '60s';
END
$$;

SELECT set_config('mcp.pw', '', false) AS _p \gset
\echo 'role mcp_admin aplicada'
