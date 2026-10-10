-- Migration do banco mcp_control para o suporte a DDL do db-mcp.
-- Aplica sobre o schema base (000-base.sql). Idempotente.
-- Uso (humano, no host do banco): psql -U postgres -d mcp_control -f 001-ddl.sql
\set ON_ERROR_STOP on

BEGIN;

-- Novos tipos de pedido: DDL em prod, criação de banco e promoção de lote hml -> prod.
-- Já com promote_project/mirror (002): reaplicar sobre um banco com esses pedidos não quebra o boot.
ALTER TABLE pending_ops DROP CONSTRAINT IF EXISTS pending_ops_kind_check;
ALTER TABLE pending_ops ADD CONSTRAINT pending_ops_kind_check
  CHECK (kind IN ('update','delete','insert','ddl','create_database','promote','promote_project','mirror'));

-- Alvos criados por db_create_database. DSNs cifrados (AES-256-GCM, DB_MCP_TARGETS_KEY,
-- formato iv:authTag:ciphertext hex). Nunca texto claro.
CREATE TABLE IF NOT EXISTS targets (
  name text PRIMARY KEY, env text NOT NULL CHECK (env IN ('hml','prod')),
  dsn_rw_enc text NOT NULL, dsn_exec_enc text NOT NULL, dsn_ddl_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), op_id uuid
);

-- Toda DDL executada (hml direta ou prod aprovada), em ordem de execução.
CREATE TABLE IF NOT EXISTS migrations (
  id bigserial PRIMARY KEY, target text NOT NULL, env text NOT NULL, sql text NOT NULL,
  checksum text NOT NULL, executed_at timestamptz NOT NULL DEFAULT now(),
  agent_id text NOT NULL, op_id uuid
);
CREATE INDEX IF NOT EXISTS migrations_target_id_idx ON migrations (target, id);

COMMIT;
