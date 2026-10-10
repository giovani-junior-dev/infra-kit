---
name: instalar
description: Instala o infra-kit numa VPS Ubuntu 24.04 do aluno, do zero até o db-mcp conectado no Claude Code. Entrevista, checklist da Cloudflare, kit.env, clone da release e etapas 00 a 70 por SSH, uma por vez. Use quando o aluno pedir para instalar, montar o servidor, configurar a VPS ou retomar uma instalação parada.
argument-hint: "[retomar da etapa NN]"
disable-model-invocation: true
---

# /infra:instalar

Você conduz a instalação. Não reimplementa nada: roda os scripts do repo no servidor, mostra o resultado de cada etapa e explica erro em português simples. O aluno não é especialista: frases curtas, sem jargão solto (explique termo novo na primeira vez).

## Regras que não quebram

1. **Nunca peça segredo no chat.** Token da Cloudflare, senhas, client secret: o aluno digita num terminal dele **fora do Claude Code** ou guarda num arquivo local que você só passa adiante por pipe, sem ler. Comando com `!` também entra na conversa: não use `!` para nada que contenha segredo. Se ele colar um segredo no chat, avise que precisa revogar e criar outro.
2. **Uma etapa por vez.** Rode, mostre o resultado (`[ok]`, `[aviso]`, `[falha]`), só então siga.
3. **Nunca feche a sessão SSH em uso durante a etapa 15** e nunca rode `--confirm` sem a conexão nova ter funcionado.
4. Nada de `curl | bash`, nada de editar arquivo do servidor à mão fora do que está aqui.
5. Falhou → pare, explique causa e o que fazer (veja `docs/05-problemas.md` no repo), ofereça retomar **daquela etapa**. As etapas são idempotentes: rodar de novo é seguro.

## 1. Entrevista

Pergunte, uma coisa por vez, e repita o resumo no fim para o aluno confirmar:

| Dado | Exemplo | Observação |
|---|---|---|
| IP da VPS | `203.0.113.10` | Ubuntu 24.04, 2 vCPU, 4 GB RAM, 40 GB disco |
| Usuário inicial | `root` ou `ubuntu` | o que o provedor entregou |
| Chave SSH | `~/.ssh/id_ed25519` | se não existir, gere (abaixo) |
| Domínio | `meudominio.com` | já na Cloudflare |
| E-mail do dono | `voce@exemplo.com` | login do Access e quem aprova no db-mcp |
| Porta SSH nova | `2222` | padrão 2222 |
| Usuário admin | `deploy` | minúsculas, nunca `root` |

Chave inexistente: peça para o aluno rodar no terminal dele (a passphrase é digitada lá, não aqui):

```
! ssh-keygen -t ed25519 -f ~/.ssh/infra-kit -C infra-kit
```

Recomende **com passphrase**: essa chave vira, na prática, a chave de root do servidor (o usuário admin tem sudo sem senha). Depois `ssh-add ~/.ssh/infra-kit` para não digitar a cada comando.

Teste o acesso inicial: `ssh -i <chave> <usuario>@<ip> 'cat /etc/os-release | grep VERSION_ID'`. Se a VPS só aceita senha, peça `! ssh-copy-id -i <chave>.pub <usuario>@<ip>` (a senha é digitada pelo aluno no terminal).

## 2. Checklist do que o aluno faz fora

Mostre como lista e só avance quando ele disser que terminou cada item. O passo a passo com tabela de permissões está em `docs/02-cloudflare.md`; leia esse arquivo antes de orientar.

- [ ] Domínio na Cloudflare com status **Active** — https://dash.cloudflare.com → Add a domain
- [ ] **Zero Trust** ativado no plano **Free** — https://one.dash.cloudflare.com. Pede cartão no cadastro, mas o Free não cobra. Anotar o **Account ID**.
- [ ] **API token** custom com exatamente: Account › Cloudflare Tunnel › Edit; Account › Access: Apps and Policies › Edit; Account › Access: Service Tokens › Edit; Account › Access: Organizations, Identity Providers, and Groups › Read; Zone › DNS › Edit; Zone › Zone › Read. Recursos: só a conta dele e *Specific zone* = o domínio. https://dash.cloudflare.com/profile/api-tokens
- [ ] Bucket **R2** `infra-kit-backups` + token R2 de leitura/escrita só nesse bucket (usado depois no painel do PG Back Web) — https://dash.cloudflare.com → R2

O Account ID não é segredo: pode vir no chat. O API token é segredo: **não** pergunte o valor. Combine que ele vai guardar num arquivo local, por exemplo `~/.infra-kit-cf-token` (`chmod 600`), ou digitar na hora da etapa 30.

## 3. Variáveis de conexão

Antes da etapa 15 a conexão é `ssh -i <chave> <usuario_inicial>@<ip>` (porta 22). Depois do `--confirm` da etapa 15 passa a ser `ssh -i <chave> -p <porta> <admin>@<ip>`. Chame isso de `$SSH` daqui em diante e use `sudo` quando o usuário não for root.

## 4. Release e kit.env no servidor

Descubra a última tag de release:

```
git ls-remote --tags --refs https://github.com/giovani-junior-dev/infra-kit 'v*' | sed 's#.*/##' | sort -V | tail -n1
```

Sem tag nenhuma: avise que o kit ainda não tem release estável e só use `main` se o aluno aceitar.

No servidor (troque `<tag>`):

```
$SSH 'sudo apt-get update -qq && sudo apt-get install -y -qq git jq && sudo install -d -m 700 /opt/infra-kit && (sudo test -d /opt/infra-kit/src || sudo git clone --depth 1 --branch <tag> https://github.com/giovani-junior-dev/infra-kit /opt/infra-kit/src)'
```

Já existe clone de outra versão? Mostre `sudo git -C /opt/infra-kit/src describe --tags` e pergunte antes de trocar.

Grave o `kit.env` (nada secreto aqui). A chave **pública** vai inteira em `KIT_ADMIN_PUBKEY`; leia de `<chave>.pub`:

```
$SSH 'sudo tee /opt/infra-kit/kit.env >/dev/null && sudo chmod 600 /opt/infra-kit/kit.env' <<EOF
KIT_DOMAIN=<dominio>
KIT_OWNER_EMAIL=<email>
KIT_SSH_PORT=<porta>
KIT_ADMIN_USER=<admin>
KIT_ADMIN_PUBKEY="<conteúdo de <chave>.pub>"
KIT_SUBDOMAINS="portainer pgbackweb db-mcp"
KIT_CF_ACCOUNT_ID=<account id>
KIT_SERVER_HOST=<ip>
EOF
```

Se o `kit.env` já existe (retomada), não sobrescreva: mostre as chaves com `sudo grep -v PUBKEY /opt/infra-kit/kit.env` e ajuste só o que o aluno pedir. As etapas 30 em diante acrescentam valores sozinhas.

## 5. Etapas, uma por vez

Todas assim: `$SSH 'sudo bash /opt/infra-kit/src/install/<etapa>.sh'`. Antes de cada uma, diga em uma frase o que ela faz. Etapa já concluída aparece em `/opt/infra-kit/state/<etapa>.done`; para retomar, comece da primeira sem `.done`.

| Etapa | O que faz | Tempo |
|---|---|---|
| `00-preflight` | confere Ubuntu 24.04, CPU, disco, RAM e se o domínio está na Cloudflare | 1 min |
| `10-base` | atualiza o sistema, fail2ban, swap, fuso, cria o usuário admin com a chave | 5–10 min |
| `15-ssh-hardening` | SSH só por chave, sem root, porta nova (fluxo especial abaixo) | 2 min |
| `20-docker-swarm` | Docker oficial, Swarm, rede `infra_net`, bloqueio do Docker passando por cima do UFW | 3 min |
| `30-cloudflare` | túnel, DNS e Access (precisa do token, abaixo) | 2 min |
| `40-portainer` | painel Portainer atrás do túnel | 2 min |
| `50-postgres` | Postgres prod e homolog, senhas só em Docker secret | 3 min |
| `60-backups` | PG Back Web | 2 min |
| `70-db-mcp` | db-mcp e o agente | 3 min |

### Etapa 15: três tempos (anti-lockout)

1. Rode a etapa sem argumento. Ela imprime um comando de teste e liga um **rollback automático em 10 minutos**.
2. Peça ao aluno para rodar esse comando de teste **num terminal novo** (com `!` aqui funciona, porque é outra conexão). Deve terminar sem erro. Não feche a sessão antiga.
3. Funcionou → `sudo bash /opt/infra-kit/src/install/15-ssh-hardening.sh --confirm` **pela conexão nova** (porta nova, usuário admin). A partir daqui `$SSH` muda.
   Não funcionou → `... 15-ssh-hardening.sh --rollback` pela sessão antiga e investigue (`docs/05-problemas.md`, "Fiquei trancado fora do SSH").

Se passarem 10 minutos sem `--confirm`, o servidor volta sozinho ao SSH antigo. Avise o aluno disso antes de começar, para ele não sair no meio.

### Etapa 30: token pelo stdin

O token nunca passa pelo chat nem fica gravado no servidor. Duas formas, o aluno escolhe:

- Arquivo local (você roda, sem ler o arquivo):
  `cat ~/.infra-kit-cf-token | $SSH 'sudo bash /opt/infra-kit/src/install/30-cloudflare.sh'`
- Digitado agora, **num terminal seu fora do Claude Code** (o que passa pelo `!` fica no histórico da conversa; `read -s` não mostra o que é digitado):
  `read -rs -p 'Token Cloudflare: ' T && printf '%s' "$T" | ssh -i <chave> -p <porta> <admin>@<ip> 'sudo bash /opt/infra-kit/src/install/30-cloudflare.sh'; unset T`

Na primeira vez a etapa mostra **uma única vez** o Client Id e o Client Secret do service token `agente-1`. Peça para o aluno copiar os dois para um gerenciador de senhas antes de continuar. Se você rodou pela forma do arquivo, a saída apareceu para você: **não repita o secret** na resposta; diga onde ele está na saída e peça para o aluno guardar. Depois pode revogar o API token no painel.

### Etapa 40

Mostra a senha inicial do Portainer uma vez. Mesmo cuidado: o aluno guarda, você não repete.

### Etapa 60

Depois dela o aluno cadastra no painel do PG Back Web o destino R2, o banco e a agenda (`docs/backups.md` e `docs/02-cloudflare.md`, seção 4). Pode fazer depois; avise que backup não configurado é o primeiro vermelho do `/infra:verificar`.

## 6. Quando uma etapa falha

- Leia a linha `[falha]` e o código de saída: `2` = configuração (kit.env), `3` = pré-requisito (etapa anterior, sistema), `1` = erro na execução.
- Explique em uma ou duas frases o que aconteceu e o que fazer. Procure o caso em `docs/05-problemas.md`.
- Pergunte se quer retomar daquela etapa. Não pule etapa.

## 7. Fim: conectar o Claude Code ao db-mcp

O aluno roda **num terminal dele, fora do Claude Code** (o secret não pode entrar na conversa). Ele cola o Client Id e o Client Secret quando o `read` pedir:

```
read -r -p 'Client Id: ' CID && read -rs -p 'Client Secret: ' CS && echo && claude mcp add --scope user --transport http db-mcp https://db-mcp.<dominio>/mcp   --header "CF-Access-Client-Id: $CID" --header "CF-Access-Client-Secret: $CS"; unset CID CS
claude mcp get db-mcp
```

Esperado: `✔ Connected`. Depois, sugira `/infra:verificar` para ver tudo verde e `/infra:novo-projeto` para criar o primeiro banco.
