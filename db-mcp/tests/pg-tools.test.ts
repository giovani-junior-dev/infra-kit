import { describe, it, expect } from 'vitest'
import { pgConnEnv, dumpArgs, restoreArgs } from '../src/pg-tools'

const DSN = 'postgresql://mcp_loja_ddl:s3nh4%40x@db.host:5433/loja'

describe('pg-tools', () => {
  it('conexão vai por variáveis PG* do processo filho', () => {
    expect(pgConnEnv(DSN)).toEqual({ PGHOST: 'db.host', PGPORT: '5433', PGUSER: 'mcp_loja_ddl', PGPASSWORD: 's3nh4@x', PGDATABASE: 'loja' })
  })

  it('argv nunca leva senha, usuário nem DSN', () => {
    expect(dumpArgs('/tmp/x.dump')).toEqual(['--format=custom', '--no-owner', '--no-acl', '--file', '/tmp/x.dump'])
    expect(restoreArgs('/tmp/x.dump', 'loja')).toEqual(['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', 'loja', '/tmp/x.dump'])
    for (const joined of [dumpArgs('/tmp/x.dump').join(' '), restoreArgs('/tmp/x.dump', 'loja').join(' ')]) {
      expect(joined).not.toMatch(/s3nh4|postgresql:\/\/|mcp_loja_ddl/)
    }
  })
})
