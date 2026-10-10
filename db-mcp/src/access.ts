// Identidade via Cloudflare Access. O Access remove os headers do service token
// (cf-access-client-id/secret) antes de repassar à origem; o que chega é o JWT
// assinado em Cf-Access-Jwt-Assertion. Validamos RS256 contra o JWKS do time.
// AIDEV-SECURITY: falha de identidade vira 403 no app (nunca 401: o cliente MCP
// trata 401 como OAuth e tenta POST /register).
import { createPublicKey, verify, type JsonWebKeyInput, type KeyObject } from 'node:crypto'

type Jwk = JsonWebKeyInput['key'] & { kid?: unknown }
type Jwks = { keys: Jwk[] }
type Claims = Record<string, unknown>
export type HeaderGetter = (name: string) => string | undefined

export interface AccessConfig {
  teamDomain: string
  audMcp: string
  audApprove: string
  /** Se definido, só esses e-mails (minúsculos) aprovam. */
  approverEmails?: string[]
  /** Modo local/teste: confia nos headers antigos. Nunca em produção (ver accessConfigFromEnv). */
  devTrustHeader?: boolean
  fetchJwks?: () => Promise<Jwks>
  /** Relógio em ms (teste). */
  now?: () => number
}

export interface Access {
  agentId(header: HeaderGetter): Promise<string | null>
  approver(header: HeaderGetter): Promise<string | null>
}

const SKEW_S = 60
const REFRESH_MS = 60_000

export function accessConfigFromEnv(env: Record<string, string | undefined>): AccessConfig {
  const get = (k: string) => env[k]?.trim() ?? ''
  const devTrustHeader = get('DB_MCP_DEV_TRUST_HEADER') === '1' && env.NODE_ENV !== 'production'
  const cfg = { teamDomain: get('CF_ACCESS_TEAM_DOMAIN'), audMcp: get('CF_ACCESS_AUD_MCP'), audApprove: get('CF_ACCESS_AUD_APPROVE') }
  if (!devTrustHeader && (!cfg.teamDomain || !cfg.audMcp || !cfg.audApprove)) {
    throw new Error('CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD_MCP e CF_ACCESS_AUD_APPROVE são obrigatórias')
  }
  const emails = get('APPROVER_EMAILS').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  return { ...cfg, approverEmails: emails.length ? emails : undefined, devTrustHeader }
}

function decode(part: string): Claims | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return v && typeof v === 'object' ? (v as Claims) : null
  } catch { return null }
}

export function createAccess(cfg: AccessConfig): Access {
  const issuer = `https://${cfg.teamDomain}`
  const fetchJwks = cfg.fetchJwks ?? (async () => {
    const r = await fetch(`${issuer}/cdn-cgi/access/certs`)
    if (!r.ok) throw new Error(`JWKS ${r.status}`)
    return (await r.json()) as Jwks
  })
  const now = cfg.now ?? Date.now
  let keys = new Map<string, KeyObject>()
  let lastFetch = -Infinity
  let inflight: Promise<void> | null = null

  // AIDEV-SECURITY: kid desconhecido busca o JWKS no máximo 1x a cada 60s e buscas
  // simultâneas compartilham a mesma promise — kid aleatório não vira flood no Cloudflare.
  function refresh(): Promise<void> {
    inflight ??= (async () => {
      lastFetch = now()
      const { keys: jwks } = await fetchJwks()
      keys = new Map(jwks.filter((k) => typeof k.kid === 'string').map((k) => [k.kid as string, createPublicKey({ key: k, format: 'jwk' })]))
    })().finally(() => { inflight = null })
    return inflight
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    if (!keys.has(kid) && (inflight || now() - lastFetch >= REFRESH_MS)) await refresh()
    return keys.get(kid)
  }

  async function verifyJwt(token: string | undefined, aud: string): Promise<Claims | null> {
    if (!token || !cfg.teamDomain) return null
    const [h, p, s] = token.split('.')
    if (!h || !p || !s) return null
    const head = decode(h)
    const claims = decode(p)
    if (head?.alg !== 'RS256' || typeof head.kid !== 'string' || !claims) return null
    const key = await keyFor(head.kid).catch((e: unknown) => {
      console.error(`[db-mcp] JWKS falhou: ${e instanceof Error ? e.message : 'erro'}`)
      return undefined
    })
    if (!key || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return null
    const now = Date.now() / 1000
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== issuer || !auds.includes(aud)) return null
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) return null
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > now) return null
    return claims
  }

  const JWT = 'cf-access-jwt-assertion'
  return {
    async agentId(header) {
      const c = await verifyJwt(header(JWT), cfg.audMcp)
      if (typeof c?.common_name === 'string' && c.common_name) return c.common_name
      return cfg.devTrustHeader ? header('cf-access-client-id') || null : null
    },
    async approver(header) {
      const c = await verifyJwt(header(JWT), cfg.audApprove)
      const raw = typeof c?.email === 'string' ? c.email : cfg.devTrustHeader ? header('cf-access-authenticated-user-email') : undefined
      const email = raw?.trim().toLowerCase()
      if (!email) return null
      return !cfg.approverEmails || cfg.approverEmails.includes(email) ? email : null
    },
  }
}
