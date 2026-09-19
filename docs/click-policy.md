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

## Split Test A/B

Quando o link tem Split Test A/B ativo:

- cada requisição humana elegível sorteia a variante de forma independente e stateless
- Control A é sempre `target_url`; Variant B é `ab_target_url`
- o redirect é sempre `302` com `Cache-Control: no-store`; A/B nunca emite redirect permanente cacheável e a combinação A/B + `301` é rejeitada pela API
- o clique conta uma única escrita agregada: `clicks_total = clicks_total + 1` e `ab_clicks_a` ou `ab_clicks_b` incrementados juntos
- a escrita assíncrona carrega a geração do experimento: um clique originado antes de mudança de configuração ainda conta em `clicks_total`, mas não contamina os contadores da nova geração
- bots, crawlers, previews sociais, prefetch e prerender ficam sempre no Control A e não incrementam `clicks_total` nem contadores de variante
- o filtro continua sendo exclusivamente métrico: nenhum bot é bloqueado por ser bot

## Zerar estatísticas

O admin pode zerar a contagem agregada de um link ativo.

Essa ação:

- define `links.clicks_total = 0`
- em link com Split Test A/B, também define `ab_clicks_a = 0` e `ab_clicks_b = 0`, avança geração/epóque e renova `ab_started_at`
- funciona como corte explícito: um clique originado antes do reset não reaparece em nenhum contador depois do reset
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
- o Split Test A/B é stateless: não existe cookie de experimento, visitor ID, fingerprint ou registro de qual visitante recebeu A ou B
- a contagem é apenas agregada no registro do link

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
