// Integração promote_project + mirror contra Postgres real (opcional):
//   DB_MCP_IT_ADMIN_URL   superuser descartável ("servidor prod")
//   DB_MCP_IT_HML_PORT    mesma instância em outra porta ("servidor hml")
//   DB_MCP_IT_PG_BIN_DIR  pasta com pg_dump/pg_restore 16 (senão usa o PATH)
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createRuntime, type Runtime } from '../src/runtime'
import { handleApproval, signToken } from '../src/approval/link'
import { createHandlers } from '../src/tools/handlers'
import { decryptSecret, parseKey } from '../src/crypto'
import type { Agent } from '../src/types'
import { createControlDb } from './fixtures/control-db'

const ADMIN = process.env.DB_MCP_IT_ADMIN_URL
const HML_PORT = process.env.DB_MCP_IT_HML_PORT
const SECRET = 'it-secret'
const KEY_HEX = randomBytes(32).toString('hex')
const DBS = ['dbmcp_prj_control', 'proj_hml', 'proj']
const ROLES = ['dbmcp_prj_admin_hml', 'dbmcp_prj_admin_prod', ...['proj_hml', 'proj'].flatMap((d) => ['rw', 'exec', 'ddl'].map((r) => `mcp_${d}_${r}`))]

function dsn(user: string, pass: string, db: string, port?: string): string {
  const u = new URL(ADMIN!)
  if (port) u.port = port
  u.username = user
  u.password = pass
  u.pathname = `/${db}`
  return u.toString()
}
const superDsn = (db: string) => { const u = new URL(ADMIN!); u.pathname = `/${db}`; return u.toString() }

async function run(url: string, sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try { return await c.query(sql, params) } finally { await c.end() }
}

describe.skipIf(!ADMIN)('db-mcp promote_project e mirror contra Postgres real', () => {
  let admin: pg.Client
  let rt: Runtime
  let masksDir: string
  const agent: Agent = { clientId: 'cid', name: 'agente-it', targets: ['proj_hml@hml', 'proj@prod'], active: true }
  const h = () => createHandlers(rt.toolContext(agent))
  const opId = (r: unknown) => (r as { opId: string }).opId

  async function approve(id: string) {
    const op = (await rt.store.getOp(id))!
    await handleApproval(rt.approval, { id: op.id, token: signToken(op.id, op.expiresAt, SECRET), action: 'approve', by: 'dono', now: new Date() })
    return rt.store.getOp(id)
  }
  const count = async (target: string, table: string) =>
    Number((await run(rt.targets.get(target)!.dsnDdl, `SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN })
    await admin.connect()
    for (const d of DBS) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
    for (const r of ROLES) await admin.query(`DROP ROLE IF EXISTS ${r}`)
    await admin.query(`CREATE ROLE dbmcp_prj_admin_hml LOGIN PASSWORD 'pw' CREATEDB CREATEROLE`)
    await admin.query(`CREATE ROLE dbmcp_prj_admin_prod LOGIN PASSWORD 'pw' CREATEDB CREATEROLE`)
    const controlDsn = await createControlDb(ADMIN!, 'dbmcp_prj_control')

    masksDir = mkdtempSync(path.join(os.tmpdir(), 'dbmcp-masks-'))
    writeFileSync(path.join(masksDir, 'mask.sql'), [
      'BEGIN;',
      "DO $$ BEGIN IF current_database() NOT LIKE '%\\_hml' THEN RAISE EXCEPTION 'recusado; nao e hml'; END IF; END $$;",
      "UPDATE clientes SET nome = 'mascarado';",
      'COMMIT;',
    ].join('\n'))

    rt = await createRuntime({
      targets: new Map(),
      controlDsn,
      secret: SECRET,
      baseUrl: 'http://127.0.0.1:8002',
      adminDsns: { hml: dsn('dbmcp_prj_admin_hml', 'pw', 'postgres', HML_PORT), prod: dsn('dbmcp_prj_admin_prod', 'pw', 'postgres') },
      targetsKey: parseKey(KEY_HEX),
      masksDir,
      pgBinDir: process.env.DB_MCP_IT_PG_BIN_DIR,
      env: {},
    })
  }, 60_000)

  afterAll(async () => {
    await rt?.close()
    if (masksDir) rmSync(masksDir, { recursive: true, force: true })
    if (admin) {
      for (const d of DBS) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
      for (const r of ROLES) await admin.query(`DROP ROLE IF EXISTS ${r}`)
      await admin.end()
    }
  })

  it('prepara o projeto em hml', async () => {
    expect(await approve(opId(await h().db_create_database({ name: 'proj_hml', env: 'hml', reason: 'it' })))).toMatchObject({ status: 'executed' })
    for (const sql of [
      'CREATE TABLE produtos (id int PRIMARY KEY, nome text NOT NULL)',
      'CREATE TABLE clientes (id int PRIMARY KEY, nome text)',
      'CREATE INDEX produtos_nome_idx ON produtos (nome)',
    ]) expect(await h().db_ddl({ target: 'proj_hml', sql, reason: 'it' })).toMatchObject({ status: 'executed' })
    await h().db_insert({ target: 'proj_hml', sql: "INSERT INTO produtos VALUES (1, 'caneta'), (2, 'lápis')", reason: 'it' })
    await h().db_insert({ target: 'proj_hml', sql: "INSERT INTO clientes VALUES (1, 'teste hml')", reason: 'it' })
  })

  it('promote_project cria o banco prod, aplica migrations, copia só a tabela marcada e o diff é zero', async () => {
    const r = await h().db_promote_project({ from: 'proj_hml', database: 'proj', copy_tables: ['produtos'], reason: 'go-live' })
    expect(r).toMatchObject({ status: 'pending', estimatedRows: 3 })
    const op = await approve(opId(r))
    expect(op).toMatchObject({
      status: 'executed',
      result: { created: true, migrations: 3, copied: { produtos: 2 }, diff: { onlyHml: [], onlyProd: [] } },
    })
    expect(rt.targets.get('proj@prod')).toMatchObject({ env: 'prod' })
    expect(new URL(rt.targets.get('proj@prod')!.dsnRw).port).toBe(new URL(ADMIN!).port)
    expect(await count('proj@prod', 'produtos')).toBe(2)
    expect(await count('proj@prod', 'clientes')).toBe(0)
    expect((await rt.store.listUnapplied('proj_hml@hml')).length).toBe(0)
  })

  it('segunda promoção aplica só as migrations novas', async () => {
    await h().db_ddl({ target: 'proj_hml', sql: 'ALTER TABLE produtos ADD COLUMN preco int', reason: 'it' })
    const r = await h().db_promote_project({ from: 'proj_hml', database: 'proj', reason: 'release 2' })
    expect(r).toMatchObject({ estimatedRows: 1 })
    expect(await approve(opId(r))).toMatchObject({
      status: 'executed', result: { created: false, migrations: 1, copied: {}, diff: { onlyHml: [], onlyProd: [] } },
    })
  })

  it('diff ≠ 0 marca failed com o diff', async () => {
    await run(rt.targets.get('proj@prod')!.dsnDdl, 'CREATE TABLE so_prod (id int)')
    const r = await h().db_promote_project({ from: 'proj_hml', database: 'proj', reason: 'x' })
    const op = await approve(opId(r))
    expect(op?.status).toBe('failed')
    expect(JSON.stringify((op?.result as { diff: unknown }).diff)).toContain('so_prod')
    await run(rt.targets.get('proj@prod')!.dsnDdl, 'DROP TABLE so_prod')
  })

  it('mirror recusa destino prod', async () => {
    await expect(h().db_mirror_to_homolog({ from: 'proj', to: 'proj', reason: 'x' })).rejects.toThrow(/destino.*hml/)
  })

  it('mirror recria hml com os dados de prod, aplica a máscara e alinha as migrations', async () => {
    await run(rt.targets.get('proj@prod')!.dsnExec, "INSERT INTO clientes VALUES (7, 'Fulano Real')")
    await run(rt.targets.get('proj_hml@hml')!.dsnRw, "INSERT INTO produtos VALUES (99, 'só em hml')")
    const op = await approve(opId(await h().db_mirror_to_homolog({ from: 'proj', to: 'proj_hml', mask_script: 'mask.sql', reason: 'refresh' })))
    expect(op).toMatchObject({ status: 'executed', result: { masked: 'mask.sql' } })
    const hml = rt.targets.get('proj_hml@hml')!
    expect((await run(hml.dsnDdl, 'SELECT id, nome FROM clientes')).rows).toEqual([{ id: 7, nome: 'mascarado' }])
    expect(await count('proj_hml@hml', 'produtos')).toBe(2)
    expect((await rt.store.listUnapplied('proj_hml@hml')).length).toBe(0)
    // Grants recriados: rw escreve, mas não apaga.
    await run(hml.dsnRw, "INSERT INTO produtos (id, nome) VALUES (3, 'novo')")
    await expect(run(hml.dsnRw, 'DELETE FROM produtos WHERE id = 3')).rejects.toThrow(/permission denied/)
  })

  it('senhas dos bancos criados não aparecem em auditoria, pedidos nem migrations', async () => {
    const key = parseKey(KEY_HEX)
    const rows = (await run(superDsn('dbmcp_prj_control'), 'SELECT * FROM targets')).rows
    const passwords = rows.flatMap((r) => [r.dsn_rw_enc, r.dsn_exec_enc, r.dsn_ddl_enc]).map((e) => decodeURIComponent(new URL(decryptSecret(e, key)).password))
    expect(passwords).toHaveLength(6)
    const dump = JSON.stringify(await Promise.all(['audit_log', 'pending_ops', 'migrations'].map(async (t) => (await run(superDsn('dbmcp_prj_control'), `SELECT * FROM ${t}`)).rows)))
    for (const p of passwords) expect(dump).not.toContain(p)
  })
})
