# Click Policy (v2.2.1)

## O que conta

BoltLink incrementa `clicks_total` apenas quando `isCountableClick(request)` retorna `true`.

Regras principais:

- slug público precisa passar no padrão do produto antes de consultar D1
- rajadas públicas podem receber `429` por rate limit em memória antes da leitura D1
- método `GET`
- bloqueio de prefetch e prerender por `Purpose`, `Sec-Purpose` e `X-Purpose`
- rejeição de `User-Agent` vazio
- rejeição de bots, crawlers, previews sociais, monitores e clientes automatizados reconhecidos, antes de aceitar `Sec-Fetch-Mode: navigate`
- `Sec-Fetch-Mode: navigate` com User-Agent não reconhecido como automação conta; a ausência desse header preserva a compatibilidade com navegadores legítimos

O filtro decide somente a métrica. Bots, previews sociais, crawlers de busca, prefetches e automação reconhecida continuam recebendo o redirect quando o link está ativo; eles apenas não incrementam `clicks_total`.

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

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
