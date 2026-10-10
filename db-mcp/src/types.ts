export type SqlParam = string | number | boolean | null

/** Linha da tabela agents (chave = CF-Access-Client-Id do Service Token). */
export interface Agent {
  clientId: string
  name: string
  targets: string[]
  active: boolean
}

/** Subconjunto do pg.PoolClient que o guard usa (facilita mock). */
export interface DbClient {
  query(sql: string, params?: SqlParam[]): Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }>
  release(): void
}

export type OpKind = 'insert' | 'update' | 'delete' | 'ddl' | 'create_database' | 'promote' | 'promote_project' | 'mirror'

/** Linha da tabela migrations (mcp_control): toda DDL executada. */
export interface Migration {
  id: number
  target: string
  env: string
  sql: string
  checksum: string
  executedAt: Date
  agentId: string
  opId: string | null
}

export interface DdlMeta {
  agentId: string
  opId: string | null
}

export interface NewPendingOp {
  agentId: string
  target: string
  kind: OpKind
  sql: string
  params: SqlParam[]
  estimatedRows: number
  reason: string
}

export type OpStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired' | 'failed'

export interface PendingOp extends NewPendingOp {
  id: string
  status: OpStatus
  createdAt: Date
  expiresAt: Date
  result: unknown
}

export interface PendingRef {
  opId: string
  link: string
  estimatedRows: number
}

export type AuditOutcome = 'executed' | 'pending' | 'refused' | 'failed' | 'approved' | 'rejected'

/** Nunca leva SQL cru nem params: só hash + preview sem literais. */
export interface AuditEntry {
  agentId: string
  target: string
  tool: string
  sqlHash: string
  sqlPreview: string
  rows: number | null
  outcome: AuditOutcome
  opId?: string
}
