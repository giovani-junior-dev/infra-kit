import { describe, it, expect, vi } from 'vitest'
import { approvalUrl, handleApproval, signToken, verifyToken, type ApprovalDeps } from '../src/approval/link'
import type { PendingOp } from '../src/types'

const SECRET = 's3cr3t'
const NOW = new Date('2026-10-09T12:00:00Z')

function op(over: Partial<PendingOp> = {}): PendingOp {
  return {
    id: 'op-1', agentId: 'a', target: 'hml', kind: 'delete', sql: 'DELETE FROM t WHERE id=$1', params: [1],
    estimatedRows: -1, reason: 'r', status: 'pending', createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 30 * 60_000), result: null, ...over,
  }
}

function deps(current: PendingOp | null): ApprovalDeps {
  let state = current
  return {
    secret: SECRET,
    getOp: vi.fn(async () => state),
    decide: vi.fn(async (_id, status) => {
      if (!state || state.status !== 'pending') return null
      state = { ...state, status }
      return state
    }),
    markExpired: vi.fn(async () => {}),
    execute: vi.fn(async () => {}),
  }
}

describe('token HMAC', () => {
  it('assina id|expires e verifica', () => {
    const exp = op().expiresAt
    const t = signToken('op-1', exp, SECRET)
    expect(verifyToken('op-1', exp, t, SECRET)).toBe(true)
    expect(verifyToken('op-2', exp, t, SECRET)).toBe(false)
    expect(verifyToken('op-1', new Date(exp.getTime() + 1), t, SECRET)).toBe(false)
    expect(verifyToken('op-1', exp, 'zz', SECRET)).toBe(false)
  })

  it('url leva id e token', () => {
    const exp = op().expiresAt
    expect(approvalUrl('https://db-mcp.example.com/', 'op-1', exp, SECRET)).toBe(
      `https://db-mcp.example.com/approve/op-1?t=${signToken('op-1', exp, SECRET)}`,
    )
  })
})

describe('handleApproval', () => {
  const good = signToken('op-1', op().expiresAt, SECRET)

  it('HMAC inválido = 403 e nada executa', async () => {
    const d = deps(op())
    const r = await handleApproval(d, { id: 'op-1', token: 'bad', action: 'approve', by: 'dono', now: NOW })
    expect(r.code).toBe(403)
    expect(d.decide).not.toHaveBeenCalled()
  })

  it('pedido inexistente = 403 (não revela existência)', async () => {
    expect((await handleApproval(deps(null), { id: 'op-1', token: good, now: NOW })).code).toBe(403)
  })

  it('expirado = 410 e marca expired', async () => {
    const d = deps(op())
    const later = new Date(NOW.getTime() + 31 * 60_000)
    const r = await handleApproval(d, { id: 'op-1', token: good, action: 'approve', by: 'dono', now: later })
    expect(r.code).toBe(410)
    expect(d.markExpired).toHaveBeenCalledWith('op-1')
    expect(d.execute).not.toHaveBeenCalled()
  })

  it('GET com token válido só mostra', async () => {
    const d = deps(op())
    const r = await handleApproval(d, { id: 'op-1', token: good, now: NOW })
    expect(r).toMatchObject({ code: 200, outcome: 'view' })
    expect(d.decide).not.toHaveBeenCalled()
  })

  it('aprovar executa uma vez; segunda aprovação é no-op', async () => {
    const d = deps(op())
    const first = await handleApproval(d, { id: 'op-1', token: good, action: 'approve', by: 'dono', now: NOW })
    expect(first).toMatchObject({ code: 200, outcome: 'approved' })
    const second = await handleApproval(d, { id: 'op-1', token: good, action: 'approve', by: 'dono', now: NOW })
    expect(second).toMatchObject({ code: 200, outcome: 'noop' })
    expect(d.execute).toHaveBeenCalledTimes(1)
  })

  it('recusar não executa', async () => {
    const d = deps(op())
    const r = await handleApproval(d, { id: 'op-1', token: good, action: 'reject', by: 'dono', now: NOW })
    expect(r).toMatchObject({ code: 200, outcome: 'rejected' })
    expect(d.decide).toHaveBeenCalledWith('op-1', 'rejected', 'dono')
    expect(d.execute).not.toHaveBeenCalled()
  })
})
