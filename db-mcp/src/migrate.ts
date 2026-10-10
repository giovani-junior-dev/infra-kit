// Migrations do banco mcp_control aplicadas no boot. Cada arquivo é idempotente; a tabela
// schema_migrations só evita reaplicar. Advisory lock: duas réplicas subindo juntas não
// correm a mesma migration.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface QueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/** <pacote>/control-migrations (funciona de src/ nos testes e de dist/ na imagem). */
export const DEFAULT_MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'control-migrations')

const LOCK_KEY = 4_202_610 // número fixo qualquer, só do db-mcp

/** Os arquivos também rodam pelo psql; o driver não entende \set, \echo etc. */
export function stripPsqlMeta(sql: string): string {
  return sql.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('\\')).join('\n')
}

export function listMigrations(dir: string): { name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: stripPsqlMeta(readFileSync(path.join(dir, name), 'utf8')) }))
}

/** Aplica as migrations pendentes em ordem. Devolve os nomes aplicados agora. */
export async function migrateControl(c: QueryClient, dir = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  await c.query(`SELECT pg_advisory_lock(${LOCK_KEY})`)
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => String(r.name)))
    const applied: string[] = []
    for (const m of listMigrations(dir)) {
      if (done.has(m.name)) continue
      try {
        await c.query(m.sql)
      } catch (e) {
        throw new Error(`migration ${m.name} falhou: ${e instanceof Error ? e.message : 'erro'}`)
      }
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [m.name])
      applied.push(m.name)
    }
    return applied
  } finally {
    await c.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => {})
  }
}
