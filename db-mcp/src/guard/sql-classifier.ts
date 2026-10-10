// AIDEV-SECURITY: classificador simples de propósito (plano Q5). A trava real é a
// role do Postgres (rw sem DELETE/DDL); isto só decide "executa direto ou pede OK".
// Tudo que não for claramente um único SELECT/INSERT/UPDATE/DELETE vira OTHER.

export type SqlKind =
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  | 'DDL_CREATE' | 'DDL_DESTRUCTIVE' | 'CREATE_DATABASE'
  | 'MULTI' | 'OTHER'

export interface Classification {
  kind: SqlKind
  /** WHERE no nível 0 de parênteses do statement (fora de string/comentário/subquery). */
  hasWhere: boolean
  /** CREATE INDEX CONCURRENTLY: não roda dentro de transação. */
  concurrently: boolean
}

const DML = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
const CREATE_OBJECTS = new Set(['TABLE', 'INDEX', 'SEQUENCE', 'TYPE', 'VIEW'])
const CREATE_MODIFIERS = new Set(['UNIQUE', 'TEMP', 'TEMPORARY', 'UNLOGGED'])
/** DROP destes é OTHER (recusado sempre): fora do escopo de um agente. */
const DROP_FORBIDDEN = new Set(['DATABASE', 'ROLE', 'USER', 'GROUP', 'SCHEMA', 'OWNED', 'EXTENSION', 'TABLESPACE', 'FUNCTION', 'PROCEDURE', 'TRIGGER'])
const ALTER_OBJECTS = new Set(['INDEX', 'SEQUENCE', 'VIEW', 'TYPE'])
const ALTER_TABLE_DESTRUCTIVE = /\b(DROP|RENAME|TYPE|ALTER|SET|RESET|OWNER|DISABLE|ENABLE|CONSTRAINT|VALIDATE|INHERIT|NO|ATTACH|DETACH|CLUSTER)\b/

/** Classifica DDL a partir das palavras do nível 0 (já sem literais/comentários). */
function classifyDdl(words: string[], text: string): SqlKind {
  const [verb, ...rest] = words
  if (verb === 'TRUNCATE') return 'DDL_DESTRUCTIVE'
  if (verb === 'DROP') return DROP_FORBIDDEN.has(rest[0]) ? 'OTHER' : 'DDL_DESTRUCTIVE'
  if (verb === 'CREATE') {
    if (rest[0] === 'DATABASE') return 'CREATE_DATABASE'
    if (rest[0] === 'OR' && rest[1] === 'REPLACE' && rest[2] === 'VIEW') return 'DDL_DESTRUCTIVE'
    const obj = rest.find((w) => !CREATE_MODIFIERS.has(w))
    return obj && CREATE_OBJECTS.has(obj) ? 'DDL_CREATE' : 'OTHER'
  }
  if (verb === 'ALTER') {
    if (rest[0] === 'TABLE') {
      // Só ADD [COLUMN] é aditivo; qualquer outra ação (ou ADD CONSTRAINT) é destrutiva.
      const actions = text.replace(/^\s*ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?\S+/i, '').toUpperCase()
      return /^\s*ADD\b/.test(actions) && !ALTER_TABLE_DESTRUCTIVE.test(actions) ? 'DDL_CREATE' : 'DDL_DESTRUCTIVE'
    }
    if (rest[0] === 'TYPE' && /\bADD\s+VALUE\b/i.test(text) && !/\b(RENAME|DROP)\b/i.test(text)) return 'DDL_CREATE'
    return ALTER_OBJECTS.has(rest[0]) ? 'DDL_DESTRUCTIVE' : 'OTHER'
  }
  return 'OTHER'
}

/**
 * Remove comentários e troca literais (string, identificador entre aspas, dollar-quote)
 * por placeholders. Devolve null se algo ficou aberto (ambíguo).
 */
function normalize(sql: string): string | null {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? n : end
      out += ' '
    } else if (c === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2 }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      if (depth > 0) return null
      out += ' '
    } else if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '')
      i++
      let closed = false
      while (i < n) {
        if (escapes && sql[i] === '\\') { i += 2; continue }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue }
          closed = true
          i++
          break
        }
        i++
      }
      if (!closed) return null
      out += "'?'"
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1)
      if (end === -1) return null
      out += '"?"'
      i = end + 1
    } else if (c === '$' && /[A-Za-z_$]/.test(next ?? '') && !/\w/.test(sql[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))
      if (!m) { out += c; i++; continue }
      const tag = m[0]
      const end = sql.indexOf(tag, i + tag.length)
      if (end === -1) return null
      out += "'?'"
      i = end + tag.length
    } else {
      out += c
      i++
    }
  }
  return out
}

function depthZero(text: string): string {
  let depth = 0
  let out = ''
  for (const c of text) {
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) out += c
  }
  return out
}

export function classify(sql: string): Classification {
  const result = (kind: SqlKind, hasWhere = false, concurrently = false): Classification => ({ kind, hasWhere, concurrently })
  const norm = normalize(sql)
  if (norm === null) return result('OTHER')
  const body = norm.trim().replace(/;\s*$/, '')
  if (body.includes(';')) return result('MULTI')
  const top = depthZero(body)
  const words = top.toUpperCase().match(/[A-Z_]+/g) ?? []
  const first = /^[A-Za-z]+/.test(body) ? words[0] : undefined
  if (!first) return result('OTHER')
  if (DML.has(first)) return result(first as SqlKind, /\bWHERE\b/i.test(top))
  const kind = classifyDdl(words, top)
  const concurrently = kind === 'DDL_CREATE' && words[0] === 'CREATE' && words.slice(1, 4).includes('CONCURRENTLY')
  return result(kind, false, concurrently)
}

/** SQL sem comentários e sem valores literais, truncado: seguro para log/auditoria. */
export function previewSql(sql: string, max = 200): string {
  const norm = normalize(sql) ?? '<sql não analisável>'
  return norm
    .replace(/'\?'/g, '?')
    .replace(/(?<![\w$])\d+(\.\d+)?/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
