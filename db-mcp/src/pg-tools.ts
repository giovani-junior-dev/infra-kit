// pg_dump/pg_restore via child_process (dependência: postgresql-client 16 no host do
// db-mcp; DB_MCP_PG_BIN_DIR aponta a pasta dos binários, senão usa o PATH).
// AIDEV-SECURITY: conexão e senha vão por variáveis PG* do processo filho, nunca no argv
// (argv aparece em `ps`). Nada aqui é logado com a DSN.
import { spawn } from 'node:child_process'
import path from 'node:path'

export function pgConnEnv(dsn: string): Record<string, string> {
  const u = new URL(dsn)
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  }
}

export const dumpArgs = (file: string) => ['--format=custom', '--no-owner', '--no-acl', '--file', file]
// Só o nome do banco (validado a-z0-9_) vai no argv; host/usuário/senha vêm de PG*.
export const restoreArgs = (file: string, dbname: string) => ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', dbname, file]

export function runPgTool(binDir: string | undefined, tool: 'pg_dump' | 'pg_restore', args: string[], dsn: string): Promise<void> {
  const bin = binDir ? path.join(binDir, tool) : tool
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, ...pgConnEnv(dsn) }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000) })
    child.on('error', (e) => reject(new Error(`${tool} indisponível (instale postgresql-client 16 ou ajuste DB_MCP_PG_BIN_DIR): ${e.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${tool} saiu com código ${code}: ${stderr.trim()}`))))
  })
}
