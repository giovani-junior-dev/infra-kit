// Mirror com o mask.sql do pacote (sql/mask.sql) sobre o schema de exemplo que ele cobre
// (users, messages). Mesmas variáveis do
// project.integration.test.ts (DB_MCP_IT_ADMIN_URL, DB_MCP_IT_HML_PORT, DB_MCP_IT_PG_BIN_DIR).
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createRuntime, type Runtime } from '../src/runtime'
import { handleApproval, signToken } from '../src/approval/link'
import { createHandlers } from '../src/tools/handlers'
import { parseKey } from '../src/crypto'
import type { Agent } from '../src/types'
import { createControlDb } from './fixtures/control-db'

const ADMIN = process.env.DB_MCP_IT_ADMIN_URL
const HML_PORT = process.env.DB_MCP_IT_HML_PORT
const MASKS_DIR = path.join(__dirname, '../sql')
const SECRET = 'it-secret'
const DBS = ['dbmcp_mask_control', 'loja', 'loja_hml']
const ROLES = ['dbmcp_mask_admin_hml', 'dbmcp_mask_admin_prod', ...['loja', 'loja_hml'].flatMap((d) => ['rw', 'exec', 'ddl'].map((r) => `mcp_${d}_${r}`))]

function dsn(user: string, pass: string, db: string, port?: string): string {
  const u = new URL(ADMIN!)
  if (port) u.port = port
  u.username = user
  u.password = pass
  u.pathname = `/${db}`
  return u.toString()
}

async function run(url: string, sql: string) {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try { return await c.query(sql) } finally { await c.end() }
}

describe.skipIf(!ADMIN)('mirror com o mask.sql de exemplo', () => {
  let admin: pg.Client
  let rt: Runtime
  const agent: Agent = { clientId: 'cid', name: 'agente-it', targets: ['loja@prod', 'loja_hml@hml'], active: true }
  const h = () => createHandlers(rt.toolContext(agent))
  async function approve(id: string) {
    const op = (await rt.store.getOp(id))!
    await handleApproval(rt.approval, { id: op.id, token: signToken(op.id, op.expiresAt, SECRET), action: 'approve', by: 'dono', now: new Date() })
    return rt.store.getOp(id)
  }
  const opId = (r: unknown) => (r as { opId: string }).opId
  const maskSql = readFileSync(path.join(MASKS_DIR, 'mask.sql'), 'utf8')

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN })
    await admin.connect()
    for (const d of DBS) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
    for (const r of ROLES) await admin.query(`DROP ROLE IF EXISTS ${r}`)
    for (const e of ['hml', 'prod']) await admin.query(`CREATE ROLE dbmcp_mask_admin_${e} LOGIN PASSWORD 'pw' CREATEDB CREATEROLE`)
    const controlDsn = await createControlDb(ADMIN!, 'dbmcp_mask_control')

    rt = await createRuntime({
      targets: new Map(),
      controlDsn,
      secret: SECRET,
      baseUrl: 'http://127.0.0.1:8002',
      adminDsns: { hml: dsn('dbmcp_mask_admin_hml', 'pw', 'postgres', HML_PORT), prod: dsn('dbmcp_mask_admin_prod', 'pw', 'postgres') },
      targetsKey: parseKey(randomBytes(32).toString('hex')),
      masksDir: MASKS_DIR,
      pgBinDir: process.env.DB_MCP_IT_PG_BIN_DIR,
      env: {},
    })
    for (const [name, env] of [['loja', 'prod'], ['loja_hml', 'hml']] as const) {
      expect(await approve(opId(await h().db_create_database({ name, env, reason: 'it' })))).toMatchObject({ status: 'executed' })
    }

    const prod = rt.targets.get('loja@prod')!
    await run(prod.dsnDdl, `
      CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL UNIQUE, name text, phone text, password_hash text);
      CREATE TABLE messages (id serial PRIMARY KEY, user_id int NOT NULL REFERENCES users(id), body text, raw jsonb NOT NULL DEFAULT '{}');`)
    await run(prod.dsnExec, `
      INSERT INTO users (email, name, phone, password_hash) VALUES
        ('ana@real.com.br', 'Ana Real', '+5511977776666', 'bcrypt-hash'), ('bia@real.com.br', 'Bia Real', NULL, 'h2');
      INSERT INTO messages (user_id, body, raw) VALUES (1, 'oi, meu CPF é 123', '{"from":"+5511977776666"}');`)
  }, 120_000)

  afterAll(async () => {
    await rt?.close()
    if (admin) {
      for (const d of DBS) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
      for (const r of ROLES) await admin.query(`DROP ROLE IF EXISTS ${r}`)
      await admin.end()
    }
  })

  it('mask.sql não tem meta-comando do psql', () => {
    expect(maskSql.split(/\r?\n/).filter((l) => l.trimStart().startsWith('\\'))).toEqual([])
  })

  it('mask.sql recusa rodar num banco que não termina em _hml e não muda nada', async () => {
    const prod = rt.targets.get('loja@prod')!
    await expect(run(prod.dsnDdl, maskSql)).rejects.toThrow(/recusado/)
    expect((await run(prod.dsnDdl, `SELECT phone FROM users WHERE id = 1`)).rows[0].phone).toBe('+5511977776666')
  })

  it('mirror loja -> loja_hml aplica o mask.sql real', async () => {
    const op = await approve(opId(await h().db_mirror_to_homolog({ from: 'loja', to: 'loja_hml', mask_script: 'mask.sql', reason: 'refresh' })))
    expect(op).toMatchObject({ status: 'executed', result: { masked: 'mask.sql' } })
    const hml = rt.targets.get('loja_hml@hml')!.dsnDdl
    const users = (await run(hml, `SELECT email, name, phone, password_hash FROM users ORDER BY id`)).rows
    expect(users).toEqual([
      { email: 'user1@hml.local', name: 'Usuario 1', phone: '+5500000000001', password_hash: null },
      { email: 'user2@hml.local', name: 'Usuario 2', phone: null, password_hash: null },
    ])
    expect((await run(hml, `SELECT body, raw FROM messages`)).rows).toEqual([{ body: 'mensagem mascarada', raw: {} }])
    // Prod intacto.
    expect((await run(rt.targets.get('loja@prod')!.dsnDdl, `SELECT email FROM users WHERE id = 1`)).rows[0].email).toBe('ana@real.com.br')
  }, 60_000)
})
