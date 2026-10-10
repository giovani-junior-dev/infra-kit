-- Migration do banco mcp_control: o mirror (alignAfterMirror) apaga as migrations hml
-- não aplicadas do banco recriado. mcp_control_rw ganha DELETE só em migrations;
-- pending_ops, audit_log, agents e targets seguem sem DELETE. Idempotente.
-- Uso (humano, no host do banco): psql -U postgres -d mcp_control -f 004-control-migrations-delete.sql
\set ON_ERROR_STOP on

-- Condicional: no boot a role pode ainda não existir (create-control-db.sql cria e já dá o grant).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_control_rw') THEN
    GRANT DELETE ON TABLE migrations TO mcp_control_rw;
  END IF;
END $$;
