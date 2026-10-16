import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { APPROVAL_TTL_MS } from './link.js'
import { decryptSecret, encryptSecret } from '../crypto.js'
import { makeTarget, type Target } from '../targets.js'
import type { NewMigration } from '../ddl.js'
import type { Agent, AuditEntry, Migration, NewPendingOp, OpStatus, PendingOp } from '../types.js'

type Row = Record<string, unknown>

function toOp(r: Row): PendingOp {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    target: r.target as string,
    kind: r.kind as PendingOp['kind'],
    sql: r.sql as string,
    params: r.params as PendingOp['params'],
    estimatedRows: r.estimated_rows as number,
    reason: (r.reason as string | null) ?? '',
    status: r.status as OpStatus,
    createdAt: r.created_at as Date,
    expiresAt: r.expires_at as Date,
    result: r.result ?? null,
  }
}

function toMigration(r: Row): Migration {
  return {
    id: Number(r.id), target: r.target as string, env: r.env as string, sql: r.sql as string, checksum: r.checksum as string,
    executedAt: r.executed_at as Date, agentId: r.agent_id as string, opId: (r.op_id as string | null) ?? null,
  }
}

/** Banco mcp_control: agents, pending_ops, audit_log (plano 2.2). */
export class ControlStore {
  constructor(private readonly pool: pg.Pool) {}

  async getAgent(clientId: string): Promise<Agent | null> {
    const { rows } = await this.pool.query('SELECT client_id, name, targets, active FROM agents WHERE client_id = $1', [clientId])
    const r = rows[0]
    return r ? { clientId: r.client_id, name: r.name, targets: r.targets, active: r.active } : null
  }

  async insertPending(op: NewPendingOp, ttlMs = APPROVAL_TTL_MS): Promise<PendingOp> {
    const { rows } = await this.pool.query(
      `INSERT INTO pending_ops (id, agent_id, target, kind, sql, params, estimated_rows, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9::double precision / 1000))
       RETURNING *`,
      [randomUUID(), op.agentId, op.target, op.kind, op.sql, JSON.stringify(op.params), op.estimatedRows, op.reason, ttlMs],
    )
    return toOp(rows[0])
  }

  async getOp(id: string): Promise<PendingOp | null> {
    const { rows } = await this.pool.query('SELECT * FROM pending_ops WHERE id = $1', [id])
    return rows[0] ? toOp(rows[0]) : null
  }

  async listOps(agentId: string, opId?: string): Promise<PendingOp[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM pending_ops WHERE agent_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)
       ORDER BY created_at DESC LIMIT 50`,
      [agentId, opId ?? null],
    )
    return rows.map(toOp)
  }

  /** Atômico: só decide se ainda está pending e não venceu (aprovação idempotente). */
  async decide(id: string, status: 'approved' | 'rejected', by: string): Promise<PendingOp | null> {
    const { rows } = await this.pool.query(
      `UPDATE pending_ops SET status = $2, decided_at = now(), decided_by = $3
       WHERE id = $1 AND status = 'pending' AND expires_at > now() RETURNING *`,
      [id, status, by],
    )
    return rows[0] ? toOp(rows[0]) : null
  }

  async markExpired(id: string): Promise<void> {
    await this.pool.query(`UPDATE pending_ops SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [id])
  }

  async expirePending(): Promise<number> {
    const r = await this.pool.query(`UPDATE pending_ops SET status = 'expired' WHERE status = 'pending' AND expires_at < now()`)
    return r.rowCount ?? 0
  }

  async finish(id: string, status: 'executed' | 'failed', result: unknown): Promise<void> {
    await this.pool.query(
      'UPDATE pending_ops SET status = $2, executed_at = now(), result = $3 WHERE id = $1',
      [id, status, JSON.stringify(result)],
    )
  }

  async audit(e: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (agent_id, target, tool, sql_hash, sql_preview, rows, outcome, op_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.agentId, e.target, e.tool, e.sqlHash, e.sqlPreview, e.rows, e.outcome, e.opId ?? null],
    )
  }

  async recordMigrations(rows: NewMigration[]): Promise<void> {
    for (const m of rows) {
      await this.pool.query(
        'INSERT INTO migrations (target, env, sql, checksum, agent_id, op_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [m.target, m.env, m.sql, m.checksum, m.agentId, m.opId],
      )
    }
  }

  async listMigrations(target: string, since?: Date): Promise<Migration[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM migrations WHERE target = $1 AND ($2::timestamptz IS NULL OR executed_at >= $2) ORDER BY id`,
      [target, since ?? null],
    )
    return rows.map(toMigration)
  }

  /** Migrations do alvo ainda não aplicadas em prod, em ordem de execução. */
  async listUnapplied(target: string): Promise<Migration[]> {
    const { rows } = await this.pool.query('SELECT * FROM migrations WHERE target = $1 AND applied_prod_at IS NULL ORDER BY id', [target])
    return rows.map(toMigration)
  }

  async getMigrations(ids: number[]): Promise<Migration[]> {
    const { rows } = await this.pool.query('SELECT * FROM migrations WHERE id = ANY($1::bigint[]) ORDER BY id', [ids])
    return rows.map(toMigration)
  }

  async markApplied(ids: number[], opId: string): Promise<void> {
    await this.pool.query('UPDATE migrations SET applied_prod_at = now(), applied_prod_op = $2 WHERE id = ANY($1::bigint[])', [ids, opId])
  }

  /**
   * Depois do mirror o hml é cópia do prod: descarta as migrations hml não aplicadas
   * (o banco que as tinha foi recriado) e registra as do prod como já aplicadas.
   */
  async alignAfterMirror(hml: string, prod: string, opId: string): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM migrations WHERE target = $1 AND applied_prod_at IS NULL', [hml])
      const r = await client.query(
        `INSERT INTO migrations (target, env, sql, checksum, agent_id, op_id, applied_prod_at, applied_prod_op)
         SELECT $1, 'hml', p.sql, p.checksum, p.agent_id, $3, now(), $3 FROM migrations p
          WHERE p.target = $2 AND NOT EXISTS (SELECT 1 FROM migrations h WHERE h.target = $1 AND h.checksum = p.checksum)
          ORDER BY p.id`,
        [hml, prod, opId],
      )
      await client.query('COMMIT')
      return r.rowCount ?? 0
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  /** DSNs vão cifrados (AES-256-GCM); nunca texto claro no banco de controle. */
  async saveTarget(t: Target, key: Buffer, opId: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO targets (name, env, dsn_rw_enc, dsn_exec_enc, dsn_ddl_enc, op_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [t.name, t.env, encryptSecret(t.dsnRw, key), encryptSecret(t.dsnExec, key), encryptSecret(t.dsnDdl, key), opId],
    )
  }

  /** Libera o alvo (nome@env) para o agente; idempotente. */
  async grantTarget(clientId: string, ref: string): Promise<void> {
    await this.pool.query(
      'UPDATE agents SET targets = array_append(targets, $2) WHERE client_id = $1 AND NOT ($2 = ANY(targets))',
      [clientId, ref],
    )
  }

  async listTargets(key: Buffer): Promise<Target[]> {
    const { rows } = await this.pool.query('SELECT * FROM targets ORDER BY name, env')
    return rows.map((r) => makeTarget(r.name, r.env, {
      dsnRw: decryptSecret(r.dsn_rw_enc, key),
      dsnExec: decryptSecret(r.dsn_exec_enc, key),
      dsnDdl: decryptSecret(r.dsn_ddl_enc, key),
    }))
  }

  async countAudit(agentId: string): Promise<number> {
    const { rows } = await this.pool.query('SELECT count(*)::int AS n FROM audit_log WHERE agent_id = $1', [agentId])
    return rows[0].n
  }
}
