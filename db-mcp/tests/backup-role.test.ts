import { describe, expect, it, vi } from 'vitest'
import { backupConnectSql, grantBackupConnect } from '../src/approval/create-database'

function fakeClient(roleExists: boolean) {
  const calls: { sql: string; params?: unknown[] }[] = []
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      return { rows: sql.includes('pg_roles') && roleExists ? [{ ok: 1 }] : [], rowCount: roleExists ? 1 : 0 }
    }),
  }
}

describe('CONNECT da role de backup', () => {
  it('monta o GRANT com identificadores escapados', () => {
    expect(backupConnectSql('loja', 'backup_reader')).toBe('GRANT CONNECT ON DATABASE "loja" TO "backup_reader"')
    expect(backupConnectSql('a"b', 'r')).toBe('GRANT CONNECT ON DATABASE "a""b" TO "r"')
  })

  it('concede CONNECT quando a role existe no servidor', async () => {
    const c = fakeClient(true)
    const log = vi.fn()
    expect(await grantBackupConnect(c, 'loja', 'backup_reader', log)).toBe(true)
    expect(c.calls[0].params).toEqual(['backup_reader'])
    expect(c.calls[1].sql).toBe('GRANT CONNECT ON DATABASE "loja" TO "backup_reader"')
    expect(log).not.toHaveBeenCalled()
  })

  it('pula sem erro e loga uma linha quando a role não existe', async () => {
    const c = fakeClient(false)
    const log = vi.fn()
    expect(await grantBackupConnect(c, 'loja', 'backup_reader', log)).toBe(false)
    expect(c.calls).toHaveLength(1)
    expect(log).toHaveBeenCalledTimes(1)
  })
})
