# db-mcp

MCP de banco com guardrails para agentes de IA. O agente propõe; o db-mcp segura o que é perigoso; o dono aprova pelo link.

- Leitura sempre `READ ONLY`, com limite de linhas.
- Escrita por impacto: UPDATE/INSERT pequenos passam; acima do limite, e todo DELETE, viram pedido de aprovação.
- DDL direto em homologação; em produção só aprovada. Criação de banco, promote hml → prod e mirror prod → hml (com máscara) por aprovação.
- Identidade pelo JWT do Cloudflare Access (`Cf-Access-Jwt-Assertion`), nunca superuser.

Imagem: `ghcr.io/giovani-junior-dev/infra-kit-db-mcp:<versão>`.

## Variáveis de ambiente

Toda variável aceita a forma `X_FILE=/run/secrets/x` (Docker secret). Definir `X` e `X_FILE` juntas é erro.

Secret com só a senha: todo DSN `X` aceita `X_PASSWORD` (ou `X_PASSWORD_FILE`), que entra no DSN. Exemplo no kit (1 servidor, rede `infra_net`):

```
MCP_CONTROL_DATABASE_URL=postgres://mcp_control_rw@pg-prod_postgres:5432/mcp_control
MCP_CONTROL_DATABASE_URL_PASSWORD_FILE=/run/secrets/mcp_control_rw_pw
DB_MCP_ADMIN_DSN_PROD=postgres://mcp_admin@pg-prod_postgres:5432/postgres
DB_MCP_ADMIN_DSN_PROD_PASSWORD_FILE=/run/secrets/mcp_admin_pw_prod
DB_MCP_ADMIN_DSN_HML=postgres://mcp_admin@pg-homolog_postgres:5432/postgres
DB_MCP_ADMIN_DSN_HML_PASSWORD_FILE=/run/secrets/mcp_admin_pw_homolog
CF_ACCESS_TEAM_DOMAIN=${KIT_CF_TEAM_DOMAIN}
CF_ACCESS_AUD_MCP=${KIT_CF_AUD_DBMCP}
CF_ACCESS_AUD_APPROVE=${KIT_CF_AUD_DBMCP_APPROVE}
```

DSN que já traz senha junto com `X_PASSWORD` é erro.

| Variável | Obrigatória | O que é |
|---|---|---|
| `MCP_CONTROL_DATABASE_URL` | sim | DSN do banco `mcp_control` com a role `mcp_control_rw` |
| `MCP_CONTROL_MIGRATE_URL` | não | DSN da role dona do schema do `mcp_control`, usada só nas migrations do boot. Sem ela, usa a `MCP_CONTROL_DATABASE_URL` |
| `APPROVAL_SECRET` | sim | segredo HMAC dos links de aprovação |
| `APPROVAL_BASE_URL` | não | URL pública, ex. `https://db-mcp.seudominio.com` |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD_MCP`, `CF_ACCESS_AUD_APPROVE` | sim | Cloudflare Access |
| `APPROVER_EMAILS` | não | e-mails que podem aprovar (vírgula) |
| `DB_MCP_TARGETS_KEY` | para criar banco | 64 hex; cifra os DSNs da tabela `targets` |
| `DB_MCP_ADMIN_DSN_HML`, `DB_MCP_ADMIN_DSN_PROD` | para criar banco | role `mcp_admin` (CREATEDB, CREATEROLE, nunca superuser) |
| `DB_MCP_TARGETS` + `DB_MCP_TARGET_<NOME>_{ENV,DSN_RW,DSN_EXEC,DSN_DDL}` | não | alvos fixos pelo env |
| `DB_MCP_MASKS_DIR` | não | pasta das máscaras do mirror (imagem: `/app/masks`) |
| `DB_MCP_BACKUP_ROLE` | não | role de backup (ex.: `backup_reader`) que recebe `CONNECT` em todo banco criado, promovido ou recriado pelo mirror; ausente no servidor = pula e loga |
| `DB_MCP_PG_BIN_DIR` | não | pasta do `pg_dump`/`pg_restore` 16 (padrão `/usr/lib/postgresql/16/bin`) |
| `NOTIFY_WEBHOOK_URL` | não | recebe `POST` JSON `{opId,target,kind,estimatedRows,agentName,link}` a cada pedido |
| `NOTIFY_TELEGRAM_BOT_TOKEN`, `NOTIFY_TELEGRAM_CHAT_ID` | não | aviso do pedido pelo Telegram |
| `HOST`, `PORT` | não | padrão `127.0.0.1:8002` (imagem: `0.0.0.0:8002`) |

Aviso nunca bloqueia: sem configuração ou com falha, o link volta só na resposta da tool.

## Banco de controle

No boot, o db-mcp aplica `control-migrations/*.sql` em ordem (tabela `schema_migrations`, advisory lock, idempotente). `sql/control/create-control-db.sql` cria o banco, a role `mcp_control_rw` e os grants. `sql/roles/` cria as roles por banco (`_rw`, `_exec`, `_ddl`) e o `mcp_admin`. `sql/mask.sql` é um exemplo de máscara LGPD: adapte às suas tabelas.

## Desenvolvimento

```bash
npm ci
npm test                 # unitários
npm run build
# integração: Postgres 16 descartável (superuser) + mesma instância em outra porta + outra instância
DB_MCP_IT_ADMIN_URL=postgres://postgres:pw@127.0.0.1:5432/postgres \
DB_MCP_IT_HML_PORT=5433 \
DB_MCP_IT_HML_ADMIN_URL=postgres://postgres:pw@127.0.0.1:5434/postgres \
npm run test:integration
```
