# Changelog

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
