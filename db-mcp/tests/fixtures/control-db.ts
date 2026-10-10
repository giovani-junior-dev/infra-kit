// Banco de controle de teste com a role real do app (mcp_control_rw), não superuser:
// grants lidos de sql/control/create-control-db.sql + control migrations
// de grant. Assim falta de grant (ex.: DELETE em migrations no mirror) aparece no teste.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const ROOT = path.join(__dirname, '../..')
const ROLE = 'mcp_control_rw'
const PASSWORD = 'pw'
const GRANT_MIGRATIONS = ['004-control-migrations-delete.sql']

const withDb = (url: string, db: string, user?: string, pass?: string) => {
  const u = new URL(url)
  u.pathname = `/${db}`
  if (user) { u.username = user; u.password = pass ?? '' }
  return u.toString()
}

async function run(url: string, sql: string) {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try { await c.query(sql) } finally { await c.end() }
}

const noPsql = (sql: string) => sql.split('\n').filter((l) => !l.startsWith('\\')).join('\n')

/** Grants do create-control-db.sql (linhas GRANT/REVOKE depois do \ir schema.sql), com o nome do banco de teste. */
function controlGrants(db: string): string {
  const file = readFileSync(path.join(ROOT, 'sql/control/create-control-db.sql'), 'utf8')
  return file.split('\n').filter((l) => /^(GRANT|REVOKE) /.test(l))
    .map((l) => l.replace(/ON DATABASE mcp_control /, `ON DATABASE ${pg.escapeIdentifier(db)} `)).join('\n')
}

/** Cria o banco de controle (superuser), aplica schema + grants reais e devolve o DSN da mcp_control_rw. */
export async function createControlDb(adminUrl: string, db: string): Promise<string> {
  await run(adminUrl, `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
      CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${PASSWORD}';
    END IF; END $$`)
  await run(adminUrl, `CREATE DATABASE ${pg.escapeIdentifier(db)}`)
  const sup = withDb(adminUrl, db)
  await run(sup, readFileSync(path.join(__dirname, 'control-schema.sql'), 'utf8'))
  await run(sup, controlGrants(db))
  for (const m of GRANT_MIGRATIONS) await run(sup, noPsql(readFileSync(path.join(ROOT, 'control-migrations', m), 'utf8')))
  return withDb(adminUrl, db, ROLE, PASSWORD)
}
