import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createHandlers, type ToolContext } from './handlers.js'

const target = z.string().min(1).describe('Alvo no formato nome@env, ex.: loja@hml ou loja@prod. Só o nome vale se ele existir em um único env; se existir nos dois, informe @hml ou @prod.')
const sql = z.string().min(1).max(20_000).describe('Um único comando SQL. Use $1, $2… para valores.')
const params = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(1000).optional()
  .describe('Valores dos placeholders $1, $2…')
const reason = z.string().min(3).max(500).describe('Por que esta escrita é necessária (aparece para o dono aprovar).')

function asResult(run: () => Promise<unknown>) {
  return run().then(
    (data) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }),
    (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : 'erro' }] }),
  )
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const h = createHandlers(ctx)

  server.registerTool('db_query', {
    description: 'SELECT somente leitura (transação READ ONLY). LIMIT 500 forçado se não informado. Não exige aprovação.',
    inputSchema: { target, sql, params, limit: z.number().int().min(1).max(5000).optional() },
  }, (a) => asResult(() => h.db_query(a)))

  server.registerTool('db_insert', {
    description: 'INSERT. Executa direto até o limite do alvo (hml 500 linhas, prod 50); acima disso NÃO grava e vira pedido que exige aprovação do dono (devolve op_id e link).',
    inputSchema: { target, sql, params, reason },
  }, (a) => asResult(() => h.db_insert(a)))

  server.registerTool('db_update', {
    description: 'UPDATE. Executa direto se tiver WHERE e afetar até o limite do alvo (hml 20 linhas, prod 1). Sem WHERE ou acima do limite NÃO grava e vira pedido que exige aprovação do dono.',
    inputSchema: { target, sql, params, reason },
  }, (a) => asResult(() => h.db_update(a)))

  server.registerTool('db_delete_request', {
    description: 'DELETE nunca executa direto: sempre cria pedido que exige aprovação do dono pelo link. Devolve op_id e link; acompanhe com db_pending.',
    inputSchema: { target, sql, params, reason },
  }, (a) => asResult(() => h.db_delete_request(a)))

  server.registerTool('db_pending', {
    description: 'Lista seus pedidos de aprovação (ou um, por op_id) e o status: pending, approved, rejected, executed, expired, failed. Use para esperar o OK sem repetir o comando.',
    inputSchema: { op_id: z.string().uuid().optional() },
  }, (a) => asResult(() => h.db_pending(a)))

  server.registerTool('db_ddl', {
    description: 'DDL de um comando só (CREATE TABLE/INDEX [CONCURRENTLY]/SEQUENCE/TYPE/VIEW, ADD COLUMN, DROP, ALTER ... DROP/RENAME/TYPE, TRUNCATE). Em hml só DDL aditiva (CREATE, ADD COLUMN) executa direto e grava em migrations. DDL destrutiva (DROP, ALTER DROP/RENAME/TYPE, TRUNCATE) em qualquer alvo e toda DDL em prod NUNCA executam direto: viram pedido que exige aprovação do dono pelo link.',
    inputSchema: { target, sql, reason },
  }, (a) => asResult(() => h.db_ddl(a)))

  server.registerTool('db_create_database', {
    description: 'Pede a criação de um banco novo com as roles mcp_<db>_rw/_exec/_ddl no servidor do env. Sempre exige aprovação do dono pelo link; ao aprovar, o banco vira o alvo nome@env (ex.: loja@hml). O mesmo nome pode existir em hml e em prod. O dono libera o acesso do agente depois.',
    inputSchema: {
      name: z.string().min(2).max(41).describe('Nome do banco: a-z, 0-9, _; começa com letra'),
      env: z.enum(['hml', 'prod']),
      reason,
    },
  }, (a) => asResult(() => h.db_create_database(a)))

  server.registerTool('db_migrations_export', {
    description: 'Lista em ordem as DDL já executadas num alvo (tabela migrations), com o script SQL pronto. Não exige aprovação.',
    inputSchema: { target, since: z.string().datetime().optional().describe('ISO 8601; só migrations a partir daqui') },
  }, (a) => asResult(() => h.db_migrations_export(a)))

  server.registerTool('db_migrations_promote', {
    description: 'Leva para um alvo prod (to, ex.: loja@prod) as migrations do alvo hml (from, ex.: loja@hml) ainda não aplicadas em prod, como UM pedido que exige aprovação do dono; aprovado, roda em ordem numa transação, aborta no primeiro erro e marca cada migration como aplicada.',
    inputSchema: { from: target, to: target, reason },
  }, (a) => asResult(() => h.db_migrations_promote(a)))

  server.registerTool('db_promote_project', {
    description: 'Leva um projeto de hml para produção: from = loja@hml vai para loja@prod (mesmo nome de banco no servidor prod). Cria o alvo prod se não existir, aplica as migrations pendentes, copia só as tabelas de dados listadas e confere o schema (diff hml×prod). Sempre exige aprovação do dono pelo link.',
    inputSchema: {
      from: target,
      database: z.string().min(2).max(41).optional().describe('Nome do banco em prod, sem @ (padrão: o mesmo nome do from). O destino é sempre <database>@prod.'),
      copy_tables: z.array(z.string()).max(50).optional().describe('Tabelas cujos dados vão de hml para prod (padrão: nenhuma)'),
      reason,
    },
  }, (a) => asResult(() => h.db_promote_project(a)))

  server.registerTool('db_mirror_to_homolog', {
    description: 'Espelha um alvo prod num alvo hml: from = loja@prod vai para loja@hml (padrão). Apaga e recria o banco hml com o dump de prod e aplica a máscara informada. Destino precisa ser hml. Sempre exige aprovação do dono pelo link.',
    inputSchema: {
      from: target,
      to: target.optional().describe('Alvo hml de destino, ex.: loja@hml (padrão: mesmo nome do from @hml)'),
      mask_script: z.string().optional().describe('Nome de um arquivo .sql em DB_MCP_MASKS_DIR'),
      reason,
    },
  }, (a) => asResult(() => h.db_mirror_to_homolog(a)))

  server.registerTool('db_schema', {
    description: 'Colunas e tipos do schema public (information_schema). Use antes de escrever SQL para não chutar nomes. Não exige aprovação.',
    inputSchema: { target, table: z.string().optional() },
  }, (a) => asResult(() => h.db_schema(a)))
}
