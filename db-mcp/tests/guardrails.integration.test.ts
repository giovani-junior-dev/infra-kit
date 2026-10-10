// Integração contra Postgres real (opcional). Roda só com DB_MCP_IT_ADMIN_URL
// apontando para um superuser descartável, ex.: docker run postgres:16.
//   DB_MCP_IT_ADMIN_URL=postgres://postgres:pw@127.0.0.1:5432/postgres npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createDb } from '../src/db'
import { ControlStore } from '../src/approval/store'
import { createExecutor } from '../src/approval/executor'
import { handleApproval, signToken } from '../src/approval/link'
import { guardedWrite, type WriteDeps } from '../src/guard/blast-radius'
import { createHandlers } from '../src/tools/handlers'
import { LIMITS, type Target } from '../src/targets'
import { createControlDb } from './fixtures/control-db'

const ADMIN = process.env.DB_MCP_IT_ADMIN_URL
const SECRET = 'it-secret'

function dsn(user: string, pass: string, db: string): string {
  const u = new URL(ADMIN!)
  u.username = user
  u.password = pass
  u.pathname = `/${db}`
  return u.toString()
}

describe.skipIf(!ADMIN)('db-mcp contra Postgres real', () => {
  let admin: pg.Client
  let app: pg.Client
  let store: ControlStore
  let target: Target
  const db = createDb()
  let deps: WriteDeps
  let executor: ReturnType<typeof createExecutor>

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN })
    await admin.connect()
    for (const name of ['dbmcp_it_app', 'dbmcp_it_control']) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    for (const role of ['dbmcp_it_rw', 'dbmcp_it_exec']) {
      await admin.query(`DROP ROLE IF EXISTS ${role}`)
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`)
    }
    await admin.query('CREATE DATABASE dbmcp_it_app')
    const controlDsn = await createControlDb(ADMIN!, 'dbmcp_it_control')

    app = new pg.Client({ connectionString: dsn(new URL(ADMIN!).username, decodeURIComponent(new URL(ADMIN!).password), 'dbmcp_it_app') })
    await app.connect()
    await app.query('CREATE TABLE t (id int PRIMARY KEY, g int NOT NULL, a text)')
    await app.query("INSERT INTO t VALUES (1, 1, 'x'), (2, 2, 'x'), (3, 2, 'x'), (4, 3, 'x')")
    // Mesmas permissões dos templates de role do plano (0.3): rw sem DELETE, exec com DELETE.
    await app.query('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO dbmcp_it_rw')
    await app.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dbmcp_it_exec')

    const control = new pg.Client({ connectionString: dsn(new URL(ADMIN!).username, decodeURIComponent(new URL(ADMIN!).password), 'dbmcp_it_control') })
    await control.connect()
    await control.query(`INSERT INTO agents VALUES ('cid', 'agente-it', '{it@prod}', true), ('off', 'inativo', '{it@prod}', false)`)
    await control.end()

    target = { name: 'it', env: 'prod', dsnRw: dsn('dbmcp_it_rw', 'pw', 'dbmcp_it_app'), dsnExec: dsn('dbmcp_it_exec', 'pw', 'dbmcp_it_app'), limits: LIMITS.prod }
    store = new ControlStore(db.pool(controlDsn))
    const targets = new Map([['it@prod', target]])
    deps = {
      connectRw: (t) => db.connect(t.dsnRw),
      enqueue: async (op) => {
        const p = await store.insertPending(op)
        return { opId: p.id, link: `x/${p.id}`, estimatedRows: p.estimatedRows }
      },
      audit: (e) => store.audit(e),
    }
    executor = createExecutor({ targets, connectExec: (t) => db.connect(t.dsnExec), store })
  }, 30_000)

  afterAll(async () => {
    await db.end()
    await app?.end()
    if (admin) {
      for (const name of ['dbmcp_it_app', 'dbmcp_it_control']) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      for (const role of ['dbmcp_it_rw', 'dbmcp_it_exec']) await admin.query(`DROP ROLE IF EXISTS ${role}`)
      await admin.end()
    }
  })

  const val = async (id: number) => (await app.query('SELECT a FROM t WHERE id = $1', [id])).rows[0]?.a

  it('agente ativo é encontrado; inativo e desconhecido não', async () => {
    expect(await store.getAgent('cid')).toMatchObject({ name: 'agente-it', targets: ['it@prod'], active: true })
    expect(await store.getAgent('off')).toMatchObject({ active: false })
    expect(await store.getAgent('nope')).toBeNull()
  })

  it('a role rw não tem DELETE (trava do Postgres)', async () => {
    const c = await db.connect(target.dsnRw)
    try {
      await expect(c.query('DELETE FROM t WHERE id = 4')).rejects.toThrow(/permission denied/)
    } finally { c.release() }
  })

  it('UPDATE de 1 linha commita', async () => {
    const r = await guardedWrite(deps, { target, sql: "UPDATE t SET a = 'um' WHERE id = $1", params: [1], agentId: 'cid', reason: 'it', tool: 'db_update', expected: 'UPDATE' })
    expect(r).toEqual({ status: 'executed', rows: 1 })
    expect(await val(1)).toBe('um')
  })

  it('UPDATE de 2 linhas faz rollback e vira pedido com 2; aprovado executa com a role exec', async () => {
    const r = await guardedWrite(deps, { target, sql: "UPDATE t SET a = 'dois' WHERE g = $1", params: [2], agentId: 'cid', reason: 'it', tool: 'db_update', expected: 'UPDATE' })
    expect(r).toMatchObject({ status: 'pending', estimatedRows: 2 })
    expect(await val(2)).toBe('x')
    const op = (await store.getOp((r as { opId: string }).opId))!
    const appr = { secret: SECRET, getOp: (id: string) => store.getOp(id), decide: store.decide.bind(store), markExpired: store.markExpired.bind(store), execute: executor }
    const token = signToken(op.id, op.expiresAt, SECRET)
    expect((await handleApproval(appr, { id: op.id, token, action: 'approve', by: 'dono', now: new Date() }))).toMatchObject({ outcome: 'approved' })
    expect(await val(2)).toBe('dois')
    expect((await store.getOp(op.id))?.status).toBe('executed')
    expect((await handleApproval(appr, { id: op.id, token, action: 'approve', by: 'dono', now: new Date() }))).toMatchObject({ outcome: 'noop' })
  })

  it('DELETE vira pedido; recusado não executa; aprovado apaga', async () => {
    const appr = { secret: SECRET, getOp: (id: string) => store.getOp(id), decide: store.decide.bind(store), markExpired: store.markExpired.bind(store), execute: executor }
    const ask = () => guardedWrite(deps, { target, sql: 'DELETE FROM t WHERE id = $1', params: [4], agentId: 'cid', reason: 'it', tool: 'db_delete_request', expected: 'DELETE' })
    const rejected = (await store.getOp(((await ask()) as { opId: string }).opId))!
    await handleApproval(appr, { id: rejected.id, token: signToken(rejected.id, rejected.expiresAt, SECRET), action: 'reject', by: 'dono', now: new Date() })
    expect((await app.query('SELECT 1 FROM t WHERE id = 4')).rowCount).toBe(1)
    expect((await store.getOp(rejected.id))?.status).toBe('rejected')

    const approved = (await store.getOp(((await ask()) as { opId: string }).opId))!
    await handleApproval(appr, { id: approved.id, token: signToken(approved.id, approved.expiresAt, SECRET), action: 'approve', by: 'dono', now: new Date() })
    expect((await app.query('SELECT 1 FROM t WHERE id = 4')).rowCount).toBe(0)
    expect(await store.getOp(approved.id)).toMatchObject({ status: 'executed', result: { rows: 1 } })
  })

  it('db_query roda READ ONLY com LIMIT e audita; expirePending expira', async () => {
    const h = createHandlers({
      agent: { clientId: 'cid', name: 'agente-it', targets: ['it@prod'], active: true },
      targets: new Map([['it@prod', target]]), write: deps,
      readOnly: (t, sql, params) => db.readOnly(t.dsnRw, sql, params),
      listOps: (a, id) => store.listOps(a, id),
    })
    expect((await h.db_query({ target: 'it', sql: 'SELECT id FROM t ORDER BY id', limit: 2 })).rowCount).toBe(2)
    await expect(h.db_query({ target: 'it', sql: 'SELECT * FROM t FOR UPDATE' })).rejects.toThrow(/read-only/)
    expect((await h.db_schema({ target: 'it', table: 't' })).map((r) => r.column_name)).toEqual(['id', 'g', 'a'])
    // 1 linha por chamada: update(1) + update pedido(1) + executor(1) + 2 delete pedidos(2)
    // + executor(1) + db_query ok(1) + db_query falha(1) + db_schema(1)
    expect(await store.countAudit('cid')).toBe(9)

    const p = await store.insertPending({ agentId: 'cid', target: 'it@prod', kind: 'delete', sql: 'DELETE FROM t', params: [], estimatedRows: -1, reason: 'x' }, -1000)
    expect(await store.expirePending()).toBeGreaterThanOrEqual(1)
    expect((await store.getOp(p.id))?.status).toBe('expired')
    expect((await h.db_pending({ op_id: p.id }))[0]).toMatchObject({ status: 'expired', sql_preview: 'DELETE FROM t' })
  })
})
