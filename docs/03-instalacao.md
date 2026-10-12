# 03 · Instalação

## 1. Instalar o plugin

No Claude Code:

```
/plugin install infra --marketplace giovani-junior-dev/infra-kit
```

Versões antigas do Claude Code: `/plugin marketplace add giovani-junior-dev/infra-kit` e depois `/plugin install infra@infra-kit`.

## 2. Rodar a instalação

```
/infra:instalar
```

O Claude vai:

1. **Perguntar** o IP da VPS, o usuário inicial (`root` ou `ubuntu`), a chave SSH, o domínio, o seu e-mail, a porta SSH nova e o nome do usuário admin. Sem chave? Ele mostra o comando para gerar uma. Coloque **passphrase** (uma senha na chave): essa chave abre o servidor inteiro.
2. **Conferir o checklist** da Cloudflare ([02-cloudflare.md](02-cloudflare.md)).
3. **Copiar o kit** para `/opt/infra-kit/src` no servidor (a última versão publicada) e gravar `/opt/infra-kit/kit.env` (configuração sem senhas).
4. **Rodar as etapas**, uma por vez, mostrando o resultado:

| Etapa | O que faz |
|---|---|
| 00 | confere sistema, CPU, disco, RAM e o domínio |
| 10 | atualiza o sistema, cria swap e o usuário admin com a sua chave |
| 15 | SSH só com chave, sem root, porta nova |
| 20 | Docker, Swarm e a rede interna `infra_net` |
| 30 | túnel, DNS e Access na Cloudflare |
| 40 | Portainer |
| 50 | Postgres prod e homolog |
| 60 | PG Back Web (backups) |
| 70 | db-mcp |

## Etapa 15: o teste da conexão nova

É a etapa que pode te trancar fora do servidor, então ela tem trava:

1. Ela aplica a configuração nova e mostra um comando de teste.
2. **Abra um terminal novo** e rode esse comando. Não feche o terminal antigo.
3. Funcionou: o Claude roda `--confirm` e a porta 22 fecha.
4. Não funcionou: o Claude roda `--rollback` e volta tudo como estava.

Se ninguém confirmar em **10 minutos**, o servidor desfaz sozinho. Não saia no meio dessa etapa.

## Etapa 30: o token da Cloudflare

O token **não** vai no chat. Você escolhe:

- salvar num arquivo no seu computador (ex.: `~/.infra-kit-cf-token`) e o Claude manda o arquivo pelo SSH sem ler; ou
- digitar num terminal seu, fora do Claude Code, com o comando que o Claude mostrar (o que você digita não aparece na tela).

No fim, a etapa mostra **uma única vez** o Client Id e o Client Secret do agente. Guarde os dois num gerenciador de senhas. Depois você pode apagar o API token na Cloudflare.

## Senhas mostradas uma vez

- Portainer (etapa 40): usuário `admin` e a senha inicial. Troque no primeiro login.
- Agente do db-mcp (etapa 30): Client Id e Client Secret.

As senhas do Postgres nunca aparecem. Quando precisar de uma (ex.: cadastrar o backup), use no servidor `sudo install/ops/show-secret.sh <nome> --mostrar`, num terminal seu.

## 3. Conectar o Claude Code ao db-mcp

Num terminal seu, **fora do Claude Code** (o secret não pode entrar na conversa):

```
read -r -p 'Client Id: ' CID && read -rs -p 'Client Secret: ' CS && echo && \
claude mcp add --scope user --transport http db-mcp https://db-mcp.seudominio.com/mcp \
  --header "CF-Access-Client-Id: $CID" --header "CF-Access-Client-Secret: $CS"; unset CID CS
claude mcp get db-mcp
```

Esperado: `✔ Connected`.

## 4. Backups

A etapa 60 já agenda um backup local diário (03:00, 14 dias) do prod, e cada banco liberado com `new-project.sh grant <banco>@prod` ganha o seu. Nada para cadastrar no painel. Depois do primeiro backup, teste a restauração: [backups.md](backups.md). Cópia fora do servidor (R2) é opcional: `02-cloudflare.md`, seção 4.

## 5. Conferir

```
/infra:verificar
```

Tudo verde? Pronto. Próximo: [04 · Dia a dia](04-dia-a-dia.md).

## Parou no meio?

Rode `/infra:instalar` de novo. As etapas concluídas ficam marcadas em `/opt/infra-kit/state/` e rodar uma etapa duas vezes não estraga nada. Erros comuns: [05 · Problemas](05-problemas.md).
