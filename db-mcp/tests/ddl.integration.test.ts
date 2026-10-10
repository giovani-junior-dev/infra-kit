// Integração DDL contra Postgres real (opcional): roda só com DB_MCP_IT_ADMIN_URL
// (superuser descartável, ex.: docker run postgres:16). Ver guardrails.integration.test.ts.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createRuntime, type Runtime } from '../src/runtime'
import { handleApproval, signToken } from '../src/approval/link'
import { createHandlers } from '../src/tools/handlers'
import { decryptSecret, parseKey } from '../src/crypto'
import { makeTarget, type Target } from '../src/targets'
import type { Agent } from '../src/types'
import { createControlDb } from './fixtures/control-db'

const ADMIN = process.env.DB_MCP_IT_ADMIN_URL
const SECRET = 'it-secret'
const KEY_HEX = randomBytes(32).toString('hex')
const DBS = ['dbmcp_ddl_hml', 'dbmcp_ddl_prod', 'dbmcp_ddl_control', 'dbmcp_ddl_novo', 'dbmcp_ddl_novo_prod']
// Homologação roda em outro servidor Postgres. No teste, o "servidor hml" é a mesma
// instância publicada em outra porta (DB_MCP_IT_HML_PORT) e com outro admin.
const HML_PORT = process.env.DB_MCP_IT_HML_PORT
const ROLES = ['dbmcp_ddl_rw', 'dbmcp_ddl_exec', 'dbmcp_ddl_owner', 'dbmcp_ddl_admin_hml', 'dbmcp_ddl_admin_prod', 'mcp_dbmcp_ddl_novo_rw', 'mcp_dbmcp_ddl_novo_exec', 'mcp_dbmcp_ddl_novo_ddl']

function dsn(user: string, pass: string, db: string, port?: string): string {
  const u = new URL(ADMIN!)
  if (port) u.port = port
  u.username = user
  u.password = pass
  u.pathname = `/${db}`
  return u.toString()
}
const superDsn = (db: string) => { const u = new URL(ADMIN!); u.pathname = `/${db}`; return u.toString() }

async function q(db: string, sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: superDsn(db) })
  await c.connect()
  try { return await c.query(sql, params) } finally { await c.end() }
}

describe.skipIf(!ADMIN)('db-mcp DDL contra Postgres real', () => {
  let admin: pg.Client
  let rt: Runtime
  let hml: Target
  let prod: Target
  const agent: Agent = { clientId: 'cid', name: 'agente-it', targets: ['hml@hml', 'prod@prod', 'dbmcp_ddl_novo@hml', 'dbmcp_ddl_novo_prod@prod'], active: true }
  const h = () => createHandlers(rt.toolContext(agent))

  async function approve(opId: string) {
    const op = (await rt.store.getOp(opId))!
    return handleApproval(rt.approval, { id: op.id, token: signToken(op.id, op.expiresAt, SECRET), action: 'approve', by: 'dono', now: new Date() })
  }
  const tableExists = async (db: string, t: string) => (await q(db, 'SELECT to_regclass($1) AS r', [t])).rows[0].r !== null

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN })
    await admin.connect()
    for (const d of DBS) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
    for (const r of ROLES) await admin.query(`DROP ROLE IF EXISTS ${r}`)
    for (const r of ['dbmcp_ddl_rw', 'dbmcp_ddl_exec', 'dbmcp_ddl_owner']) await admin.query(`CREATE ROLE ${r} LOGIN PASSWORD 'pw'`)
    // Admin do executor por env: CREATEDB/CREATEROLE, nunca superuser. O de prod fica
    // sem CREATEDB/CREATEROLE: se o executor usar a conexão errada, o teste falha.
    await admin.query(`CREATE ROLE dbmcp_ddl_admin_hml LOGIN PASSWORD 'pw' CREATEDB CREATEROLE`)
    await admin.query(`CREATE ROLE dbmcp_ddl_admin_prod LOGIN PASSWORD 'pw'`)
    for (const d of ['dbmcp_ddl_hml', 'dbmcp_ddl_prod']) {
      await admin.query(`CREATE DATABASE ${d} OWNER dbmcp_ddl_owner`)
      await q(d, `GRANT USAGE ON SCHEMA public TO dbmcp_ddl_rw, dbmcp_ddl_exec;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE dbmcp_ddl_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO dbmcp_ddl_rw;
        ALTER DEFAULT PRIVILEGES FOR ROLE dbmcp_ddl_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dbmcp_ddl_exec`)
    }
    const controlDsn = await createControlDb(ADMIN!, 'dbmcp_ddl_control')

    const roles = (db: string) => ({ dsnRw: dsn('dbmcp_ddl_rw', 'pw', db), dsnExec: dsn('dbmcp_ddl_exec', 'pw', db), dsnDdl: dsn('dbmcp_ddl_owner', 'pw', db) })
    hml = makeTarget('hml', 'hml', roles('dbmcp_ddl_hml'))
    prod = makeTarget('prod', 'prod', roles('dbmcp_ddl_prod'))
    rt = await createRuntime({
      targets: new Map([['hml@hml', hml], ['prod@prod', prod]]),
      controlDsn,
      secret: SECRET,
      baseUrl: 'http://127.0.0.1:8002',
      adminDsns: { hml: dsn('dbmcp_ddl_admin_hml', 'pw', 'postgres', HML_PORT), prod: dsn('dbmcp_ddl_admin_prod', 'pw', 'postgres') },
      targetsKey: parseKey(KEY_HEX),
      env: {},
    })
  }, 60_000)

  afterAll(async () => {
    await rt?.close()
    if (admin) {
      for (const d of DBS) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
      for (const r of ROLES) await admin.query(`DROP ROLE IF EXISTS ${r}`)
      await admin.end()
    }
  })

  it('role rw continua sem DDL: CREATE TABLE = permission denied', async () => {
    const c = new pg.Client({ connectionString: hml.dsnRw })
    await c.connect()
    await expect(c.query('CREATE TABLE nope (a int)')).rejects.toThrow(/permission denied/)
    await c.end()
  })

  it('hml executa DDL direto e grava migrations; rw usa a tabela nova', async () => {
    expect(await h().db_ddl({ target: 'hml', sql: 'CREATE TABLE h1 (id int PRIMARY KEY)', reason: 'it' })).toMatchObject({ status: 'executed' })
    expect(await h().db_ddl({ target: 'hml', sql: 'ALTER TABLE h1 ADD COLUMN y int', reason: 'it' })).toMatchObject({ status: 'executed' })
    expect(await tableExists('dbmcp_ddl_hml', 'h1')).toBe(true)
    expect(await h().db_insert({ target: 'hml', sql: 'INSERT INTO h1 (id, y) VALUES (1, 1)', reason: 'it' })).toMatchObject({ status: 'executed' })
    const m = await h().db_migrations_export({ target: 'hml' })
    expect(m.script).toBe('CREATE TABLE h1 (id int PRIMARY KEY);\nALTER TABLE h1 ADD COLUMN y int;\n')
  })

  it('CREATE INDEX CONCURRENTLY em hml roda fora de transação', async () => {
    const r = await h().db_ddl({ target: 'hml', sql: 'CREATE INDEX CONCURRENTLY h1_y_idx ON h1 (y)', reason: 'it' })
    expect(r).toMatchObject({ status: 'executed' })
    expect(await tableExists('dbmcp_ddl_hml', 'h1_y_idx')).toBe(true)
  })

  it('DDL destrutiva em hml vira pedido e não executa', async () => {
    const r = await h().db_ddl({ target: 'hml', sql: 'DROP TABLE h1', reason: 'it' })
    expect(r).toMatchObject({ status: 'pending' })
    expect(await tableExists('dbmcp_ddl_hml', 'h1')).toBe(true)
  })

  it('prod vira pedido; só executa depois de aprovado', async () => {
    const r = await h().db_ddl({ target: 'prod', sql: 'CREATE TABLE p1 (id int)', reason: 'it' })
    expect(r).toMatchObject({ status: 'pending' })
    expect(await tableExists('dbmcp_ddl_prod', 'p1')).toBe(false)
    await approve((r as { opId: string }).opId)
    expect(await tableExists('dbmcp_ddl_prod', 'p1')).toBe(true)
    const op = await rt.store.getOp((r as { opId: string }).opId)
    expect(op?.status).toBe('executed')
    expect((await rt.store.listMigrations('prod@prod')).map((x) => x.opId)).toContain(op?.id)
  })

  it('promote aplica o lote em ordem numa aprovação', async () => {
    // Sem o índice CONCURRENTLY: promove só as 2 primeiras migrations do hml.
    await q('dbmcp_ddl_control', `DELETE FROM migrations WHERE target = 'hml@hml' AND sql LIKE '%CONCURRENTLY%'`)
    const r = await h().db_migrations_promote({ from: 'hml', to: 'prod', reason: 'release' })
    expect(r).toMatchObject({ status: 'pending', estimatedRows: 2 })
    await approve((r as { opId: string }).opId)
    const cols = await q('dbmcp_ddl_prod', `SELECT column_name FROM information_schema.columns WHERE table_name = 'h1' ORDER BY ordinal_position`)
    expect(cols.rows.map((x) => x.column_name)).toEqual(['id', 'y'])
    expect(await rt.store.getOp((r as { opId: string }).opId)).toMatchObject({ status: 'executed', result: { statements: 2 } })
    // Marcadas como aplicadas em prod pelo pedido; nada mais pendente.
    const marked = await q('dbmcp_ddl_control', `SELECT applied_prod_op FROM migrations WHERE target = 'hml@hml' ORDER BY id`)
    expect(marked.rows.every((x) => x.applied_prod_op === (r as { opId: string }).opId)).toBe(true)
    await expect(h().db_migrations_promote({ from: 'hml', to: 'prod', reason: 'de novo' })).rejects.toThrow(/nenhuma/)
  })

  it('promote aborta no primeiro erro, não deixa nada pela metade e não marca nada', async () => {
    await h().db_ddl({ target: 'hml', sql: 'CREATE TABLE h2 (id int)', reason: 'it' })
    await q('dbmcp_ddl_control', `INSERT INTO migrations (target, env, sql, checksum, agent_id) VALUES ('hml@hml', 'hml', 'ALTER TABLE h1 ADD COLUMN y int', 'x', 'cid')`)
    const r = await h().db_migrations_promote({ from: 'hml', to: 'prod', reason: 'release' })
    expect(r).toMatchObject({ estimatedRows: 2 })
    await approve((r as { opId: string }).opId)
    expect(await tableExists('dbmcp_ddl_prod', 'h2')).toBe(false)
    expect(await rt.store.getOp((r as { opId: string }).opId)).toMatchObject({ status: 'failed', result: { failedIndex: 1 } })
    expect((await rt.store.listUnapplied('hml@hml')).length).toBe(2)
  })

  it('create_database aprovado cria banco + roles; rw do banco novo não deleta; senhas fora de log/auditoria', async () => {
    const r = await h().db_create_database({ name: 'dbmcp_ddl_novo', env: 'hml', reason: 'projeto novo' })
    expect(r).toMatchObject({ status: 'pending' })
    expect((await q('postgres', `SELECT 1 FROM pg_database WHERE datname = 'dbmcp_ddl_novo'`)).rowCount).toBe(0)
    await approve((r as { opId: string }).opId)
    const op = await rt.store.getOp((r as { opId: string }).opId)
    expect(op).toMatchObject({ status: 'executed', result: { database: 'dbmcp_ddl_novo', roles: ['mcp_dbmcp_ddl_novo_rw', 'mcp_dbmcp_ddl_novo_exec', 'mcp_dbmcp_ddl_novo_ddl'] } })

    const roles = await q('postgres', `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname LIKE 'mcp_dbmcp_ddl_novo_%' ORDER BY 1`)
    expect(roles.rows).toHaveLength(3)
    expect(roles.rows.every((x) => !x.rolsuper && !x.rolcreaterole && !x.rolcreatedb)).toBe(true)

    const row = (await q('dbmcp_ddl_control', `SELECT * FROM targets WHERE name = 'dbmcp_ddl_novo'`)).rows[0]
    expect(row.dsn_rw_enc).not.toContain('postgres')
    const key = parseKey(KEY_HEX)
    const novo = { rw: decryptSecret(row.dsn_rw_enc, key), exec: decryptSecret(row.dsn_exec_enc, key), ddl: decryptSecret(row.dsn_ddl_enc, key) }
    expect(rt.targets.get('dbmcp_ddl_novo@hml')).toMatchObject({ env: 'hml', dsnRw: novo.rw })
    // Criado pelo admin hml (o de prod não tem CREATEDB) e com host/porta do servidor hml.
    const owner = await q('postgres', `SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = 'dbmcp_ddl_novo'`)
    expect(owner.rows[0].rolname).toBe('mcp_dbmcp_ddl_novo_ddl')
    const hmlAdmin = new URL(dsn('dbmcp_ddl_admin_hml', 'pw', 'postgres', HML_PORT))
    for (const u of Object.values(novo)) expect(new URL(u).host).toBe(hmlAdmin.host)

    // DDL pelo dono do schema; rw sem DELETE; exec com DELETE.
    const run = async (url: string, sql: string) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return await c.query(sql) } finally { await c.end() } }
    await run(novo.ddl, 'CREATE TABLE n1 (id int)')
    await run(novo.rw, 'INSERT INTO n1 VALUES (1), (2)')
    await expect(run(novo.rw, 'DELETE FROM n1 WHERE id = 1')).rejects.toThrow(/permission denied/)
    await expect(run(novo.rw, 'CREATE TABLE n2 (id int)')).rejects.toThrow(/permission denied/)
    expect((await run(novo.exec, 'DELETE FROM n1 WHERE id = 1')).rowCount).toBe(1)

    const passwords = Object.values(novo).map((u) => decodeURIComponent(new URL(u).password))
    expect(passwords.every((p) => /^[0-9a-f]{48}$/.test(p))).toBe(true)
    const dump = JSON.stringify([
      (await q('dbmcp_ddl_control', 'SELECT * FROM audit_log')).rows,
      (await q('dbmcp_ddl_control', 'SELECT * FROM pending_ops')).rows,
      (await q('dbmcp_ddl_control', 'SELECT * FROM migrations')).rows,
    ])
    for (const p of passwords) expect(dump).not.toContain(p)
  })

  it('pedido prod usa o admin prod (aqui sem CREATEDB: falha e nada é criado)', async () => {
    const r = await h().db_create_database({ name: 'dbmcp_ddl_novo_prod', env: 'prod', reason: 'it' })
    await approve((r as { opId: string }).opId)
    expect((await rt.store.getOp((r as { opId: string }).opId))?.status).toBe('failed')
    expect((await q('postgres', `SELECT 1 FROM pg_database WHERE datname = 'dbmcp_ddl_novo_prod'`)).rowCount).toBe(0)
  })
})
