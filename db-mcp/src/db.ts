import pg from 'pg'
import type { DbClient, SqlParam } from './types.js'

/** Um pool por DSN (rw, exec e control são roles diferentes). DSN nunca é logado. */
export function createDb() {
  const pools = new Map<string, pg.Pool>()

  function pool(dsn: string): pg.Pool {
    let p = pools.get(dsn)
    if (!p) {
      p = new pg.Pool({ connectionString: dsn, max: 5, idleTimeoutMillis: 30_000 })
      p.on('error', (e) => console.error(`[db-mcp] erro no pool: ${e.message}`))
      pools.set(dsn, p)
    }
    return p
  }

  async function connect(dsn: string): Promise<DbClient> {
    return (await pool(dsn).connect()) as unknown as DbClient
  }

  /** READ ONLY: o Postgres recusa qualquer escrita escondida num SELECT. */
  async function readOnly(dsn: string, sql: string, params: SqlParam[]): Promise<Record<string, unknown>[]> {
    const c = await connect(dsn)
    try {
      await c.query('BEGIN READ ONLY')
      const r = await c.query(sql, params)
      await c.query('COMMIT')
      return r.rows
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }

  async function end(): Promise<void> {
    await Promise.all([...pools.values()].map((p) => p.end()))
    pools.clear()
  }

  return { pool, connect, readOnly, end }
}
