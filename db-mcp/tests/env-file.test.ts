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
