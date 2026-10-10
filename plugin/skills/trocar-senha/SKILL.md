---
name: trocar-senha
description: Troca a senha do superuser postgres do Postgres de produção ou de homologação do infra-kit com install/ops/rotate-superuser.sh, atualizando todos os consumidores registrados. Use quando o aluno pedir para trocar, rotacionar ou resetar a senha do Postgres, ou depois de suspeitar de vazamento.
argument-hint: "<prod|homolog>"
disable-model-invocation: true
---

# /infra:trocar-senha

A senha nova nasce no servidor e nunca aparece na conversa.

## 1. Qual banco

`prod` ou `homolog`. Confirme com o aluno; em `prod` lembre que é o banco de verdade.

Conexão: `ssh -i <chave> -p <porta> <admin>@<ip>` (chame de `$SSH`).

## 2. Mostrar o plano (não muda nada)

```
$SSH 'sudo bash /opt/infra-kit/src/install/ops/rotate-superuser.sh <env> --dry-run'
```

Explique o plano ao aluno:

- cria um secret novo versionado (`pg_<env>_superuser_pw_v2`, `_v3`...), porque secret do Docker não muda de valor;
- troca a senha no banco (`ALTER ROLE` pelo socket local, sem rede);
- **o Postgres reinicia e fica 10 a 30 segundos fora do ar.** Em `prod`, escolha um horário com pouco uso;
- cada serviço da lista de consumidores reinicia com o secret novo;
- consumidores **MANUAIS** (por exemplo o painel do PG Back Web) guardam a senha fora do Docker: o aluno atualiza à mão depois.

## 3. Executar só com OK explícito

Pergunte: "Pode reiniciar o Postgres de `<env>` agora?". Com sim:

```
$SSH 'sudo bash /opt/infra-kit/src/install/ops/rotate-superuser.sh <env> --sim'
```

Mostre cada `[ok]` e `[aviso]`. No fim:

- **MANUAL**: o script mostra o comando para ler a senha nova (`show-secret.sh <secret> --mostrar`). O aluno roda no terminal **dele, fora do Claude Code**, e cola direto no painel. Não rode você: o valor apareceria na conversa.
- O secret antigo fica guardado para voltar atrás. Depois de tudo conferido, ofereça `sudo docker secret rm <antigo>` (pergunte antes).
- Rode `/infra:verificar` para fechar.

## 4. Se falhar

- `ALTER ROLE falhou`: nada mudou; o secret novo foi apagado. Veja se o `pg-<env>_postgres` está rodando (`sudo docker service ps pg-<env>_postgres`).
- Postgres não voltou em 120 s: `sudo docker service ps pg-<env>_postgres --no-trunc` mostra o motivo. A senha nova já vale no banco; rodar de novo com `--sim` gera outra versão e reaplica.
- Consumidor não convergiu: `sudo docker service ps <stack>_<serviço> --no-trunc` e `sudo docker service logs <stack>_<serviço> --tail 50`. Ele monta o secret novo no mesmo caminho; erro de senha ali indica que o app guarda a senha em outro lugar (vira consumidor manual).
