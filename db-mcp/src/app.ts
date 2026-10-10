import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { registerTools } from './tools/register.js'
import { handleApproval, type ApprovalDeps } from './approval/link.js'
import type { ToolContext } from './tools/handlers.js'
import type { Access } from './access.js'
import type { Agent, PendingOp } from './types.js'

export interface AppDeps {
  /** Identidade pelo JWT do Cloudflare Access (Cf-Access-Jwt-Assertion). */
  access: Access
  /** Tabela agents; chave = Client ID do Service Token (claim common_name do JWT). */
  getAgent(clientId: string): Promise<Agent | null>
  toolContext(agent: Agent): ToolContext
  approval: ApprovalDeps
}

function rpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null })
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c])

function page(title: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}pre{white-space:pre-wrap;background:#f4f4f4;padding:12px}button{font-size:16px;padding:10px 18px;margin-right:8px}</style></head><body>${body}</body></html>`
}

function opPage(op: PendingOp, token: string, note = ''): string {
  const rows = op.estimatedRows < 0 ? 'a medir na execução' : String(op.estimatedRows)
  const action = (a: string) => `/approve/${encodeURIComponent(op.id)}?t=${encodeURIComponent(token)}&a=${a}`
  const buttons = op.status === 'pending'
    ? `<form method="post" action="${action('approve')}" style="display:inline"><button>Aprovar</button></form><form method="post" action="${action('reject')}" style="display:inline"><button>Recusar</button></form>`
    : ''
  return page('Aprovação db-mcp', `<h1>Pedido ${esc(op.kind.toUpperCase())}</h1>${note ? `<p><b>${esc(note)}</b></p>` : ''}
<p>Alvo: <b>${esc(op.target)}</b> · Agente: ${esc(op.agentId)} · Linhas: ${esc(rows)} · Status: <b>${esc(op.status)}</b></p>
<p>Motivo: ${esc(op.reason)}</p><pre>${esc(op.sql)}</pre><p>Expira: ${esc(op.expiresAt.toISOString())}</p>${buttons}`)
}

const NOTES = { view: '', approved: 'Aprovado e executado (veja o status).', rejected: 'Recusado.', noop: 'Já decidido antes; nada mudou.' }

export function createApp(deps: AppDeps) {
  // host 127.0.0.1: o SDK liga a proteção anti DNS-rebinding (Host = localhost/127.0.0.1),
  // mesmo quando o processo escuta em 0.0.0.0 no container. O tunnel Cloudflare usa
  // httpHostHeader 127.0.0.1:<porta>.
  const app = createMcpExpressApp({ host: '127.0.0.1' })

  // Healthcheck do container: sem identidade, sem banco.
  app.get('/health', (_req: Request, res: Response) => { res.json({ ok: true }) })

  app.post('/mcp', async (req: Request, res: Response) => {
    // AIDEV-SECURITY: sempre 403, nunca 401 — 401 faz o cliente MCP iniciar OAuth (POST /register).
    const clientId = await deps.access.agentId((n) => req.header(n))
    if (!clientId) return rpcError(res, 403, 'identidade do Access ausente ou inválida')
    const agent = await deps.getAgent(clientId).catch(() => null)
    if (!agent?.active) return rpcError(res, 403, 'agente não autorizado')

    const server = new McpServer({ name: 'db-mcp', version: '1.0.0' })
    registerTools(server, deps.toolContext(agent))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { void transport.close(); void server.close() })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (e) {
      console.error(`[db-mcp] erro no /mcp: ${e instanceof Error ? e.message : 'erro'}`)
      if (!res.headersSent) rpcError(res, 500, 'erro interno')
    }
  })
  app.get('/mcp', (_req: Request, res: Response) => rpcError(res, 405, 'método não permitido'))
  app.delete('/mcp', (_req: Request, res: Response) => rpcError(res, 405, 'método não permitido'))

  async function approve(req: Request, res: Response) {
    const token = typeof req.query.t === 'string' ? req.query.t : ''
    const a = req.query.a
    const by = await deps.access.approver((n) => req.header(n))
    if (!by) return res.status(403).send(page('Negado', '<p>Aprovador não autorizado.</p>'))
    if (req.method === 'POST' && a !== 'approve' && a !== 'reject') return res.status(400).send(page('Erro', '<p>Ação inválida.</p>'))
    const r = await handleApproval(deps.approval, {
      id: String(req.params.id),
      token,
      action: req.method === 'POST' ? (a as 'approve' | 'reject') : undefined,
      by,
      now: new Date(),
    })
    if (r.code === 403) return res.status(403).send(page('Negado', '<p>Link inválido.</p>'))
    if (r.code === 410) return res.status(410).send(page('Expirado', '<p>Pedido expirado. Peça ao agente para refazer.</p>'))
    res.status(200).send(opPage(r.op, token, NOTES[r.outcome]))
  }
  const safe = (fn: typeof approve) => (req: Request, res: Response) =>
    fn(req, res).catch((e: unknown) => {
      console.error(`[db-mcp] erro no /approve: ${e instanceof Error ? e.message : 'erro'}`)
      if (!res.headersSent) res.status(500).send(page('Erro', '<p>Erro interno.</p>'))
    })
  app.get('/approve/:id', safe(approve))
  app.post('/approve/:id', safe(approve))

  return app
}
