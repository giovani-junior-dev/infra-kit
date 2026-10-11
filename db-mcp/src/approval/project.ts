// Execução aprovada de promote_project (hml → prod) e mirror (prod → hml).
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { DdlBatchError, type DdlRunner } from '../ddl.js'
import { applyDatabaseGrants, createOwnedDatabase } from './create-database.js'
import { dumpArgs, restoreArgs, runPgTool } from '../pg-tools.js'
import { MASK_NAME } from '../tools/handlers.js'
import { parseRef, resolveTarget, targetRef, type Target, type TargetEnv } from '../targets.js'
import type { DbClient, Migration, PendingOp, SqlParam } from '../types.js'

/** Falha com resultado para gravar no pedido (status failed). */
export class OpFailure extends Error {
  constructor(message: string, readonly result: Record<string, unknown>) {
    super(message)
  }
}

export interface ProjectDeps {
  targets: Map<string, Target>
  runDdl: DdlRunner
  connect(dsn: string): Promise<DbClient>
  readOnly(dsn: string, sql: string, params: SqlParam[]): Promise<Record<string, unknown>[]>
  createDatabase(name: string, env: TargetEnv, opId: string): Promise<{ database: string; roles: string[] }>
  store: {
    listUnapplied(target: string): Promise<Migration[]>
    getMigrations(ids: number[]): Promise<Migration[]>
    markApplied(ids: number[], opId: string): Promise<void>
    alignAfterMirror(hml: string, prod: string, opId: string): Promise<number>
  }
  adminDsns: Partial<Record<TargetEnv, string>>
  pgBinDir?: string
  masksDir?: string
  backupRole?: string
}

const qid = (s: string) => pg.escapeIdentifier(s)
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'erro')
const dbName = (dsn: string) => decodeURIComponent(new URL(dsn).pathname.slice(1))
const dbUser = (dsn: string) => decodeURIComponent(new URL(dsn).username)

/** Aceita nome@env (ou nome único, de pedido antigo); exige o env esperado. */
function needTarget(deps: ProjectDeps, ref: string, env: TargetEnv): Target {
  const t = resolveTarget(deps.targets, ref)
  if (t.env !== env) throw new Error(`alvo ${ref} não é ${env}`)
  return t
}

/** Aplica migrations (uma transação) e marca applied_prod_*. Erro → DdlBatchError, nada marcado. */
export async function applyMigrations(deps: ProjectDeps, prod: Target, list: Migration[], op: PendingOp): Promise<number> {
  if (list.length === 0) return 0
  await deps.runDdl(prod, list.map((m) => m.sql), { agentId: op.agentId, opId: op.id })
  await deps.store.markApplied(list.map((m) => m.id), op.id)
  return list.length
}

// Colunas com sequence (serial ou identity) da tabela, com o nome da sequence.
const SEQUENCES = `
  SELECT a.attname AS col, pg_get_serial_sequence(quote_ident($1), a.attname) AS seq
    FROM pg_attribute a
   WHERE a.attrelid = to_regclass(quote_ident($1)) AND a.attnum > 0 AND NOT a.attisdropped
     AND pg_get_serial_sequence(quote_ident($1), a.attname) IS NOT NULL`

// AIDEV-NOTE: role DDL (dona das tabelas): setval exige UPDATE na sequence, que a
// role exec não tem. OVERRIDING SYSTEM VALUE aceita id explícito em GENERATED ALWAYS.
// Depois da cópia, cada sequence vai para max(col)+1 (tabela vazia → 1), na mesma transação.
async function copyTables(deps: ProjectDeps, hml: Target, prod: Target, tables: string[]): Promise<Record<string, number>> {
  const copied: Record<string, number> = {}
  if (tables.length === 0) return copied
  const c = await deps.connect(prod.dsnDdl)
  try {
    await c.query('BEGIN')
    for (const t of tables) {
      const rows = await deps.readOnly(hml.dsnDdl, `SELECT * FROM ${qid(t)}`, [])
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500)
        const cols = Object.keys(batch[0])
        const values = batch.map((_, r) => `(${cols.map((_, k) => `$${r * cols.length + k + 1}`).join(', ')})`)
        const params = batch.flatMap((row) => cols.map((col) => row[col] as SqlParam))
        await c.query(`INSERT INTO ${qid(t)} (${cols.map(qid).join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${values.join(', ')}`, params)
      }
      for (const s of (await c.query(SEQUENCES, [t])).rows as { col: string; seq: string }[]) {
        await c.query(`SELECT setval($1::regclass, coalesce((SELECT max(${qid(s.col)}) FROM ${qid(t)}), 0) + 1, false)`, [s.seq])
      }
      copied[t] = rows.length
    }
    await c.query('COMMIT')
    return copied
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

const SCHEMA_KEYS = `
  SELECT 'table:' || table_name AS k FROM information_schema.tables WHERE table_schema = 'public'
  UNION ALL
  SELECT 'column:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable
    FROM information_schema.columns WHERE table_schema = 'public'
  UNION ALL
  SELECT 'index:' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname = 'public'`

export async function schemaDiff(deps: ProjectDeps, a: Target, b: Target) {
  const keys = async (t: Target) => new Set((await deps.readOnly(t.dsnDdl, SCHEMA_KEYS, [])).map((r) => String(r.k)))
  const [ka, kb] = await Promise.all([keys(a), keys(b)])
  return { onlyHml: [...ka].filter((k) => !kb.has(k)).sort(), onlyProd: [...kb].filter((k) => !ka.has(k)).sort() }
}

// AIDEV-NOTE: (a) cria o banco se faltar — falha deixa o que foi criado; (b) migrations
// e (c) cópia são transações próprias (rollback da etapa); (d) diff ≠ 0 → failed.
export async function promoteProject(deps: ProjectDeps, op: PendingOp): Promise<Record<string, unknown>> {
  const [from, ...tables] = op.params as string[]
  const hml = needTarget(deps, from, 'hml')
  const result: Record<string, unknown> = { created: false }

  const prodRef = targetRef({ name: parseRef(op.target).name, env: 'prod' })
  if (!deps.targets.has(prodRef)) {
    try {
      Object.assign(result, await deps.createDatabase(parseRef(op.target).name, 'prod', op.id), { created: true })
    } catch (e) {
      throw new OpFailure(errMsg(e), { ...result, step: 'create_database', error: errMsg(e) })
    }
  }
  const prod = needTarget(deps, prodRef, 'prod')

  try {
    result.migrations = await applyMigrations(deps, prod, await deps.store.listUnapplied(targetRef(hml)), op)
  } catch (e) {
    const failedIndex = e instanceof DdlBatchError ? e.index : undefined
    throw new OpFailure(errMsg(e), { ...result, step: 'migrations', error: errMsg(e), failedIndex })
  }

  try {
    result.copied = await copyTables(deps, hml, prod, tables)
  } catch (e) {
    throw new OpFailure(errMsg(e), { ...result, step: 'copy', error: errMsg(e) })
  }

  result.diff = await schemaDiff(deps, hml, prod)
  const { onlyHml, onlyProd } = result.diff as { onlyHml: string[]; onlyProd: string[] }
  if (onlyHml.length + onlyProd.length > 0) throw new OpFailure('schema hml × prod diverge', { ...result, step: 'diff' })
  return result
}

async function readMask(masksDir: string | undefined, name: string): Promise<string> {
  if (!masksDir || !MASK_NAME.test(name) || name.includes('..')) throw new Error(`máscara inválida: ${name}`)
  // AIDEV-NOTE: arquivo inteiro numa query simples (sem split por ';'): blocos DO $$ e
  // BEGIN/COMMIT do próprio arquivo funcionam igual ao psql. Meta-comando do psql
  // (\set ...) não existe no driver: a máscara não deve ter (falha alto se tiver).
  return readFile(path.join(masksDir, path.basename(name)), 'utf8')
}

// AIDEV-SECURITY: destino só hml (rechecado aqui, além da tool). Dump com a role DDL
// de prod (só lê); senhas vão por PGPASSWORD no processo filho, nunca no argv.
export async function mirrorToHomolog(deps: ProjectDeps, op: PendingOp): Promise<Record<string, unknown>> {
  const [from, mask] = op.params as [string, string | null]
  const prod = needTarget(deps, from, 'prod')
  const hml = needTarget(deps, op.target, 'hml')
  const admin = deps.adminDsns.hml
  if (!admin) throw new Error('DB_MCP_ADMIN_DSN_HML ausente')
  const maskSql = mask ? await readMask(deps.masksDir, mask) : null

  const dir = await mkdtemp(path.join(os.tmpdir(), 'db-mcp-mirror-'))
  const file = path.join(dir, 'prod.dump')
  try {
    await runPgTool(deps.pgBinDir, 'pg_dump', dumpArgs(file), prod.dsnDdl)
    const name = dbName(hml.dsnDdl)
    await createOwnedDatabase(admin, name, dbUser(hml.dsnDdl), [dbUser(hml.dsnRw), dbUser(hml.dsnExec)])
    // AIDEV-NOTE: daqui em diante o hml antigo já foi apagado: toda falha diz isso no resultado.
    const result: Record<string, unknown> = { from: targetRef(prod), to: targetRef(hml), masked: mask ?? null, hmlRecreated: true }
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      try { return await fn() } catch (e) { throw new OpFailure(errMsg(e), { ...result, step: name, error: errMsg(e) }) }
    }
    await step('restore', async () => {
      await applyDatabaseGrants(hml.dsnDdl, name, dbUser(hml.dsnRw), dbUser(hml.dsnExec), deps.backupRole)
      await runPgTool(deps.pgBinDir, 'pg_restore', restoreArgs(file, name), hml.dsnDdl)
      // Restore cria as tabelas como a dona: reaplica os grants nas tabelas novas.
      await applyDatabaseGrants(hml.dsnDdl, name, dbUser(hml.dsnRw), dbUser(hml.dsnExec), deps.backupRole)
    })
    if (maskSql) {
      await step('mask', async () => {
        const c = await deps.connect(hml.dsnDdl)
        try { await c.query(maskSql) } finally { c.release() }
      })
    }
    result.migrationsAligned = await step('control', () => deps.store.alignAfterMirror(targetRef(hml), targetRef(prod), op.id))
    return result
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
