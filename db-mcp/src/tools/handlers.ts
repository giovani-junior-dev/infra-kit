import { classify, previewSql } from '../guard/sql-classifier.js'
import { guardedWrite, sqlHash, type WriteDeps } from '../guard/blast-radius.js'
import { resolveTarget, targetRef, type Target, type TargetEnv } from '../targets.js'
import type { Agent, AuditOutcome, DdlMeta, Migration, NewPendingOp, PendingOp, SqlParam } from '../types.js'

export class ToolError extends Error {}

export interface ToolContext {
  agent: Agent
  targets: Map<string, Target>
  write: WriteDeps
  /** Executa numa transação READ ONLY com a role rw. */
  readOnly(target: Target, sql: string, params: SqlParam[]): Promise<Record<string, unknown>[]>
  listOps(agentId: string, opId?: string): Promise<PendingOp[]>
  ddl: {
    /** Roda as DDL em ordem com a role DDL (uma transação) e grava em migrations. */
    run(target: Target, statements: string[], meta: DdlMeta): Promise<void>
    migrations(target: string, since?: Date): Promise<Migration[]>
    /** Migrations do alvo hml ainda não aplicadas em prod, em ordem. */
    unapplied(target: string): Promise<Migration[]>
  }
  /** Envs com DSN admin (DB_MCP_ADMIN_DSN_HML/_PROD) e chave configurados. */
  createDatabaseEnvs: ReadonlySet<TargetEnv>
  /** Arquivo de máscara existe em DB_MCP_MASKS_DIR (nome já validado). */
  maskExists(name: string): Promise<boolean>
}

const DB_NAME = /^[a-z][a-z0-9_]{1,40}$/
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
/** Só nome de arquivo .sql, sem diretório nem "..". */
export const MASK_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\.sql$/
const RESERVED_DBS = new Set(['postgres', 'template0', 'template1', 'mcp_control'])
const DDL_KINDS = new Set(['DDL_CREATE', 'DDL_DESTRUCTIVE'])

interface QueryArgs { target: string; sql: string; params?: SqlParam[]; limit?: number }
interface WriteArgs { target: string; sql: string; params?: SqlParam[]; reason: string }

const SCHEMA_SQL = `SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND ($1::text IS NULL OR table_name = $1)
 ORDER BY table_name, ordinal_position`

export function createHandlers(ctx: ToolContext) {
  const audit = (tool: string, target: string, sql: string, outcome: AuditOutcome, rows: number | null) =>
    ctx.write.audit({ agentId: ctx.agent.clientId, target, tool, sqlHash: sqlHash(sql), sqlPreview: previewSql(sql), rows, outcome })

  async function audited(tool: string, target: string, sql: string, run: () => Promise<Record<string, unknown>[]>) {
    try {
      const rows = await run()
      await audit(tool, target, sql, 'executed', rows.length)
      return rows
    } catch (e) {
      await audit(tool, target, sql, 'failed', null)
      throw e
    }
  }

  /** Aceita nome@env ou nome único; permissão do agente é por nome@env. */
  async function resolve(tool: string, ref: string, sql: string): Promise<Target> {
    let target: Target
    try {
      target = resolveTarget(ctx.targets, ref)
    } catch (e) {
      await audit(tool, ref, sql, 'refused', null)
      throw new ToolError(e instanceof Error ? e.message : 'alvo inválido')
    }
    const canonical = targetRef(target)
    if (!ctx.agent.targets.includes(canonical)) {
      await audit(tool, canonical, sql, 'refused', null)
      throw new ToolError(`alvo não permitido para este agente: ${canonical}`)
    }
    return target
  }

  async function enqueue(tool: string, op: Omit<NewPendingOp, 'agentId'>) {
    const ref = await ctx.write.enqueue({ ...op, agentId: ctx.agent.clientId })
    await ctx.write.audit({
      agentId: ctx.agent.clientId, target: op.target, tool, sqlHash: sqlHash(op.sql),
      sqlPreview: previewSql(op.sql), rows: op.estimatedRows, outcome: 'pending', opId: ref.opId,
    })
    return { status: 'pending' as const, ...ref }
  }

  const script = (list: Migration[]) => list.map((m) => `${m.sql.trim().replace(/;\s*$/, '')};\n`).join('')

  async function unappliedBatch(from: string): Promise<Migration[]> {
    const list = await ctx.ddl.unapplied(from)
    if (list.some((m) => classify(m.sql).concurrently)) {
      throw new ToolError('lote com CREATE INDEX CONCURRENTLY não roda em transação: promova esse índice sozinho com db_ddl')
    }
    return list
  }

  const write = (tool: string, expected: 'INSERT' | 'UPDATE' | 'DELETE') => async (a: WriteArgs) =>
    guardedWrite(ctx.write, {
      target: await resolve(tool, a.target, a.sql),
      sql: a.sql, params: a.params ?? [], agentId: ctx.agent.clientId, reason: a.reason, tool, expected,
    })

  return {
    async db_query(a: QueryArgs) {
      const target = await resolve('db_query', a.target, a.sql)
      if (classify(a.sql).kind !== 'SELECT') {
        await audit('db_query', targetRef(target), a.sql, 'refused', null)
        throw new ToolError('db_query aceita só SELECT')
      }
      const body = a.sql.trim().replace(/;\s*$/, '')
      const limit = a.limit ?? target.limits.selectRows
      const rows = await audited('db_query', targetRef(target), a.sql, () =>
        ctx.readOnly(target, `SELECT * FROM (\n${body}\n) AS _q LIMIT ${limit}`, a.params ?? []))
      return { rows, rowCount: rows.length, limit }
    },
    db_insert: write('db_insert', 'INSERT'),
    db_update: write('db_update', 'UPDATE'),
    db_delete_request: write('db_delete_request', 'DELETE'),
    async db_pending(a: { op_id?: string }) {
      const ops = await ctx.listOps(ctx.agent.clientId, a.op_id)
      return ops.map((o) => ({
        op_id: o.id, target: o.target, kind: o.kind, status: o.status, estimated_rows: o.estimatedRows,
        sql_preview: previewSql(o.sql), created_at: o.createdAt, expires_at: o.expiresAt, result: o.result,
      }))
    },
    async db_ddl(a: { target: string; sql: string; reason: string }) {
      const target = await resolve('db_ddl', a.target, a.sql)
      const { kind } = classify(a.sql)
      if (!DDL_KINDS.has(kind)) {
        await audit('db_ddl', targetRef(target), a.sql, 'refused', null)
        throw new ToolError(`comando não permitido em db_ddl (classificado como ${kind})`)
      }
      // Só DDL aditiva em hml roda direto; destrutiva (qualquer env) e tudo em prod pede OK.
      if (target.env !== 'hml' || kind === 'DDL_DESTRUCTIVE') {
        return enqueue('db_ddl', { target: targetRef(target), kind: 'ddl', sql: a.sql, params: [], estimatedRows: 0, reason: a.reason })
      }
      try {
        await ctx.ddl.run(target, [a.sql], { agentId: ctx.agent.clientId, opId: null })
      } catch (e) {
        await audit('db_ddl', targetRef(target), a.sql, 'failed', null)
        throw e
      }
      await audit('db_ddl', targetRef(target), a.sql, 'executed', null)
      return { status: 'executed' as const, class: kind }
    },
    async db_create_database(a: { name: string; env: 'hml' | 'prod'; reason: string }) {
      const ref = targetRef({ name: a.name, env: a.env })
      if (!DB_NAME.test(a.name) || RESERVED_DBS.has(a.name) || ctx.targets.has(ref)) {
        throw new ToolError('nome de banco inválido ou já existente (use a-z, 0-9, _; começa com letra)')
      }
      if (!ctx.createDatabaseEnvs.has(a.env)) {
        throw new ToolError(`criação de banco em ${a.env} não configurada (DB_MCP_ADMIN_DSN_${a.env.toUpperCase()} e DB_MCP_TARGETS_KEY)`)
      }
      return enqueue('db_create_database', {
        target: ref, kind: 'create_database', sql: `CREATE DATABASE "${a.name}"`,
        params: [a.name, a.env], estimatedRows: 0, reason: a.reason,
      })
    },
    async db_migrations_export(a: { target: string; since?: string }) {
      const list = await ctx.ddl.migrations(targetRef(await resolve('db_migrations_export', a.target, '')), a.since ? new Date(a.since) : undefined)
      return {
        count: list.length,
        migrations: list.map((m) => ({ id: m.id, sql: m.sql, checksum: m.checksum, executed_at: m.executedAt })),
        script: script(list),
      }
    },
    async db_migrations_promote(a: { from: string; to: string; reason: string }) {
      const from = await resolve('db_migrations_promote', a.from, '')
      const to = await resolve('db_migrations_promote', a.to, '')
      if (from.env !== 'hml' || to.env !== 'prod') throw new ToolError('promote só de um alvo hml para um alvo prod')
      const list = await unappliedBatch(targetRef(from))
      if (list.length === 0) throw new ToolError('nenhuma migration pendente de aplicar em prod')
      // params = ids: o executor relê o SQL do banco de controle e marca applied_prod_*.
      return enqueue('db_migrations_promote', {
        target: targetRef(to), kind: 'promote', sql: `-- promote ${targetRef(from)} -> ${targetRef(to)}\n${script(list)}`,
        params: list.map((m) => m.id), estimatedRows: list.length, reason: a.reason,
      })
    },
    async db_promote_project(a: { from: string; database?: string; copy_tables?: string[]; reason: string }) {
      const from = await resolve('db_promote_project', a.from, '')
      if (from.env !== 'hml') throw new ToolError('origem do promote_project precisa ser um alvo hml')
      // Destino = mesmo projeto em prod (nome do banco igual nos dois servidores).
      const database = a.database ?? from.name
      if (!DB_NAME.test(database) || RESERVED_DBS.has(database)) throw new ToolError('nome de banco prod inválido')
      const to = targetRef({ name: database, env: 'prod' })
      const existing = ctx.targets.has(to)
      if (existing) await resolve('db_promote_project', to, '')
      else if (!ctx.createDatabaseEnvs.has('prod')) {
        throw new ToolError('criação de banco em prod não configurada (DB_MCP_ADMIN_DSN_PROD e DB_MCP_TARGETS_KEY)')
      }
      const tables = a.copy_tables ?? []
      const bad = tables.find((t) => !TABLE_NAME.test(t))
      if (bad !== undefined) throw new ToolError(`nome de tabela inválido em copy_tables: ${bad}`)
      const list = await unappliedBatch(targetRef(from))
      return enqueue('db_promote_project', {
        target: to, kind: 'promote_project',
        sql: `-- promote_project ${targetRef(from)} -> ${to}${existing ? '' : ' (cria o banco)'}\n-- copia dados: ${tables.join(', ') || 'nenhuma tabela'}\n${script(list)}`,
        params: [targetRef(from), ...tables], estimatedRows: list.length, reason: a.reason,
      })
    },
    async db_mirror_to_homolog(a: { from: string; to?: string; mask_script?: string; reason: string }) {
      const from = await resolve('db_mirror_to_homolog', a.from, '')
      if (from.env !== 'prod') throw new ToolError('origem do mirror precisa ser um alvo prod')
      const to = await resolve('db_mirror_to_homolog', a.to ?? targetRef({ name: from.name, env: 'hml' }), '')
      // AIDEV-SECURITY: o mirror apaga e recria o destino. Nunca em prod.
      if (to.env !== 'hml') throw new ToolError('destino do mirror precisa ser um alvo hml (nunca prod)')
      if (!ctx.createDatabaseEnvs.has('hml')) throw new ToolError('mirror exige DB_MCP_ADMIN_DSN_HML e DB_MCP_TARGETS_KEY configurados')
      const mask = a.mask_script
      if (mask !== undefined && (!MASK_NAME.test(mask) || mask.includes('..') || !(await ctx.maskExists(mask)))) {
        throw new ToolError(`máscara inválida ou não registrada em DB_MCP_MASKS_DIR: ${mask}`)
      }
      return enqueue('db_mirror_to_homolog', {
        target: targetRef(to), kind: 'mirror',
        sql: `-- mirror ${targetRef(from)} -> ${targetRef(to)} (apaga e recria ${targetRef(to)})${mask ? `\n-- máscara: ${mask}` : '\n-- SEM máscara'}`,
        params: [targetRef(from), mask ?? null], estimatedRows: 0, reason: a.reason,
      })
    },
    async db_schema(a: { target: string; table?: string }) {
      const target = await resolve('db_schema', a.target, SCHEMA_SQL)
      return audited('db_schema', targetRef(target), SCHEMA_SQL, () => ctx.readOnly(target, SCHEMA_SQL, [a.table ?? null]))
    },
  }
}

export type Handlers = ReturnType<typeof createHandlers>
