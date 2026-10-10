import { describe, expect, it, vi } from 'vitest'
import { accessConfigFromEnv, createAccess } from '../src/access'
import { AUD_APPROVE, AUD_MCP, TEAM, jwt, keyPair } from './fixtures/access-jwt'

const k1 = keyPair('k1')
const k2 = keyPair('k2')
const other = keyPair('k1') // mesmo kid, chave diferente = assinatura inválida
const hdr = (h: Record<string, string>) => (n: string) => h[n.toLowerCase()]
const JWT = 'cf-access-jwt-assertion'

function make(keys = [k1.jwk], extra = {}) {
  const fetchJwks = vi.fn(async () => ({ keys }))
  return { fetchJwks, access: createAccess({ teamDomain: TEAM, audMcp: AUD_MCP, audApprove: AUD_APPROVE, fetchJwks, ...extra }) }
}

describe('access: agente em /mcp', () => {
  it('JWT válido identifica o agente pelo common_name', async () => {
    const { access } = make()
    expect(await access.agentId(hdr({ [JWT]: jwt(k1, { aud: [AUD_MCP], common_name: 'cid.access' }) }))).toBe('cid.access')
  })

  it('assinatura errada, aud errado, expirado, nbf futuro, iss errado, lixo, sem header = null', async () => {
    const { access } = make()
    const now = Math.floor(Date.now() / 1000)
    const bad = [
      jwt(other, { aud: [AUD_MCP], common_name: 'x' }),
      jwt(k1, { aud: [AUD_APPROVE], common_name: 'x' }),
      jwt(k1, { aud: [AUD_MCP], common_name: 'x', exp: now - 61 }),
      jwt(k1, { aud: [AUD_MCP], common_name: 'x', nbf: now + 120 }),
      jwt(k1, { aud: [AUD_MCP], common_name: 'x', iss: 'https://outro.com' }),
      'lixo',
    ]
    for (const t of bad) expect(await access.agentId(hdr({ [JWT]: t }))).toBeNull()
    expect(await access.agentId(hdr({}))).toBeNull()
  })

  it('tolera 60s de relógio no exp', async () => {
    const { access } = make()
    const t = jwt(k1, { aud: AUD_MCP, common_name: 'cid', exp: Math.floor(Date.now() / 1000) - 30 })
    expect(await access.agentId(hdr({ [JWT]: t }))).toBe('cid')
  })

  it('header cf-access-client-id é ignorado sem modo dev', async () => {
    const { access } = make()
    expect(await access.agentId(hdr({ 'cf-access-client-id': 'cid' }))).toBeNull()
  })

  it('JWKS em cache; kid desconhecido busca no máximo 1x a cada 60s', async () => {
    const keys = [k1.jwk]
    let t = 1_000_000
    const { access, fetchJwks } = make(keys, { now: () => t })
    const tok2 = jwt(k2, { aud: AUD_MCP, common_name: 'b' })
    await access.agentId(hdr({ [JWT]: jwt(k1, { aud: AUD_MCP, common_name: 'a' }) }))
    await access.agentId(hdr({ [JWT]: jwt(k1, { aud: AUD_MCP, common_name: 'a' }) }))
    expect(fetchJwks).toHaveBeenCalledTimes(1)
    keys.push(k2.jwk)
    t += 59_000 // dentro da janela: kid desconhecido = null sem buscar
    expect(await access.agentId(hdr({ [JWT]: tok2 }))).toBeNull()
    expect(await access.agentId(hdr({ [JWT]: jwt(k1, { aud: AUD_MCP, common_name: 'x' }) }))).toBe('x')
    expect(fetchJwks).toHaveBeenCalledTimes(1)
    t += 2_000 // passou 60s: busca de novo
    expect(await access.agentId(hdr({ [JWT]: tok2 }))).toBe('b')
    expect(fetchJwks).toHaveBeenCalledTimes(2)
  })

  it('requisições simultâneas com kid desconhecido compartilham a mesma busca', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const fetchJwks = vi.fn(async () => { await gate; return { keys: [k1.jwk, k2.jwk] } })
    const access = createAccess({ teamDomain: TEAM, audMcp: AUD_MCP, audApprove: AUD_APPROVE, fetchJwks })
    const reqs = [k1, k2, k2].map((k) => access.agentId(hdr({ [JWT]: jwt(k, { aud: AUD_MCP, common_name: k.kid }) })))
    release()
    expect(await Promise.all(reqs)).toEqual(['k1', 'k2', 'k2'])
    expect(fetchJwks).toHaveBeenCalledTimes(1)
  })
})

describe('access: aprovador em /approve', () => {
  it('email vem do JWT com aud de approve; header de email é ignorado', async () => {
    const { access } = make()
    expect(await access.approver(hdr({ [JWT]: jwt(k1, { aud: [AUD_APPROVE], email: 'dono@x.com' }) }))).toBe('dono@x.com')
    expect(await access.approver(hdr({ [JWT]: jwt(k1, { aud: [AUD_MCP], email: 'dono@x.com' }) }))).toBeNull()
    expect(await access.approver(hdr({ 'cf-access-authenticated-user-email': 'dono@x.com' }))).toBeNull()
  })

  it('APPROVER_EMAILS restringe', async () => {
    const { access } = make([k1.jwk], { approverEmails: ['dono@x.com'] })
    expect(await access.approver(hdr({ [JWT]: jwt(k1, { aud: AUD_APPROVE, email: 'Dono@X.com' }) }))).toBe('dono@x.com')
    expect(await access.approver(hdr({ [JWT]: jwt(k1, { aud: AUD_APPROVE, email: 'intruso@x.com' }) }))).toBeNull()
  })
})

describe('accessConfigFromEnv', () => {
  const base = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD_MCP: AUD_MCP, CF_ACCESS_AUD_APPROVE: AUD_APPROVE }
  const noKeys = async () => ({ keys: [] })

  it('lê as env vars e APPROVER_EMAILS', () => {
    expect(accessConfigFromEnv({ ...base, APPROVER_EMAILS: 'a@x.com, B@x.com' })).toMatchObject({
      teamDomain: TEAM, audMcp: AUD_MCP, audApprove: AUD_APPROVE, approverEmails: ['a@x.com', 'b@x.com'], devTrustHeader: false,
    })
  })

  it('DB_MCP_DEV_TRUST_HEADER=1 só vale fora de produção', async () => {
    const prodCfg = accessConfigFromEnv({ ...base, DB_MCP_DEV_TRUST_HEADER: '1', NODE_ENV: 'production' })
    expect(prodCfg.devTrustHeader).toBe(false)
    const prod = createAccess({ ...prodCfg, fetchJwks: noKeys })
    expect(await prod.agentId(hdr({ 'cf-access-client-id': 'cid' }))).toBeNull()
    expect(await prod.approver(hdr({ 'cf-access-authenticated-user-email': 'a@x.com' }))).toBeNull()
    const dev = createAccess({ ...accessConfigFromEnv({ DB_MCP_DEV_TRUST_HEADER: '1' }), fetchJwks: noKeys })
    expect(await dev.agentId(hdr({ 'cf-access-client-id': 'cid' }))).toBe('cid')
    expect(await dev.approver(hdr({ 'cf-access-authenticated-user-email': 'a@x.com' }))).toBe('a@x.com')
  })

  it('sem modo dev exige as 3 variáveis do Access', () => {
    expect(() => accessConfigFromEnv({})).toThrow(/CF_ACCESS_TEAM_DOMAIN/)
  })
})
