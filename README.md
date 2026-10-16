# infra-kit

**Sua própria infraestrutura numa VPS, montada por conversa com o Claude Code.**

Você aluga um servidor (VPS), conecta seu domínio na Cloudflare e roda um comando no Claude Code. Ele instala tudo, passo a passo, explicando o que está fazendo. No fim você tem:

- um **banco de dados de produção** e outro de **teste** (homologação), como o Supabase oferece, só que seu;
- **backup diário automático**;
- **painéis** para gerenciar tudo pelo navegador, protegidos por login;
- o **db-mcp**, que deixa o Claude Code criar tabelas e mexer nos dados **com limites**: o que é perigoso só acontece depois que **você** aprova por um link.

E o servidor fica fechado: nenhuma porta aberta na internet além do acesso SSH (com chave, sem senha).

> Versão estável: **v1.0.0**. Testada em VPS real (instalação do zero, reinstalação, backup e restauração). Feito para quem **não é especialista** em servidor.

---

## Sumário

1. [O que vem no kit](#1-o-que-vem-no-kit)
2. [Como tudo se conecta](#2-como-tudo-se-conecta)
3. [O que você precisa (e quanto custa)](#3-o-que-você-precisa-e-quanto-custa)
4. [Palavras que vão aparecer](#4-palavras-que-vão-aparecer)
5. [Tutorial completo, do zero ao primeiro projeto](#5-tutorial-completo-do-zero-ao-primeiro-projeto)
6. [Os comandos do plugin](#6-os-comandos-do-plugin)
7. [O que o Claude pode e não pode fazer no banco](#7-o-que-o-claude-pode-e-não-pode-fazer-no-banco)
8. [Dia a dia](#8-dia-a-dia)
9. [Segurança: o que o kit faz por você](#9-segurança-o-que-o-kit-faz-por-você)
10. [Perguntas frequentes e problemas](#10-perguntas-frequentes-e-problemas)
11. [Guias detalhados e estrutura do repositório](#11-guias-detalhados-e-estrutura-do-repositório)

---

## 1. O que vem no kit

### Programas instalados no servidor

| Ferramenta | Para que serve | Onde você acessa |
|---|---|---|
| **Docker + Docker Swarm** | Roda cada programa isolado num "container" e reinicia sozinho se cair | — |
| **Portainer CE** 2.45 | Painel para ver e gerenciar os containers pelo navegador | `https://portainer.seudominio.com` |
| **PostgreSQL 16 + pgvector** (produção) | O banco de dados dos seus apps. O `pgvector` permite busca por similaridade (IA, embeddings) | Só por dentro do servidor (sem porta pública) |
| **PostgreSQL 16 + pgvector** (homologação) | Um segundo banco, separado, para testar antes de ir para produção | Só por dentro do servidor |
| **PG Back Web** 0.5.2 | Faz o backup dos bancos todo dia e mostra o histórico | `https://pgbackweb.seudominio.com` |
| **db-mcp** | Servidor MCP: a "ponte" segura entre o Claude Code e o seu banco | `https://db-mcp.seudominio.com` (só o seu agente entra) |
| **cloudflared** (Cloudflare Tunnel) | Liga o servidor à Cloudflare sem abrir portas | — |

### Proteção do servidor

| Ferramenta | O que faz |
|---|---|
| **UFW** (firewall) | Fecha todas as portas, menos a do SSH |
| **Bloqueio DOCKER-USER** | Impede que um container fique exposto na internet "por fora" do firewall (um erro comum com Docker) |
| **SSH só com chave** | Sem senha e sem login de root; porta trocada (padrão 2222) |
| **fail2ban** | Bloqueia quem tenta adivinhar o acesso SSH |
| **Atualizações automáticas de segurança** | O Ubuntu se corrige sozinho |
| **chrony** | Relógio do servidor sempre certo (importante para backups e logs) |
| **swap** | Memória de reserva para o servidor não travar |
| **Cloudflare Access** | Login na frente de cada painel: só entra o seu e-mail |

### Plugin para o Claude Code

O plugin `infra` adiciona 4 comandos ao Claude Code: `/infra:instalar`, `/infra:verificar`, `/infra:novo-projeto` e `/infra:trocar-senha`. Detalhes na [seção 6](#6-os-comandos-do-plugin).

---

## 2. Como tudo se conecta

```
                    Você (navegador)            Seu Claude Code
                          │                           │
                 login com seu e-mail        token do agente (agente-1)
                          │                           │
                          ▼                           ▼
              ┌───────────────────────────────────────────────┐
              │      Cloudflare  (Access: quem pode entrar)   │
              └───────────────────────┬───────────────────────┘
                                      │  túnel (sai do servidor,
                                      │  nenhuma porta aberta)
┌─────────────────────────────────────▼─────────────────────────────────────┐
│ Sua VPS (Ubuntu)                                                           │
│                                                                            │
│   cloudflared ──► Portainer        PG Back Web        db-mcp               │
│                                         │               │                  │
│                                         ▼               ▼                  │
│                         Postgres PRODUÇÃO   ◄──►   Postgres HOMOLOGAÇÃO    │
│                                                                            │
│   Firewall: só a porta SSH (2222) aberta, e só com a sua chave             │
└────────────────────────────────────────────────────────────────────────────┘
```

- Os painéis ficam em endereços do **seu domínio**, mas quem responde é a Cloudflare. Ela pede login e só então passa a conversa pelo túnel até o servidor.
- O Claude Code fala com o **db-mcp**, nunca direto com o banco. O db-mcp decide o que pode rodar na hora e o que precisa da sua aprovação.
- Seus apps também rodam na mesma VPS e falam com o banco por dentro, sem porta pública.

---

## 3. O que você precisa (e quanto custa)

| Item | Detalhe | Custo |
|---|---|---|
| **VPS** | **Ubuntu 24.04 ou 26.04**, mínimo **2 vCPU, 4 GB de RAM, 40 GB de disco**. Qualquer provedor (Hetzner, Contabo, DigitalOcean, Hostinger...). Testamos na Hetzner. | mensalidade do provedor |
| **Domínio** | Qualquer um (ex.: `meusite.com.br`), com o DNS gerenciado pela Cloudflare | anuidade do registro |
| **Conta na Cloudflare** | Plano **Free** + **Zero Trust Free** | R$ 0 |
| **Claude Code** | Instalado no seu computador (Windows, Mac ou Linux) | sua assinatura atual |

**Sobre o cartão na Cloudflare:** o cadastro do Zero Trust pede cartão de crédito. Pode colocar: o plano **Free** (até 50 usuários) não cobra nada. Só confira que escolheu **Free** antes de confirmar.

**Tempo:** cerca de 40 minutos na primeira vez, contando os cliques na Cloudflare. Dá para parar e continuar depois.

---

## 4. Palavras que vão aparecer

| Palavra | O que significa |
|---|---|
| **VPS** | Um computador alugado na internet, ligado 24 horas. É o seu "servidor". |
| **SSH** | O jeito de acessar o terminal do servidor pela internet. |
| **Chave SSH** | Um par de arquivos que substitui a senha. A parte **pública** (`.pub`) vai para o servidor; a **privada** fica só no seu computador. Quem tem a privada entra no servidor, então **guarde bem**. |
| **Passphrase** | Uma senha que protege a sua chave privada. Se alguém copiar o arquivo, ainda precisa dela. |
| **Docker / container** | Cada programa roda numa "caixinha" isolada. Se um cair, o Docker sobe de novo. |
| **Stack** | Um arquivo que descreve um ou mais containers e como se ligam. |
| **Docker secret** | O cofre de senhas do Docker. A senha não fica em arquivo nem aparece na tela. |
| **Cloudflare Tunnel** | Um "cano" que sai do servidor até a Cloudflare. Os painéis funcionam sem abrir porta no servidor. |
| **Cloudflare Access** | A portaria dos painéis: pede login antes de deixar entrar. |
| **Produção (prod)** | O banco "de verdade", que o seu app usa. |
| **Homologação (hml)** | O banco de teste. Tudo é feito lá primeiro. |
| **MCP** | Um padrão que deixa o Claude Code usar ferramentas externas, como o db-mcp. |
| **Migration** | O registro de cada mudança na estrutura do banco (criar tabela, coluna...). É o que permite levar de hml para prod igualzinho. |

---

## 5. Tutorial completo, do zero ao primeiro projeto

Siga na ordem. Cada passo diz **onde** você faz: no navegador, no terminal do seu computador ou no Claude Code.

### Passo 1 · Contratar a VPS (navegador)

1. No provedor que você escolheu, crie um servidor com **Ubuntu 24.04** (ou 26.04).
2. Escolha pelo menos **2 vCPU, 4 GB de RAM e 40 GB de disco**.
3. Anote o **IP** do servidor (ex.: `203.0.113.10`) e o **usuário inicial** (geralmente `root`; em alguns provedores é `ubuntu`).
4. Se o provedor deixar cadastrar uma chave SSH na criação, cadastre a do passo 3. Se não, tudo bem: o Claude mostra como enviar depois.

### Passo 2 · Instalar o Claude Code (seu computador)

Siga o guia oficial: https://docs.claude.com/en/docs/claude-code . Depois, abra um terminal e rode `claude` para conferir que abre.

### Passo 3 · Criar a sua chave SSH (terminal do seu computador)

No **Windows** (PowerShell), **Mac** ou **Linux**, o comando é o mesmo:

```
ssh-keygen -t ed25519 -f ~/.ssh/infra-kit -C infra-kit
```

- Ele pede uma **passphrase**. Coloque uma, e anote num gerenciador de senhas. Essa chave vai abrir o servidor inteiro.
- Vão aparecer dois arquivos: `~/.ssh/infra-kit` (privada, **nunca compartilhe**) e `~/.ssh/infra-kit.pub` (pública).

> Não sabe fazer? Pode pular. No passo 6 o `/infra:instalar` pergunta pela chave e mostra o comando.

### Passo 4 · Colocar o domínio na Cloudflare (navegador)

1. Crie uma conta em https://dash.cloudflare.com (plano **Free**).
2. Clique em **Add a domain** (Adicionar domínio), digite seu domínio e siga as telas.
3. A Cloudflare mostra **2 nameservers** (ex.: `ada.ns.cloudflare.com`). Vá no site onde você comprou o domínio (Registro.br, GoDaddy, Hostinger...) e troque os nameservers por esses dois.
4. Espere o status do domínio ficar **Active** (de minutos a algumas horas).

### Passo 5 · Zero Trust e o token da Cloudflare (navegador)

**5.1 · Ativar o Zero Trust**

1. No painel da Cloudflare, abra **Zero Trust**.
2. Escolha um nome de time (vira `seutime.cloudflareaccess.com`).
3. Escolha o plano **Free**. Ele pede cartão, mas não cobra.

**5.2 · Criar o API token** (é com ele que o kit configura a Cloudflare sozinho)

1. Ícone do perfil (canto de cima) → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**.
2. Dê um nome, ex.: `infra-kit`.
3. Adicione **exatamente** estas 6 permissões:

| Tipo | Permissão | Nível |
|---|---|---|
| Account | Cloudflare Tunnel | Edit |
| Account | Access: Apps and Policies | Edit |
| Account | Access: Service Tokens | Edit |
| Account | Access: Organizations, Identity Providers, and Groups | Read |
| Zone | DNS | Edit |
| Zone | Zone | Read |

4. Em **Account Resources**, escolha só a sua conta. Em **Zone Resources**, escolha **Specific zone** e o seu domínio.
5. Crie o token. Ele aparece **uma vez só**.
6. **Não cole o token no chat do Claude.** Salve num arquivo no seu computador, por exemplo `~/.infra-kit-cf-token`. O Claude envia esse arquivo para o servidor sem ler o conteúdo.

> Terminada a instalação, você pode apagar esse token na mesma tela. Ele só é necessário para instalar ou reinstalar.

### Passo 6 · Instalar o plugin e rodar a instalação (Claude Code)

Abra o Claude Code e digite:

```
/plugin install infra --marketplace giovani-junior-dev/infra-kit
```

Em versões antigas do Claude Code: `/plugin marketplace add giovani-junior-dev/infra-kit` e depois `/plugin install infra@infra-kit`.

Agora:

```
/infra:instalar
```

O Claude vai conversar com você:

1. **Perguntas**, uma de cada vez: IP da VPS, usuário inicial, caminho da chave SSH, domínio, seu e-mail (o login dos painéis), porta SSH nova (padrão `2222`) e nome do usuário administrador (padrão `deploy`). No fim ele repete tudo para você confirmar.
2. **Checklist da Cloudflare**: confere com você os passos 4 e 5.
3. **Prepara o servidor**: copia o kit da última versão publicada para `/opt/infra-kit/src` e grava a configuração em `/opt/infra-kit/kit.env` (sem nenhuma senha).
4. **Roda as etapas, uma por vez**, mostrando `[ok]`, `[aviso]` ou `[falha]`:

| Etapa | O que faz |
|---|---|
| 00 | Confere o sistema, CPU, memória, disco e se o domínio já está na Cloudflare |
| 10 | Atualiza o Ubuntu, liga atualizações automáticas, fail2ban, relógio, swap e cria o usuário admin com a sua chave |
| 15 | SSH só com chave, sem root, na porta nova, e liga o firewall (**leia o aviso abaixo**) |
| 20 | Instala Docker e Swarm, cria a rede interna `infra_net` e o bloqueio de portas do Docker |
| 30 | Cria na Cloudflare o túnel, os endereços (DNS) e os logins (Access) |
| 40 | Sobe o Portainer |
| 50 | Sobe os dois Postgres (produção e homologação), com senhas geradas e guardadas no cofre |
| 60 | Sobe o PG Back Web e **já agenda o backup diário** |
| 70 | Sobe o db-mcp e cadastra o seu agente |

**Aviso da etapa 15 (a única que pode te trancar fora):**

1. Ela aplica a configuração nova e mostra um comando de teste.
2. O Claude testa numa **conexão nova**. A conexão antiga continua aberta.
3. Funcionou: ele confirma, e a porta 22 fecha.
4. Não funcionou: ele desfaz tudo.
5. Se ninguém confirmar em **10 minutos**, o próprio servidor desfaz sozinho.

Não feche o Claude Code no meio dessa etapa.

**Parou no meio?** Rode `/infra:instalar` de novo. Ele continua de onde parou. Rodar uma etapa duas vezes não estraga nada.

### Passo 7 · Guardar as senhas que aparecem uma vez

| O quê | Onde aparece | O que fazer |
|---|---|---|
| Senha inicial do **Portainer** (usuário `admin`) | Na etapa 40 | Guarde e **troque no primeiro login** |
| **Client Id** do agente | Na etapa 30 | Não é segredo, mas anote |
| **Client Secret** do agente | Não aparece na tela: fica no servidor em `/opt/infra-kit/agente-1.secret` (só o root lê) | Use no passo 8 |

As senhas do Postgres **nunca aparecem**. Se um dia precisar de uma, no servidor: `sudo /opt/infra-kit/src/install/ops/show-secret.sh <nome> --mostrar`.

### Passo 8 · Conectar o Claude Code ao seu banco (terminal do seu computador)

Rode **num terminal seu, fora do Claude Code** (o segredo não pode entrar na conversa). Troque os valores entre `< >`:

```
CS=$(ssh -i ~/.ssh/infra-kit -p 2222 deploy@<IP> 'sudo cat /opt/infra-kit/agente-1.secret') && \
claude mcp add --scope user --transport http db-mcp https://db-mcp.<seudominio>/mcp \
  --header "CF-Access-Client-Id: <CLIENT_ID>" \
  --header "CF-Access-Client-Secret: $CS"; unset CS
```

Confira:

```
claude mcp get db-mcp
```

Tem que aparecer **`✔ Connected`**.

> No Windows, rode esse comando no **Git Bash** ou no **WSL** (o PowerShell não entende `$(...)` do mesmo jeito).

### Passo 9 · Abrir os painéis (navegador)

| Painel | Endereço | Login |
|---|---|---|
| Portainer | `https://portainer.seudominio.com` | Primeiro o seu e-mail (a Cloudflare manda um código), depois `admin` + a senha do passo 7 |
| PG Back Web | `https://pgbackweb.seudominio.com` | Seu e-mail; no primeiro acesso, crie o usuário do painel |
| Aprovações do db-mcp | Os links chegam pelo Claude | Seu e-mail |

### Passo 10 · Conferir se está tudo certo (Claude Code)

```
/infra:verificar
```

São 18 itens: SSH, firewall, portas, senhas fora de texto, se cada stack em uso é igual ao arquivo, serviços no ar, backup, db-mcp e túnel. **Tudo verde = pronto.** Cada item vermelho vem com o que fazer.

> Logo depois de instalar, o backup aparece verde como "agendado". O primeiro roda às 03:00.

### Passo 11 · Seu primeiro projeto com banco (Claude Code)

```
/infra:novo-projeto
```

Exemplo de conversa: *"crie um banco chamado `loja` com uma tabela de produtos"*. O caminho é sempre este:

1. O Claude pede o banco **em homologação**. Você recebe um **link de aprovação** (vale 30 minutos), abre, entra com seu e-mail e aprova.
2. Aprovado, o banco já fica liberado para o Claude que pediu. Nada para rodar no servidor.
3. O Claude cria as tabelas e testa com dados em homologação.
4. Pronto para produção: o Claude pede a **promoção** (`loja@hml` → `loja@prod`). Você aprova pelo link.
5. Agende o backup diário do banco novo, no servidor: `sudo /opt/infra-kit/src/install/ops/new-project.sh grant loja@prod`. (O acesso do Claude a produção já vem liberado na aprovação.)
6. Para o seu app usar o banco, gere a conexão como Docker secret (sem passar pelo chat): `sudo /opt/infra-kit/src/install/ops/new-project.sh app-secret loja@prod`. Ele imprime um modelo de stack pronto.

### Passo 12 · Subir o seu app (servidor)

O app roda **na mesma VPS**, na rede interna `infra_net`. Modelo (o `app-secret` imprime com os nomes certos):

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

Para abrir na internet: Cloudflare **Zero Trust** → **Networks** → **Tunnels** → `infra-kit` → **Public Hostname** → `app.seudominio.com` apontando para `http://meu-app_web:3000` (troque pela porta do seu app).

> Não compile a imagem do app na VPS: falta memória e o servidor trava. Gere a imagem no GitHub Actions e só baixe no servidor.

---

## 6. Os comandos do plugin

| Comando | Quando usar | O que faz |
|---|---|---|
| `/infra:instalar` | Primeira vez, ou para retomar uma instalação parada | Entrevista, checklist da Cloudflare e as etapas 00 a 70, uma por vez |
| `/infra:verificar` | Depois de qualquer mudança, ou quando algo parecer errado | Roda os 18 testes e explica cada vermelho |
| `/infra:novo-projeto` | Para criar o banco de um app novo | Homologação primeiro, sua aprovação, depois produção e a conexão do app |
| `/infra:trocar-senha` | Para trocar a senha principal do Postgres (ou se suspeitar de vazamento) | Gera senha nova no servidor e atualiza os serviços que usam. O Postgres fica de 10 a 30 segundos fora |

---

## 7. O que o Claude pode e não pode fazer no banco

O db-mcp separa o que é seguro do que é perigoso. O que é perigoso vira um **link de aprovação** para você.

| Ação | Homologação | Produção |
|---|---|---|
| Ler dados (`SELECT`) | Livre (até 500 linhas por consulta) | Livre (até 500 linhas por consulta) |
| Inserir (`INSERT`) | Livre até 500 linhas; acima disso, pede aprovação | Livre até 50 linhas; acima disso, pede aprovação |
| Alterar (`UPDATE`) | Livre com `WHERE` e até 20 linhas | Livre com `WHERE` e só 1 linha |
| `UPDATE` sem `WHERE` | Sempre pede aprovação | Sempre pede aprovação |
| Apagar (`DELETE`) | **Sempre** pede aprovação | **Sempre** pede aprovação |
| Criar tabela, coluna, índice | Livre (e fica registrado como migration) | Pede aprovação |
| Apagar, renomear ou mudar tipo de tabela/coluna (`DROP`, `RENAME`, `ALTER ... TYPE`, `TRUNCATE`) | Pede aprovação | Pede aprovação |
| Criar banco novo | Pede aprovação | Pede aprovação |
| Levar de homologação para produção | — | Pede aprovação |

As ferramentas que o Claude usa: `db_query`, `db_schema`, `db_insert`, `db_update`, `db_delete_request`, `db_ddl`, `db_create_database`, `db_promote_project`, `db_migrations_export`, `db_migrations_promote`, `db_mirror_to_homolog` e `db_pending` (acompanha os pedidos de aprovação).

**O link de aprovação** mostra exatamente o comando e quantas linhas serão afetadas. Só você entra nele (login com o seu e-mail). Vale 30 minutos; expirou, peça de novo ao Claude.

---

## 8. Dia a dia

- **Entrar no servidor:** `ssh -i ~/.ssh/infra-kit -p 2222 deploy@SEU_IP`. Root e senha não entram mais.
- **Saúde:** `/infra:verificar`.
- **Backups:** rodam sozinhos às 03:00, guardam 14 dias, e você vê o histórico no PG Back Web. Uma vez por mês, teste a restauração: `sudo /opt/infra-kit/src/install/ops/restore-test.sh --db <banco> --file <arquivo do backup>`. Backup que nunca foi restaurado não é backup. Detalhes em [docs/backups.md](docs/backups.md).
- **Cópia fora do servidor (opcional, recomendado):** o backup padrão fica no próprio servidor. Para sobreviver à perda da VPS, mande também para o Cloudflare R2: [docs/02-cloudflare.md](docs/02-cloudflare.md), seção 4.
- **Mexer numa stack:** toda porta, variável e senha precisa estar **no arquivo da stack**. Editar pelo Portainer reaplica o arquivo inteiro, e o que não estiver lá some.
- **Atualizar o kit:** leia as notas da versão nova em [Releases](https://github.com/giovani-junior-dev/infra-kit/releases), depois:
  ```
  sudo git -C /opt/infra-kit/src fetch --tags
  sudo git -C /opt/infra-kit/src checkout <nova versão>
  ```
  E rode `/infra:instalar` (só refaz o que mudou) e `/infra:verificar`.

Mais em [docs/04-dia-a-dia.md](docs/04-dia-a-dia.md).

---

## 9. Segurança: o que o kit faz por você

- **Nenhuma senha no chat.** Token da Cloudflare, senhas e o secret do agente passam por arquivo ou terminal seu, nunca pela conversa com o Claude.
- **Nenhuma senha em texto.** Tudo fica em Docker secret. O `/infra:verificar` acusa se achar senha exposta.
- **Nenhuma porta aberta** além do SSH. Postgres, painéis e db-mcp só são acessíveis pelo túnel, com login.
- **SSH blindado:** só chave, sem root, porta trocada, fail2ban, e a trava de 10 minutos contra ficar trancado fora.
- **Banco com limites:** o agente não apaga nem altera em massa sem a sua aprovação.
- **Backup só leitura:** o backup usa um usuário do banco que só lê (`backup_reader`), nunca o administrador.

**Sua parte:**

- Guarde a chave SSH com passphrase e não copie para outros lugares.
- Troque a senha do Portainer no primeiro acesso.
- Se colar um segredo no chat sem querer, considere vazado: troque (`/infra:trocar-senha` para o Postgres, ou gere outro token na Cloudflare).

---

## 10. Perguntas frequentes e problemas

**Posso usar outro sistema que não seja Ubuntu 24.04 ou 26.04?**
Não. A etapa 00 para logo no começo, de propósito.

**Preciso pagar a Cloudflare?**
Não, no uso normal. O plano Free e o Zero Trust Free bastam. O R2 (opcional) não cobra até 10 GB por mês.

**Posso rodar a instalação de novo?**
Pode. Todas as etapas podem ser repetidas sem estragar nada. Se recriar a VPS, o kit reaproveita o que já existe na Cloudflare e gera um secret novo para o agente (refaça o passo 8).

**Fiquei trancado fora do SSH.**
Se foi na etapa 15, espere 10 minutos: o servidor desfaz sozinho. Depois disso, use o console web do seu provedor. Passo a passo em [docs/05-problemas.md](docs/05-problemas.md).

**O link de aprovação expirou.**
Peça de novo ao Claude. Cada link vale 30 minutos.

**O `/infra:verificar` está vermelho no backup.**
Nas primeiras 26 horas ele fica verde só com o backup agendado. Depois, precisa de um backup com sucesso recente. Abra o PG Back Web → **Backups** → **Run backup now** e veja o erro em **Executions**.

**O servidor travou ao compilar meu app.**
Falta de memória. Compile a imagem fora (GitHub Actions) e só baixe no servidor.

**Uma etapa falhou.**
O Claude mostra o erro e explica. Corrija e rode `/infra:instalar` de novo: ele retoma daquela etapa.

Lista completa, com os problemas que já aconteceram em servidor de verdade: [docs/05-problemas.md](docs/05-problemas.md).

---

## 11. Guias detalhados e estrutura do repositório

**Guias**

| Guia | Conteúdo |
|---|---|
| [01 · Antes de começar](docs/01-antes-de-comecar.md) | Requisitos, custos e termos |
| [02 · Cloudflare](docs/02-cloudflare.md) | Domínio, Zero Trust, token e R2, com detalhes |
| [03 · Instalação](docs/03-instalacao.md) | O que cada etapa faz |
| [04 · Dia a dia](docs/04-dia-a-dia.md) | Projetos, apps, senhas e atualização |
| [05 · Problemas](docs/05-problemas.md) | Erros reais e como sair |
| [Backups](docs/backups.md) | Como o backup funciona e como testar a restauração |

**Estrutura**

```
install/        etapas da instalação (00 a 70) e a verificação (90)
install/ops/    comandos de operação: novo projeto, troca de senha, restauração, mostrar senha
stacks/         arquivos das stacks (Portainer, Postgres, PG Back Web, db-mcp, túnel)
db-mcp/         código do servidor MCP de banco
plugin/         plugin "infra" do Claude Code (os 4 comandos)
docs/           guias
tests/          testes automáticos dos scripts
```

## Licença

MIT
