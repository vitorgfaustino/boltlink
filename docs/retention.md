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

Como a linha `2.0.x` não possui tabela `stats`, a exclusão do link não precisa limpar eventos de clique. O único cleanup automático relacionado é remover um grupo vazio quando o último link ativo sai dele.

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
