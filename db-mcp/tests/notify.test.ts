import { describe, it, expect, vi } from 'vitest'
import { createNotifier } from '../src/approval/notify'

const msg = { opId: 'op-1', target: 'loja@prod', kind: 'delete' as const, estimatedRows: -1, agentName: 'ag', link: 'https://l' }
const ok = () => vi.fn(async (_u: string, _i: RequestInit) => new Response('{}', { status: 200 }))
const call = (f: ReturnType<typeof ok>, i = 0) => f.mock.calls[i] as unknown as [string, RequestInit]

describe('notify', () => {
  it('sem env configurado não chama nada', async () => {
    const fetchFn = ok()
    await createNotifier({}, fetchFn)(msg)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('webhook genérico: POST JSON com os campos do pedido', async () => {
    const fetchFn = ok()
    await createNotifier({ NOTIFY_WEBHOOK_URL: 'https://hook.example/x' }, fetchFn)(msg)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = call(fetchFn)
    expect(url).toBe('https://hook.example/x')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual(msg)
  })

  it('telegram: sendMessage com chat_id e o link no texto', async () => {
    const fetchFn = ok()
    await createNotifier({ NOTIFY_TELEGRAM_BOT_TOKEN: '123:abc', NOTIFY_TELEGRAM_CHAT_ID: '-100' }, fetchFn)(msg)
    const [url, init] = call(fetchFn)
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage')
    const body = JSON.parse(String(init.body))
    expect(body.chat_id).toBe('-100')
    expect(body.text).toContain('https://l')
    expect(body.text).toContain('DELETE')
    expect(body.text).toContain('loja@prod')
  })

  it('telegram só com token (sem chat) não chama', async () => {
    const fetchFn = ok()
    await createNotifier({ NOTIFY_TELEGRAM_BOT_TOKEN: '123:abc' }, fetchFn)(msg)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('webhook e telegram juntos: avisa nos dois', async () => {
    const fetchFn = ok()
    await createNotifier({ NOTIFY_WEBHOOK_URL: 'https://hook.example/x', NOTIFY_TELEGRAM_BOT_TOKEN: 't', NOTIFY_TELEGRAM_CHAT_ID: '1' }, fetchFn)(msg)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('falha de rede ou HTTP não lança e não vaza o token no log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = { NOTIFY_WEBHOOK_URL: 'https://hook.example/x', NOTIFY_TELEGRAM_BOT_TOKEN: 'segredo-bot', NOTIFY_TELEGRAM_CHAT_ID: '1' }
    await expect(createNotifier(env, vi.fn(async () => { throw new Error('down segredo-bot') }))(msg)).resolves.toBeUndefined()
    await expect(createNotifier(env, vi.fn(async () => new Response('', { status: 500 })))(msg)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).not.toContain('segredo-bot')
    warn.mockRestore()
  })
})
