# Backups com o PG Back Web

O PG Back Web conecta nos bancos com a role `backup_reader`: só leitura
(`pg_read_all_data`), sem superuser. A etapa 50 cria essa role nos dois
servidores e guarda as senhas nos secrets `backup_reader_pw_prod` e
`backup_reader_pw_homolog`.

## 1. Ler a senha (uma vez)

No servidor:

```bash
sudo install/ops/show-secret.sh backup_reader_pw_prod --mostrar
sudo install/ops/show-secret.sh backup_reader_pw_homolog --mostrar
```

Sem `--mostrar` o comando não imprime nada. Copie a senha direto para o
painel e não cole em chat nem em arquivo.

## 2. Cadastrar no painel

Em `https://pgbackweb.seudominio.com` → **Databases** → **Add database**, uma
para cada banco que você quer copiar, com versão 16:

| Servidor | Connection string |
|---|---|
| prod | `postgresql://backup_reader:<senha>@pg-prod_postgres:5432/<banco>` |
| homolog | `postgresql://backup_reader:<senha>@pg-homolog_postgres:5432/<banco>` |

Destino R2, agenda e retenção: veja `02-cloudflare.md`, seção 4.

## 3. Conferir que o backup restaura

```bash
sudo install/ops/restore-test.sh --db <banco> --file <dump>
```

O teste restaura num banco temporário no pg-homolog, compara a quantidade de
tabelas com o prod (lida como `backup_reader`) e apaga o temporário.

## Troca de senha

A senha fica guardada dentro do PG Back Web, por isso o `consumers.json` lista
esses secrets com o consumidor `pgbackweb/painel`. Depois de trocar a senha da
`backup_reader`, atualize as connection strings no painel.
