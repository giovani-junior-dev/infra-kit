// Bootstrap do db-mcp. Só lê o env, migra o mcp_control e sobe o HTTP; a composição está
// em runtime.ts. Toda variável aceita X_FILE (Docker secret em /run/secrets/...).
import pg from 'pg'
import { createApp } from './app.js'
import { createRuntime } from './runtime.js'
import { loadTargets } from './targets.js'
import { parseKey } from './crypto.js'
import { accessConfigFromEnv, createAccess } from './access.js'
import { resolveFileEnv } from './env-file.js'
import { migrateControl } from './migrate.js'

const env = resolveFileEnv(process.env)

function required(key: string): string {
  const v = env[key]?.trim()
  if (!v) throw new Error(`variável de ambiente ausente: ${key} (ou ${key}_FILE)`)
  return v
}
const optional = (key: string) => env[key]?.trim() || undefined

// Antes do runtime: env do Access ausente derruba o boot (falha cedo).
// CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD_MCP, CF_ACCESS_AUD_APPROVE obrigatórias; APPROVER_EMAILS opcional.
// DB_MCP_DEV_TRUST_HEADER=1 (só com NODE_ENV != production): confia em cf-access-client-id, para teste local.
const access = createAccess(accessConfigFromEnv(env))
const port = Number(env.PORT ?? 8002)
const host = optional('HOST') ?? '127.0.0.1'
const controlDsn = required('MCP_CONTROL_DATABASE_URL')
const keyHex = optional('DB_MCP_TARGETS_KEY')

// Migrations do mcp_control. MCP_CONTROL_MIGRATE_URL: role dona do schema (a mcp_control_rw
// não tem DDL); sem ela, tenta com a própria MCP_CONTROL_DATABASE_URL.
const migrator = new pg.Client({ connectionString: optional('MCP_CONTROL_MIGRATE_URL') ?? controlDsn })
await migrator.connect()
try {
  const applied = await migrateControl(migrator)
  console.log(`[db-mcp] migrations do mcp_control: ${applied.length ? applied.join(', ') : 'nada pendente'}`)
} finally {
  await migrator.end()
}

const rt = await createRuntime({
  targets: loadTargets(env),
  controlDsn,
  secret: required('APPROVAL_SECRET'),
  baseUrl: env.APPROVAL_BASE_URL ?? `http://127.0.0.1:${port}`,
  adminDsns: {
    hml: optional('DB_MCP_ADMIN_DSN_HML'),
    prod: optional('DB_MCP_ADMIN_DSN_PROD'),
  },
  targetsKey: keyHex ? parseKey(keyHex) : undefined,
  masksDir: optional('DB_MCP_MASKS_DIR'),
  // Imagem traz o cliente PG 16 do PGDG nesta pasta.
  pgBinDir: optional('DB_MCP_PG_BIN_DIR') ?? '/usr/lib/postgresql/16/bin',
  env,
})

// Job de expiração: pending → expired quando expires_at < now().
setInterval(() => {
  rt.store.expirePending().catch((e: unknown) => console.error(`[db-mcp] expiração falhou: ${e instanceof Error ? e.message : 'erro'}`))
}, 60_000).unref()

// HOST=0.0.0.0 no container (o cloudflared alcança pela rede overlay); fora dele, só loopback.
createApp({ ...rt.appDeps, access }).listen(port, host, () => {
  console.log(`[db-mcp] ouvindo em ${host}:${port}/mcp · alvos: ${[...rt.targets.keys()].join(', ') || 'nenhum'}`)
})
