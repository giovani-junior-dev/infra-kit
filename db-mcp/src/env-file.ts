import { readFileSync } from 'node:fs'

type Env = Record<string, string | undefined>

/**
 * Convenção Docker secret: X_FILE=/run/secrets/x vira X com o conteúdo do arquivo
 * (sem a quebra de linha final). Vale para qualquer variável. Devolve uma cópia.
 * AIDEV-SECURITY: erros citam só o nome da variável, nunca o conteúdo.
 */
export function resolveFileEnv(env: Env): Env {
  const out: Env = { ...env }
  for (const [key, file] of Object.entries(env)) {
    if (!key.endsWith('_FILE') || !file?.trim()) continue
    const name = key.slice(0, -'_FILE'.length)
    if (env[name] !== undefined && env[name] !== '') throw new Error(`defina só uma: ${name} e ${key} estão presentes`)
    try {
      out[name] = readFileSync(file.trim(), 'utf8').replace(/\r?\n$/, '')
    } catch {
      throw new Error(`não consegui ler o arquivo de ${key}`)
    }
  }
  return injectPasswords(out)
}

/**
 * Secret com só a senha: X=postgres://user@host:5432/db + X_PASSWORD(_FILE) vira o DSN completo.
 * DSN que já traz senha junto com X_PASSWORD é erro (ambíguo).
 */
function injectPasswords(env: Env): Env {
  for (const [key, pw] of Object.entries(env)) {
    if (!key.endsWith('_PASSWORD') || pw === undefined || pw === '') continue
    const name = key.slice(0, -'_PASSWORD'.length)
    const dsn = env[name]?.trim()
    if (!dsn) continue
    let u: URL
    try {
      u = new URL(dsn)
    } catch {
      throw new Error(`${name} não é um DSN válido para receber ${key}`)
    }
    if (u.password) throw new Error(`${name} já tem senha; tire a senha do DSN ou remova ${key}`)
    u.password = encodeURIComponent(pw)
    env[name] = u.toString()
  }
  return env
}
