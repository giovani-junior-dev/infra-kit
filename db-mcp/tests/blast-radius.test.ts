import { describe, it, expect, vi } from 'vitest'
import { guardedWrite, type WriteDeps } from '../src/guard/blast-radius'
import { LIMITS, type Target } from '../src/targets'

const prod: Target = { name: 'prod', env: 'prod', dsnRw: 'rw', dsnExec: 'exec', limits: LIMITS.prod }

function setup(rowCount: number, fail = false, returned: Record<string, unknown>[] = []) {
  const calls: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (fail && !['BEGIN', 'ROLLBACK'].includes(sql)) throw new Error('permission denied')
      const tx = ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)
      return { rowCount: tx ? null : rowCount, rows: tx ? [] : returned }
    }),
    release: vi.fn(),
  }
  const deps: WriteDeps = {
    connectRw: vi.fn(async () => client),
    enqueue: vi.fn(async (op) => ({ opId: 'op-1', link: 'https://x/approve/op-1?t=abc', estimatedRows: op.estimatedRows })),
    audit: vi.fn(async () => {}),
  }
  return { calls, client, deps }
}

const base = { target: prod, params: [], agentId: 'agent-1', reason: 'teste' }

describe('guardedWrite', () => {
  it('UPDATE de 1 linha com WHERE commita', async () => {
    const { calls, deps, client } = setup(1)
    const r = await guardedWrite(deps, { ...base, tool: 'db_update', expected: 'UPDATE', sql: 'UPDATE t SET a=1 WHERE id=$1' })
    expect(r).toEqual({ status: 'executed', rows: 1 })
    expect(calls).toEqual(['BEGIN', 'UPDATE t SET a=1 WHERE id=$1', 'COMMIT'])
    expect(deps.enqueue).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalled()
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'executed', rows: 1, tool: 'db_update' }))
  })

  it('UPDATE de 2 linhas faz ROLLBACK e cria pedido com estimatedRows=2', async () => {
    const { calls, deps } = setup(2)
    const r = await guardedWrite(deps, { ...base, tool: 'db_update', expected: 'UPDATE', sql: 'UPDATE t SET a=1 WHERE g=$1' })
    expect(calls).toEqual(['BEGIN', 'UPDATE t SET a=1 WHERE g=$1', 'ROLLBACK'])
    expect(deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'update', estimatedRows: 2, target: 'prod@prod', agentId: 'agent-1' }))
    expect(r).toMatchObject({ status: 'pending', opId: 'op-1', estimatedRows: 2 })
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pending', opId: 'op-1' }))
  })

  it('UPDATE sem WHERE vira pedido mesmo com 1 linha', async () => {
    const { calls, deps } = setup(1)
    const r = await guardedWrite(deps, { ...base, tool: 'db_update', expected: 'UPDATE', sql: 'UPDATE t SET a=1' })
    expect(calls.at(-1)).toBe('ROLLBACK')
    expect(r.status).toBe('pending')
  })

  it('INSERT até o limite commita; acima vira pedido', async () => {
    const ok = setup(50)
    expect((await guardedWrite(ok.deps, { ...base, tool: 'db_insert', expected: 'INSERT', sql: 'INSERT INTO t SELECT 1' })).status).toBe('executed')
    const big = setup(51)
    expect((await guardedWrite(big.deps, { ...base, tool: 'db_insert', expected: 'INSERT', sql: 'INSERT INTO t SELECT 1' })).status).toBe('pending')
    expect(big.calls.at(-1)).toBe('ROLLBACK')
  })

  it('DELETE nunca toca a role rw: enfileira direto', async () => {
    const { deps } = setup(1)
    const r = await guardedWrite(deps, { ...base, tool: 'db_delete_request', expected: 'DELETE', sql: 'DELETE FROM t WHERE id=1' })
    expect(deps.connectRw).not.toHaveBeenCalled()
    expect(deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'delete', estimatedRows: -1 }))
    expect(r.status).toBe('pending')
  })

  it.each([
    ['DDL', 'DROP TABLE t'],
    ['MULTI', 'UPDATE t SET a=1 WHERE id=1; DELETE FROM t'],
    ['OTHER', 'COPY t FROM stdin'],
    ['verbo diferente da tool', 'DELETE FROM t WHERE id=1'],
  ])('recusa %s sem conectar', async (_label, sql) => {
    const { deps } = setup(1)
    await expect(guardedWrite(deps, { ...base, tool: 'db_update', expected: 'UPDATE', sql })).rejects.toThrow(/não permitido/)
    expect(deps.connectRw).not.toHaveBeenCalled()
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused' }))
  })

  it('erro do banco faz ROLLBACK, audita failed e repassa', async () => {
    const { calls, deps, client } = setup(1, true)
    await expect(guardedWrite(deps, { ...base, tool: 'db_update', expected: 'UPDATE', sql: 'UPDATE t SET a=1 WHERE id=1' })).rejects.toThrow('permission denied')
    expect(calls.at(-1)).toBe('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
  })

  it('auditoria nunca leva valores: só hash e preview sem literais', async () => {
    const { deps } = setup(1)
    await guardedWrite(deps, { ...base, params: ['+5511999990000'], tool: 'db_update', expected: 'UPDATE', sql: "UPDATE t SET phone='+5511' WHERE id=$1" })
    const entry = vi.mocked(deps.audit).mock.calls[0][0]
    expect(JSON.stringify(entry)).not.toContain('5511')
    expect(entry.sqlHash).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('guardedWrite com RETURNING (Kaneo #450)', () => {
  it('INSERT ... RETURNING devolve as linhas retornadas', async () => {
    const { deps } = setup(1, false, [{ id: 4 }])
    const r = await guardedWrite(deps, { ...base, tool: 'db_insert', expected: 'INSERT', sql: 'INSERT INTO t(a) VALUES (1) RETURNING id' })
    expect(r).toEqual({ status: 'executed', rows: 1, returning: [{ id: 4 }] })
  })

  it('UPDATE ... RETURNING devolve as linhas retornadas', async () => {
    const { deps } = setup(1, false, [{ id: 7, a: 1 }])
    const r = await guardedWrite(deps, { ...base, tool: 'db_update', expected: 'UPDATE', sql: 'UPDATE t SET a=1 WHERE id=$1 RETURNING id, a' })
    expect(r).toEqual({ status: 'executed', rows: 1, returning: [{ id: 7, a: 1 }] })
  })

  it('acima do limite com RETURNING vira pedido sem vazar linhas revertidas', async () => {
    const { deps } = setup(51, false, [{ id: 1 }])
    const r = await guardedWrite(deps, { ...base, tool: 'db_insert', expected: 'INSERT', sql: 'INSERT INTO t SELECT 1 RETURNING id' })
    expect(r.status).toBe('pending')
    expect(r).not.toHaveProperty('returning')
  })
})
