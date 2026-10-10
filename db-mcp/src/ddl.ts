import { createHash } from 'node:crypto'
import { classify } from './guard/sql-classifier.js'
import { targetRef, type Target } from './targets.js'
import type { DbClient, DdlMeta } from './types.js'

export interface NewMigration {
  target: string
  env: string
  sql: string
  checksum: string
  agentId: string
  opId: string | null
}

export interface DdlRunnerDeps {
  /** Role DDL (dona do schema). A rw nunca roda DDL. */
  connectDdl(target: Target): Promise<DbClient>
  recordMigrations(rows: NewMigration[]): Promise<void>
}

/** Falha num lote: índice (0-based) do comando que abortou a transação. */
export class DdlBatchError extends Error {
  constructor(readonly index: number, message: string) {
    super(message)
  }
}

export const checksum = (sql: string) => createHash('sha256').update(sql.trim()).digest('hex')

// AIDEV-NOTE: lote = uma transação, em ordem, aborta no primeiro erro (nada fica pela
// metade). CREATE INDEX CONCURRENTLY não roda em transação: só aceito sozinho.
export function createDdlRunner(deps: DdlRunnerDeps) {
  return async function run(target: Target, statements: string[], meta: DdlMeta): Promise<void> {
    if (statements.length === 0) return
    const concurrent = statements.some((s) => classify(s).concurrently)
    if (concurrent && statements.length > 1) throw new DdlBatchError(0, 'CREATE INDEX CONCURRENTLY não roda em lote')

    const c = await deps.connectDdl(target)
    try {
      if (concurrent) {
        await c.query(statements[0])
      } else {
        await c.query('BEGIN')
        for (const [i, sql] of statements.entries()) {
          try {
            await c.query(sql)
          } catch (e) {
            await c.query('ROLLBACK').catch(() => {})
            throw new DdlBatchError(i, e instanceof Error ? e.message : 'erro')
          }
        }
        await c.query('COMMIT')
      }
    } finally {
      c.release()
    }
    await deps.recordMigrations(statements.map((sql) => ({
      target: targetRef(target), env: target.env, sql, checksum: checksum(sql), agentId: meta.agentId, opId: meta.opId,
    })))
  }
}

export type DdlRunner = ReturnType<typeof createDdlRunner>
