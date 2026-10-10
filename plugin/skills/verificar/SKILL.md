---
name: verificar
description: Confere a saúde do servidor do infra-kit rodando install/90-verify.sh por SSH e resume em verde e vermelho, com o que fazer em cada vermelho. Use quando o aluno pedir para verificar, checar, conferir o servidor, ou depois de instalar, trocar senha ou mexer numa stack.
---

# /infra:verificar

Roda a checagem completa no servidor e traduz o resultado. Só lê: não muda nada.

## 1. Conexão

Pergunte (ou reaproveite da conversa) IP, porta SSH, usuário admin e chave. Comando:

```
ssh -i <chave> -p <porta> <admin>@<ip> 'sudo bash /opt/infra-kit/src/install/90-verify.sh'
```

## 2. Contrato da saída

O script imprime **um único objeto JSON** no stdout:

```json
{"ok": true, "checks": [{"id": "ssh", "ok": true, "detail": "texto em PT-BR", "fix": "o que fazer, em PT-BR"}]}
```

Código de saída `0` = tudo verde; `1` = pelo menos um vermelho. Mensagens de log podem vir no stderr: ignore para o resumo.

Se o stdout não for JSON válido (script ausente, versão antiga, erro antes da checagem), diga isso ao aluno, mostre as últimas linhas da saída e sugira atualizar o clone em `/opt/infra-kit/src` para a última release. Não invente resultado.

## 3. Resumo

1. Primeira linha: **tudo verde** ou **N problemas**.
2. Vermelhos primeiro, um por linha: `id` — `detail` — **o que fazer:** `fix`.
3. Verdes numa linha só, por `id`.
4. Se um `fix` manda rodar comando no servidor, mostre o comando, explique o efeito e **pergunte antes** de rodar. Comando que reinicia serviço ou troca senha só com OK explícito.

Use a explicação de `docs/05-problemas.md` quando o vermelho bater com um caso de lá (porta sumiu depois de update no Portainer, senha em texto na env, backup antigo).

Nunca peça senha nem token para "consertar": nenhum `fix` precisa disso no chat.
