# 02 · Cloudflare

Tudo o que o kit expõe (Portainer, PG Back Web, db-mcp) passa por um túnel da
Cloudflare. Nenhuma porta fica aberta no servidor além do SSH. Você faz 4 coisas
no painel; o resto o script `install/30-cloudflare.sh` cria sozinho.

## 1. Domínio na Cloudflare

Seu domínio precisa usar os nameservers da Cloudflare (plano Free serve).
Painel → **Add a domain** → siga até o status ficar **Active**.

## 2. Ativar o Zero Trust (plano Free)

Painel → **Zero Trust** → escolha um nome de time (vira `seutime.cloudflareaccess.com`)
→ plano **Free**.

> O cadastro pede cartão de crédito. Pode colocar: o plano **Free** (até 50
> usuários) não cobra nada. Não desista nessa tela; só confira que o plano
> escolhido é o Free antes de confirmar.

Não precisa anotar o Account ID: a etapa 30 descobre sozinha pela zona do seu
domínio e grava no `kit.env`.

## 3. API token com escopo mínimo

Painel → ícone do perfil → **My Profile** → **API Tokens** → **Create Token** →
**Create Custom Token**. Adicione estas permissões:

| Tipo | Permissão | Nível |
|---|---|---|
| Account | Cloudflare Tunnel | Edit |
| Account | Access: Apps and Policies | Edit |
| Account | Access: Service Tokens | Edit |
| Account | Access: Organizations, Identity Providers, and Groups | Read |
| Zone | DNS | Edit |
| Zone | Zone | Read |

- **Account Resources**: só a sua conta.
- **Zone Resources**: *Specific zone* → seu domínio.
- Os dois "Read" servem para o script achar a zona e o domínio do time.

O token é mostrado uma vez. Você cola na hora em que o `/infra:instalar` pedir;
ele vai pelo stdin e não é gravado no servidor. Terminada a instalação, pode
revogar o token na mesma tela (**Roll** ou **Delete**).

O script cria:

- túnel `infra-kit` (gerenciado pelo painel) e o secret `cf_tunnel_token`;
- DNS `portainer.`, `pgbackweb.` e `db-mcp.` apontando para o túnel;
- apps do Access: portainer e pgbackweb (login com o seu e-mail), db-mcp (só o
  service token `agente-1`) e `db-mcp/approve` (login com o seu e-mail).

No fim ele mostra **uma única vez** o Client Id e o Client Secret do
`agente-1`. Guarde num gerenciador de senhas. Perdeu? Apague o service token
em Zero Trust → Access → Service Auth e rode a etapa 30 de novo.

## 4. Bucket R2 para os backups

Backup no próprio servidor não protege contra perder o servidor. Use o R2:

1. Painel → **R2 Object Storage** → **Create bucket** → nome `infra-kit-backups`.
   (O R2 também pede cartão; até 10 GB/mês não cobra.)
2. **R2** → **Manage R2 API Tokens** → **Create API token** → permissão
   **Object Read & Write**, só esse bucket. Guarde o Access Key ID e o Secret.
3. Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

Opcional: o backup local diário já vem agendado pela instalação. Para ter
cópia fora do servidor, no painel do PG Back Web (`https://pgbackweb.seudominio.com`):

- **Destination**: S3, endpoint acima, região `auto`, bucket e as duas chaves;
- **Backup**: troque o destino do backup já cadastrado para esse R2.

Para o `install/ops/restore-test.sh` baixar o último dump, adicione no
`kit.env` `KIT_R2_ENDPOINT` e `KIT_R2_BUCKET` (não são segredo) e passe as
chaves só no ambiente da execução:

```bash
sudo R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... install/ops/restore-test.sh --db meu_banco
```

## Aviso sobre o Portainer

Editar uma stack pelo Portainer reaplica o arquivo inteiro. Porta ou secret que
não estiver no arquivo some no update. Por isso todo arquivo em `stacks/`
declara tudo o que o serviço usa.
