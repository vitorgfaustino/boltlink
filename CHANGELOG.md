# Changelog

## Unreleased

> Este bloco cobre o baseline local da **Fase 2** (Split Test A/B, migration `0004`) e o estado **Unreleased da Fase 3** (Smart Routing, migration `0005`). A tag publicada `v2.2.1` termina na `0003` e não contém nenhum dos dois. Nenhum bump de versão está associado a estas correções.

### Adicionado

- Split Test A/B por link com Control A (`target_url`) e Variant B (`ab_target_url`), distribuição stateless por requisição e contadores agregados `ab_clicks_a`/`ab_clicks_b`
- migration `0004_ab_testing.sql` como fonte autoritativa das colunas A/B; o runtime não pré-aplica a migration e mantém links normais funcionando em banco pré-0004
- migrations como única autoridade do schema: instalação limpa = aplicar `0000` a `0005`; `schema.sql` passa a ser apenas o baseline da `0000` para ferramentas manuais
- UI de Split Test A/B no admin (toggle, Variant B, presets de Traffic Allocation) e exibição de Cliques A/B e Distribuição observada, inclusive após o teste ser encerrado
- validação fail-fast de `abEnabled`/`abTargetUrl`/`abWeightB` (1 a 99) sem partial mutation
- `ab_generation`/`metric_epoch` para fencing de métricas atrasadas e concorrência otimista (`version`) nos updates administrativos
- testes determinísticos de split (RNG injetado), geração, late write, reset, concorrência, cache, senha + A/B, duplicação, instalação limpa e upgrade
- Smart Routing privacy-first por link: regras ordenadas de país/dispositivo com first-match-wins e fallback em `target_url`, usando `links.smart_routing_rules` (JSON em linha) e país/dispositivo apenas em memória
- editor de Smart Routing no Admin com regras ordenadas (mover para cima/baixo, remover), país via lista ISO local com `Intl.DisplayNames` quando disponível, `Qualquer país`/`Qualquer dispositivo`, fallback somente leitura e limite de 20 regras
- capability-aware UI: a seção Smart Routing só aparece quando `smartRouting=true`; instalações pré-`0005` não recebem o campo no payload
- migration `0005_smart_routing.sql` como fonte autoritativa de `links.smart_routing_rules`; instalação limpa = aplicar `0000` a `0005`
- exclusão mútua entre Smart Routing e Split Test A/B, e bloqueio de `301` quando Smart Routing está ativo, com transição atômica em um único `PATCH`
- redirect público integrado: Smart Routing usa sempre `302` + `Cache-Control: no-store`, bot/preview/prefetch sempre no fallback, e estado híbrido/corrompido falha seguro em `target_url` com métrica somente `clicks_total`
- hot path sem SELECT adicional, sem tabela auxiliar, sem API externa e sem PRAGMA por clique; testes de SQL instrumentado (cold vs warm) e provas de zero parse/classificação/RNG em bots e híbridos

### Corrigido

- escrita de métrica atrasada não contamina mais a nova geração A/B nem ressuscita um reset manual
- `PATCH`/`PUT` concorrentes retornam `409` em vez de persistir configuração A/B inválida
- runtime não cria nenhuma coluna (A/B ou de features) e não executa `schema.sql`: banco vazio falha fechado com `503 Database schema is not initialized` até as migrations serem aplicadas, então a cadeia `0000`→`0004` aplica sem `duplicate column` (`BL-AB-003-R1`)
- A/B nunca emite `301` cacheável: sempre `302` com `Cache-Control: no-store`, e a API rejeita A/B + `301`
- RNG do split só é executado quando existe A/B ativo e acesso humano elegível
- runtime não executa mais rebuild destrutivo de tabela: colunas legadas extras (`last_clicked_at`, `notes`, `stats`) são ignoradas e permanecem até uma migration explícita, eliminando a corrida entre rebuild e migration (`BL-AB-015`)
- capability negativa não fica cacheada: um isolate iniciado antes da `0004` passa a usar fencing assim que a migration é aplicada
- results de um teste encerrado continuam visíveis no admin sem associar alocação/Variant B atuais aos counters históricos; configuração futura aparece separada como "Próximo teste"
- clique capturado antes da migration `0004` usa fence execution-time (`boltlink_metric_fence`): não ressuscita reset mesmo quando a migration e o reset chegam depois do SQL legado já ter sido escolhido, e um bootstrap iniciado pré-`0004` não consegue rebaixar a view real promovida pela migration (promoção `SHIM → REAL` é exclusiva da migration; runtime só faz `CREATE VIEW IF NOT EXISTS`)
- `GET /api/capabilities` informa `abTesting` ao Admin; antes da `0004` o painel oculta A/B e mantém create/edit normais sem campos A/B
- README deixa explícito que migrations são autoritativas e que o runtime não cria colunas A/B
- scripts `dev-validate-phase-*` usam `--testNamePattern` (Vitest 4) com `--passWithNoTests`
- fluxo local deixa explícito que `npm run dev-init` prepara apenas o SQLite auxiliar `.dev-env/db.sqlite3`; o Worker usa o D1 local do Wrangler, preparado por `npm run dev-prepare` antes de `npm run dev`; mensagem final do `dev-init` e fluxos one-click/remotos sincronizados (provisionar/deploy inicial não substitui migrations remotas) (`BL-AB-016`)
- o redirect público deixou de depender de cache de capability por isolate: a linha principal é lida com projeção schema-neutral (`SELECT *`) e a presença da coluna é observada a cada request, então um isolate aquecido antes da `0005` converge sozinho no próximo request público — sem `PRAGMA` por clique e sem depender de afinidade com um request Admin/API (`BL-SR-GLOBAL-001`)
- configuração Smart Routing persistida e ilegível deixou de ser confundida com "desativada": a API expõe `smartRoutingStatus` (`disabled`/`valid`/`invalid`) sem revelar o valor cru, o Admin mantém o estado como corrupção preservada, edições não relacionadas não enviam o campo e só a ação explícita de limpeza grava `NULL`; a validação de híbrido passou a rejeitar apenas híbrido novo ou reescrito, preservando o fail-safe de linhas já híbridas (`BL-SR-GLOBAL-002`)
- documentação separada em três bases explícitas — tag publicada `v2.2.1` (até `0003`), baseline local da Fase 2 (`0004`) e working tree da Fase 3 (`0005`) — e o scanner de documentação passou a proteger também o limite publicado vs. artefatos da Fase 2 (`0004`, A/B, `ab_enabled`, `ab_target_url`, `dev-prepare`) (`BL-SR-GLOBAL-003`)

### Segurança e comportamento

- lifecycle do `POST /:slug` agora valida agendamento e expiração antes de decidir se um link não possui senha
- rotas fixas `version` e `privacidade` passam a fazer parte da fonte central de slugs reservados
- filtros de métricas classificam User-Agents reconhecidos antes de aceitar `Sec-Fetch-Mode: navigate`; o redirect continua aberto para previews e crawlers
- links protegidos só podem ser criados ou receber senha quando `PASSWORD_SESSION_SECRET` está configurado; `API_KEY` não é fallback
- tipos inválidos no campo `password` passam a responder HTTP 400 sem qualquer mutação; somente string não vazia adiciona senha e somente `null` remove
- filtros de métricas reconhecem `Purpose`/`Sec-Purpose`/`X-Purpose` tokenizados, incluindo valores compostos como `prefetch;prerender`
- CI usa Node 22, compatível com o lockfile atual

### Operação

- removida injeção de desenvolvimento localhost do asset público do admin
- rótulo do contador do admin agora informa que exibe links ativos retornados pela API
- documentação de capacidade Free, política de cliques, segredo de sessão e referrer foi sincronizada

## [2.2.1] - 2026-06-12

### Alterado
- Side-stripe removido dos headings em `public/privacidade.html` (substituído por underline `::after` consistente com admin).
- Tokens CSS de `privacidade.html` alinhados com `admin.css` (radius, accent-soft, blur, motion).
- Empty state do painel reescrito para texto neutro (funciona em desktop e mobile).
- Contador renomeado de "Links criados" para "Total de links".
- Accordion do formulário agora permite apenas uma seção aberta por vez (reduz carga cognitiva).
- Tokens duplicados nos templates server-side (`renderHomePage`, `renderPasswordGate`) sincronizados com `admin.css`/DESIGN.md (radius 12px, cubic-bezier motion, `--font`, blur 24px, tokens faltantes adicionados).
- Raw motion (`150ms ease`, `200ms ease`) substituído por `var(--motion-fast)`/`var(--motion-medium)` nos templates do Worker.
- Touch targets em mobile ajustados para 44px (WCAG 2.5.5) nos botões compactos e dropdown trigger.
- Contraste de placeholder melhorado (`#52525b` → `#71717a`) para atingir ~4.5:1.
- `text-wrap: pretty` adicionado a parágrafos para reduzir órfãs tipográficas.

### Adicionado
- Atalhos de teclado no painel: `/` foca busca, `Ctrl+Enter` submete formulário, `Esc` cancela edição/fecha dropdowns.
- Botão `×` para limpar busca rapidamente.
- `text-wrap: balance` no heading principal.
- `:focus-visible` no link da topbar da página de privacidade.
- `prefers-reduced-motion` cobre `transform` na página de privacidade.
- Breakpoints mobile (`max-width: 480px`) nos templates `renderHomePage()` e `renderPasswordGate()`.

## [2.2.0] - 2026-05-29

### Adicionado
- Redesign visual premium (dark tech aesthetic) utilizando custom properties, glassmorphism e animações suaves.
- Menu dropdown interativo (`<details>`) no painel administrativo mobile para agrupar ações secundárias de forma limpa.
- Omitida a variável `passwordSessionFallbackSecret`. O sistema agora segue uma arquitetura fail-secure explícita e lançará um erro se o recurso de senha for ativado sem a correta configuração do segredo estático.

### Alterado
- Melhoria de Segurança: Mitigação de timing attacks em `verifyPassword` usando `constantTimeEqual` ao invés de comparação em tempo variável.
- Otimização do design responsivo com reorganização de tabelas e botões no admin UI, prevenindo overflow de texto em telas médias.
- Remoção de botão "Acessar Painel" público da página inicial (home) em prol de uma interface mais fluida para usuários finais.
- Refino da paleta de cores globais com azul (#00A1F5) de maior contraste e estética premium.

## [2.1.0] - 2026-05-22
- Added: public/admin.css extracted from inline <style> block for independent caching
- Added: public/admin.js extracted from inline <script> block for maintainability
- Changed: admin.html loads CSS and JS as external files via <link> and <script src>
- Added: admin.css and admin.js to reserved slug set

## [2.0.1] - 2026-05-21

### Adicionado

- endpoint administrativo para zerar `clicks_total` de um link ativo
- botão no painel para zerar estatísticas agregadas por link
- guia `docs/free-plan-traffic.md` com medidas gratuitas para reduzir tráfego indesejado

### Alterado

- redirects públicos rejeitam slugs fora do padrão antes da leitura D1
- redirects públicos aplicam rate limit em memória antes da leitura D1 para reduzir rajadas no banco
- documentação explica que exclusão de link é lógica e não limpa eventos porque eventos não existem na v2.0.0

## [2.0.0] - 2026-05-17

### Breaking

- removida a tabela `stats`
- removido `IP_HASH_SECRET`
- removido `last_clicked_at`
- removido `notes`
- removido o endpoint `/api/links/:slug/stats`
- removido o endpoint `/api/maintenance/purge-stats`

### Alterado

- cliques passam a ser contados apenas em `links.clicks_total`
- redirects públicos passam a usar `Referrer-Policy: strict-origin`
- admin e API continuam `no-referrer`
- o bootstrap do Worker agora reconcilia schema legado para o modelo LGPD
- `observability.enabled` passa a `false` no template público
- `upload_source_maps` passa a `false` no template público

### Banco

- `schema.sql` consolidado sem `stats`, `last_clicked_at` e `notes`
- nova migration `0003_lgpd_minimization.sql`

### Documentação

- fluxos Wrangler, AI-start e one-click reescritos para a nova baseline
- guias de upgrade e privacidade atualizados

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
