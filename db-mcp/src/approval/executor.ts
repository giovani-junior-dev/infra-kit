import { previewSql } from '../guard/sql-classifier.js'
import { sqlHash } from '../guard/blast-radius.js'
import { DdlBatchError, type DdlRunner } from '../ddl.js'
import { applyMigrations, mirrorToHomolog, OpFailure, promoteProject, type ProjectDeps } from './project.js'
import { resolveTarget, type Target, type TargetEnv } from '../targets.js'
import type { AuditEntry, DbClient, PendingOp } from '../types.js'

export interface ExecutorDeps {
  targets: Map<string, Target>
  /** Única porta para a role com DELETE. */
  connectExec(target: Target): Promise<DbClient>
  /** DDL e promote: role DDL, transação, grava migrations. */
  runDdl: DdlRunner
  /** Cria banco + roles e registra o alvo. Devolve só nomes, nunca senhas. */
  createDatabase(name: string, env: TargetEnv, opId: string): Promise<{ database: string; roles: string[] }>
  /** promote, promote_project e mirror. */
  project?: ProjectDeps
  store: {
    finish(id: string, status: 'executed' | 'failed', result: unknown): Promise<void>
    audit(e: AuditEntry): Promise<void>
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'erro')

async function runDml(deps: ExecutorDeps, target: Target, op: PendingOp): Promise<{ rows: number }> {
  const c = await deps.connectExec(target)
  try {
    await c.query('BEGIN')
    const r = await c.query(op.sql, op.params)
    await c.query('COMMIT')
    return { rows: r.rowCount ?? 0 }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

// AIDEV-SECURITY: só roda pedido já aprovado (handleApproval garante a transição
// pending → approved antes). Falha grava failed e mantém o pedido para reanálise.
export function createExecutor(deps: ExecutorDeps) {
  async function run(op: PendingOp): Promise<Record<string, unknown>> {
    if (op.kind === 'create_database') {
      const [name, env] = op.params as [string, TargetEnv]
      return deps.createDatabase(name, env, op.id)
    }
    if (op.kind === 'promote_project') {
      if (!deps.project) throw new Error('promote_project não configurado')
      return promoteProject(deps.project, op)
    }
    // Pedido antigo (antes de nome@env) traz só o nome: resolve se for único.
    const target = resolveTarget(deps.targets, op.target)
    const meta = { agentId: op.agentId, opId: op.id }
    if (op.kind === 'ddl') {
      await deps.runDdl(target, [op.sql], meta)
      return { statements: 1 }
    }
    if (op.kind === 'mirror' || op.kind === 'promote') {
      if (!deps.project) throw new Error(`${op.kind} não configurado`)
      if (op.kind === 'mirror') return mirrorToHomolog(deps.project, op)
      const list = await deps.project.store.getMigrations(op.params as number[])
      return { statements: await applyMigrations(deps.project, target, list, op) }
    }
    return runDml(deps, target, op)
  }

  return async function execute(op: PendingOp): Promise<void> {
    const audit = (outcome: 'executed' | 'failed', rows: number | null) =>
      deps.store.audit({ agentId: op.agentId, target: op.target, tool: 'executor', sqlHash: sqlHash(op.sql), sqlPreview: previewSql(op.sql), rows, outcome, opId: op.id })
    try {
      const result = await run(op)
      await deps.store.finish(op.id, 'executed', result)
      await audit('executed', typeof result.rows === 'number' ? result.rows : null)
    } catch (e) {
      const result = e instanceof OpFailure ? e.result
        : e instanceof DdlBatchError ? { error: e.message, failedIndex: e.index }
          : { error: errorMessage(e) }
      await deps.store.finish(op.id, 'failed', result)
      await audit('failed', null)
    }
  }
}
