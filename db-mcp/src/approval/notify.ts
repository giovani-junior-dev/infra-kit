import type { OpKind } from '../types.js'

export interface NotifyMessage {
  opId: string
  target: string
  kind: OpKind
  estimatedRows: number
  agentName: string
  link: string
}

type Env = Record<string, string | undefined>
type FetchFn = (url: string, init: RequestInit) => Promise<Response>

/**
 * Aviso opcional do pedido de aprovação. Só avisa: o link também volta na resposta da tool.
 * - NOTIFY_WEBHOOK_URL: POST com o NotifyMessage em JSON (n8n, Slack via ponte, etc.).
 * - NOTIFY_TELEGRAM_BOT_TOKEN + NOTIFY_TELEGRAM_CHAT_ID: mensagem de texto pelo bot.
 * Falha nunca bloqueia nem lança.
 * AIDEV-SECURITY: o token do bot vai na URL do Telegram; o log nunca cita URL nem mensagem de erro crua.
 */
export function createNotifier(env: Env, fetchFn: FetchFn = fetch) {
  const webhook = env.NOTIFY_WEBHOOK_URL?.trim()
  const botToken = env.NOTIFY_TELEGRAM_BOT_TOKEN?.trim()
  const chatId = env.NOTIFY_TELEGRAM_CHAT_ID?.trim()

  async function post(channel: string, url: string, body: unknown, opId: string): Promise<void> {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) console.warn(`[db-mcp] notify ${channel} falhou: HTTP ${res.status} op=${opId}`)
    } catch {
      console.warn(`[db-mcp] notify ${channel} falhou: erro de rede op=${opId}`)
    }
  }

  return async (m: NotifyMessage): Promise<void> => {
    const sends: Promise<void>[] = []
    if (webhook) sends.push(post('webhook', webhook, m, m.opId))
    if (botToken && chatId) {
      const rows = m.estimatedRows < 0 ? 'linhas: a medir na execução' : `linhas: ${m.estimatedRows}`
      const text = `db-mcp: pedido ${m.kind.toUpperCase()} em ${m.target} (${rows}) do agente ${m.agentName}.\nAprovar/recusar: ${m.link}`
      sends.push(post('telegram', `https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text }, m.opId))
    }
    await Promise.all(sends)
  }
}
