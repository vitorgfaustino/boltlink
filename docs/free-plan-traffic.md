# Trafego e Plano Gratuito Cloudflare

Este guia documenta medidas para reduzir desperdicio de requisicoes e uso de D1 em instancias BoltLink operadas no plano gratuito ou com foco em baixo custo.

## Limites que importam

Os valores abaixo refletem a documentação oficial consultada em setembro de 2026; a Cloudflare pode alterá-los. Eles não são SLA do BoltLink.

- Workers Free: 100.000 requests por dia ao Worker.
- D1 Free: 5 milhões de rows read/dia e 100.000 rows written/dia.
- Requisições de Static Assets são gratuitas e ilimitadas quando servidas como asset; requisições que invocam o script do Worker contam no uso de Workers.
- D1 Free também tem limites próprios de storage e bancos, que devem ser consultados na documentação vigente antes de planejar uma operação maior.

Fontes oficiais:

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Static Assets billing: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/

## Capacidade operacional conservadora

BoltLink é projetado para dezenas de milhares de acessos públicos por dia no Cloudflare Free. Um alvo operacional conservador é **aproximadamente 75.000 requisições públicas/dia** sob os limites atuais, preservando margem abaixo dos 100.000 requests/dia para previews sociais, crawlers, admin/API e outros overheads.

Isso não significa “75.000 cliques garantidos por dia”. Requisições públicas não são cliques contabilizados:

```text
70.000 acessos humanos
+ 10.000 previews/crawlers
+ admin/API
= invocações totais do Worker
```

Um crawler pode consumir uma invocação mesmo sem aumentar `clicks_total`. Previews sociais e bots conhecidos devem continuar recebendo redirect para que consigam buscar os metadados Open Graph do destino.

## Custo do caminho crítico

Um redirect público normal deve permanecer aproximadamente:

```text
1 invocação do Worker
+ 1 lookup principal no D1
+ no máximo 1 escrita agregada para clicks_total
```

A escrita é feita somente para uma requisição elegível e não atrasa a resposta de redirect. Links protegidos podem executar a verificação de sessão/gate, mas não adicionam consultas externas ou uma tabela de eventos. A contagem agregada não cria clickstream.

## Split Test A/B no caminho crítico (release 3.0.0)

> Escopo: release `3.0.0` (migration `0004`, introduzida originalmente na Fase 2 e publicada desde a `3.0.0`). A tag anterior `v2.2.1` não tem Split Test A/B.

O Split Test A/B é stateless e não aumenta o custo normal:

```text
link normal contável:
1 invocação do Worker
+ 1 lookup principal no D1
+ 1 linha agregada escrita

link A/B humano:
1 invocação do Worker
+ 1 lookup principal no D1
+ 1 linha agregada escrita (clicks_total + contador da variante na mesma row)

crawler/preview em link A/B:
1 invocação do Worker
+ 1 lookup principal no D1
+ 0 escrita de métrica
```

Não existe tabela separada de variantes, lookup extra ou segunda escrita por clique. A decisão A/B usa um sorteio em memória e retorna sempre o Control A quando o filtro de métricas reconhece automação, sem bloquear o redirect.

## Smart Routing no caminho crítico (release 3.0.0)

> Escopo: release `3.0.0` (migration `0005`, introduzida originalmente na Fase 3 e publicada desde a `3.0.0`). A tag anterior `v2.2.1` não processa Smart Routing.

O Smart Routing é stateless e não adiciona lookup extra:

```text
link Smart Routing humano:
1 invocação do Worker
+ 1 lookup principal no D1
+ 1 linha agregada escrita (somente clicks_total)

crawler/preview em link Smart Routing:
1 invocação do Worker
+ 1 lookup principal no D1
+ 0 escrita de métrica
```

As regras vivem em uma coluna JSON na própria linha do link, então não há tabela secundária, JOIN auxiliar, SELECT adicional nem API externa de geolocalização. O país vem do metadado da Cloudflare e o dispositivo é derivado do `User-Agent` em memória. O pior caso do teste de capability é uma sondagem de schema por isolate, não por clique.

## Destino de expiração e redirect da raiz no caminho crítico (release 3.0.0)

> Escopo: release `3.0.0` (migration `0006` e `ROOT_REDIRECT_URL`, introduzidos originalmente na Fase 4 e publicados desde a `3.0.0`). A tag anterior `v2.2.1` não contém estes recursos.

O destino de expiração não adiciona lookup nem escrita:

```text
link expirado (com ou sem destino):
1 invocação do Worker
+ 1 lookup principal no D1
+ 0 escrita de métrica

redirect da raiz (ROOT_REDIRECT_URL válida):
1 invocação do Worker
+ 0 leitura de D1
```

O destino é uma coluna da própria linha lida pelo SELECT existente, decidido no lifecycle antes de qualquer classificação ou métrica. O redirect da raiz decide antes de qualquer acesso a D1. Nenhuma quota ou preço novo é introduzido por esta fase; os limites listados no topo do documento continuam os mesmos.

## Portabilidade e QR Code fora do caminho crítico (release 3.0.0)

> Escopo: release `3.0.0` (introduzidos originalmente na Fase 5 e publicados desde a `3.0.0`).

O export é uma leitura administrativa sob demanda e **não** toca o caminho crítico:

```text
redirect público normal:
0 mudança (mesma invocação, 1 lookup, 0 consulta a link_groups)

GET /api/export (admin, quando solicitado):
1 invocação do Worker
+ 1 leitura de contagem
+ 1 leitura de grupos + 1 leitura de links
+ 0 escrita
```

É esperado que uma exportação use mais leituras e mais CPU do que um redirect, e isso é aceitável porque a operação é rara, exige autenticação administrativa e é limitada pelo próprio formato (50 grupos, 100 links e 256 KiB). O export não adiciona KV, Durable Objects, cron, API externa nem processamento em background, e não introduz nenhuma quota ou preço novo: os limites do topo deste documento continuam os mesmos. O rate limit administrativo de `/api/*` já existente é o mesmo para esta rota.

O import (`POST /api/import/preview` e `POST /api/import/apply`) e o QR Code do painel (`GET/POST /api/links/:slug/qrcode`) são administrativos como o export: executam dentro do boundary administrativo de `/api/*`, satisfeito por uma sessão válida do Cloudflare Access do painel ou por uma chave de API válida (`Authorization: Bearer`, quando `API_KEY` está configurada na instalação), e limitados pelo mesmo rate limit de `/api/*`. O preview é somente leitura, o apply é um único lote transacional (sem retry automático nem processamento em background) e o QR é gerado sob demanda — SVG no Worker, PNG rasterizado no navegador — sem persistir imagem e sem contar clique. Nenhum dos três adiciona KV, R2, Queue, cron ou API externa, e nenhum deles toca o redirect público, que continua sendo o produto principal.

## O que o código faz

BoltLink aplica duas protecoes gratuitas dentro da aplicacao:

- rejeita probes publicos com slug invalido antes de consultar D1, por exemplo `/.env`, `/wp-login.php` e caminhos com caracteres fora do padrao de slug
- aplica rate limit em memoria para leituras publicas de redirect antes do D1, reduzindo rajadas de um mesmo IP no banco

Essas protecoes economizam D1, mas nao eliminam a requisicao do Worker. Se a requisicao chegou ao Worker, ela ainda conta como requisicao do Worker.

## Opcoes gratuitas no painel Cloudflare

### Bot Fight Mode

Bot Fight Mode e um recurso gratuito da Cloudflare para desafiar trafego identificado como bot.

Fonte oficial: https://developers.cloudflare.com/bots/get-started/free/

Como habilitar:

1. Acesse o dashboard da Cloudflare.
2. Selecione a conta e o dominio.
3. Abra `Security > Bots` ou `Security > Settings`.
4. Ative `Bot Fight Mode`.
5. Monitore `Security > Events`.

Observacao: Bot Fight Mode atua no dominio inteiro e nao permite ajuste por endpoint. Se afetar trafego legitimo, desative e revise a origem do problema.

### workers.dev e Preview URLs

Para instancias reais em dominio proprio, reduza superficies publicas extras:

1. Use um dominio proprio para o Worker.
2. No `wrangler.local.jsonc` do ambiente real, defina `workers_dev: false`.
3. Defina `preview_urls: false` para evitar URL publica de preview.
4. Faca deploy novamente pelo fluxo usado pela instancia.

Fonte oficial: https://developers.cloudflare.com/workers/wrangler/configuration/

O `wrangler.jsonc` publico pode continuar amigavel para Deploy Button e testes iniciais. A configuracao privada de producao deve ser ajustada pelo operador da instancia.

## WAF e Rate Limiting no plano gratuito

O Cloudflare Free **já inclui** capacidade limitada de Rate Limiting/WAF. O escopo exato dessa capacidade depende da oferta vigente do provedor e muda com o tempo: por exemplo, a quantidade de regras e quais campos/características de contagem estão disponíveis variam por plano. Recursos mais avançados ou de maior capacidade (regras mais granulares, características de contagem adicionais e Bot Management avançado) podem exigir plano ou produto pago.

Como esses limites mudam, o BoltLink **não fixa números** nem promete uma cota específica de WAF ou Rate Limiting: consulte a documentação oficial vigente do provedor antes de planejar.

A baseline do BoltLink **não exige** WAF nem Rate Limiting configurados no painel Cloudflare. Se o operador tiver esses recursos, pode usá-los como camada adicional fora da aplicação.

Fontes oficiais:

- WAF Rate limiting rules (disponibilidade e limites por plano): https://developers.cloudflare.com/waf/rate-limiting-rules/
- Planos e recursos incluídos por plano: https://www.cloudflare.com/plans/

## Trafego dos EUA

Muitas requisicoes vindas dos EUA podem ser bots, crawlers, previews sociais, monitores ou infraestrutura de nuvem. Nao bloqueie pais por padrao apenas por aparecer como EUA.

Antes de bloquear por pais:

- verifique `Security > Events`
- confirme se nao sao previews sociais ou plataformas de ads
- prefira Bot Fight Mode e reducao de superficies `workers.dev`/preview

---

Release atual publicada: 3.2.0 · Tag: v3.2.0
Criado por Vitor Faustino - vitorfaustino.com.br
