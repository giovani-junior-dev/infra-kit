import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'

export const TEAM = 'time.cloudflareaccess.com'
export const AUD_MCP = 'aud-mcp'
export const AUD_APPROVE = 'aud-approve'

export function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } }
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function jwt(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000)
  const head = `${b64({ alg: 'RS256', kid: key.kid, typ: 'JWT' })}.${b64({ iss: `https://${TEAM}`, iat: now, nbf: now, exp: now + 300, ...claims })}`
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), key.privateKey).toString('base64url')}`
}
