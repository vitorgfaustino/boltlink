# Retention (BoltLink v2.2.1)

## Estado atual

BoltLink não mantém tabela de eventos de clique.

Por isso:

- não existe retenção de `stats`
- não existe endpoint de purge de analytics
- não existe event log por clique
- a métrica total agregada vive em `links.clicks_total`, dentro da própria linha do link

O que o BoltLink persiste são **agregados e metadados operacionais**, nunca eventos individuais. Além do total, bases com o teste A/B aplicado persistem contadores agregados por variante e metadados de fencing; o modelo completo está na seção seguinte (Unreleased).

## Métricas agregadas e metadados persistidos (Unreleased)

> Escopo: modelo completo a partir do baseline local da Fase 2 (migration `0004`). A tag publicada `v2.2.1` termina na `0003` e só possui `clicks_total` como métrica.

A. Métricas agregadas persistidas:

- `clicks_total` — total acumulado de cliques contados do link (existe em todas as bases)
- `ab_clicks_a` e `ab_clicks_b` — contadores agregados do Split Test A/B por variante (migration `0004`)

B. Metadados operacionais necessários ao fencing e à exibição das métricas:

- `metric_epoch` — época da métrica, avançada a cada reset para descartar escritas atrasadas de épocas anteriores
- `ab_generation` — geração da configuração A/B, usada para não associar contadores zerados ao teste anterior
- `ab_started_at` — timestamp operacional de quando o teste A/B vigente começou a contar
- a projeção `boltlink_metric_fence` (`id`, `metric_epoch`) existe apenas para cercar escritas de métrica atrasadas; é view sobre a própria `links`, não guarda dado de visitante

Agregados não são tracking individual: são contadores sem identidade. Nenhum evento individual de clique é gravado, em nenhuma tabela.

## O que nunca é persistido (Unreleased)

Válido em todas as bases, inclusive na working tree atual:

- IP do visitante
- hash estável de IP
- país aproximado usado pelo Smart Routing em memória
- `User-Agent` e dispositivo derivado
- identificador de visitante ou de sessão pública
- clickstream ou histórico de eventos
- histórico individual de referrer
- evento individual de QR Code (existe apenas a flag operacional `has_qrcode`)

## Reset de estatísticas e fencing de métricas (Unreleased)

O admin pode zerar as métricas agregadas de um link ativo (`POST /api/links/:slug/reset-clicks`; slug reservado responde `400`, link inexistente ou desabilitado responde `404`).

Em banco com a migration `0004` aplicada, a ação atualiza somente a linha em `links`:

- `clicks_total` volta para `0`
- `ab_clicks_a` e `ab_clicks_b` voltam para `0`
- `metric_epoch` avança `+1`: uma escrita de métrica atrasada de época anterior não ressuscita o reset
- `ab_generation` avança `+1`: os contadores zerados não pertencem à geração anterior do teste
- `ab_started_at` é renovado apenas quando o link tem A/B ativo (`ab_enabled = 1`); sem A/B, permanece como está
- `updated_at` é renovado
- `version` é incrementado

Em banco anterior à `0004`, o mesmo endpoint continua existindo e atualiza apenas `clicks_total`, `updated_at` e `version`, porque as colunas A/B ainda não existem nesse schema.

Não há ganho relevante de espaço no D1: todos os campos afetados são números e timestamps dentro da própria linha do link.

## Bases anteriores à migration 0004 (Unreleased)

> Escopo: colunas A/B a partir do baseline local da Fase 2 (migration `0004`). A tag publicada `v2.2.1` termina na `0003` e não contém nenhuma delas.

- Uma base em `0003` possui apenas `clicks_total` como métrica; `ab_clicks_a`, `ab_clicks_b`, `metric_epoch`, `ab_generation` e `ab_started_at` passam a existir somente depois de aplicar a `0004`.
- O modelo agregado atual não existia desde a `0000`: a migration `0003_lgpd_minimization.sql` removeu `stats`, `last_clicked_at` e `notes`; a `0004` adicionou os contadores A/B e seus metadados de fencing.

## Exclusão de links

Excluir um link é uma exclusão lógica.

O registro continua em `links`, com `disabled_at` preenchido. Isso preserva o slug como já usado e evita que um slug antigo seja reaproveitado por acidente.

Como a linha `2.0.x` não possui tabela `stats`, a exclusão do link não precisa limpar eventos de clique.

## Grupos e hierarquia (Unreleased / Fase 5)

> Escopo: working tree da Fase 5 (sobre o HEAD congelado da Fase 4 `cdb9f83`). A tag publicada `v2.2.1` não contém esta semântica.

- Não existe exclusão automática de grupos. Mover ou excluir o último link de um grupo — inclusive o último link ativo — deixa o grupo no banco, porque ele pode ainda ter subgrupos ou links desabilitados. O helper `cleanupEmptyGroup` foi removido do runtime.
- Um grupo só sai do banco por `DELETE /api/groups/:id`, e apenas quando não tem subgrupos e nenhum link, desabilitado ou não.
- A hierarquia (`link_groups.parent_id`) é configuração administrativa do operador. Nenhum dado de visitante entra nela e a Fase 5 não introduz nenhuma retenção nova: a árvore é lida uma vez para o Admin e as operações de mover/excluir são leituras e escritas limitadas.
- Grupos não guardam dados de visitante, então a hierarquia não muda a política de retenção de cliques e links descrita acima.
- A exportação portátil (`GET /api/export`) é somente leitura no **request inteiro** e não cria retenção nova: não grava nada no banco nem executa DDL (a rota usa a readiness de schema somente leitura, então não cria a projeção de métricas), não registra auditoria de exportações e não inclui dados de visitante nem métricas. O arquivo baixado passa a viver fora do BoltLink, sob responsabilidade de quem o guarda.
- A importação portátil (`POST /api/import/preview` e `POST /api/import/apply`) também não cria retenção nova: grava apenas links e grupos, como qualquer criação pelo painel, sem histórico de importações e sem auditoria de quem importou.
- O QR Code do painel persiste apenas a flag `has_qrcode` (memória operacional de que um QR foi obtido num download): nenhuma imagem é guardada, nenhum clique é contado na geração e nada de QR entra no export/import.

## Destino de expiração (Unreleased / Fase 4)

> Escopo: working tree da Fase 4 (sobre o HEAD congelado da Fase 3 `548f179`). A tag publicada `v2.2.1` não contém esta feature.

- requests de link expirado não contam clique e não geram nenhuma retenção nova: zero escritas por request.
- `expired_redirect_url` permanece como campo de configuração da própria linha do link, no mesmo plano de `expires_at`, até o operador editar ou excluir o link.
- zerar estatísticas preserva a expiração e o destino de expiração configurados; apenas os contadores são zerados.

## O que ainda precisa de política operacional

- retenção dos próprios links criados pelo operador
- retenção de grupos
- retenção de logs externos ativados no ambiente Cloudflare

## Upgrade

Ao atualizar de versões anteriores, a migration `0003_lgpd_minimization.sql` remove `stats` e reconstrói `links` sem `last_clicked_at` e sem `notes`.

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
