import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApp, type AppDeps } from '../src/app'
import { signToken } from '../src/approval/link'
import { LIMITS } from '../src/targets'
import type { Agent, PendingOp } from '../src/types'
import { createAccess } from '../src/access'
import { AUD_APPROVE, AUD_MCP, TEAM, jwt, keyPair } from './fixtures/access-jwt'

const key = keyPair('k1')
const forged = keyPair('k1')
const mcpJwt = (cn: string, k = key) => ({ 'cf-access-jwt-assertion': jwt(k, { aud: [AUD_MCP], common_name: cn }) })
const approveJwt = (email: string) => ({ 'cf-access-jwt-assertion': jwt(key, { aud: [AUD_APPROVE], email }) })

const SECRET = 'app-secret'
const agents: Record<string, Agent> = {
  cid: { clientId: 'cid', name: 'agente', targets: ['hml@hml'], active: true },
  off: { clientId: 'off', name: 'inativo', targets: ['hml@hml'], active: false },
}
let op: PendingOp
const execute = vi.fn(async () => {})

const deps: AppDeps = {
  access: createAccess({ teamDomain: TEAM, audMcp: AUD_MCP, audApprove: AUD_APPROVE, fetchJwks: async () => ({ keys: [key.jwk] }) }),
  getAgent: async (id) => agents[id] ?? null,
  toolContext: (agent) => ({
    agent,
    targets: new Map([['hml@hml', { name: 'hml', env: 'hml', dsnRw: 'rw', dsnExec: 'ex', limits: LIMITS.hml }]]),
    write: { connectRw: vi.fn(), enqueue: vi.fn(), audit: vi.fn(async () => {}) },
    readOnly: async () => [{ ok: 1 }],
    listOps: async () => [],
  }),
  approval: {
    secret: SECRET,
    getOp: async (id) => (id === op.id ? op : null),
    decide: async (_id, status, by) => {
      if (op.status !== 'pending') return null
      op = { ...op, status, result: { by } }
      return op
    },
    markExpired: async () => {},
    execute,
  },
}

let server: Server
let base: string

beforeAll(async () => {
  server = createApp(deps).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

function freshOp(): PendingOp {
  return {
    id: '00000000-0000-4000-8000-000000000001', agentId: 'cid', target: 'hml', kind: 'delete',
    sql: "DELETE FROM t WHERE nome = '<script>'", params: [], estimatedRows: -1, reason: 'limpar <b>',
    status: 'pending', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), result: null,
  }
}

describe('/mcp identidade do agente', () => {
  const rpc = (headers: Record<string, string>) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

  it('sem JWT = 403 sem WWW-Authenticate (nunca 401: o cliente iniciaria OAuth)', async () => {
    const res = await rpc({})
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toBeNull()
    expect(await res.json()).toMatchObject({ error: { message: expect.any(String) } })
  })

  it('header cf-access-client-id sem JWT é ignorado = 403', async () => {
    expect((await rpc({ 'cf-access-client-id': 'cid' })).status).toBe(403)
  })

  it('JWT forjado, desconhecido ou inativo = 403', async () => {
    expect((await rpc(mcpJwt('cid', forged))).status).toBe(403)
    expect((await rpc(mcpJwt('nope'))).status).toBe(403)
    expect((await rpc(mcpJwt('off'))).status).toBe(403)
  })

  it('agente ativo usa as tools pelo transporte streamable-http real', async () => {
    const client = new Client({ name: 't', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: mcpJwt('cid') } }))
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(12)
    const ok = await client.callTool({ name: 'db_query', arguments: { target: 'hml', sql: 'SELECT 1' } })
    expect(ok.isError).toBeFalsy()
    const denied = await client.callTool({ name: 'db_query', arguments: { target: 'prod', sql: 'SELECT 1' } })
    expect(denied.isError).toBe(true)
    await client.close()
  })
})

describe('/approve', () => {
  it('token inválido = 403', async () => {
    op = freshOp()
    expect((await fetch(`${base}/approve/${op.id}?t=00`, { headers: approveJwt('dono@x.com') })).status).toBe(403)
  })

  it('GET mostra a página com SQL escapado e botões', async () => {
    op = freshOp()
    const res = await fetch(`${base}/approve/${op.id}?t=${signToken(op.id, op.expiresAt, SECRET)}`, { headers: approveJwt('dono@x.com') })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toMatch(/Aprovar/)
    expect(html).toMatch(/Recusar/)
  })

  it('expirado = 410', async () => {
    op = { ...freshOp(), expiresAt: new Date(Date.now() - 1000) }
    expect((await fetch(`${base}/approve/${op.id}?t=${signToken(op.id, op.expiresAt, SECRET)}`, { headers: approveJwt('dono@x.com') })).status).toBe(410)
  })

  it('sem JWT de aprovador ou só com header de e-mail = 403 e nada executa', async () => {
    op = freshOp()
    execute.mockClear()
    const url = `${base}/approve/${op.id}?t=${signToken(op.id, op.expiresAt, SECRET)}&a=approve`
    expect((await fetch(url, { method: 'POST' })).status).toBe(403)
    expect((await fetch(url, { method: 'POST', headers: { 'cf-access-authenticated-user-email': 'dono@x.com' } })).status).toBe(403)
    expect((await fetch(url, { method: 'POST', headers: mcpJwt('cid') })).status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
    expect(op.status).toBe('pending')
  })

  it('POST aprova com o e-mail do JWT do Access; repetir é no-op', async () => {
    op = freshOp()
    execute.mockClear()
    const url = `${base}/approve/${op.id}?t=${signToken(op.id, op.expiresAt, SECRET)}&a=approve`
    const headers = approveJwt('dono@x.com')
    expect((await fetch(url, { method: 'POST', headers })).status).toBe(200)
    expect(op).toMatchObject({ status: 'approved', result: { by: 'dono@x.com' } })
    expect((await fetch(url, { method: 'POST', headers })).status).toBe(200)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('POST com ação inválida = 400', async () => {
    op = freshOp()
    expect((await fetch(`${base}/approve/${op.id}?t=${signToken(op.id, op.expiresAt, SECRET)}&a=drop`, { method: 'POST', headers: approveJwt('dono@x.com') })).status).toBe(400)
  })
})

describe('/health', () => {
  it('responde 200 sem identidade (healthcheck do container)', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
