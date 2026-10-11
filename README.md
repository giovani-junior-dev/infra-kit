# infra-kit

Sua própria infraestrutura numa VPS, sem depender de Supabase ou de outro serviço de terceiros:

- Docker Swarm + Portainer
- Postgres de **produção** e de **homologação** (`pg-homolog`)
- Backups com PG Back Web, guardados no Cloudflare R2
- **db-mcp**: seus agentes de IA (Claude Code) mexem no banco com limites, e o que é perigoso espera a sua aprovação

Nenhuma porta aberta além do SSH. Painéis e MCP ficam atrás do Cloudflare Tunnel + Access.

> Em construção. Plano completo em [`specs/infra-kit.html`](specs/infra-kit.html).

## Você precisa de

- Uma VPS com **Ubuntu 24.04 ou 26.04** (mínimo 2 vCPU, 4 GB RAM, 40 GB disco)
- Um **domínio na Cloudflare** (plano Free serve; o Zero Trust pede cartão no cadastro, mas o plano Free não cobra)
- **Claude Code** instalado no seu computador

## Começar

No Claude Code:

```
/plugin install infra --marketplace giovani-junior-dev/infra-kit
/infra:instalar
```

Em versões antigas do Claude Code: `/plugin marketplace add giovani-junior-dev/infra-kit` e depois `/plugin install infra@infra-kit`.

Guia: [antes de começar](docs/01-antes-de-comecar.md) · [Cloudflare](docs/02-cloudflare.md) · [instalação](docs/03-instalacao.md) · [dia a dia](docs/04-dia-a-dia.md) · [problemas](docs/05-problemas.md)

## Licença

MIT
