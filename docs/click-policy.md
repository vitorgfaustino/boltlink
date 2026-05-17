# Click Policy (v2.0.0)

## O que conta

BoltLink incrementa `clicks_total` apenas quando `isCountableClick(request)` retorna `true`.

Regras principais:

- método `GET`
- bloqueio de prefetch e prerender por `Purpose`, `Sec-Purpose` e `X-Purpose`
- aceitação explícita de `Sec-Fetch-Mode: navigate`
- rejeição de `User-Agent` vazio
- rejeição de bots, crawlers, previews sociais, monitores e clientes automatizados

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
