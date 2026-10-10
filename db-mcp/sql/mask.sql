-- Exemplo de mascaramento LGPD para o banco de homologacao (<projeto>_hml).
-- ADAPTE as tabelas e colunas abaixo ao schema do seu projeto: este arquivo cobre um
-- schema de exemplo (users, messages) e e o mesmo que o teste de integracao usa.
-- NUNCA rodar no banco de producao: a guarda abaixo recusa banco que nao termina em _hml.
--
-- Regras:
-- - telefone, email, nome de pessoa, documento (CPF/CNPJ), corpo de mensagem, token,
--   segredo, hash de senha e payload cru sao mascarados;
-- - colunas NOT NULL recebem valor neutro; colunas UNIQUE recebem valor derivado do id.
--
-- Roda igual pelo psql (com ON_ERROR_STOP=1) e pelo driver do db-mcp
-- (db_mirror_to_homolog envia o arquivo inteiro numa query simples): sem meta-comandos
-- do psql. A guarda fica DENTRO da transacao: se ela falhar, mesmo um psql sem
-- ON_ERROR_STOP aborta a transacao e nenhum UPDATE e gravado.
-- O db-mcp procura mascaras em DB_MCP_MASKS_DIR (so o nome do arquivo vai na tool).

BEGIN;

DO $$ BEGIN
  IF current_database() NOT LIKE '%\_hml' THEN
    RAISE EXCEPTION 'mask.sql recusado: banco % nao termina em _hml', current_database();
  END IF;
END $$;

-- users: identificacao, contato, senha (email UNIQUE -> derivado do id)
UPDATE users SET
  email = 'user' || id || '@hml.local',
  name = CASE WHEN name IS NULL THEN NULL ELSE 'Usuario ' || id END,
  phone = CASE WHEN phone IS NULL THEN NULL ELSE '+5500' || lpad(id::text, 9, '0') END,
  password_hash = NULL;

-- messages: corpo e payload cru
UPDATE messages SET
  body = CASE WHEN body IS NULL THEN NULL ELSE 'mensagem mascarada' END,
  raw = '{}'::jsonb;

COMMIT;

-- Conferencia (rodar depois; todos devem dar 0):
-- SELECT count(*) FROM users WHERE email NOT LIKE '%@hml.local' OR password_hash IS NOT NULL;
-- SELECT count(*) FROM messages WHERE body IS NOT NULL AND body <> 'mensagem mascarada';
