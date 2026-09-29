# Arquitetura do Projeto

## Visão geral

BoltLink é um gerenciador de links orientado a edge:

- Worker HTTP em `src/index.ts`
- painel estático em `public/admin.html`
- D1 para links, grupos e contador agregado
- Cloudflare Access para proteger `/admin`, `/admin.html`, `/api` e `/api/*`

## Fluxo público

A rota raiz (`GET /`) fica fora do slug hot path: com `ROOT_REDIRECT_URL` válida (Unreleased / Fase 4), o Worker responde `302` + `Cache-Control: no-store` sem nenhuma leitura de D1, sem schema detection e sem métrica; sem a variável (ou com valor inválido/auto-referente) a landing estática é servida. Isso não afeta unknown slugs (`404`), `/admin`, `/api`, `/health`, `/privacidade` nem assets.

1. A requisição chega em `/:slug`.
2. O Worker rejeita slugs reservados ou fora do padrão antes de consultar D1.
3. O Worker aplica um rate limit em memória para poupar D1 em rajadas públicas.
4. O Worker garante uma vez por handle/isolate que o banco foi preparado (bootstrap + projeção de fence), sem PRAGMA por request no steady state e sem classificar capability no caminho público.
5. O Worker faz **um único `SELECT`** da linha principal, com projeção `SELECT *` (schema-neutral): a query não nomeia coluna de feature, então é válida em qualquer nível de migration, e a presença da coluna na linha é a resposta de schema daquele request. Um handle aquecido antes de uma migration converge sozinho no request público seguinte — sem `PRAGMA`, sem cache negativo e sem depender de um request Admin/API cair no mesmo handle.
6. O Worker valida lifecycle: desativado (`disabled_at`), futuro (`go_live_at`) e expirado (`expires_at`) antes de qualquer roteamento. Na Fase 4 (Unreleased), um link expirado é decidido direto no lifecycle: com destino válido em `expired_redirect_url` responde `302` + `no-store`; sem destino (ou com valor persistido inválido/auto-referente) responde `410` + `no-store`. Em ambos os casos não há gate de senha, classificação bot/humano, Smart/A-B nem escrita de métrica — a mesma resposta para todos os clientes.
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
3. O painel consome `/api/links`, `/api/groups`, `/api/preview`, `/api/export` e endpoints auxiliares.
4. O painel permite zerar `clicks_total` de um link ativo sem apagar o link.

### QR Code no painel (Unreleased / Fase 5)

Escopo: o **diálogo com preview e download em PNG**. Os endpoints `GET/POST /api/links/:slug/qrcode` e a coluna `has_qrcode` existem desde a base publicada (`0001`).

- O QR codifica apenas a short URL pública (`https://<origem>/<slug>`), nunca o destination, a Variant B, um alvo de Smart Routing ou qualquer segredo; quem escaneia entra no redirect normal, com senha, A/B, Smart Routing e lifecycle decididos pelo runtime.
- A geração é cold path administrativo: o Worker renderiza o SVG sob demanda (`Cache-Control: no-store`) e o painel rasteriza para PNG no navegador. Nenhuma imagem é persistida — o QR é derivável da URL a qualquer momento — e a geração não conta clique nem grava no banco.
- `has_qrcode` continua sendo apenas a memória operacional de que um QR já foi obtido: é escrita pelo `POST` quando o operador baixa o QR, não quando o diálogo apenas exibe o preview, e não influencia redirect, exportação ou importação (fica de fora do Portability JSON v1).
- Slug reservado responde `400`; slug inexistente ou link desabilitado (tombstone) responde `404` nas duas rotas.

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
- `expired_redirect_url` (destino administrativo usado quando o link expira; `NULL` = sem destino. Introduzida pela migration `0006`, Unreleased / Fase 4)
- `version`

### Tabela `link_groups`

- `name`
- `parent_id` (auto-referência da migration `0002`; `NULL` = grupo raiz. A hierarquia é validada em tempo de escrita — veja "Semântica da hierarquia de grupos (Unreleased / Fase 5)")
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

- `GET /api/capabilities` expõe `{ "abTesting": boolean, "smartRouting": boolean, "expiredRedirect": boolean }` para o Admin, sem detalhes internos de schema. O Admin só mostra e envia campos A/B quando `abTesting=true`, só mostra e envia Smart Routing quando `smartRouting=true` e só mostra a seção "Após expirar" quando `expiredRedirect=true`; instalações pré-`0004`/pré-`0005`/pré-`0006` mantêm o payload normal sem os campos da feature ausente.
- `expiredRedirect` indica disponibilidade de schema (migration `0006` aplicada), não um feature flag de produto. A API continua aceitando o restante do CRUD normalmente em banco pré-`0006`; apenas `expiredRedirectUrl` é recusado com `400`.
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

### Semântica do destino de expiração (Unreleased / Fase 4)

> Escopo: working tree da Fase 4 (sobre o HEAD congelado da Fase 3 `548f179`). A tag publicada `v2.2.1` não contém esta feature nem a migration `0006`.

- `links.expired_redirect_url` guarda um destino administrativo opcional usado somente depois que `expires_at` passa. `NULL` preserva o comportamento anterior à `0006` (link expirado responde `410`).
- O campo requer `expiresAt`: CREATE/PATCH que produzam uma linha com destino e sem expiração são recusados com `400` (invariante de estado final). Limpar `expiresAt` mantendo o destino é recusado; limpar os dois na mesma requisição é a limpeza atômica permitida.
- O lifecycle é avaliado antes do gate de senha, da classificação bot/humano, do Smart Routing e do A/B: link expirado nunca pede senha, nunca roda RNG e nunca avalia regras. A precedência é lifecycle > password > Smart/A-B.
- Link expirado com destino válido responde `302` + `Cache-Control: no-store`; sem destino responde `410` + `Cache-Control: no-store`. Requests expirados executam zero escritas: nenhuma métrica, nenhum contador.
- O destino é revalidado em read-time pela mesma política de `target_url` (`normalizeTargetUrl`): valor não-string, não parseável, scheme não http/https ou self-loop direto (mesma origem e mesmo path da request) respondem `410`. `target_url` nunca é fallback de um link expirado: uma vez expirado, o link não volta ao roteamento normal. O valor persistido é apenas lido, nunca reescrito nem ecoado.
- Link ativo ignora `expired_redirect_url` por completo; o campo só passa a valer quando o link expira.
- Duplicar um link não copia `expires_at`, `go_live_at`, `password_hash` nem `expired_redirect_url`: o duplicado nasce ativo sem configuração de lifecycle. `reset-clicks` preserva expiração e destino.
- A coluna é adicionada somente pela migration `0006_expired_redirect.sql` (additive, nullable, sem rewrite). Em banco pré-`0006` o CRUD continua normal, a API recusa `expiredRedirectUrl` com `400` e `GET /api/capabilities` reporta `expiredRedirect: false`.
- `expired_redirect_url` é configuração administrativa, não dado de visitante. O destino de expiração não é regra de Smart Routing nem variante de A/B.

### Rota raiz e `ROOT_REDIRECT_URL` (Unreleased / Fase 4)

> Escopo: working tree da Fase 4. A tag publicada `v2.2.1` não contém esta configuração.

- `GET /` decide antes de qualquer outra etapa: zero chamadas de `prepare`, zero schema detection, zero capability probe, zero cookie e zero métrica.
- Valor válido: `302` + `Cache-Control: no-store` (sempre temporário — é configuração mutável por ambiente; `301` reteria um destino que pode mudar).
- Valor ausente, inválido (não http/https, relativo, `javascript:`, `data:` etc.) ou com self-loop direto para a própria raiz: a landing é servida (fail-safe silencioso; não há erro de startup nem log do valor rejeitado).
- Não afeta unknown slugs (`404`), `/admin`, `/api`, `/health`, `/privacidade` nem assets. A validação reusa `normalizeTargetUrl`, sem exceção específica da raiz.

### Semântica da hierarquia de grupos (Unreleased / Fase 5)

> Escopo: working tree da Fase 5 (sobre o HEAD congelado da Fase 4 `cdb9f83`). A hierarquia **já existe** desde a migration `0002_advanced_features.sql`; a Fase 5 não adiciona migration, coluna, tabela auxiliar, closure table nem materialized path, e não muda nenhuma capability.

- `parent_id` é a única representação da árvore. `GET /api/groups` continua devolvendo linhas planas (`name`, `parent_id`, `created_at`); o Admin monta a árvore no cliente e o endpoint não virou uma resposta aninhada.
- `parentId` é o campo de escrita. Em `POST /api/groups`, ausente ou `null` significa raiz e um inteiro positivo significa filho do grupo informado. Em `PATCH /api/groups/:id`, ausente preserva o pai, `null` move para a raiz e um inteiro positivo move sob o grupo informado. `parentGroupId` não existe na API pública.
- Um grupo pai inexistente responde `404`: o pedido não é ignorado, não é convertido para raiz e não cria grupo implicitamente.
- A hierarquia é acíclica. Auto-parentesco e qualquer ciclo indireto (`A → B → A`, `A → B → C → A`) respondem `409` sem escrita. O backend é a autoridade; a UI não é proteção suficiente.
- `MAX_GROUP_DEPTH = 16`, com raiz em profundidade 1. `POST` sob profundidade 16 responde `409` e não grava linha parcial. Um `MOVE` mede a subárvore inteira (grupo + descendentes), não apenas o nó movido.
- Árvore legada já acima de 16 continua legível e reparável: uma operação que reduz a profundidade máxima é aceita, e uma que mantém ou aumenta a violação responde `409`.
- Toda mudança de pai é **um único `UPDATE` condicionado** com CTEs recursivas: ciclo, profundidade e a precondição do pai observado são decididos na mesma instrução que escreve. Não existe `SELECT` de verificação seguido de `UPDATE` desprotegido, logo não há janela entre checar e gravar. As CTEs usam `UNION` e um limite de recursão, então um ciclo pré-existente termina em vez de girar.
- A precondição de concorrência é `expectedParentId`, obrigatória sempre que `parentId` é enviado. `null` significa que o cliente observou o grupo na raiz. Se o pai mudou desde a leitura, a resposta é `409` e nenhum move concorrente é sobrescrito. `PATCH` sem `parentId` (renomear) continua *last-write-wins*: a Fase 5 não adiciona coluna `version` a grupos.
- `DELETE /api/groups/:id` é **um `DELETE` condicional atômico**: só remove grupo com zero subgrupos e zero links, incluindo links desabilitados. Grupo inexistente responde `404`; com subgrupos ou com links responde `409`. Não há cascade, não há reparent automático e a FK `ON DELETE SET NULL` da `0002` é preservada — a API impede que ela seja alcançada em deletes normais.
- A exclusão automática de grupos foi **removida**. Mover ou excluir o último link de um grupo deixa o grupo no banco; remover um grupo é sempre uma decisão explícita do operador. O helper `cleanupEmptyGroup` não existe mais no runtime.
- Grafo corrompido por edição SQL externa (ciclo, ou `parent_id` apontando para grupo ausente) falha fechado: `GET /api/groups` responde `409` e o Admin mostra o erro sem montar árvore parcial e sem reparo automático. `POST`/`PATCH` que precisam interpretar a árvore também respondem `409`.
- O redirect público não muda. `PUBLIC_REDIRECT_SQL` permanece `SELECT * FROM links WHERE slug = ? AND disabled_at IS NULL`: sem `JOIN`, sem `SELECT` em `link_groups`, sem CTE e sem `PRAGMA` extra. Um link com `group_id` não carrega o grupo no hot path.

### Portabilidade: BoltLink Portability JSON v1 (Unreleased / Fase 5)

> Escopo: working tree da Fase 5. A tag publicada `v2.2.1` não possui `GET /api/export` nem as rotas de importação. A porta­bilidade é **configuração**, nunca backup: o documento descreve intenção administrativa e não substitui backup do D1.

O módulo `src/portability.ts` é dono do formato e o handler Hono permanece fino. As regras de produto que já existem no runtime (sintaxe e slugs reservados, política de destino) entram por injeção, para que o export não mantenha uma segunda cópia divergente das regras de escrita.

**Identidade do formato.** `format: "boltlink-portability"` e `schemaVersion: 1`. A versão do formato evolui independentemente da versão do produto: `schemaVersion` nunca espelha `package.json`. `exportedAt` é metadado informativo e não influencia a identidade nem a semântica da importação.

**Configuração lógica, não backup.** O documento descreve intenção administrativa: `slug`, `targetUrl`, `redirectType`, `tags`, `groupRef`, `disabled`, `goLiveAt`, `expiresAt`, `expiredRedirectUrl`, `passwordProtected`, `abTest` e `smartRouting`. Métricas (`clicks_total`, `ab_clicks_*`, `ab_started_at`, `metric_epoch`, `ab_generation`), `has_qrcode`, `version` e os `id` do D1 ficam de fora **por projeção**, não por filtro posterior. Recuperação integral de hashes, contadores e metadados operacionais continua sendo backup do banco.

**Senha.** A consulta nunca seleciona `password_hash`: ela calcula `CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END AS has_password`, então o hash não entra no processo. O documento carrega apenas o booleano, e a importação exige uma **nova** senha para cada link protegido.

**Refs de grupo.** Nenhum `id` interno vira identidade portátil. Cada grupo recebe uma `ref` local ao documento (`g1`, `g2`, …) derivada da ordenação determinística, e cada link se vincula por `groupRef`, com `null` — nunca omissão — para link sem grupo. Refs não dependem do banco de destino e não exigem coluna nova.

**Capacidade por nível de migration.** `expiredRedirectUrl`, `abTest` e `smartRouting` só aparecem quando a coluna existe no banco, seguindo exatamente o que a API administrativa já faz: ausência significa "este banco não tem a feature", nunca "configurado como `null`".

**Ordem e determinismo.** Grupos são ordenados por nome (comparação total e independente de locale, com o `id` apenas como desempate) e links por `slug`. `ref` deriva dessa ordem, então a mesma configuração produz o mesmo documento funcional: apenas `exportedAt` varia. Ordem de tags e ordem das regras de Smart Routing são preservadas porque first-match-wins é semântico.

**Falha fechado.** Qualquer linha que o BoltLink não aceitaria hoje recusa o export inteiro com `409` e mensagem controlada, sem citar SQL bruto, erro do SQLite, stack, hash ou segredo:

| Estado persistido | Resposta |
| --- | --- |
| Smart Routing corrompido (incluindo JSON válido que não é array de regras) | `409` — nunca convertido em "desativado" |
| Destino de expiração sem `expires_at`, ou URL inválida | `409` |
| URL de destino inválida, `redirect_type` fora de `301`/`302`, tags fora do contrato | `409` |
| Slug malformado ou reservado (corrupção externa) | `409` |
| Lifecycle não parseável, ou `expiresAt` anterior a `goLiveAt` | `409` |
| `group_id` apontando para grupo inexistente; ciclo ou pai órfão no grafo | `409` |
| Nome de grupo não canônico: com espaços nas pontas, só espaços, ou acima de 120 caracteres | `409` — nunca normalizado para um valor que o banco não contém |
| A/B inválido (`ab_weight_b` fora de 1–99, split ativo sem Variant B, split ativo em `301`) | `409` |
| Linha híbrida A/B + Smart Routing | `409` |
| Acima de 50 grupos, 100 links ou 256 KiB (bytes UTF-8) | `413`, sem truncar |

O limite de bytes é aplicado sobre o documento serializado e medido em UTF-8, não em unidades de string do JavaScript.

**Leitura consistente.** Os dois `SELECT` do export viajam em um único `batch`, e os statements dentro desse batch têm a semântica que o D1 oferece para o batch — não uma garantia acrescentada aqui. O export completo, porém, também faz leituras **fora** desse conjunto: a contagem prévia e as sondagens de capability. O gate portanto **não** promete um snapshot único do request inteiro. O que ele garante é consistência interna: os grupos são lidos antes dos links e o documento só é emitido quando todo `groupRef` e `parentRef` resolve naquela leitura dos grupos. Se um link aponta para um grupo que a leitura não viu (por exemplo, um grupo criado no intervalo), a resposta é `409` em vez de referência órfã. A consistência final vem da validação das referências, não de uma alegação de snapshot isolation, e uma corrida nunca produz documento internamente inconsistente.

**Isolamento do hot path.** Nada do export toca o redirect: o módulo não é importado no caminho público, e um teste instrumentado garante que um redirect aquecido continua com um único `SELECT * FROM links` e nenhuma menção a `link_groups`, `JOIN`, CTE ou `PRAGMA`.

**Somente leitura do request inteiro.** `GET /api/export` não escreve no D1 e não executa DDL — e isso vale para o **request completo**, não apenas para o handler. A rota usa a readiness de schema somente leitura (validação por `sqlite_master`/`PRAGMA` e sondagem de capabilities), então nem o middleware cria objetos: a projeção `boltlink_metric_fence` que a readiness de bootstrap instala nas demais rotas `/api` **não** é criada ao pedir o export, inclusive no primeiro request em handle frio. Autenticação (`requireAdmin`/Access/chave de API), rate limit e o `503` de banco não preparado continuam idênticos.

### Importação portátil: `POST /api/import/preview` e `POST /api/import/apply` (Unreleased / Fase 5)

O módulo `src/portability-import.ts` é dono da validação e do plano; os handlers permanecem finos. A autoridade do formato é o documento que `GET /api/export` gera — não existe um segundo schema, e as regras de negócio continuam vindo do runtime por injeção (`src/index.ts`), para que o import não mantenha cópias divergentes de slug, URL, tags, lifecycle ou peso default de A/B.

**Envelope.** As duas rotas recebem `{ document, replacementPasswords? }`. O documento é exatamente o artefato do export; as senhas viajam **fora** dele, porque o formato não carrega segredo nenhum. `POST` é obrigatório: não existe operação de importação por `GET`.

**Preview é somente leitura no request inteiro.** `POST /api/import/preview` mede bytes, valida a estrutura, as referências, a árvore, as capacidades do destino e as colisões, e devolve um plano com resumo. Ele não escreve linha, não executa DDL e não instala a projeção `boltlink_metric_fence`: usa a readiness de schema somente leitura, como o export, e responde `503` quando o banco nunca foi preparado.

**Apply revalida tudo e é atômico.** `POST /api/import/apply` não confia no preview, no plano nem em estado do browser: repete a validação do documento, a resolução de capabilities, a checagem de colisão e a validação das senhas, e só então monta **um único `batch`** do D1 — os grupos em ordem topológica (pai antes de filho) e depois os links, na ordem do documento. O batch é uma transação: uma falha em qualquer statement desfaz o documento inteiro, então o resultado é tudo ou nada.

**Mapeamento de ids sem migration.** Cada grupo é inserido com o id derivado pela própria instrução, e o pai é endereçado pela **distância** até a linha que está sendo inserida, constante do plano. O piso da alocação é `max(MAX(id), sqlite_sequence.seq)`, não `MAX(id)`: `link_groups.id` é `AUTOINCREMENT`, então uma instalação que apagou seus grupos mais novos tem `MAX(id)` abaixo dos ids que a tabela já entregou, e o D1 não aplica `links.group_id` como foreign key. Usar `MAX(id) + 1` devolveria a um grupo importado um id já gasto, e um `group_id` deixado para trás por um grupo excluído passaria a resolver — em silêncio — para um grupo ao qual aquele link nunca pertenceu. Nenhum id é calculado fora da transação, nenhuma tabela temporária existe, nenhum nome ou caminho é usado como chave e a sequência `AUTOINCREMENT` continua correta depois do bloco importado.

**Validação estrita.** Chave desconhecida é recusada em todos os níveis, tipo errado responde `400` e nada é coercido (`"302"` não vira `302`, `"true"` não vira `true`). Reaproveitam-se as regras já existentes: `validateSlug`/`normalizeTargetUrl`/`normalizeTags` do runtime, `isCanonicalGroupName` e `analyzeGroupHierarchy` do módulo de hierarquia, `parseSmartRoutingRules` do domínio de Smart Routing e o mesmo leitor de instantes e de tags do export — um valor não pode ser aceito em uma direção e recusado na outra.

**Corpo em UTF-8 estrito.** O corpo é decodificado com `TextDecoder("utf-8", { fatal: true })`. O modo padrão *substitui* sequência malformada por U+FFFD, e o resultado continuaria sendo um documento válido: o operador importaria um texto que não é o do arquivo, com o único sinal sendo um caractere de substituição dentro de algum nome. Byte inválido responde `400 INVALID_BODY` nas duas rotas, sem tentativa de latin-1, de reparo ou de continuar o `JSON.parse`.

**Classificação causal da falha do batch.** O único erro esperado do batch é a `UNIQUE` de `links.slug` — a guarda que transforma um slug tomado desde o preview em transação abortada — e o SQLite nomeia a constraint que recusou, mensagem que o D1 reexpõe em `cause`. Essa assinatura é a evidência; ler o destino depois não é, porque o rollback deixa exatamente o estado anterior e uma instalação que já tinha um slug do documento explicaria qualquer falha alheia (trigger, coluna ausente, banco travado) como colisão. Falha que não pode ser classificada responde `500` controlado — sem SQL, stack, binds ou senha — e a atomicidade segue garantindo zero partial import.

**Bloqueios (`409`), nunca degradação.** Colisão com qualquer slug reservado no destino (ativo, desabilitado ou tombstone) bloqueia o import inteiro, sem overwrite, sem merge por nome e sem partial import. Feature realmente usada pelo documento que o banco de destino não suporta bloqueia com `TARGET_CAPABILITY_MISSING` — A/B no estado default não conta como uso, porque não há configuração a perder. Documento mais profundo que `MAX_GROUP_DEPTH` bloqueia com `GROUP_DEPTH_EXCEEDED`: o export transmite árvores legadas válidas acima do limite, mas o import não introduz no destino uma forma que os caminhos de escrita atuais recusariam construir. Árvore de destino corrompida bloqueia com `DESTINATION_HIERARCHY_CORRUPT`. Destino com link apontando para grupo inexistente bloqueia com `TARGET_GROUP_REFERENCE_CORRUPT`: nada é reparado, nada é reparentado, nenhum `group_id` é zerado e nenhum grupo importado ocupa o id vago — o operador corrige os links órfãos e tenta de novo. Documento com link protegido numa instalação sem `PASSWORD_SESSION_SECRET` bloqueia com `PASSWORD_SESSION_SECRET_MISSING`.

**Revisão no navegador.** `public/portability-import-ui.js` mantém a identidade da seleção (`createImportSelection`): cada operação que substitui o documento — arquivo novo, reset, close, reabertura — avança uma geração e derruba o preview aprovado junto. Toda requisição carrega a geração em que começou e só pode pintar o painel enquanto ela for a atual, então a resposta mais lenta de um arquivo substituído é descartada em vez de descrever o que o apply enviaria (a API revalida, mas quem seria contornado é a revisão, não a validação). O `AbortController` que cancela a requisição anterior é cortesia: cancelamento pode chegar depois da resposta, então a checagem de geração continua sendo a autoridade. O apply só habilita com preview aprovado para a seleção corrente, e a aprovação termina com a tentativa (`endImportAttempt`): recusa, falha de transporte, resposta ilegível ou sucesso revogam o preview aprovado, limpam o estado da revisão e descartam as senhas digitadas, então o caminho de volta é sempre um preview novo. O veredito de uma tentativa é lido por `readApplyResponse(status, body)`, que recebe o **corpo cru**: o status sozinho nunca decide, porque um `200` com corpo truncado ou corrompido pode ser uma importação já gravada. E um corpo **legível não basta**: só os envelopes do contrato autorizam o painel a afirmar o que aconteceu — o de sucesso (`ok: true` com as duas contagens como inteiros não negativos), os de recusa (`ok: false` com `error`, um `code` que o painel sabe explicar e a lista de issues do formato que ele alega, `errors` ou `blockers`) e o erro interno controlado. Um objeto JSON que não é nenhum deles (`{}`, `{"ok": true}` sem as contagens, `{"ok": false}` sem envelope) é `unknown`, não uma recusa: aceitá-lo deixaria o painel anunciar "nenhuma alteração foi aplicada" — uma afirmação de rollback — com base num corpo que a rota não produz. A única exceção em que o status participa é o erro interno: a rota responde `500` com um único campo `error` depois que o batch falhou, e como o batch é uma transação isso realmente significa que nada foi aplicado; o envelope só é reconhecido nessa forma exata (um campo, sem `ok`) e nesse status, porque um campo de texto livre é discriminador fraco demais sozinho. Corpo não reconhecido recebe o mesmo tratamento conservador de uma requisição sem resposta (`unknownOutcomePlan`), sem refresh automático: nada de sucesso, nada de rollback, só o pedido de recarregar e revisar. O mapa de senhas é construído sem protótipo (`Object.create(null)`): `__proto__` é slug válido pela política atual, e `passwords["__proto__"] = …` em um objeto comum escreveria um protótipo em vez de uma propriedade, fazendo o `JSON.stringify` perder a senha.

**Métricas e estado interno.** O documento não carrega métricas, então o import não inventa nem restaura nenhuma: a linha nasce com os defaults do destino (`clicks_total = 0`, `metric_epoch = 0`, `ab_generation` conforme o split criado), como se o operador tivesse digitado a configuração no painel. `has_qrcode`, `version`, `created_at` e `updated_at` também são do destino.

**Hot path intocado.** Nada do import entra no caminho público: `GET /:slug`, o fluxo de senha, `PUBLIC_REDIRECT_SQL`, `recordClick`, bot detection, A/B, Smart Routing, lifecycle e o redirect da raiz continuam iguais. As rotas são administrativas, compartilham o boundary de `/api` e o mesmo rate limit, e respondem com `Cache-Control: no-store`.

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

#### Instalação limpa e upgrade (Unreleased / Fase 4)

Na working tree da Fase 4, a instalação limpa e o upgrade aplicam também a `0006_expired_redirect.sql`. Banco em `0005` com código da Fase 4 continua operando normalmente (o destino de expiração fica bloqueado até a migration); banco em `0006` com código da Fase 3 é um rollback benigno — a coluna extra é ignorada. Não há downtime obrigatório: a mudança é additive e nullable.

## Decisões preservadas

- slug continua imutável após criação
- redirect continua prioritário sobre contagem
- links deletados continuam em exclusão lógica
- zerar estatísticas é uma ação explícita e não acontece automaticamente na exclusão
- Split Test A/B é stateless: nenhuma escolha de variante é persistida por visitante; somente contadores agregados existem na linha do link
- o destino de expiração é decisão de lifecycle, não de roteamento: expirado com destino responde `302`/`no-store`, sem destino `410`/`no-store`, sempre com zero escritas e zero métrica (Fase 4)
- unknown slugs continuam `404`; o redirect da raiz não substitui o 404 (Fase 4)
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
