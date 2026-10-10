import { describe, it, expect } from 'vitest'
import { loadTargets, mergeTargets, makeTarget, LIMITS, resolveTarget, targetRef } from '../src/targets'

describe('loadTargets', () => {
  const env = {
    DB_MCP_TARGETS: 'hml, prod',
    DB_MCP_TARGET_HML_ENV: 'hml',
    DB_MCP_TARGET_HML_DSN_RW: 'postgres://rw@h/hml',
    DB_MCP_TARGET_HML_DSN_EXEC: 'postgres://ex@h/hml',
    DB_MCP_TARGET_HML_DSN_DDL: 'postgres://ddl@h/hml',
    DB_MCP_TARGET_PROD_ENV: 'prod',
    DB_MCP_TARGET_PROD_DSN_RW: 'postgres://rw@h/p',
    DB_MCP_TARGET_PROD_DSN_EXEC: 'postgres://ex@h/p',
    DB_MCP_TARGET_PROD_DSN_DDL: 'postgres://ddl@h/p',
  }

  it('lê alvos do env com limites do ambiente e a role DDL', () => {
    const t = loadTargets(env)
    expect([...t.keys()]).toEqual(['hml@hml', 'prod@prod'])
    expect(t.get('hml@hml')).toMatchObject({ env: 'hml', dsnRw: 'postgres://rw@h/hml', dsnDdl: 'postgres://ddl@h/hml', limits: { updateRows: 20, insertRows: 500, selectRows: 500 } })
    expect(t.get('prod@prod')?.limits).toEqual({ updateRows: 1, insertRows: 50, selectRows: 500 })
    expect(LIMITS.prod.insertRows).toBe(50)
  })

  it('variável faltando falha citando o nome, nunca o valor', () => {
    const { DB_MCP_TARGET_PROD_DSN_EXEC: _omit, ...partial } = env
    expect(() => loadTargets(partial)).toThrow(/DB_MCP_TARGET_PROD_DSN_EXEC/)
    const { DB_MCP_TARGET_HML_DSN_DDL: _omit2, ...noDdl } = env
    expect(() => loadTargets(noDdl)).toThrow(/DB_MCP_TARGET_HML_DSN_DDL/)
    expect(() => loadTargets({ ...env, DB_MCP_TARGET_HML_ENV: 'stage' })).toThrow(/DB_MCP_TARGET_HML_ENV/)
  })

  it('sem DB_MCP_TARGETS = nenhum alvo', () => {
    expect(loadTargets({}).size).toBe(0)
  })
})

describe('mergeTargets', () => {
  it('alvos da tabela entram por nome@env; env vence só no mesmo nome@env', () => {
    const map = loadTargets({})
    map.set('a@hml', makeTarget('a', 'hml', { dsnRw: 'env', dsnExec: 'env', dsnDdl: 'env' }))
    mergeTargets(map, [
      makeTarget('a', 'hml', { dsnRw: 'tab', dsnExec: 'tab', dsnDdl: 'tab' }),
      makeTarget('a', 'prod', { dsnRw: 'tab', dsnExec: 'tab', dsnDdl: 'tab' }),
    ])
    expect(map.get('a@hml')?.dsnRw).toBe('env')
    expect(map.get('a@prod')).toMatchObject({ name: 'a', env: 'prod', dsnRw: 'tab', limits: LIMITS.prod })
  })
})

describe('resolveTarget', () => {
  const d = { dsnRw: 'r', dsnExec: 'e', dsnDdl: 'd' }
  const map = new Map([
    ['loja@hml', makeTarget('loja', 'hml', d)],
    ['loja@prod', makeTarget('loja', 'prod', d)],
    ['blog@hml', makeTarget('blog', 'hml', d)],
  ])

  it('referência canônica é nome@env', () => {
    expect(targetRef(makeTarget('loja', 'prod', d))).toBe('loja@prod')
  })
  it('nome@env explícito resolve o alvo daquele env', () => {
    expect(resolveTarget(map, 'loja@prod')).toMatchObject({ name: 'loja', env: 'prod' })
    expect(resolveTarget(map, 'loja@hml')).toMatchObject({ name: 'loja', env: 'hml' })
  })
  it('sem @ e nome único: usa o único alvo', () => {
    expect(resolveTarget(map, 'blog')).toMatchObject({ name: 'blog', env: 'hml' })
  })
  it('sem @ e nome nos dois envs: erro pedindo @hml ou @prod', () => {
    expect(() => resolveTarget(map, 'loja')).toThrow(/ambíguo.*loja@hml.*loja@prod/)
  })
  it('inexistente ou env inválido: erro', () => {
    expect(() => resolveTarget(map, 'nada')).toThrow(/não encontrado: nada/)
    expect(() => resolveTarget(map, 'blog@prod')).toThrow(/não encontrado: blog@prod/)
    expect(() => resolveTarget(map, 'loja@stage')).toThrow(/não encontrado/)
  })
})
