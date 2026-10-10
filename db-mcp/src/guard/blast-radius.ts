import { createHash } from 'node:crypto'
import { classify, previewSql } from './sql-classifier.js'
import { targetRef, type Target } from '../targets.js'
import type { AuditEntry, AuditOutcome, DbClient, NewPendingOp, PendingRef, SqlParam } from '../types.js'

export interface WriteDeps {
  connectRw(target: Target): Promise<DbClient>
  enqueue(op: NewPendingOp): Promise<PendingRef>
  audit(entry: AuditEntry): Promise<void>
}

export interface WriteInput {
  target: Target
  sql: string
  params: SqlParam[]
  agentId: string
  reason: string
  tool: string
  /** Verbo que a ferramenta aceita; qualquer outro é recusado. */
  expected: 'INSERT' | 'UPDATE' | 'DELETE'
}

export type WriteResult =
  | { status: 'executed'; rows: number; returning?: Record<string, unknown>[] }
  | ({ status: 'pending' } & PendingRef)

export class GuardError extends Error {}

/** Linhas desconhecidas: DELETE não é medido na role rw (ela não tem DELETE). */
const UNKNOWN_ROWS = -1

export function sqlHash(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

// AIDEV-SECURITY: guardrail por impacto. A escrita roda numa transação; só commita
// se ficou dentro do limite do alvo (e UPDATE tem WHERE). Senão ROLLBACK + pedido.
export async function guardedWrite(deps: WriteDeps, input: WriteInput): Promise<WriteResult> {
  const { target, sql, params, agentId, reason, tool, expected } = input
  const audit = (outcome: AuditOutcome, rows: number | null, opId?: string) =>
    deps.audit({ agentId, target: targetRef(target), tool, sqlHash: sqlHash(sql), sqlPreview: previewSql(sql), rows, outcome, opId })
  const enqueue = async (rows: number): Promise<WriteResult> => {
    const kind = expected.toLowerCase() as NewPendingOp['kind']
    const ref = await deps.enqueue({ agentId, target: targetRef(target), kind, sql, params, estimatedRows: rows, reason })
    await audit('pending', rows, ref.opId)
    return { status: 'pending', ...ref }
  }

  const { kind, hasWhere } = classify(sql)
  if (kind !== expected) {
    await audit('refused', null)
    throw new GuardError(`comando não permitido nesta ferramenta (classificado como ${kind}, esperado ${expected})`)
  }
  if (kind === 'DELETE') return enqueue(UNKNOWN_ROWS)

  const client = await deps.connectRw(target)
  try {
    await client.query('BEGIN')
    const r = await client.query(sql, params)
    const rows = r.rowCount ?? 0
    const limit = kind === 'INSERT' ? target.limits.insertRows : target.limits.updateRows
    const whereOk = kind === 'UPDATE' ? hasWhere : true
    if (rows <= limit && whereOk) {
      await client.query('COMMIT')
      await audit('executed', rows)
      // Só statement com RETURNING traz linhas; sem ele a resposta segue igual.
      return r.rows.length > 0 ? { status: 'executed', rows, returning: r.rows } : { status: 'executed', rows }
    }
    await client.query('ROLLBACK')
    return await enqueue(rows)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    await audit('failed', null)
    throw e
  } finally {
    client.release()
  }
}
