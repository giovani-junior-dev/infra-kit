import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PendingOp } from '../types.js'

export const APPROVAL_TTL_MS = 30 * 60_000

// AIDEV-SECURITY: o expires usado no HMAC vem do banco (expires_at), não da URL;
// o link não carrega nada que o portador possa alterar além do token.
export function signToken(id: string, expiresAt: Date, secret: string): string {
  return createHmac('sha256', secret).update(`${id}|${expiresAt.getTime()}`).digest('hex')
}

export function verifyToken(id: string, expiresAt: Date, token: string, secret: string): boolean {
  const expected = Buffer.from(signToken(id, expiresAt, secret), 'hex')
  const got = Buffer.from(token, 'hex')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export function approvalUrl(baseUrl: string, id: string, expiresAt: Date, secret: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/approve/${encodeURIComponent(id)}?t=${signToken(id, expiresAt, secret)}`
}

export interface ApprovalDeps {
  secret: string
  getOp(id: string): Promise<PendingOp | null>
  /** Transição atômica pending → status. null se já não estava pending. */
  decide(id: string, status: 'approved' | 'rejected', by: string): Promise<PendingOp | null>
  markExpired(id: string): Promise<void>
  /** Executa o pedido aprovado com a role exec; registra executed/failed. */
  execute(op: PendingOp): Promise<void>
}

export interface ApprovalRequest {
  id: string
  token: string
  action?: 'approve' | 'reject'
  by?: string
  now: Date
}

export type ApprovalResponse =
  | { code: 403 }
  | { code: 410 }
  | { code: 200; outcome: 'view' | 'approved' | 'rejected' | 'noop'; op: PendingOp }

export async function handleApproval(deps: ApprovalDeps, req: ApprovalRequest): Promise<ApprovalResponse> {
  const op = await deps.getOp(req.id)
  if (!op || !verifyToken(op.id, op.expiresAt, req.token, deps.secret)) return { code: 403 }
  if (op.status === 'expired') return { code: 410 }
  if (op.status === 'pending' && op.expiresAt.getTime() <= req.now.getTime()) {
    await deps.markExpired(op.id)
    return { code: 410 }
  }
  if (!req.action) return { code: 200, outcome: 'view', op }
  if (op.status !== 'pending') return { code: 200, outcome: 'noop', op }

  const status = req.action === 'approve' ? 'approved' : 'rejected'
  const decided = await deps.decide(op.id, status, req.by ?? 'desconhecido')
  if (!decided) return { code: 200, outcome: 'noop', op }
  if (status === 'approved') await deps.execute(decided)
  return { code: 200, outcome: status, op: decided }
}
