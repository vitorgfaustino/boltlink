# Retention (BoltLink v2.0.0)

## Estado atual

BoltLink não mantém mais tabela de eventos de clique.

Por isso:

- não existe retenção de `stats`
- não existe endpoint de purge de analytics
- a única métrica persistida é `links.clicks_total`

## O que ainda precisa de política operacional

- retenção dos próprios links criados pelo operador
- retenção de grupos
- retenção de logs externos ativados no ambiente Cloudflare

## Upgrade

Ao atualizar de versões anteriores, a migration `0003_lgpd_minimization.sql` remove `stats` e reconstrói `links` sem `last_clicked_at` e sem `notes`.

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
