import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// DSNs dos alvos criados pelo db_create_database ficam na tabela targets cifrados
// com AES-256-GCM (formato do repo: iv:authTag:ciphertext em hex). Chave = DB_MCP_TARGETS_KEY.

export function parseKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('DB_MCP_TARGETS_KEY deve ter 32 bytes em hex (64 caracteres)')
  return Buffer.from(hex, 'hex')
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ct.toString('hex')}`
}

export function decryptSecret(enc: string, key: Buffer): string {
  const [iv, tag, ct] = enc.split(':')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'hex')), decipher.final()]).toString('utf8')
}
