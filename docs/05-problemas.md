# 05 · Problemas e como sair

Problemas que já aconteceram com a gente, em servidor de verdade. Antes de qualquer coisa: `/infra:verificar`.

## Fiquei trancado fora do SSH

**O que acontece:** depois de mudar porta ou desligar senha, a conexão nova não entra e a antiga caiu.

**Como o kit evita:** a etapa 15 libera a porta nova no firewall antes de mudar o SSH, testa uma conexão nova e só fecha a porta 22 com `--confirm`. Sem confirmação em 10 minutos, desfaz sozinha.

**Se acontecer:**

1. Espere 10 minutos e tente de novo na porta 22 com o usuário antigo: o rollback automático pode ter rodado.
2. Ainda fora: use o **console web** do provedor da VPS (Hetzner, DigitalOcean etc. têm um terminal no painel). Lá:
   `sudo bash /opt/infra-kit/src/install/15-ssh-hardening.sh --rollback`
3. Causas comuns: chave errada no `-i`, porta errada, usuário errado (depois da etapa 15 só o usuário admin entra, nunca root).

## A porta (ou a senha) sumiu depois de atualizar a stack no Portainer

**O que acontece:** alguém publicou uma porta ou trocou um secret à mão (`docker service update`). Na próxima edição da stack pelo Portainer, ele reaplicou o **arquivo** e tudo o que estava só no serviço sumiu. Com a gente, a produção ficou 2,5 minutos fora.

**Regra:** porta, variável e secret moram no arquivo da stack. Nunca só no serviço.

**Como achar:** `/infra:verificar` compara a stack em uso com o arquivo e aponta a diferença.

## O link de aprovação expirou

**O que acontece:** todo pedido do db-mcp (criar banco, DELETE, DDL em produção, promote) gera um link que vale **30 minutos**. Depois disso o pedido fica `expired` e o link não faz nada.

**Como sair:** peça ao Claude para fazer o pedido de novo. Não tem como reaproveitar o antigo, de propósito.

## O servidor travou ao compilar (OOM)

**O que acontece:** `npm run build` ou `docker build` dentro da VPS come toda a RAM, o Linux mata processos (às vezes o Postgres) e o servidor fica lento ou para.

**Como o kit evita:** a etapa 10 cria swap, e o db-mcp vem como imagem pronta (você não compila).

**Como sair:** espere o processo morrer ou reinicie a VPS pelo painel. Para o seu app, gere a imagem no GitHub Actions e só baixe no servidor. Se precisar compilar lá, pare antes o que não é essencial.

## A porta do container ficou aberta mesmo com o firewall (UFW)

**O que acontece:** o Docker escreve as próprias regras de firewall e passa por cima do UFW. Um `ports: - 5432:5432` numa stack deixa o Postgres aberto para a internet, mesmo com o UFW dizendo que está tudo fechado.

**Como o kit evita:** as stacks não publicam porta, e a etapa 20 instala um bloqueio na chain `DOCKER-USER` que derruba conexão de fora para containers. `/infra:verificar` confere esse bloqueio e as portas publicadas.

**Se publicou porta:** tire o `ports:` do arquivo e rode `docker stack deploy` de novo. Para acessar o banco do seu computador, use túnel SSH, nunca porta aberta.

## Senha apareceu em texto na configuração

**O que acontece:** uma senha em `environment:` aparece em `docker service inspect`, nos logs do Portainer e em qualquer backup da configuração.

**Regra:** senha só em Docker secret, lida por arquivo (`*_FILE`). `/infra:verificar` acusa env com senha.

**Como sair:** considere a senha vazada. `/infra:trocar-senha` (Postgres) ou gere um secret novo para o serviço e tire a senha do arquivo.

## O /infra:verificar acusa "nenhum backup encontrado"

Nas primeiras 26 horas depois da instalação o item fica verde só com o backup
agendado (o 1º roda às 03:00). Depois disso, falta um backup com sucesso recente:
rode de novo a etapa 60 (recadastra o que faltar) e, em
`https://pgbackweb.<seu-dominio>` → **Backups**, clique em **Run backup now** e
veja o erro em **Executions**.

## Uma etapa falhou

Leia a linha `[falha]`. O código de saída diz o tipo:

| Código | Significa | O que fazer |
|---|---|---|
| 2 | configuração | confira `/opt/infra-kit/kit.env` |
| 3 | pré-requisito | rode a etapa anterior ou corrija o sistema |
| 1 | erro na execução | leia a mensagem; rode a etapa de novo (é seguro) |

Abrindo issue no GitHub: anexe a saída do `/infra:verificar` e a linha `[falha]`. **Nunca** cole senha, token ou o `kit.env` inteiro.
