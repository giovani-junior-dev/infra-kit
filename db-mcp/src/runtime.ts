// Composição das peças (pools, store, executor, tools). server.ts só lê o env e
// chama isto; o teste de integração usa o mesmo caminho.
import { access } from 'node:fs/promises'
import path from 'node:path'
import { createDb } from './db.js'
import { MASK_NAME } from './tools/handlers.js'
import { mergeTargets, targetRef, type Target, type TargetEnv } from './targets.js'
import { ControlStore } from './approval/store.js'
import { createExecutor } from './approval/executor.js'
import { createDatabase } from './approval/create-database.js'
import { approvalUrl, type ApprovalDeps } from './approval/link.js'
import { createNotifier } from './approval/notify.js'
import { createDdlRunner } from './ddl.js'
import type { WriteDeps } from './guard/blast-radius.js'
import type { ToolContext } from './tools/handlers.js'
import type { AppDeps } from './app.js'
import type { Agent } from './types.js'

export interface RuntimeConfig {
  /** Alvos do env, chave nome@env; os da tabela targets entram por cima (env vence). */
  targets: Map<string, Target>
  controlDsn: string
  secret: string
  baseUrl: string
  /**
   * DSN admin por env (DB_MCP_ADMIN_DSN_HML / _PROD): CREATEDB/CREATEROLE, nunca superuser.
   * Homologação e produção são servidores Postgres diferentes: o banco nasce no servidor do env.
   */
  adminDsns: Partial<Record<TargetEnv, string>>
  /** DB_MCP_TARGETS_KEY: cifra os DSNs da tabela targets. */
  targetsKey?: Buffer
  /** DB_MCP_MASKS_DIR: diretório dos arquivos de máscara do mirror (só nomes de arquivo). */
  masksDir?: string
  /** DB_MCP_PG_BIN_DIR: pasta do pg_dump/pg_restore 16 (senão PATH). */
  pgBinDir?: string
  /** DB_MCP_BACKUP_ROLE: recebe CONNECT em todo banco criado (ex.: backup_reader). */
  backupRole?: string
  env: Record<string, string | undefined>
}

export async function createRuntime(cfg: RuntimeConfig) {
  const { targets, secret, baseUrl } = cfg
  const db = createDb()
  const store = new ControlStore(db.pool(cfg.controlDsn))
  if (cfg.targetsKey) mergeTargets(targets, await store.listTargets(cfg.targetsKey))
  const notify = createNotifier(cfg.env)
  const runDdl = createDdlRunner({ connectDdl: (t) => db.connect(t.dsnDdl), recordMigrations: (rows) => store.recordMigrations(rows) })

  async function createAndRegister(name: string, env: TargetEnv, opId: string) {
    const adminDsn = cfg.adminDsns[env]
    if (!adminDsn || !cfg.targetsKey) throw new Error(`DB_MCP_ADMIN_DSN_${env.toUpperCase()} e DB_MCP_TARGETS_KEY são obrigatórios para criar banco`)
    const created = await createDatabase(adminDsn, name, env, cfg.backupRole)
    await store.saveTarget(created.target, cfg.targetsKey, opId)
    targets.set(targetRef(created.target), created.target)
    // O dono já aprovou a criação: o agente que pediu sai com o alvo liberado.
    const op = await store.getOp(opId)
    if (op) await store.grantTarget(op.agentId, targetRef(created.target))
    return { database: name, roles: created.roles }
  }

  const execute = createExecutor({
    targets,
    connectExec: (t) => db.connect(t.dsnExec),
    runDdl,
    store,
    createDatabase: createAndRegister,
    project: {
      targets,
      runDdl,
      connect: (dsn) => db.connect(dsn),
      readOnly: (dsn, sql, params) => db.readOnly(dsn, sql, params),
      createDatabase: createAndRegister,
      store,
      adminDsns: cfg.adminDsns,
      pgBinDir: cfg.pgBinDir,
      masksDir: cfg.masksDir,
      backupRole: cfg.backupRole,
    },
  })

  async function maskExists(name: string): Promise<boolean> {
    if (!cfg.masksDir || !MASK_NAME.test(name) || name.includes('..')) return false
    return access(path.join(cfg.masksDir, path.basename(name))).then(() => true, () => false)
  }

  const createDatabaseEnvs = new Set(
    cfg.targetsKey ? (Object.keys(cfg.adminDsns) as TargetEnv[]).filter((e) => cfg.adminDsns[e]) : [],
  )

  const approval: ApprovalDeps = {
    secret,
    getOp: (id) => store.getOp(id),
    decide: (id, status, by) => store.decide(id, status, by),
    markExpired: (id) => store.markExpired(id),
    execute,
  }

  function toolContext(agent: Agent): ToolContext {
    const write: WriteDeps = {
      connectRw: (t) => db.connect(t.dsnRw),
      audit: (e) => store.audit(e),
      enqueue: async (op) => {
        const p = await store.insertPending(op)
        const link = approvalUrl(baseUrl, p.id, p.expiresAt, secret)
        void notify({ opId: p.id, target: p.target, kind: p.kind, estimatedRows: p.estimatedRows, agentName: agent.name, link })
        return { opId: p.id, link, estimatedRows: p.estimatedRows }
      },
    }
    return {
      agent,
      targets,
      write,
      readOnly: (t, sql, params) => db.readOnly(t.dsnRw, sql, params),
      listOps: (agentId, opId) => store.listOps(agentId, opId),
      ddl: {
        run: runDdl,
        migrations: (target, since) => store.listMigrations(target, since),
        unapplied: (target) => store.listUnapplied(target),
      },
      createDatabaseEnvs,
      maskExists,
    }
  }

  // access fica no server.ts (vem do env de boot; testes de integração não sobem HTTP).
  const appDeps: Omit<AppDeps, 'access'> = { getAgent: (id) => store.getAgent(id), approval, toolContext }

  return { targets, store, approval, toolContext, appDeps, close: () => db.end() }
}

export type Runtime = Awaited<ReturnType<typeof createRuntime>>
