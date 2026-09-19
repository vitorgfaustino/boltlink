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
4. O Worker valida janela de ativação, expiração e gate de senha.
5. O Worker responde `301` ou `302`.
6. Se o link tem Split Test A/B e a requisição é humana elegível, a variante é sorteada por requisição (stateless); bots e previews ficam sempre no Control A.
7. Em paralelo, incrementa `links.clicks_total` e, quando aplicável, o contador da variante, com `ctx.waitUntil()`.

Não existe mais persistência de evento por clique.

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
- `version`

### Tabela `link_groups`

- `name`
- `parent_id`
- `created_at`

### Semântica do Split Test A/B

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
- `GET /api/capabilities` expõe `{ "abTesting": boolean }` para o Admin, sem detalhes internos de schema. O Admin só mostra e envia campos A/B quando `abTesting=true`; instalações pré-`0004` mantêm o payload normal da Fase 1.

### Migrações e runtime

- Migrations são a única autoridade para criar ou evoluir tabelas e colunas.
- O runtime **não** executa `schema.sql`, **não** cria colunas, **não** aplica migrations implicitamente e **não** reconstrói tabelas. Ele valida que o banco foi preparado; sem a tabela `links` ou sem colunas obrigatórias, responde `503` com erro operacional controlado e sem vazar SQL.
- Colunas legadas extras (`last_clicked_at`, `notes`, `stats`) são ignoradas e permanecem até que uma migration explícita as remova. Nenhum rebuild destrutivo roda durante requests.
- Enquanto a `0004` não estiver aplicada, links normais continuam com redirect, lifecycle, senha e contagem; qualquer tentativa de configurar A/B pela API retorna `400` com mensagem explícita pedindo a migration.
- `schema.sql` é apenas o snapshot baseline da migration `0000_initial_schema.sql` para ferramentas manuais; não é executado pelo runtime e não deve receber colunas de features.
- Instalação limpa: criar o D1, aplicar `migrations/0000` até `0004`, publicar o Worker. Upgrade: aplicar as migrations pendentes, depois publicar e validar capabilities. Mesmo sem restart, um isolate antigo detecta a migration aplicada no request seguinte (cache negativo revalidado).

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
