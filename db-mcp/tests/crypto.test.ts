import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret, parseKey } from '../src/crypto'

const key = parseKey(randomBytes(32).toString('hex'))

describe('AES-256-GCM dos DSNs', () => {
  it('ida e volta, formato iv:tag:ciphertext, sem texto claro', () => {
    const enc = encryptSecret('postgres://u:segredo@h/db', key)
    expect(enc).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/)
    expect(enc).not.toContain('segredo')
    expect(decryptSecret(enc, key)).toBe('postgres://u:segredo@h/db')
  })

  it('iv aleatório: mesmo texto cifra diferente', () => {
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key))
  })

  it('adulterado ou chave errada falha', () => {
    const enc = encryptSecret('x', key)
    const bad = enc.slice(0, -2) + (enc.endsWith('00') ? '11' : '00')
    expect(() => decryptSecret(bad, key)).toThrow()
    expect(() => decryptSecret(enc, parseKey(randomBytes(32).toString('hex')))).toThrow()
  })

  it('chave precisa ter 32 bytes em hex', () => {
    expect(() => parseKey('abc')).toThrow(/DB_MCP_TARGETS_KEY/)
  })
})
