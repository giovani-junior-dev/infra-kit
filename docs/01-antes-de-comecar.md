# 01 · Antes de começar

O infra-kit monta, numa VPS sua, o que muita gente paga para o Supabase fazer: Postgres de produção, Postgres de homologação (um banco de teste, separado), backups e um MCP de banco para o seu Claude Code mexer no banco com limites.

Você conversa com o Claude Code; ele roda os scripts no servidor e explica cada passo.

## O que você precisa

| Item | Detalhe | Custo |
|---|---|---|
| VPS | **Ubuntu 24.04 ou 26.04**, mínimo 2 vCPU, 4 GB de RAM, 40 GB de disco | mensalidade do provedor que você escolher |
| Domínio | qualquer um, com DNS na Cloudflare | anuidade do registro |
| Cloudflare | plano Free + Zero Trust Free + R2 | R$ 0 no uso normal (veja abaixo) |
| Claude Code | instalado no seu computador | sua assinatura atual |

Só Ubuntu 24.04 e 26.04 (LTS) são suportados. Outro sistema: o script para logo no começo, de propósito.

**Sobre o cartão na Cloudflare:** o cadastro do Zero Trust e do R2 pede cartão. O plano Free do Zero Trust (até 50 usuários) não cobra, e o R2 não cobra até 10 GB por mês. Confira que escolheu **Free** antes de confirmar.

## Termos que vão aparecer

- **SSH**: o jeito de acessar o terminal do servidor pela internet. Usamos só **chave** (um arquivo no seu computador), nunca senha.
- **Chave SSH**: um par de arquivos. A parte **pública** (`.pub`) vai para o servidor; a **privada** fica só com você. Quem tem a privada entra no servidor.
- **Docker / Swarm / stack**: os programas rodam em containers. Uma *stack* é um arquivo que descreve um ou mais containers e como eles se ligam.
- **Docker secret**: cofre do Docker para senhas. A senha não fica em arquivo de configuração nem aparece em `docker inspect`.
- **Cloudflare Tunnel**: um "cano" que sai do seu servidor até a Cloudflare. Os painéis ficam acessíveis em `https://portainer.seudominio.com` sem abrir porta nenhuma no servidor.
- **Cloudflare Access**: a porta de entrada desses painéis. Só entra quem faz login com o seu e-mail (ou o agente, com um token próprio).
- **Homologação (hml)**: banco de testes. Tudo é feito lá primeiro; produção (prod) só recebe o que foi aprovado.
- **db-mcp**: o servidor MCP que o Claude Code usa para mexer no banco. Leitura e mudanças pequenas passam; o que é perigoso vira um link que **você** aprova.

## O que fica aberto na internet

Só a porta SSH (você escolhe, padrão 2222). Postgres, Portainer, PG Back Web e db-mcp não têm porta pública.

## Tempo

Cerca de 40 minutos, contando os cliques na Cloudflare. Pode parar e continuar depois: o `/infra:instalar` retoma da etapa onde parou.

## Próximo passo

[02 · Cloudflare](02-cloudflare.md): deixe domínio, Zero Trust, token e bucket prontos. Depois, [03 · Instalação](03-instalacao.md).
