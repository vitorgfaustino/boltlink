## BoltLink 2.0.0 - LGPD Baseline

BoltLink 2.0.0 é a nova baseline de privacidade do projeto.

Esta versão muda o produto para um modelo de minimização real de dados: o redirect continua rápido, a contagem continua existindo, mas o sistema deixa de manter analytics detalhado por evento e remove campos que aumentavam a superfície de tratamento sem serem essenciais para o objetivo principal.

### Destaques

- contagem apenas agregada em `clicks_total`
- remoção da tabela `stats`
- remoção de `IP_HASH_SECRET`
- remoção de `last_clicked_at`
- remoção de `notes`
- remoção do endpoint `/api/links/:slug/stats`
- remoção do endpoint `/api/maintenance/purge-stats`
- `Referrer-Policy: strict-origin` nos redirects públicos
- `Referrer-Policy: no-referrer` no admin, API e demais respostas
- `observability.enabled = false` no template público
- `upload_source_maps = false` no template público

### Impacto funcional

BoltLink continua suportando:

- redirect público por slug
- CRUD de links
- tags, grupos, QR code, agendamento e expiração
- proteção por senha
- Cloudflare Access no admin
- deploy por Wrangler local
- deploy guiado por IA
- one-click / GitHub auto-deploy

O que deixa de existir na linha 2.x:

- analytics por clique
- retenção de eventos
- hash estável de IP
- visualização do último clique
- notas internas livres no link

### Upgrade

A migration `0003_lgpd_minimization.sql` remove dados legados e reconstrói a tabela `links` no novo formato.

Fluxo recomendado:

```bash
git pull --ff-only
npm install
npm run wrangler:init
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm test