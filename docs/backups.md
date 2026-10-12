# Backups com o PG Back Web

O PG Back Web conecta nos bancos com a role `backup_reader`: só leitura
(`pg_read_all_data`), sem superuser. A etapa 50 cria essa role nos dois
servidores e guarda as senhas nos secrets `backup_reader_pw_prod` e
`backup_reader_pw_homolog`.

Banco criado pelo db-mcp já nasce com `CONNECT` para a `backup_reader`
(`DB_MCP_BACKUP_ROLE` em `stacks/db-mcp.yml`); `pg_read_all_data` sozinho não dá CONNECT.

## 1. Cadastro automático

Ninguém cadastra nada no painel. A etapa 60 agenda o backup local do banco
`postgres` do prod, e `sudo install/ops/new-project.sh grant <banco>@prod`
agenda o do banco liberado. Padrão: todo dia às 03:00 (`America/Sao_Paulo`),
14 dias de retenção, em `/backups/prod-<banco>/` no volume do PG Back Web.
A senha da `backup_reader` vai do secret direto para o banco do painel,
cifrada como o próprio painel faz; ela não aparece na tela.

Rodar de novo não duplica. Para ver ou rodar na hora: `https://pgbackweb.seudominio.com`
→ **Backups** → **Run backup now**.

## 2. Cópia fora do servidor (opcional)

Destino R2: veja `02-cloudflare.md`, seção 4. Se precisar da senha da
`backup_reader` (ex.: cadastrar um banco do homolog à mão), no servidor:

```bash
sudo install/ops/show-secret.sh backup_reader_pw_prod --mostrar
```

Sem `--mostrar` o comando não imprime nada. Copie direto para o painel.

## 3. Conferir que o backup restaura

```bash
sudo install/ops/restore-test.sh --db <banco> --file <dump>
```

O teste restaura num banco temporário no pg-homolog (sem as linhas de dono e
GRANT, porque roles só do prod não existem lá), compara a quantidade de
tabelas com o prod (lida como `backup_reader`) e apaga o temporário.

## Troca de senha

A senha fica guardada dentro do PG Back Web, por isso o `consumers.json` lista
esses secrets com o consumidor `pgbackweb/painel`. Depois de trocar a senha da
`backup_reader`, atualize as connection strings no painel.
