-- Migration do banco mcp_control: identidade do alvo = (nome, env). O mesmo projeto
-- existe como nome@hml e nome@prod (mesmo nome de banco nos dois servidores).
-- Aplica sobre 002-promote-tracking.sql. Idempotente.
-- Uso (humano, no host do banco): psql -U postgres -d mcp_control -f 003-target-env.sql
\set ON_ERROR_STOP on

BEGIN;

-- targets: chave única passa de (name) para (name, env). Linhas mantêm name e env.
ALTER TABLE targets DROP CONSTRAINT IF EXISTS targets_pkey;
ALTER TABLE targets ADD CONSTRAINT targets_pkey PRIMARY KEY (name, env);

-- agents.targets: entradas sem @ viram nome@env pelo alvo de mesmo nome na tabela targets.
-- Alvo que só existe no env do processo (DB_MCP_TARGETS) não está aqui: fica sem @ (o
-- db-mcp nega acesso) e sai no NOTICE abaixo para o dono corrigir à mão.
UPDATE agents a
   SET targets = ARRAY(
     SELECT CASE
              WHEN u.e LIKE '%@%' THEN u.e
              -- Só converte se o nome for único (rodar de novo com nome nos dois envs não chuta).
              ELSE coalesce((SELECT min(t.name || '@' || t.env) FROM targets t WHERE t.name = u.e HAVING count(*) = 1), u.e)
            END
       FROM unnest(a.targets) WITH ORDINALITY AS u(e, ord)
      ORDER BY u.ord)
 WHERE EXISTS (SELECT 1 FROM unnest(a.targets) e WHERE e NOT LIKE '%@%');

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT client_id, e FROM agents, unnest(targets) e WHERE e NOT LIKE '%@%' LOOP
    RAISE NOTICE 'agents.targets sem env (alvo do env DB_MCP_TARGETS?): client_id=% alvo=% -> troque por %@hml ou %@prod', r.client_id, r.e, r.e, r.e;
  END LOOP;
END $$;

-- migrations: target vira nome@env (a coluna env já diz de onde veio a DDL).
UPDATE migrations SET target = target || '@' || env WHERE target NOT LIKE '%@%';

COMMIT;
