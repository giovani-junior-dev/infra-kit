import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { makeTarget, type Target, type TargetEnv } from '../targets.js'

export interface CreatedDatabase {
  target: Target
  roles: string[]
}

export async function withClient<T>(dsn: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: dsn })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

function dsnFor(adminDsn: string, user: string, password: string, db: string): string {
  const u = new URL(adminDsn)
  u.username = user
  u.password = password
  u.pathname = `/${db}`
  return u.toString()
}

// AIDEV-SECURITY: roda só após aprovação. adminDsn = role com CREATEDB/CREATEROLE,
// nunca superuser. Senhas geradas em memória (24 bytes hex, equivale a
// openssl rand -hex 24) e só saem daqui dentro dos DSNs, que o chamador cifra.
// Grants reproduzem sql/roles/create-{rw,executor}-role.sql;
// a role mcp_<db>_ddl é dona do banco (e do schema public, PG15+).
export async function createDatabase(adminDsn: string, name: string, env: TargetEnv, backupRole?: string): Promise<CreatedDatabase> {
  const lit = (s: string) => pg.escapeLiteral(s)
  // Mesmo padrão dos SQLs de infra: mcp_<db>_{rw,exec,ddl}.
  const roles = { rw: `mcp_${name}_rw`, exec: `mcp_${name}_exec`, ddl: `mcp_${name}_ddl` }
  const pw = { rw: randomBytes(24).toString('hex'), exec: randomBytes(24).toString('hex'), ddl: randomBytes(24).toString('hex') }

  await withClient(adminDsn, async (c) => {
    for (const k of ['rw', 'exec', 'ddl'] as const) {
      await c.query(`CREATE ROLE ${id(roles[k])} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${lit(pw[k])}`)
    }
    await c.query(`ALTER ROLE ${id(roles.rw)} SET statement_timeout = '15s'`)
    await c.query(`ALTER ROLE ${id(roles.rw)} SET idle_in_transaction_session_timeout = '30s'`)
    await c.query(`ALTER ROLE ${id(roles.exec)} SET statement_timeout = '60s'`)
    await c.query(`ALTER ROLE ${id(roles.exec)} SET idle_in_transaction_session_timeout = '30s'`)
    await c.query(`ALTER ROLE ${id(roles.ddl)} SET statement_timeout = '60s'`)
  })

  await createOwnedDatabase(adminDsn, name, roles.ddl)
  const target = makeTarget(name, env, {
    dsnRw: dsnFor(adminDsn, roles.rw, pw.rw, name),
    dsnExec: dsnFor(adminDsn, roles.exec, pw.exec, name),
    dsnDdl: dsnFor(adminDsn, roles.ddl, pw.ddl, name),
  })

  await applyDatabaseGrants(target.dsnDdl, name, roles.rw, roles.exec, backupRole)

  return { target, roles: [roles.rw, roles.exec, roles.ddl] }
}

const id = (s: string) => pg.escapeIdentifier(s)

/**
 * (Re)cria o banco com dono = role DDL. O admin vira membro das roles só durante a
 * operação: OWNER/DROP exigem assumir a dona e o FORCE só derruba sessões de roles
 * que o admin assume. dropWith = roles cujas sessões podem ser derrubadas (mirror).
 */
export async function createOwnedDatabase(adminDsn: string, name: string, ddlRole: string, dropWith?: string[]): Promise<void> {
  const assume = [...new Set([ddlRole, ...(dropWith ?? [])])].map(id).join(', ')
  await withClient(adminDsn, async (c) => {
    await c.query(`GRANT ${assume} TO CURRENT_USER`)
    try {
      if (dropWith) await c.query(`DROP DATABASE IF EXISTS ${id(name)} WITH (FORCE)`)
      await c.query(`CREATE DATABASE ${id(name)} OWNER ${id(ddlRole)}`)
    } finally {
      await c.query(`REVOKE ${assume} FROM CURRENT_USER`)
    }
  })
}

/** Grants feitos pela dona do banco, conectada nele (default privileges são por banco). */
export async function applyDatabaseGrants(ddlDsn: string, name: string, rwRole: string, execRole: string, backupRole?: string): Promise<void> {
  await withClient(ddlDsn, async (c) => {
    const rw = id(rwRole)
    const ex = id(execRole)
    await c.query(`REVOKE ALL ON DATABASE ${id(name)} FROM PUBLIC`)
    await c.query(`GRANT CONNECT ON DATABASE ${id(name)} TO ${rw}, ${ex}`)
    if (backupRole) await grantBackupConnect(c, name, backupRole)
    await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await c.query(`GRANT USAGE ON SCHEMA public TO ${rw}, ${ex}`)
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ${rw}`)
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ex}`)
    await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${rw}, ${ex}`)
    // Tabelas que já existem (ex.: vindas de um restore).
    await c.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${rw}`)
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ex}`)
    await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${rw}, ${ex}`)
  })
}

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }

export const backupConnectSql = (db: string, role: string) => `GRANT CONNECT ON DATABASE ${id(db)} TO ${id(role)}`

/**
 * DB_MCP_BACKUP_ROLE: o REVOKE ALL FROM PUBLIC tira o CONNECT e pg_read_all_data não o
 * devolve. Role ausente no servidor (ex.: kit sem backup) só loga e segue.
 */
export async function grantBackupConnect(c: Queryable, db: string, role: string, log: (m: string) => void = console.log): Promise<boolean> {
  const { rows } = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])
  if (!rows.length) {
    log(`[db-mcp] role de backup ${role} não existe neste servidor; CONNECT em ${db} não concedido`)
    return false
  }
  await c.query(backupConnectSql(db, role))
  return true
}
