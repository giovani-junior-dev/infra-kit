import { describe, it, expect } from 'vitest'
import { classify, previewSql } from '../src/guard/sql-classifier'

describe('classify', () => {
  it.each([
    ['SELECT * FROM "Contact"', 'SELECT'],
    ['  select 1', 'SELECT'],
    ['INSERT INTO t (a) VALUES (1)', 'INSERT'],
    ['UPDATE t SET a = 1 WHERE id = 2', 'UPDATE'],
    ['DELETE FROM t WHERE id = 1', 'DELETE'],
    ['CREATE TABLE x (a int)', 'DDL_CREATE'],
    ['create table if not exists x (a int)', 'DDL_CREATE'],
    ['CREATE INDEX i ON t (a)', 'DDL_CREATE'],
    ['CREATE UNIQUE INDEX i ON t (a)', 'DDL_CREATE'],
    ['CREATE INDEX CONCURRENTLY i ON t (a)', 'DDL_CREATE'],
    ['CREATE SEQUENCE s', 'DDL_CREATE'],
    ['CREATE TYPE e AS ENUM (\'a\')', 'DDL_CREATE'],
    ['CREATE VIEW v AS SELECT 1', 'DDL_CREATE'],
    ['ALTER TABLE t ADD COLUMN x int', 'DDL_CREATE'],
    ['ALTER TABLE t ADD x int, ADD COLUMN y text', 'DDL_CREATE'],
    ['CREATE OR REPLACE VIEW v AS SELECT 1', 'DDL_DESTRUCTIVE'],
    ['DROP TABLE t', 'DDL_DESTRUCTIVE'],
    ['DROP INDEX CONCURRENTLY i', 'DDL_DESTRUCTIVE'],
    ['ALTER TABLE t DROP COLUMN x', 'DDL_DESTRUCTIVE'],
    ['ALTER TABLE t ADD COLUMN y int, DROP COLUMN x', 'DDL_DESTRUCTIVE'],
    ['ALTER TABLE t RENAME COLUMN a TO b', 'DDL_DESTRUCTIVE'],
    ['ALTER TABLE t RENAME TO u', 'DDL_DESTRUCTIVE'],
    ['ALTER TABLE t ALTER COLUMN a TYPE bigint', 'DDL_DESTRUCTIVE'],
    ['ALTER TABLE t ADD CONSTRAINT c UNIQUE (a)', 'DDL_DESTRUCTIVE'],
    ['TRUNCATE t', 'DDL_DESTRUCTIVE'],
    ['CREATE DATABASE x', 'CREATE_DATABASE'],
    ['DROP DATABASE x', 'OTHER'],
    ['DROP ROLE x', 'OTHER'],
    ['DROP SCHEMA public CASCADE', 'OTHER'],
    ['CREATE ROLE x', 'OTHER'],
    ['CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql', 'OTHER'],
    ['ALTER ROLE x SUPERUSER', 'OTHER'],
    ['GRANT ALL ON t TO x', 'OTHER'],
    ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'OTHER'],
    ['COPY t FROM stdin', 'OTHER'],
    ['', 'OTHER'],
  ])('%s -> %s', (sql, kind) => {
    expect(classify(sql).kind).toBe(kind)
  })

  it('marca CONCURRENTLY (precisa rodar fora de transação)', () => {
    expect(classify('CREATE INDEX CONCURRENTLY i ON t (a)').concurrently).toBe(true)
    expect(classify('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a)').concurrently).toBe(true)
    expect(classify('CREATE INDEX i ON t (a)').concurrently).toBe(false)
    expect(classify("CREATE INDEX i ON t (a) WHERE b = 'CONCURRENTLY'").concurrently).toBe(false)
  })

  it('DDL multi-statement continua recusado', () => {
    expect(classify('CREATE TABLE a (x int); DROP TABLE b').kind).toBe('MULTI')
  })

  it('comentário enganoso não muda o verbo', () => {
    expect(classify('/* DELETE */ SELECT 1').kind).toBe('SELECT')
    expect(classify('-- DROP TABLE t\nSELECT 1').kind).toBe('SELECT')
    expect(classify('/* SELECT */ DELETE FROM t WHERE id=1').kind).toBe('DELETE')
  })

  it('; fora de string é MULTI', () => {
    expect(classify('SELECT 1; DELETE FROM t').kind).toBe('MULTI')
    expect(classify('UPDATE t SET a=1 WHERE id=1;DROP TABLE t').kind).toBe('MULTI')
  })

  it('; dentro de string/identificador/dollar-quote não é MULTI', () => {
    expect(classify("SELECT 'a;b'").kind).toBe('SELECT')
    expect(classify("SELECT 'it''s; ok'").kind).toBe('SELECT')
    expect(classify('SELECT "we;ird" FROM t').kind).toBe('SELECT')
    expect(classify('SELECT $x$ ; $x$').kind).toBe('SELECT')
    expect(classify("SELECT E'a\\';b'").kind).toBe('SELECT')
  })

  it('; final único é aceito', () => {
    expect(classify('SELECT 1;  ').kind).toBe('SELECT')
  })

  it('string/comentário não fechado é OTHER', () => {
    expect(classify("SELECT 'abc").kind).toBe('OTHER')
    expect(classify('SELECT 1 /* x').kind).toBe('OTHER')
  })

  it('detecta WHERE no nível do statement', () => {
    expect(classify('UPDATE t SET a = 1').hasWhere).toBe(false)
    expect(classify('UPDATE t SET a = 1 WHERE id = 1').hasWhere).toBe(true)
    expect(classify("UPDATE t SET a = 'WHERE'").hasWhere).toBe(false)
    expect(classify('UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)').hasWhere).toBe(false)
    expect(classify('UPDATE t SET a = 1 -- WHERE id = 1').hasWhere).toBe(false)
    expect(classify('DELETE FROM t').hasWhere).toBe(false)
  })
})

describe('previewSql', () => {
  it('troca literais por ? e trunca', () => {
    expect(previewSql("UPDATE t1 SET phone = '+5511999' WHERE id = 1 AND x = $2")).toBe('UPDATE t1 SET phone = ? WHERE id = ? AND x = $2')
    expect(previewSql('SELECT 1 /* senha 123 */')).toBe('SELECT ?')
    expect(previewSql('SELECT ' + 'a,'.repeat(200)).length).toBeLessThanOrEqual(200)
  })
})
