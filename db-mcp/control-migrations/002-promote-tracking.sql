-- Migration do banco mcp_control: rastreamento de promoção por migration +
-- novos pedidos promote_project e mirror. Aplica sobre 001-ddl.sql. Idempotente.
-- Uso (humano, no host do banco): psql -U postgres -d mcp_control -f 002-promote-tracking.sql
\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE pending_ops DROP CONSTRAINT IF EXISTS pending_ops_kind_check;
ALTER TABLE pending_ops ADD CONSTRAINT pending_ops_kind_check
  CHECK (kind IN ('update','delete','insert','ddl','create_database','promote','promote_project','mirror'));

-- Migration de hml já aplicada em prod: quando e por qual pedido. NULL = pendente.
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS applied_prod_at timestamptz;
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS applied_prod_op uuid;
CREATE INDEX IF NOT EXISTS migrations_unapplied_idx ON migrations (target, id) WHERE applied_prod_at IS NULL;

COMMIT;
