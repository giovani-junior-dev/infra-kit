import { describe, it, expect, vi } from 'vitest'
import { createHandlers, type ToolContext } from '../src/tools/handlers'
import { makeTarget } from '../src/targets'
import type { Migration } from '../src/types'

const dsns = { dsnRw: 'rw', dsnExec: 'ex', dsnDdl: 'ddl' }
const hml = makeTarget('hml', 'hml', dsns)
const prod = makeTarget('prod', 'prod', dsns)
const lojaHml = makeTarget('loja', 'hml', dsns)
const lojaProd = makeTarget('loja', 'prod', dsns)

function mig(id: number, sql: string): Migration {
  return { id, target: 'hml', env: 'hml', sql, checksum: `c${id}`, executedAt: new Date(2026, 9, id), agentId: 'cid', opId: null }
}

function ctx(migrations: Migration[] = [], extra: [string, typeof hml][] = []) {
  const c = {
    agent: { clientId: 'cid', name: 'agente', targets: ['hml@hml', 'prod@prod', 'loja@hml', 'loja@prod'], active: true },
    targets: new Map([['hml@hml', hml], ['prod@prod', prod], ['loja@hml', lojaHml], ...extra]),
    write: {
      connectRw: vi.fn(),
      enqueue: vi.fn(async (op) => ({ opId: 'op-1', link: 'https://x/approve/op-1?t=1', estimatedRows: op.estimatedRows })),
      audit: vi.fn(async () => {}),
    },
    readOnly: vi.fn(async () => []),
    listOps: vi.fn(async () => []),
    ddl: {
      run: vi.fn(async () => {}),
      migrations: vi.fn(async () => migrations),
      unapplied: vi.fn(async () => migrations),
    },
    createDatabaseEnvs: new Set(['hml', 'prod'] as const),
    maskExists: vi.fn(async (name: string) => name === 'mask.sql'),
  } satisfies ToolContext
  return c
}

describe('db_ddl', () => {
  it('hml executa direto pela role DDL', async () => {
    const c = ctx()
    const r = await createHandlers(c).db_ddl({ target: 'hml', sql: 'CREATE TABLE x (a int)', reason: 'nova tabela' })
    expect(r).toMatchObject({ status: 'executed', class: 'DDL_CREATE' })
    expect(c.ddl.run).toHaveBeenCalledWith(hml, ['CREATE TABLE x (a int)'], { agentId: 'cid', opId: null })
    expect(c.write.enqueue).not.toHaveBeenCalled()
    expect(c.write.audit).toHaveBeenCalledWith(expect.objectContaining({ tool: 'db_ddl', outcome: 'executed' }))
  })

  it.each(['DROP TABLE t', 'ALTER TABLE t DROP COLUMN a', 'ALTER TABLE t RENAME TO u', 'TRUNCATE t'])(
    'destrutiva vira pedido mesmo em hml: %s', async (sql) => {
      const c = ctx()
      const r = await createHandlers(c).db_ddl({ target: 'hml', sql, reason: 'x' })
      expect(r).toMatchObject({ status: 'pending' })
      expect(c.ddl.run).not.toHaveBeenCalled()
      expect(c.write.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ddl', target: 'hml@hml', sql }))
    })

  it('prod sempre vira pedido kind ddl, mesmo CREATE', async () => {
    const c = ctx()
    const r = await createHandlers(c).db_ddl({ target: 'prod', sql: 'CREATE INDEX CONCURRENTLY i ON t (a)', reason: 'índice' })
    expect(r).toMatchObject({ status: 'pending', opId: 'op-1' })
    expect(c.ddl.run).not.toHaveBeenCalled()
    expect(c.write.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ddl', target: 'prod@prod', sql: 'CREATE INDEX CONCURRENTLY i ON t (a)' }))
  })

  it.each([
    ['DML', 'UPDATE t SET a=1 WHERE id=1'],
    ['CREATE DATABASE', 'CREATE DATABASE x'],
    ['MULTI', 'CREATE TABLE a (x int); DROP TABLE b'],
    ['proibido', 'DROP SCHEMA public CASCADE'],
  ])('recusa %s', async (_l, sql) => {
    const c = ctx()
    await expect(createHandlers(c).db_ddl({ target: 'hml', sql, reason: 'x' })).rejects.toThrow(/não permitido/)
    expect(c.ddl.run).not.toHaveBeenCalled()
  })
})

describe('db_create_database', () => {
  it('sempre vira pedido create_database com alvo nome@env', async () => {
    const c = ctx()
    const r = await createHandlers(c).db_create_database({ name: 'loja_hml', env: 'hml', reason: 'projeto novo' })
    expect(r).toMatchObject({ status: 'pending', opId: 'op-1' })
    expect(c.write.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create_database', target: 'loja_hml@hml', params: ['loja_hml', 'hml'] }))
  })

  it('mesmo nome pode existir no outro env', async () => {
    const c = ctx()
    await createHandlers(c).db_create_database({ name: 'loja', env: 'prod', reason: 'x' })
    expect(c.write.enqueue).toHaveBeenCalledWith(expect.objectContaining({ target: 'loja@prod', params: ['loja', 'prod'] }))
    await expect(createHandlers(c).db_create_database({ name: 'loja', env: 'hml', reason: 'x' })).rejects.toThrow(/já existente/)
  })

  it('env sem DSN admin configurado falha já ao criar o pedido', async () => {
    const c = { ...ctx(), createDatabaseEnvs: new Set(['prod'] as const) }
    await expect(createHandlers(c).db_create_database({ name: 'loja_hml', env: 'hml', reason: 'x' })).rejects.toThrow(/DB_MCP_ADMIN_DSN_HML/)
    expect(c.write.enqueue).not.toHaveBeenCalled()
  })

  it.each(['Loja', '1abc', 'a-b', 'x; DROP', 'postgres', 'hml'])('nome inválido ou já existente: %s', async (name) => {
    const c = ctx()
    await expect(createHandlers(c).db_create_database({ name, env: 'hml', reason: 'x' })).rejects.toThrow(/nome/)
    expect(c.write.enqueue).not.toHaveBeenCalled()
  })
})

describe('migrations', () => {
  const list = [mig(1, 'CREATE TABLE a (x int)'), mig(2, 'ALTER TABLE a ADD COLUMN y int')]

  it('export devolve o SQL em ordem', async () => {
    const c = ctx(list)
    const since = new Date(2026, 0, 1)
    const r = await createHandlers(c).db_migrations_export({ target: 'hml', since: since.toISOString() })
    expect(c.ddl.migrations).toHaveBeenCalledWith('hml@hml', since)
    expect(r.count).toBe(2)
    expect(r.script).toBe('CREATE TABLE a (x int);\nALTER TABLE a ADD COLUMN y int;\n')
  })

  it('promote cria UM pedido com o lote em ordem', async () => {
    const c = ctx(list)
    const r = await createHandlers(c).db_migrations_promote({ from: 'hml', to: 'prod', reason: 'release' })
    expect(r).toMatchObject({ status: 'pending', opId: 'op-1' })
    // Seleção por rastreamento (não aplicadas em prod), não por data.
    expect(c.ddl.unapplied).toHaveBeenCalledWith('hml@hml')
    expect(c.ddl.migrations).not.toHaveBeenCalled()
    expect(c.write.enqueue).toHaveBeenCalledTimes(1)
    expect(c.write.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'promote', target: 'prod@prod', estimatedRows: 2, params: [1, 2],
      sql: expect.stringContaining('ALTER TABLE a ADD COLUMN y int'),
    }))
  })

  it('promote só de hml para prod, com lote não vazio e sem CONCURRENTLY', async () => {
    await expect(createHandlers(ctx(list)).db_migrations_promote({ from: 'prod', to: 'hml', reason: 'x' })).rejects.toThrow(/hml.*prod/)
    await expect(createHandlers(ctx([])).db_migrations_promote({ from: 'hml', to: 'prod', reason: 'x' })).rejects.toThrow(/nenhuma/)
    await expect(createHandlers(ctx([mig(1, 'CREATE INDEX CONCURRENTLY i ON a (x)')])).db_migrations_promote({ from: 'hml', to: 'prod', reason: 'x' })).rejects.toThrow(/CONCURRENTLY/)
  })
})

describe('db_promote_project', () => {
  it('destino derivado: x@hml vai para x@prod (cria se não existe) com as tabelas de dados', async () => {
    const c = ctx([mig(1, 'CREATE TABLE a (x int)')])
    const r = await createHandlers(c).db_promote_project({ from: 'loja@hml', copy_tables: ['a'], reason: 'go-live' })
    expect(r).toMatchObject({ status: 'pending' })
    expect(c.ddl.run).not.toHaveBeenCalled()
    expect(c.ddl.unapplied).toHaveBeenCalledWith('loja@hml')
    expect(c.write.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'promote_project', target: 'loja@prod', params: ['loja@hml', 'a'], estimatedRows: 1, sql: expect.stringContaining('(cria o banco)'),
    }))
  })

  it('bug de produção: from e database com o mesmo nome, hml e prod existentes', async () => {
    const c = ctx([], [['loja@prod', lojaProd]])
    await createHandlers(c).db_promote_project({ from: 'loja@hml', database: 'loja', reason: 'x' })
    expect(c.write.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'promote_project', target: 'loja@prod', params: ['loja@hml'] }))
    expect(c.write.enqueue.mock.calls[0][0].sql).not.toContain('cria o banco')
  })

  it('database explícito com outro nome', async () => {
    const c = ctx()
    await createHandlers(c).db_promote_project({ from: 'hml', database: 'novo', reason: 'x' })
    expect(c.write.enqueue).toHaveBeenCalledWith(expect.objectContaining({ target: 'novo@prod', params: ['hml@hml'] }))
  })

  it('nome sem @ existente nos dois envs: erro pedindo @hml ou @prod, nada enfileirado', async () => {
    const c = ctx([], [['loja@prod', lojaProd]])
    await expect(createHandlers(c).db_promote_project({ from: 'loja', reason: 'x' })).rejects.toThrow(/ambíguo.*loja@hml.*loja@prod/)
    expect(c.write.enqueue).not.toHaveBeenCalled()
    expect(c.write.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused', target: 'loja' }))
  })

  it('destino prod existente sem permissão do agente é recusado', async () => {
    const c = ctx([], [['outro@prod', makeTarget('outro', 'prod', dsns)]])
    await expect(createHandlers(c).db_promote_project({ from: 'hml@hml', database: 'outro', reason: 'x' })).rejects.toThrow(/não permitido/)
  })

  it('recusa origem não-hml, nome/tabela inválidos e prod sem admin', async () => {
    const h = createHandlers(ctx())
    await expect(h.db_promote_project({ from: 'prod@prod', reason: 'x' })).rejects.toThrow(/hml/)
    await expect(h.db_promote_project({ from: 'hml@hml', database: 'Loja;', reason: 'x' })).rejects.toThrow(/nome/)
    await expect(h.db_promote_project({ from: 'hml@hml', database: 'loja@hml', reason: 'x' })).rejects.toThrow(/nome/)
    await expect(h.db_promote_project({ from: 'loja@hml', copy_tables: ['a; DROP'], reason: 'x' })).rejects.toThrow(/tabela/)
    const noAdmin = { ...ctx(), createDatabaseEnvs: new Set(['hml'] as const) }
    await expect(createHandlers(noAdmin).db_promote_project({ from: 'loja@hml', reason: 'x' })).rejects.toThrow(/DB_MCP_ADMIN_DSN_PROD/)
  })
})

describe('db_mirror_to_homolog', () => {
  const withProd = () => ctx([], [['loja@prod', lojaProd]])

  it('destino default x@prod -> x@hml com máscara registrada', async () => {
    const c = withProd()
    const r = await createHandlers(c).db_mirror_to_homolog({ from: 'loja@prod', mask_script: 'mask.sql', reason: 'refresh' })
    expect(r).toMatchObject({ status: 'pending' })
    expect(c.write.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mirror', target: 'loja@hml', params: ['loja@prod', 'mask.sql'] }))
  })

  it('destino explícito', async () => {
    const c = withProd()
    await createHandlers(c).db_mirror_to_homolog({ from: 'prod', to: 'hml', reason: 'x' })
    expect(c.write.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mirror', target: 'hml@hml', params: ['prod@prod', null] }))
  })

  it('recusa destino prod, origem não-prod e nome ambíguo', async () => {
    const c = withProd()
    await expect(createHandlers(c).db_mirror_to_homolog({ from: 'prod', to: 'prod', reason: 'x' })).rejects.toThrow(/destino.*hml/)
    await expect(createHandlers(c).db_mirror_to_homolog({ from: 'hml', to: 'hml', reason: 'x' })).rejects.toThrow(/origem.*prod/)
    await expect(createHandlers(c).db_mirror_to_homolog({ from: 'loja', reason: 'x' })).rejects.toThrow(/ambíguo/)
    expect(c.write.enqueue).not.toHaveBeenCalled()
  })

  it.each(['../etc/passwd', 'sub/mask.sql', 'nao-existe.sql', 'mask.txt'])('recusa máscara inválida: %s', async (mask) => {
    await expect(createHandlers(withProd()).db_mirror_to_homolog({ from: 'loja@prod', mask_script: mask, reason: 'x' })).rejects.toThrow(/máscara/)
  })

  it('exige admin hml configurado', async () => {
    const c = { ...withProd(), createDatabaseEnvs: new Set(['prod'] as const) }
    await expect(createHandlers(c).db_mirror_to_homolog({ from: 'loja@prod', reason: 'x' })).rejects.toThrow(/DB_MCP_ADMIN_DSN_HML/)
  })
})
