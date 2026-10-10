// Migrations do mcp_control no boot contra Postgres real (DB_MCP_IT_ADMIN_URL, superuser descartável):
// banco vazio vira o schema completo, e rodar de novo não muda nada.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { migrateControl } from '../src/migrate'

const ADMIN = process.env.DB_MCP_IT_ADMIN_URL
const DB = 'dbmcp_migrate_it'
const withDb = (db: string) => { const u = new URL(ADMIN!); u.pathname = `/${db}`; return u.toString() }

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try { return await fn(c) } finally { await c.end() }
}

describe.skipIf(!ADMIN)('migrations do mcp_control no boot', () => {
  beforeAll(async () => {
    await withClient(ADMIN!, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
      await c.query(`CREATE DATABASE ${DB}`)
    })
  })
  afterAll(async () => {
    if (ADMIN) await withClient(ADMIN, (c) => c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`))
  })

  it('banco vazio: aplica 000..004 e cria as tabelas do controle', async () => {
    const applied = await withClient(withDb(DB), (c) => migrateControl(c))
    expect(applied).toEqual(['000-base.sql', '001-ddl.sql', '002-promote-tracking.sql', '003-target-env.sql', '004-control-migrations-delete.sql'])
    const tables = await withClient(withDb(DB), (c) => c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`))
    expect(tables.rows.map((r) => r.tablename)).toEqual(['agents', 'audit_log', 'migrations', 'pending_ops', 'schema_migrations', 'targets'])
  })

  it('schema final aceita os pedidos promote_project e mirror e tem PK (name, env) em targets', async () => {
    await withClient(withDb(DB), async (c) => {
      await c.query(`INSERT INTO pending_ops (id, agent_id, target, kind, sql, estimated_rows, expires_at)
        VALUES (gen_random_uuid(), 'a', 'x@hml', 'mirror', '-', 0, now())`)
      const pk = await c.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'targets_pkey'`)
      expect(pk.rows[0].def).toBe('PRIMARY KEY (name, env)')
    })
  })

  it('segunda execução (com pedido mirror gravado) não aplica nada e não falha', async () => {
    expect(await withClient(withDb(DB), (c) => migrateControl(c))).toEqual([])
  })

  it('boot concorrente: duas conexões juntas não duplicam nem quebram', async () => {
    await withClient(withDb(DB), (c) => c.query('DELETE FROM schema_migrations'))
    const [a, b] = await Promise.all([withClient(withDb(DB), (c) => migrateControl(c)), withClient(withDb(DB), (c) => migrateControl(c))])
    expect([...a, ...b].sort()).toEqual(['000-base.sql', '001-ddl.sql', '002-promote-tracking.sql', '003-target-env.sql', '004-control-migrations-delete.sql'])
  })
})
