import { describe, it, expect, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createHandlers, ToolError, type ToolContext } from '../src/tools/handlers'
import { registerTools } from '../src/tools/register'
import { LIMITS, type Target } from '../src/targets'

const hml: Target = { name: 'hml', env: 'hml', dsnRw: 'rw', dsnExec: 'ex', limits: LIMITS.hml }
const prod: Target = { name: 'prod', env: 'prod', dsnRw: 'rw', dsnExec: 'ex', limits: LIMITS.prod }

function ctx(): ToolContext {
  return {
    agent: { clientId: 'cid', name: 'agente', targets: ['hml@hml'], active: true },
    targets: new Map([['hml@hml', hml], ['prod@prod', prod]]),
    write: {
      connectRw: vi.fn(async () => ({ query: vi.fn(async () => ({ rowCount: 1, rows: [] })), release: vi.fn() })),
      enqueue: vi.fn(async (op) => ({ opId: 'op-9', link: 'https://x/approve/op-9?t=1', estimatedRows: op.estimatedRows })),
      audit: vi.fn(async () => {}),
    },
    readOnly: vi.fn(async () => [{ n: 1 }]),
    listOps: vi.fn(async () => []),
  }
}

describe('handlers', () => {
  it('alvo não permitido ao agente = erro, sem tocar banco', async () => {
    const c = ctx()
    const h = createHandlers(c)
    await expect(h.db_query({ target: 'prod', sql: 'SELECT 1' })).rejects.toThrow(ToolError)
    await expect(h.db_update({ target: 'prod', sql: 'UPDATE t SET a=1 WHERE id=1', reason: 'x' })).rejects.toThrow(/não permitido/)
    expect(c.readOnly).not.toHaveBeenCalled()
    expect(c.write.connectRw).not.toHaveBeenCalled()
  })

  it('alvo inexistente = erro', async () => {
    const c = ctx()
    c.agent.targets.push('fantasma')
    await expect(createHandlers(c).db_query({ target: 'fantasma', sql: 'SELECT 1' })).rejects.toThrow(/não encontrado: fantasma/)
  })

  it('db_query recusa o que não é SELECT', async () => {
    const c = ctx()
    await expect(createHandlers(c).db_query({ target: 'hml', sql: 'UPDATE t SET a=1 WHERE id=1' })).rejects.toThrow(/só SELECT/)
    expect(c.readOnly).not.toHaveBeenCalled()
  })

  it('db_query força LIMIT padrão e respeita o informado', async () => {
    const c = ctx()
    const h = createHandlers(c)
    await h.db_query({ target: 'hml', sql: 'SELECT * FROM t;' })
    expect(c.readOnly).toHaveBeenLastCalledWith(hml, 'SELECT * FROM (\nSELECT * FROM t\n) AS _q LIMIT 500', [])
    await h.db_query({ target: 'hml', sql: 'SELECT 1 -- comentário final', limit: 10 })
    expect(c.readOnly).toHaveBeenLastCalledWith(hml, 'SELECT * FROM (\nSELECT 1 -- comentário final\n) AS _q LIMIT 10', [])
  })

  it('db_delete_request devolve pedido com link', async () => {
    const r = await createHandlers(ctx()).db_delete_request({ target: 'hml', sql: 'DELETE FROM t WHERE id=1', reason: 'limpeza' })
    expect(r).toMatchObject({ status: 'pending', opId: 'op-9', link: expect.stringContaining('/approve/op-9') })
  })

  it('db_pending lista só do agente', async () => {
    const c = ctx()
    await createHandlers(c).db_pending({ op_id: 'op-9' })
    expect(c.listOps).toHaveBeenCalledWith('cid', 'op-9')
  })
})

describe('registerTools (MCP real em memória)', () => {
  async function connect() {
    const server = new McpServer({ name: 'db-mcp', version: 'test' })
    registerTools(server, ctx())
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 't', version: '1' })
    await Promise.all([server.connect(a), client.connect(b)])
    return client
  }

  it('expõe as 12 ferramentas com descrição de aprovação', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['db_create_database', 'db_ddl', 'db_delete_request', 'db_insert', 'db_migrations_export', 'db_migrations_promote', 'db_mirror_to_homolog', 'db_pending', 'db_promote_project', 'db_query', 'db_schema', 'db_update'])
    expect(tools.find((t) => t.name === 'db_delete_request')?.description).toMatch(/aprova/i)
    for (const name of ['db_ddl', 'db_create_database', 'db_migrations_promote', 'db_promote_project', 'db_mirror_to_homolog']) {
      expect(tools.find((t) => t.name === name)?.description).toMatch(/aprova/i)
    }
  })

  it('descreve o formato nome@env; database do promote e to do mirror são opcionais', async () => {
    const { tools } = await (await connect()).listTools()
    const tool = (n: string) => tools.find((t) => t.name === n)!
    const prop = (n: string, p: string) => (tool(n).inputSchema.properties as Record<string, { description?: string }>)[p]
    expect(prop('db_query', 'target').description).toMatch(/nome@env.*@hml ou @prod/)
    expect(tool('db_promote_project').description).toMatch(/loja@hml.*loja@prod/)
    expect(tool('db_mirror_to_homolog').description).toMatch(/loja@prod.*loja@hml/)
    expect(tool('db_create_database').description).toMatch(/nome@env/)
    expect(tool('db_promote_project').inputSchema.required).not.toContain('database')
    expect(tool('db_mirror_to_homolog').inputSchema.required).not.toContain('to')
  })

  it('target não permitido volta isError', async () => {
    const r = await (await connect()).callTool({ name: 'db_query', arguments: { target: 'prod', sql: 'SELECT 1' } })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toMatch(/não permitido/)
  })
})
