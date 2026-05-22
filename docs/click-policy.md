# Click Policy (v2.0.1)

## O que conta

BoltLink incrementa `clicks_total` apenas quando `isCountableClick(request)` retorna `true`.

Regras principais:

- slug público precisa passar no padrão do produto antes de consultar D1
- rajadas públicas podem receber `429` por rate limit em memória antes da leitura D1
- método `GET`
- bloqueio de prefetch e prerender por `Purpose`, `Sec-Purpose` e `X-Purpose`
- aceitação explícita de `Sec-Fetch-Mode: navigate`
- rejeição de `User-Agent` vazio
- rejeição de bots, crawlers, previews sociais, monitores e clientes automatizados

## Zerar estatísticas

O admin pode zerar a contagem agregada de um link ativo.

Essa ação:

- define `links.clicks_total = 0`
- não altera slug, destino, tags, grupo, senha, agenda ou expiração
- não apaga eventos individuais, porque eventos individuais não existem mais no modelo atual da linha `2.0.x`

## O que não existe mais

- tabela `stats`
- país por clique
- hash de IP
- último clique
- purge de analytics

## Privacidade

- nenhum `Referer` é persistido
- nenhum `User-Agent` é persistido
- nenhum IP é persistido
- a contagem é apenas agregada no registro do link

---

Versão 2.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
