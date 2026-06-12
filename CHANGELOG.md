# Changelog

## [2.2.1] - 2026-06-12

### Alterado
- Side-stripe removido dos headings em `public/privacidade.html` (substituído por underline `::after` consistente com admin).
- Tokens CSS de `privacidade.html` alinhados com `admin.css` (radius, accent-soft, blur, motion).
- Empty state do painel reescrito para texto neutro (funciona em desktop e mobile).
- Contador renomeado de "Links criados" para "Total de links" (reflete contagem incluindo desativados).
- Accordion do formulário agora permite apenas uma seção aberta por vez (reduz carga cognitiva).

### Adicionado
- Atalhos de teclado no painel: `/` foca busca, `Ctrl+Enter` submete formulário, `Esc` cancela edição/fecha dropdowns.
- Botão `×` para limpar busca rapidamente.
- `text-wrap: balance` no heading principal.
- `:focus-visible` no link da topbar da página de privacidade.
- `prefers-reduced-motion` cobre `transform` na página de privacidade.

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

Versão 2.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
