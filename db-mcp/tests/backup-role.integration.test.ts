// Banco criado pelo db-mcp precisa aceitar a role de backup (pg_read_all_data não dá CONNECT).
//   DB_MCP_IT_ADMIN_URL  superuser descartável
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createDatabase } from '../src/approval/create-database'

const ADMIN = process.env.DB_MCP_IT_ADMIN_URL
const DBS = ['bkp_it', 'bkp_it_skip']
const ROLES = ['dbmcp_bkp_admin', 'dbmcp_bkp_reader', ...DBS.flatMap((d) => ['rw', 'exec', 'ddl'].map((r) => `mcp_${d}_${r}`))]

function dsn(user: string, pass: string, db: string): string {
  const u = new URL(ADMIN!)
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

describe.skipIf(!ADMIN)('role de backup conecta no banco criado pelo db-mcp', () => {
  let admin: pg.Client

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN })
    await admin.connect()
    for (const d of DBS) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
    for (const r of ROLES) await admin.query(`DROP ROLE IF EXISTS ${r}`)
    await admin.query(`CREATE ROLE dbmcp_bkp_admin LOGIN PASSWORD 'pw' CREATEDB CREATEROLE`)
    await admin.query(`CREATE ROLE dbmcp_bkp_reader LOGIN PASSWORD 'pw'`)
    await admin.query('GRANT pg_read_all_data TO dbmcp_bkp_reader')
  })

  afterAll(async () => {
    for (const d of DBS) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`)
    for (const r of ROLES) await admin.query(`DROP ROLE IF EXISTS ${r}`)
    await admin.end()
  })

  it('com DB_MCP_BACKUP_ROLE a role pg_read_all_data conecta e lê', async () => {
    const { target } = await createDatabase(dsn('dbmcp_bkp_admin', 'pw', 'postgres'), 'bkp_it', 'hml', 'dbmcp_bkp_reader')
    await run(target.dsnDdl, 'CREATE TABLE t (id int); INSERT INTO t VALUES (1)')
    const r = await run(dsn('dbmcp_bkp_reader', 'pw', 'bkp_it'), 'SELECT count(*)::int AS n FROM t')
    expect(r.rows[0].n).toBe(1)
  })

  it('role ausente no servidor: cria o banco mesmo assim e a role de backup segue sem CONNECT', async () => {
    const { target } = await createDatabase(dsn('dbmcp_bkp_admin', 'pw', 'postgres'), 'bkp_it_skip', 'hml', 'role_que_nao_existe')
    await expect(run(target.dsnRw, 'SELECT 1')).resolves.toBeTruthy()
    await expect(run(dsn('dbmcp_bkp_reader', 'pw', 'bkp_it_skip'), 'SELECT 1')).rejects.toThrow(/permission denied for database/)
  })
})
