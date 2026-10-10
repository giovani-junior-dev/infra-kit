---
name: novo-projeto
description: Cria o banco de um projeto novo no infra-kit pelo db-mcp, do jeito seguro - homologação primeiro, aprovação do dono, depois produção - e entrega ao app a connection string por Docker secret, nunca pelo chat. Use quando o aluno pedir banco novo, projeto novo, subir app com banco, ou levar um projeto de homologação para produção.
argument-hint: "<nome_do_banco>"
---

# /infra:novo-projeto

O agente (você) usa as tools do MCP `db-mcp`. O que é perigoso vira pedido que **o dono aprova pelo link**, no celular ou no navegador, com o login do Cloudflare Access. Você nunca aprova nada por ele.

Pré-requisito: `claude mcp get db-mcp` mostra `✔ Connected` (senão, `/infra:instalar`, passo final).

## 1. Nome

Minúsculas, números e `_`, começando com letra, até 41 caracteres. Ex.: `loja`. O mesmo nome existe em `hml` (homologação) e `prod` (produção): `loja@hml`, `loja@prod`.

## 2. Banco em homologação

Chame `db_create_database` com `name`, `env: "hml"` e um `reason` curto. Volta um link de aprovação.

- Mostre o link e diga: **vale 30 minutos**. Passou, peça de novo (o pedido antigo fica `expired`).
- Acompanhe com `db_pending` (o `op_id` veio na resposta) até `executed`. Não repita o pedido enquanto estiver `pending`.

## 3. Liberar o alvo para o agente

Por segurança o banco nasce sem nenhum agente com acesso. O dono libera, no servidor:

```
ssh -i <chave> -p <porta> <admin>@<ip> 'sudo bash /opt/infra-kit/src/install/ops/new-project.sh grant <nome>@hml'
```

(o terceiro argumento opcional é o nome do agente; padrão `agente-1`). Peça OK antes de rodar.

## 4. Estrutura em homologação

- Use `db_schema` antes de escrever SQL.
- `db_ddl` com `target: "<nome>@hml"`: `CREATE TABLE`, `ADD COLUMN`, índices executam direto e ficam registrados como migrations.
- `DROP`, `RENAME`, mudança de tipo, `TRUNCATE` viram pedido de aprovação mesmo em hml.
- Teste dados com `db_insert`/`db_update`/`db_query` em hml.

## 5. Levar para produção

Quando o aluno disser que está pronto:

1. `db_promote_project` com `from: "<nome>@hml"`, e `copy_tables` só com as tabelas de dados que precisam ir (ex.: tabela de categorias). Nunca copie dados de teste por padrão.
2. Link de aprovação (30 min). Depois de `executed`, o alvo `<nome>@prod` existe com as mesmas migrations.
3. Liberar o alvo prod ao agente, se for usar: `new-project.sh grant <nome>@prod`.

Em produção toda DDL vira pedido. Mudanças futuras: faça em hml e leve com `db_migrations_promote` (`from` hml, `to` prod).

## 6. Connection string do app

O app usa a role `mcp_<nome>_rw`. A senha não passa pelo chat: o helper decifra dentro do servidor e grava direto num Docker secret.

```
ssh -i <chave> -p <porta> <admin>@<ip> 'sudo bash /opt/infra-kit/src/install/ops/new-project.sh app-secret <nome>@prod'
```

Cria o secret `app_<nome>_prod_dsn` e imprime um exemplo de stack. O app roda **na mesma VPS**, como stack na rede `infra_net`, sem porta publicada, e lê a connection string do arquivo `/run/secrets/app_<nome>_prod_dsn` (variável `DATABASE_URL_FILE`). Se o app só aceita `DATABASE_URL`, use um entrypoint que exporte a variável a partir do arquivo (como faz `stacks/pgbackweb.yml`).

Registre o app como consumidor para a troca de senha futura não esquecê-lo; peça OK e rode no servidor:

```
sudo bash -c 'source /opt/infra-kit/src/install/lib.sh && register_consumer app_<nome>_prod_dsn <stack> <serviço> mcp_<nome>_rw'
```

Para o app ficar acessível na internet, a rota passa pelo túnel da Cloudflare (hostname público no painel Zero Trust → Networks → Tunnels → `infra-kit` → Public Hostname → `http://<stack>_<serviço>:<porta>`). Nunca publique porta no servidor.

## Nunca

- Pedir ou mostrar senha/DSN no chat.
- Usar o superuser `postgres` no app.
- Tentar contornar um pedido de aprovação com outra tool.
