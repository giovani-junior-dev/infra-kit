-- Espelho do schema do banco mcp_control (plano 2.2 + control-migrations/001-ddl.sql)
-- para o teste de integração. Role e grants reais: fixtures/control-db.ts (createControlDb).
CREATE TABLE pending_ops (
  id uuid PRIMARY KEY, agent_id text NOT NULL, target text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('update','delete','insert','ddl','create_database','promote','promote_project','mirror')),
  sql text NOT NULL, params jsonb NOT NULL DEFAULT '[]',
  estimated_rows int NOT NULL, reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','expired','failed')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  decided_at timestamptz, decided_by text, executed_at timestamptz, result jsonb
);
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
  agent_id text NOT NULL, target text NOT NULL, tool text NOT NULL,
  sql_hash text NOT NULL, sql_preview text NOT NULL, rows int, outcome text NOT NULL, op_id uuid
);
CREATE TABLE agents (client_id text PRIMARY KEY, name text NOT NULL, targets text[] NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE targets (
  name text NOT NULL, env text NOT NULL CHECK (env IN ('hml','prod')),
  dsn_rw_enc text NOT NULL, dsn_exec_enc text NOT NULL, dsn_ddl_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), op_id uuid,
  PRIMARY KEY (name, env)
);
CREATE TABLE migrations (
  id bigserial PRIMARY KEY, target text NOT NULL, env text NOT NULL, sql text NOT NULL,
  checksum text NOT NULL, executed_at timestamptz NOT NULL DEFAULT now(),
  agent_id text NOT NULL, op_id uuid,
  applied_prod_at timestamptz, applied_prod_op uuid
);
