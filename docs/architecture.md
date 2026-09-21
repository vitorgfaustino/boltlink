# Arquitetura do Projeto

## Visão geral

BoltLink é um gerenciador de links orientado a edge:

- Worker HTTP em `src/index.ts`
- painel estático em `public/admin.html`
- D1 para links, grupos e contador agregado
- Cloudflare Access para proteger `/admin`, `/admin.html`, `/api` e `/api/*`

## Fluxo público

1. A requisição chega em `/:slug`.
2. O Worker rejeita slugs reservados ou fora do padrão antes de consultar D1.
3. O Worker aplica um rate limit em memória para poupar D1 em rajadas públicas.
4. O Worker garante uma vez por handle/isolate que o banco foi preparado (bootstrap + projeção de fence), sem PRAGMA por request no steady state e sem classificar capability no caminho público.
5. O Worker faz **um único `SELECT`** da linha principal, com projeção `SELECT *` (schema-neutral): a query não nomeia coluna de feature, então é válida em qualquer nível de migration, e a presença da coluna na linha é a resposta de schema daquele request. Um handle aquecido antes de uma migration converge sozinho no request público seguinte — sem `PRAGMA`, sem cache negativo e sem depender de um request Admin/API cair no mesmo handle.
6. O Worker valida lifecycle: desativado (`disabled_at`), futuro (`go_live_at`) e expirado (`expires_at`) antes de qualquer roteamento.
7. O Worker resolve o gate de senha quando o link é protegido (sem sessão/senha válida não há roteamento, classificação nem métrica).
8. O Worker classifica a requisição como clique humano contável ou bot/preview/prefetch (o filtro é apenas métrico).
9. Com o destino ainda não construído, o Worker decide entre Smart Routing, Split Test A/B ou fallback (`target_url`):
   - Smart Routing: bots/previews ficam sempre no fallback; humano elegível usa país (`request.cf.country`) e dispositivo (`User-Agent`) com first-match-wins e fallback em `target_url`;
   - A/B: variante sorteada por requisição (stateless), bots/previews no Control A;
   - híbrido/corrompido (`ab_enabled = 1` + `smart_routing_rules` não nulo): falha seguro em `target_url`.
10. O Worker constrói a response (`301`/`302`; links com Smart Routing ou A/B usam sempre `302` com `Cache-Control: no-store`).
11. Em paralelo, agenda a métrica com `ctx.waitUntil()`: `links.clicks_total` e, quando aplicável, o contador da variante.
12. O Worker retorna o redirect.

Não existe mais persistência de evento por clique e nenhum dado de visitante (país, User-Agent, dispositivo derivado ou regra selecionada) é armazenado.

## Fluxo administrativo

1. O acesso passa por `requireAdmin`.
2. O token do Access é validado no próprio Worker.
3. O painel consome `/api/links`, `/api/groups`, `/api/preview` e endpoints auxiliares.
4. O painel permite zerar `clicks_total` de um link ativo sem apagar o link.

## Modelo de dados

### Tabela `links`

- `slug`
- `target_url`
- `clicks_total`
- `created_at`
- `updated_at`
- `disabled_at`
- `expires_at`
- `go_live_at`
- `redirect_type`
- `tags`
- `has_qrcode`
- `group_id`
- `password_hash`
- `ab_enabled` (Split Test A/B ligado/desligado)
- `ab_target_url` (Variant B; Control A é sempre `target_url`)
- `ab_weight_b` (percentual de tráfego para B, 1 a 99)
- `ab_clicks_a`
- `ab_clicks_b`
- `ab_started_at`
- `smart_routing_rules` (JSON em linha; `NULL` = desativado, array ordenado = ativado)
- `version`

### Tabela `link_groups`

- `name`
- `parent_id`
- `created_at`

### Semântica do Split Test A/B (Phase 2 local)

Escopo: **baseline local da Fase 2**. A tag publicada `v2.2.1` não tem Split Test A/B.

- Control A é sempre `target_url`; Variant B é `ab_target_url`.
- `ab_weight_b` é o percentual de tráfego humano para B, aceito apenas como inteiro entre 1 e 99.
- A escolha é stateless e por requisição. Bots, crawlers, previews e prefetch/prerender ficam sempre no Control A e não incrementam contadores.
- Links com A/B ativo respondem sempre `302` com `Cache-Control: no-store`. A combinação A/B + `301` é rejeitada com `400`; nenhum redirect permanente cacheável é emitido para A/B.
- `ab_generation` identifica a geração do experimento. Mudar `target_url` (Control A), `ab_target_url` (Variant B) ou `ab_weight_b` com o teste ativo incrementa a geração, zera `ab_clicks_a`/`ab_clicks_b` e renova `ab_started_at`. `clicks_total` nunca é zerado por essa mudança.
- Escritas de métrica atrasadas carregam geração + epóque. Um clique originado antes de uma mudança de configuração ainda incrementa `clicks_total`, mas não incrementa os contadores da nova geração.
- `metric_epoch` é o corte de reset manual: um clique originado antes de `reset-clicks` não reaparece em nenhum contador depois do corte.
- Desativar o teste preserva contadores e geração; reativar incrementa a geração e começa um novo teste com contadores zerados.
- Zerar cliques (`reset-clicks`) zera `clicks_total`, `ab_clicks_a` e `ab_clicks_b` na mesma operação, incrementa `ab_generation` e `metric_epoch`, e renova `ab_started_at` quando o teste está ativo.
- Duplicar um link copia Control A, Variant B, `ab_enabled` e alocação, mas inicia o novo teste com contadores zerados e nova geração.
- Atualizações administrativas usam concorrência otimista (`version`): um `PATCH`/`PUT` baseado em estado antigo falha com `409` em vez de persistir configuração inválida.
- Colunas legadas extras de schemas antigos (`last_clicked_at`, `notes`) e a tabela `stats` são ignoradas; o runtime não reconstrói a tabela e o estado A/B existente é lido como está, sem completar migration silenciosamente.
- Resultados de um teste encerrado permanecem visíveis, mas alocação/Variant B atuais só aparecem como "Próximo teste", separados dos counters históricos. Como não há snapshot da configuração antiga, ela nunca é associada aos counters.
- Capability negativa (`abReady=false`) não é cacheada permanentemente: um isolate iniciado antes da `0004` revalida o schema em requests subsequentes e passa a usar fencing assim que a migration aparece. Capability positiva é cacheada.
- Um clique capturado antes da `0004` executa sempre um UPDATE cujo fence é avaliado na própria escrita, nunca com base apenas numa leitura anterior: a migration, um reset ou uma configuração A/B podem acontecer entre a revalidação e o `run()`. Antes da `0004` o fence lê a projeção `boltlink_metric_fence`, que reporta o epóque implícito 0; a migration `0004` promove essa projeção para a coluna real `metric_epoch`. A projeção é monotônica: o runtime só usa `CREATE VIEW IF NOT EXISTS` (shim ou real) e nunca executa `DROP VIEW`; a promoção `SHIM → REAL` pertence exclusivamente à migration. Por isso um bootstrap iniciado antes da `0004` que termine depois da migration não consegue rebaixar a view real: sua manutenção vira no-op. Assim um reset ocorrido nesse intervalo nunca é ressuscitado, um clique válido continua contando quando só a migration chega e nenhum clique retroativo é associado a A/B. A projeção não cria colunas A/B: `metric_epoch` continua sendo propriedade da migration.
### Capabilities expostas ao Admin

- `GET /api/capabilities` expõe `{ "abTesting": boolean, "smartRouting": boolean }` para o Admin, sem detalhes internos de schema. O Admin só mostra e envia campos A/B quando `abTesting=true` e só mostra e envia Smart Routing quando `smartRouting=true`; instalações pré-`0004`/pré-`0005` mantêm o payload normal da Fase 1.
- A classificação de estado persistido (`smartRoutingStatus`) é adicional e só existe quando a coluna existe; ela não substitui a capability, que continua sendo a fonte de disponibilidade da feature.

### Semântica do Smart Routing (Unreleased / Fase 3)

> Escopo: release publicada/baseline = **v2.2.1**. Smart Routing e a migration `0005` pertencem ao estado **Unreleased (Fase 3)** da branch de desenvolvimento.

- `links.smart_routing_rules` guarda um JSON em linha com a lista ordenada de regras. `NULL` significa desativado; um array não vazio significa ativado. Não existe tabela secundária nem JOIN auxiliar, e o redirect usa um único `SELECT` da linha principal.
- Cada regra tem `country` (ISO 3166-1 alpha-2 uppercase, opcional), `device` (`ios`, `android`, `desktop`, `other`, opcional) e `url` (http/https, até 2048 bytes canônicos). A regra precisa de pelo menos um matcher.
- First-match-wins: as regras são avaliadas na ordem enviada e a primeira compatível define o destino. Sem regra compatível, o destino é `target_url`.
- O país vem somente de `request.cf.country` e é normalizado de forma conservadora (`XX`, `T1`, lowercase e valores malformados viram `null`; regras de país não casam). O dispositivo é derivado do `User-Agent` da requisição; o valor cru não é armazenado.
- Bots, crawlers, previews e prefetch/prerender recebem sempre `target_url`, sem parsear regras nem classificar país/dispositivo.
- Links com Smart Routing configurado respondem sempre `302` com `Cache-Control: no-store`; `301` é rejeitado pela API e ignorado pelo runtime mesmo em caso de corrupção manual.
- Smart Routing e Split Test A/B são mutuamente exclusivos. Um estado persistido simultâneo (`ab_enabled = 1` + `smart_routing_rules` não nulo) falha seguro: o redirect usa `target_url` em `302`/`no-store`, sem RNG, sem contador A/B e sem destino Smart.
- O caminho público não usa cache de capability: como a linha é lida com `SELECT *`, a presença de `smart_routing_rules` é observada a cada request, então aplicar a `0005` sem restart converge no request público seguinte mesmo que nenhum request Admin/API chegue àquele handle. A API administrativa mantém a capability positiva em cache e revalida a negativa.
- Um valor persistido não nulo e ilegível é **corrupção preservada**, não "desativado": a API expõe `smartRoutingRules: null` com `smartRoutingStatus: "invalid"` (nunca o conteúdo cru), o Admin não reenvia o campo em edições não relacionadas e só uma ação explícita de limpeza grava `NULL`. Sem essa distinção, editar apenas as tags apagaria a corrupção e mudaria o roteamento público.
- A métrica pública continua sendo somente `clicks_total` agregado, com o mesmo fence de `metric_epoch`. Não há contador por regra, país ou dispositivo.
- Máximo de 20 regras, JSON serializado limitado a 8 KiB, sem duplicatas de matcher e sem regra totalmente coberta por uma anterior.

### Migrações e runtime (release publicada v2.2.1)

- Migrations são a única autoridade para criar ou evoluir tabelas e colunas.
- O runtime **não** executa `schema.sql`, **não** cria colunas, **não** aplica migrations implicitamente e **não** reconstrói tabelas. Ele valida que o banco foi preparado; sem a tabela `links` ou sem colunas obrigatórias, responde `503` com erro operacional controlado e sem vazar SQL.
- Colunas legadas extras (`last_clicked_at`, `notes`, `stats`) são ignoradas e permanecem até que uma migration explícita as remova. Nenhum rebuild destrutivo roda durante requests.
- `schema.sql` é apenas o snapshot baseline da migration `0000_initial_schema.sql` para ferramentas manuais; não é executado pelo runtime e não deve receber colunas de features.
- Instalação limpa da release publicada (`v2.2.1`): criar o D1, aplicar `migrations/0000` até `0003`, publicar o Worker. Upgrade da release publicada: aplicar as migrations pendentes até a `0003`, depois publicar e validar. Mesmo sem restart, um isolate antigo detecta uma migration aplicada no request seguinte.

#### Split Test A/B e migration 0004 (Phase 2 local)

Escopo: **baseline local da Fase 2** (`0004`). A tag publicada `v2.2.1` não contém esta migration.

- Enquanto a `0004` não estiver aplicada, links normais continuam com redirect, lifecycle, senha e contagem; qualquer tentativa de configurar A/B pela API retorna `400` com mensagem explícita pedindo a migration.
- Capability negativa de A/B não é cacheada permanentemente: um isolate iniciado antes da `0004` revalida o schema em requests subsequentes e passa a usar fencing assim que a migration aparece. O caminho público não depende dessa revalidação para descobrir a migration, porque a linha é lida com projeção schema-neutral.
- Instalação limpa e upgrade desta base aplicam `0000` até `0004`.

#### Instalação limpa e upgrade (Unreleased / Fase 3)

Na branch de desenvolvimento, a instalação limpa e o upgrade aplicam também a `0005_smart_routing.sql`. Um checkout da tag `v2.2.1` não contém essa migration.

## Decisões preservadas

- slug continua imutável após criação
- redirect continua prioritário sobre contagem
- links deletados continuam em exclusão lógica
- zerar estatísticas é uma ação explícita e não acontece automaticamente na exclusão
- Split Test A/B é stateless: nenhuma escolha de variante é persistida por visitante; somente contadores agregados existem na linha do link
- nenhuma persistência de IP, hash de IP, país, referrer, user-agent, `stats`, `last_clicked_at` ou `notes`

## Operação Cloudflare

- `wrangler.jsonc` continua sendo o template público
- `wrangler.local.jsonc` continua sendo a configuração privada local
- `assets.run_worker_first` continua protegendo o admin antes de servir assets
- `observability` e `upload_source_maps` ficam desligados por padrão para reduzir superfície de logs
- D1 pode ser criado com jurisdição na criação (`--jurisdiction=eu`) quando o operador precisar dessa restrição

## Rate limiting

- `/api` e `/api/*` continuam com rate limit em memória.
- redirects públicos têm rate limit em memória antes da leitura D1.
- o gate de senha usa chave derivada de IP apenas em memória.
- **Atenção (Escopo Edge):** Como a memória em Workers não é compartilhada globalmente, esses limites atuam apenas no nível de Isolate/Datacenter (Colo) para evitar rajadas localizadas (DoS acidental). Eles não mitigam ataques de negação de serviço distribuídos pelo mundo. Para ataques DDoS e Rate Limite global estrito, recomenda-se configurar regras nativas de WAF no painel da Cloudflare.
- para plano gratuito, consulte `docs/free-plan-traffic.md` antes de considerar recursos pagos.

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
