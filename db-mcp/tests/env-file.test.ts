import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { resolveFileEnv } from '../src/env-file'

const dir = mkdtempSync(path.join(os.tmpdir(), 'dbmcp-env-'))
const file = (name: string, content: string) => { const p = path.join(dir, name); writeFileSync(p, content); return p }

describe('resolveFileEnv', () => {
  it('X_FILE vira X com o conteúdo do arquivo, sem quebra de linha final', () => {
    const env = resolveFileEnv({ APPROVAL_SECRET_FILE: file('a', 's3gredo\n'), PORT: '8002' })
    expect(env.APPROVAL_SECRET).toBe('s3gredo')
    expect(env.PORT).toBe('8002')
  })

  it('vale para qualquer variável, inclusive DSNs de alvo', () => {
    const env = resolveFileEnv({ DB_MCP_TARGET_LOJA_DSN_RW_FILE: file('b', 'postgres://u:p@h/db\r\n') })
    expect(env.DB_MCP_TARGET_LOJA_DSN_RW).toBe('postgres://u:p@h/db')
  })

  it('não altera o env de entrada', () => {
    const input = { APPROVAL_SECRET_FILE: file('c', 'x') }
    resolveFileEnv(input)
    expect(input).toEqual({ APPROVAL_SECRET_FILE: path.join(dir, 'c') })
  })

  it('X e X_FILE juntos: erro claro', () => {
    expect(() => resolveFileEnv({ APPROVAL_SECRET: 'a', APPROVAL_SECRET_FILE: file('d', 'b') })).toThrow(/APPROVAL_SECRET e APPROVAL_SECRET_FILE/)
  })

  it('arquivo ausente: erro com o nome da variável', () => {
    expect(() => resolveFileEnv({ DB_MCP_TARGETS_KEY_FILE: path.join(dir, 'nao-existe') })).toThrow(/DB_MCP_TARGETS_KEY_FILE/)
  })

  it('X_FILE vazio é ignorado', () => {
    expect(resolveFileEnv({ APPROVAL_SECRET_FILE: '' }).APPROVAL_SECRET).toBeUndefined()
  })
})

describe('X_PASSWORD (senha separada do DSN)', () => {
  it('Docker secret só com a senha: X_PASSWORD_FILE entra no DSN de X', () => {
    const env = resolveFileEnv({
      MCP_CONTROL_DATABASE_URL: 'postgres://mcp_control_rw@pg-prod_postgres:5432/mcp_control',
      MCP_CONTROL_DATABASE_URL_PASSWORD_FILE: file('pw', 'p@ss/w:rd\n'),
    })
    const u = new URL(env.MCP_CONTROL_DATABASE_URL!)
    expect(u.username).toBe('mcp_control_rw')
    expect(decodeURIComponent(u.password)).toBe('p@ss/w:rd')
    expect(u.host).toBe('pg-prod_postgres:5432')
    expect(u.pathname).toBe('/mcp_control')
  })

  it('vale para os DSNs admin', () => {
    const env = resolveFileEnv({ DB_MCP_ADMIN_DSN_PROD: 'postgres://mcp_admin@pg-prod_postgres:5432/postgres', DB_MCP_ADMIN_DSN_PROD_PASSWORD: 'x' })
    expect(new URL(env.DB_MCP_ADMIN_DSN_PROD!).password).toBe('x')
  })

  it('DSN que já traz senha + X_PASSWORD: erro claro', () => {
    expect(() => resolveFileEnv({ MCP_CONTROL_DATABASE_URL: 'postgres://u:a@h/db', MCP_CONTROL_DATABASE_URL_PASSWORD: 'b' })).toThrow(/MCP_CONTROL_DATABASE_URL já tem senha/)
  })

  it('X_PASSWORD sem X: ignorado', () => {
    expect(resolveFileEnv({ DB_MCP_ADMIN_DSN_HML_PASSWORD: 'x' }).DB_MCP_ADMIN_DSN_HML).toBeUndefined()
  })
})
