-- Banco mcp_control do db-mcp: schema completo (base + control-migrations 001..003).
-- Mesmas colunas do fixture tests/fixtures/control-schema.sql. Mesmo SQL de
-- control-migrations/000-base.sql (teste em tests/migrate.test.ts garante).
-- Uso: psql -U postgres -d mcp_control -f schema.sql   (idempotente)
\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS pending_ops (
  id uuid PRIMARY KEY, agent_id text NOT NULL, target text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('update','delete','insert','ddl','create_database','promote','promote_project','mirror')),
  sql text NOT NULL, params jsonb NOT NULL DEFAULT '[]',
  estimated_rows int NOT NULL, reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','expired','failed')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  decided_at timestamptz, decided_by text, executed_at timestamptz, result jsonb
);
-- Banco criado com a versao antiga (so update/delete/insert): alarga o CHECK.
ALTER TABLE pending_ops DROP CONSTRAINT IF EXISTS pending_ops_kind_check;
ALTER TABLE pending_ops ADD CONSTRAINT pending_ops_kind_check
  CHECK (kind IN ('update','delete','insert','ddl','create_database','promote','promote_project','mirror'));

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
  agent_id text NOT NULL, target text NOT NULL, tool text NOT NULL,
  sql_hash text NOT NULL, sql_preview text NOT NULL, rows int, outcome text NOT NULL, op_id uuid
);

-- targets = referências nome@env (ex.: loja@hml, loja@prod).
CREATE TABLE IF NOT EXISTS agents (
  client_id text PRIMARY KEY, name text NOT NULL, targets text[] NOT NULL, active boolean NOT NULL DEFAULT true
);

-- Alvos criados por db_create_database. Identidade = (name, env): nome@hml e nome@prod
-- coexistem. Banco antigo (PK só em name): aplicar 003-target-env.sql.
-- DSNs cifrados (AES-256-GCM, iv:authTag:ciphertext hex).
CREATE TABLE IF NOT EXISTS targets (
  name text NOT NULL, env text NOT NULL CHECK (env IN ('hml','prod')),
  dsn_rw_enc text NOT NULL, dsn_exec_enc text NOT NULL, dsn_ddl_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), op_id uuid,
  PRIMARY KEY (name, env)
);

-- Toda DDL executada (hml direta ou prod aprovada), em ordem de execucao.
-- mcp_control_rw tem DELETE so aqui (mirror descarta migrations hml; 004-control-migrations-delete.sql).
CREATE TABLE IF NOT EXISTS migrations (
  id bigserial PRIMARY KEY, target text NOT NULL, env text NOT NULL, sql text NOT NULL,
  checksum text NOT NULL, executed_at timestamptz NOT NULL DEFAULT now(),
  agent_id text NOT NULL, op_id uuid
);
-- Rastreamento de promoção hml -> prod (control-migrations/002-promote-tracking.sql).
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS applied_prod_at timestamptz;
ALTER TABLE migrations ADD COLUMN IF NOT EXISTS applied_prod_op uuid;

CREATE INDEX IF NOT EXISTS pending_ops_status_expires_idx ON pending_ops (status, expires_at);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at);
CREATE INDEX IF NOT EXISTS migrations_target_id_idx ON migrations (target, id);
