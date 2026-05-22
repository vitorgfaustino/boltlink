# Changelog

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

Versão 2.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
