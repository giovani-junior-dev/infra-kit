import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { listMigrations, migrateControl, stripPsqlMeta, DEFAULT_MIGRATIONS_DIR } from '../src/migrate'

function fakeClient(applied: string[] = []) {
  const queries: string[] = []
  return {
    queries,
    async query(sql: string, params?: unknown[]) {
      queries.push(sql)
      if (/SELECT name FROM schema_migrations/.test(sql)) return { rows: applied.map((name) => ({ name })) }
      if (/INSERT INTO schema_migrations/.test(sql)) applied.push(String(params?.[0]))
      return { rows: [] }
    },
  }
}

function dirWith(files: Record<string, string>) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'dbmcp-mig-'))
  for (const [n, c] of Object.entries(files)) writeFileSync(path.join(d, n), c)
  return d
}

describe('migrations de controle', () => {
  it('stripPsqlMeta tira linhas de meta-comando do psql', () => {
    expect(stripPsqlMeta('\\set ON_ERROR_STOP on\nBEGIN;\n  \\echo x\nCOMMIT;')).toBe('BEGIN;\nCOMMIT;')
  })

  it('listMigrations: só .sql, em ordem de nome', () => {
    const d = dirWith({ '002-b.sql': 'b', '000-a.sql': 'a', 'README.md': 'x' })
    expect(listMigrations(d).map((m) => m.name)).toEqual(['000-a.sql', '002-b.sql'])
  })

  it('o pacote traz 000-base e as 001..004', () => {
    expect(listMigrations(DEFAULT_MIGRATIONS_DIR).map((m) => m.name)).toEqual([
      '000-base.sql', '001-ddl.sql', '002-promote-tracking.sql', '003-target-env.sql', '004-control-migrations-delete.sql',
    ])
  })

  it('000-base.sql é o mesmo SQL do sql/control/schema.sql (sem comentários)', () => {
    const sqlOnly = (f: string) => stripPsqlMeta(readFileSync(f, 'utf8')).split('\n').filter((l) => l.trim() && !l.trim().startsWith('--')).join('\n')
    expect(sqlOnly(path.join(DEFAULT_MIGRATIONS_DIR, '000-base.sql'))).toBe(sqlOnly(path.join(__dirname, '../sql/control/schema.sql')))
  })

  it('aplica as pendentes em ordem, sob advisory lock, e registra cada uma', async () => {
    const c = fakeClient(['000-a.sql'])
    const d = dirWith({ '000-a.sql': 'SELECT 0;', '001-b.sql': '\\set X\nSELECT 1;', '002-c.sql': 'SELECT 2;' })
    expect(await migrateControl(c, d)).toEqual(['001-b.sql', '002-c.sql'])
    const q = c.queries
    expect(q[0]).toMatch(/pg_advisory_lock/)
    expect(q.some((s) => /CREATE TABLE IF NOT EXISTS schema_migrations/.test(s))).toBe(true)
    expect(q).toContain('SELECT 1;')
    expect(q).not.toContain('SELECT 0;')
    expect(q.indexOf('SELECT 1;')).toBeLessThan(q.indexOf('SELECT 2;'))
    expect(q[q.length - 1]).toMatch(/pg_advisory_unlock/)
  })

  it('segunda execução não aplica nada (idempotente)', async () => {
    const c = fakeClient(['000-a.sql', '001-b.sql'])
    const d = dirWith({ '000-a.sql': 'SELECT 0;', '001-b.sql': 'SELECT 1;' })
    expect(await migrateControl(c, d)).toEqual([])
  })

  it('falha numa migration: lança com o nome e solta o lock', async () => {
    const c = fakeClient()
    const orig = c.query.bind(c)
    c.query = async (sql: string, params?: unknown[]) => { if (sql === 'BOOM;') throw new Error('syntax'); return orig(sql, params) }
    const d = dirWith({ '000-a.sql': 'BOOM;' })
    await expect(migrateControl(c, d)).rejects.toThrow(/000-a\.sql.*syntax/)
    expect(c.queries[c.queries.length - 1]).toMatch(/pg_advisory_unlock/)
  })
})
