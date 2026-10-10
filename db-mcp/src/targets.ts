// Alvos (banco + ambiente) lidos do env (DB_MCP_TARGETS; aceita X_FILE) e da tabela targets.
// Nenhum DSN em código. Limites fixos por ambiente (plano 2.3; Q2: prod insert 50).

export type TargetEnv = 'hml' | 'prod'

export interface Limits {
  /** UPDATE acima disto vira pedido de aprovação. */
  updateRows: number
  /** INSERT acima disto vira pedido de aprovação. */
  insertRows: number
  /** LIMIT forçado no SELECT quando o agente não informa. */
  selectRows: number
}

export interface Target {
  name: string
  env: TargetEnv
  /** Role sem DELETE/DDL: usada pelos agentes. */
  dsnRw: string
  /** Role com DELETE: usada só pelo executor de pedidos aprovados. */
  dsnExec: string
  /** Role dona do schema (DDL): usada só pelo executor e pelo DDL direto em hml. */
  dsnDdl: string
  limits: Limits
}

export type TargetDsns = Pick<Target, 'dsnRw' | 'dsnExec' | 'dsnDdl'>

export function makeTarget(name: string, env: TargetEnv, dsns: TargetDsns): Target {
  return { name, env, ...dsns, limits: LIMITS[env] }
}

/** Identidade do alvo = (nome, env). Referência canônica: nome@hml / nome@prod. */
export const targetRef = (t: Pick<Target, 'name' | 'env'>) => `${t.name}@${t.env}`

/** Separa nome@env; sem @ devolve só o nome. */
export function parseRef(ref: string): { name: string; env?: string } {
  const at = ref.lastIndexOf('@')
  return at < 0 ? { name: ref } : { name: ref.slice(0, at), env: ref.slice(at + 1) }
}

// AIDEV-SECURITY: nome sem @ só resolve se for único; nos dois envs vira erro, nunca
// escolhe um sozinho (escrever no env errado é o risco).
export function resolveTarget(map: ReadonlyMap<string, Target>, ref: string): Target {
  const { name, env } = parseRef(ref)
  if (env !== undefined) {
    const t = map.get(ref)
    if (!t) throw new Error(`alvo não encontrado: ${ref}`)
    return t
  }
  const found = [...map.values()].filter((t) => t.name === name)
  if (found.length === 0) throw new Error(`alvo não encontrado: ${ref}`)
  if (found.length > 1) throw new Error(`alvo ambíguo: ${ref} existe em ${found.map(targetRef).join(' e ')}; use ${name}@hml ou ${name}@prod`)
  return found[0]
}

/** Soma alvos da tabela targets (mcp_control) ao mapa; o env vence no mesmo nome@env. */
export function mergeTargets(map: Map<string, Target>, fromTable: Target[]): void {
  for (const t of fromTable) if (!map.has(targetRef(t))) map.set(targetRef(t), t)
}

export const LIMITS: Record<TargetEnv, Limits> = {
  hml: { updateRows: 20, insertRows: 500, selectRows: 500 },
  prod: { updateRows: 1, insertRows: 50, selectRows: 500 },
}

type Env = Record<string, string | undefined>

function required(env: Env, key: string): string {
  const v = env[key]?.trim()
  if (!v) throw new Error(`variável de ambiente ausente: ${key}`)
  return v
}

/** DB_MCP_TARGETS=hml,prod + DB_MCP_TARGET_<NOME>_{ENV,DSN_RW,DSN_EXEC,DSN_DDL}. Chave do mapa = nome@env. */
export function loadTargets(env: Env): Map<string, Target> {
  const names = (env.DB_MCP_TARGETS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const targets = new Map<string, Target>()
  for (const name of names) {
    const prefix = `DB_MCP_TARGET_${name.toUpperCase()}_`
    const kind = required(env, `${prefix}ENV`)
    if (kind !== 'hml' && kind !== 'prod') throw new Error(`${prefix}ENV deve ser hml ou prod`)
    const t = makeTarget(name, kind, {
      dsnRw: required(env, `${prefix}DSN_RW`),
      dsnExec: required(env, `${prefix}DSN_EXEC`),
      dsnDdl: required(env, `${prefix}DSN_DDL`),
    })
    targets.set(targetRef(t), t)
  }
  return targets
}
