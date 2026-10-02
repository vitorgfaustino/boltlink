# Click Policy (3.1.0)

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

## Split Test A/B (release 3.0.0, migration 0004)

> Escopo: release `3.0.0` (migration `0004`, introduzida originalmente na Fase 2 e publicada desde a `3.0.0`). A tag anterior `v2.2.1` não tem Split Test A/B.

Quando o link tem Split Test A/B ativo:

- cada requisição humana elegível sorteia a variante de forma independente e stateless
- Control A é sempre `target_url`; Variant B é `ab_target_url`
- o redirect é sempre `302` com `Cache-Control: no-store`; A/B nunca emite redirect permanente cacheável e a combinação A/B + `301` é rejeitada pela API
- o clique conta uma única escrita agregada: `clicks_total = clicks_total + 1` e `ab_clicks_a` ou `ab_clicks_b` incrementados juntos
- a escrita assíncrona carrega a geração do experimento: um clique originado antes de mudança de configuração ainda conta em `clicks_total`, mas não contamina os contadores da nova geração
- bots, crawlers, previews sociais, prefetch e prerender ficam sempre no Control A e não incrementam `clicks_total` nem contadores de variante
- o filtro continua sendo exclusivamente métrico: nenhum bot é bloqueado por ser bot

## Smart Routing (release 3.0.0, migration 0005)

> Escopo: release `3.0.0` (migration `0005`, introduzida originalmente na Fase 3 e publicada desde a `3.0.0`). A tag anterior `v2.2.1` não processa Smart Routing.

Quando o link tem Smart Routing configurado (`smart_routing_rules` não nulo):

- a seleção de destino usa país (`request.cf.country`) e dispositivo (`User-Agent`), com first-match-wins e fallback em `target_url`
- requests humanas contáveis incrementam **somente** `clicks_total = clicks_total + 1`; não existe contador por regra, país ou dispositivo
- bots, crawlers, previews sociais, prefetch e prerender recebem sempre `target_url` e não incrementam nenhuma métrica
- o redirect é sempre `302` com `Cache-Control: no-store`; Smart Routing nunca emite redirect permanente cacheável
- estado híbrido/corrompido (`ab_enabled = 1` + `smart_routing_rules` não nulo, inclusive com regras inválidas) falha seguro: `target_url`, `302`/`no-store`, zero RNG, zero contador A/B, somente `clicks_total` para humano contável
- a escrita assíncrona usa o mesmo fence de `metric_epoch`: um clique originado antes de um `reset-clicks` não reaparece depois do corte
- o filtro continua sendo exclusivamente métrico: nenhum bot é bloqueado por ser bot
- privacidade: nenhum país, dispositivo derivado ou regra selecionada é persistido; não existe cookie de roteamento, visitor ID ou fingerprint, e país/`User-Agent`/dispositivo são usados apenas em memória para escolher o destino

## Destino de expiração e redirect da raiz (release 3.0.0)

> Escopo: release `3.0.0` (migration `0006` e `ROOT_REDIRECT_URL`, introduzidos originalmente na Fase 4 e publicados desde a `3.0.0`). A tag anterior `v2.2.1` não contém estes recursos.

- request de link expirado **não conta clique**, com ou sem destino configurado: o lifecycle é decidido antes da classificação bot/humano, então a resposta é `302` (destino válido) ou `410` (sem destino) para todos os clientes, sem exceção para humanos
- o redirect da raiz (`ROOT_REDIRECT_URL`) não conta clique e não consulta D1
- nenhuma métrica individual nova existe: nem por request expirado, nem por redirect de raiz

## Zerar estatísticas

O admin pode zerar a contagem agregada de um link ativo.

Essa ação:

- define `links.clicks_total = 0`
- funciona como corte explícito: um clique originado antes do reset não reaparece em nenhum contador depois do reset
- não altera slug, destino, tags, grupo, senha, agenda ou expiração
- não apaga eventos individuais, porque eventos individuais não existem mais no modelo atual da linha `2.0.x`

### Split Test A/B no reset (release 3.0.0)

> Escopo: release `3.0.0` (migration `0004`, origem Fase 2). A tag anterior `v2.2.1` não tem Split Test A/B.

- em link com Split Test A/B, a ação também define `ab_clicks_a = 0` e `ab_clicks_b = 0`, avança geração/epóque e renova `ab_started_at`

## O que não existe mais

- tabela `stats`
- país por clique
- contador por regra de routing
- hash de IP
- último clique
- purge de analytics

## Privacidade

- nenhum `Referer` é persistido
- nenhum `User-Agent` é persistido
- nenhum IP é persistido
- a contagem é apenas agregada no registro do link

### Split Test A/B e privacidade (release 3.0.0)

> Escopo: release `3.0.0` (migration `0004`, origem Fase 2). A tag anterior `v2.2.1` não tem Split Test A/B.

- a escolha da variante é stateless: não existe cookie de experimento, visitor ID, fingerprint ou registro de qual visitante recebeu A ou B

---

Release atual publicada: 3.1.0 · Tag: v3.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
