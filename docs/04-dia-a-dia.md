# 04 · Dia a dia

## Entrar no servidor

```
ssh -i ~/.ssh/infra-kit -p 2222 deploy@SEU_IP
```

(troque porta, usuário e chave pelos seus). Root e senha não entram mais.

## Conferir a saúde

```
/infra:verificar
```

Confere SSH, firewall, portas abertas, serviços, senhas fora de texto, diferença entre stack em uso e arquivo, último backup e o db-mcp. Rode depois de qualquer mudança.

## Projeto novo com banco

```
/infra:novo-projeto
```

O caminho é sempre o mesmo:

1. O Claude pede o banco em **homologação** (`db_create_database`). Você recebe um link e aprova (vale 30 minutos).
2. No servidor, você libera o banco para o agente: `sudo install/ops/new-project.sh grant loja@hml`.
3. O Claude cria tabelas em homologação. Apagar ou renomear coisa pede a sua aprovação.
4. Pronto para produção: o Claude pede `db_promote_project`. Você aprova pelo link.
5. A connection string do app vira um Docker secret, sem passar pelo chat:
   `sudo install/ops/new-project.sh app-secret loja@prod`.

## Subir o seu app

O app roda **na mesma VPS**, como stack na rede `infra_net`, e fala com o banco pelo nome do serviço (`pg-prod_postgres:5432`). Nenhuma porta aberta. Exemplo (o `new-project.sh app-secret` imprime este modelo com o nome certo):

```yaml
services:
  web:
    image: ghcr.io/voce/meu-app:1.0.0
    environment:
      DATABASE_URL_FILE: /run/secrets/app_loja_prod_dsn
    secrets: [app_loja_prod_dsn]
    networks: [infra_net]

secrets:
  app_loja_prod_dsn: { external: true }

networks:
  infra_net: { external: true }
```

```
sudo docker stack deploy -c meu-app.yml meu-app
```

Para abrir o app na internet: Cloudflare Zero Trust → Networks → Tunnels → `infra-kit` → **Public Hostname** → `app.seudominio.com` → `http://meu-app_web:3000`.

Não compile imagem pesada na VPS (falta memória, veja [05-problemas.md](05-problemas.md)). Gere a imagem no GitHub Actions e só baixe no servidor.

## Mexer numa stack

Toda porta, variável e secret precisa estar **no arquivo da stack**. Editar no Portainer reaplica o arquivo inteiro: o que não estiver lá some. Prefira editar o arquivo e rodar `docker stack deploy` de novo.

## Trocar a senha do Postgres

```
/infra:trocar-senha
```

O Postgres reinicia (10 a 30 segundos fora do ar). Os serviços registrados em `/opt/infra-kit/consumers.json` são atualizados sozinhos; o Claude lista os que você atualiza à mão (ex.: painel do PG Back Web).

App novo que usa banco: registre como consumidor (o `/infra:novo-projeto` mostra o comando). Assim a próxima troca de senha não esquece dele.

## Backups

- Painel: `https://pgbackweb.seudominio.com`.
- Uma vez por mês, teste a restauração: `sudo install/ops/restore-test.sh --db <banco> --file <dump>` ([backups.md](backups.md)). Backup que nunca foi restaurado não é backup.

## Atualizar o kit

```
sudo git -C /opt/infra-kit/src fetch --tags
sudo git -C /opt/infra-kit/src checkout <nova versão>
```

Leia as notas da versão antes. Depois rode `/infra:instalar` (ele só refaz o que mudou) e `/infra:verificar`.
