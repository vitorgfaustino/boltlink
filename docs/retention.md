# Retention (BoltLink v2.2.1)

## Estado atual

BoltLink não mantém mais tabela de eventos de clique.

Por isso:

- não existe retenção de `stats`
- não existe endpoint de purge de analytics
- a única métrica persistida é `links.clicks_total`

## Reset de estatísticas

O admin pode zerar a métrica agregada de um link ativo.

Essa ação atualiza somente a linha em `links`:

- `clicks_total` volta para `0`
- `updated_at` é renovado
- `version` é incrementado

Não há ganho relevante de espaço no D1, porque `clicks_total` é apenas um número dentro da própria linha do link.

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
