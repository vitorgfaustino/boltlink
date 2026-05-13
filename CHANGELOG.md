# Changelog

Todas as mudanças relevantes deste projeto serão registradas neste arquivo.

## [Unreleased]

## [1.1.0] - 2026-05-13

### Adicionado
- Filtro de cliques reais em `src/click-filter.ts` para bloquear bots, crawlers, prefetch/prerender e tráfego automatizado.
- Contabilização segura de cliques em links com senha após submissão válida do gate (`POST /:slug`).
- Suporte a redirecionamento por link com status configurável (`301` ou `302`).
- Janela de ativação e expiração por link (`go_live_at`, `expires_at`) com validações de consistência.
- Suporte a tags e notas internas por link.
- Suporte a QR code por link (`has_qrcode`) com endpoints de marcação e geração SVG (`/api/links/:slug/qrcode`).
- Recurso de duplicação de link com sugestão automática de slug (`/api/links/:slug/duplicate`).
- Suporte a grupos de links (`link_groups`) com CRUD em `/api/groups`.
- Proteção opcional por senha em links curtos com hash+salt, sessão curta via cookie e rate limit por slug+IP.
- Endpoint de manutenção para purge manual de analytics (`POST /api/maintenance/purge-stats`) com retenção configurável.
- Endpoint `/api/preview` para extrair preview básico de URL de destino.
- Novas migrations de evolução de schema: `0001_link_management.sql` e `0002_advanced_features.sql`.
- Novos comandos de operação local: `dev-init`, `dev-reset`, `dev-test` e validações por fase no `package.json`.
- Dependência `qrcode` adicionada para geração local de QR sem serviço externo.

### Alterado
- UX/Layout do admin (`public/admin.html`) redesenhado para fluxo mais escalável com seções colapsáveis (`Gerador de UTMs` e `Opções avançadas`).
- Campos do formulário reorganizados com help text para todos os campos operacionais.
- Termo de agendamento alterado de "Go live em" para "Ativa em" no formulário e nos cards.
- Preview de URL/UTM em container scrollável com quebra de linha para evitar overflow visual.
- Exclusão de link com janela de desfazer passou a exibir contador regressivo em segundos até o commit do `DELETE`.
- Preview de imagem externa no admin agora respeita CSP local e mostra fallback de mensagem quando a origem não é permitida.
- Header `Referrer-Policy` ficou condicional por contexto:
  - redirects públicos usam `strict-origin-when-cross-origin`
  - admin, API e respostas não-redirect usam `no-referrer`

### Banco de dados
- `schema.sql` atualizado para refletir o estado consolidado da 1.1.0 (`redirect_type`, `go_live_at`, `expires_at`, `tags`, `notes`, `has_qrcode`, `group_id`, `password_hash`).
- Índices adicionados para novos filtros e consultas (`has_qrcode`, `tags`, `group_id`, `parent_id`).

### Segurança e Privacidade
- Persistência de analytics mantida sem `Referer` e sem `User-Agent` em banco.
- IP continua sem persistência em texto puro; quando configurado, é armazenado apenas hash HMAC com segredo operacional.
- Proteções de acesso administrativo e validações de segurança mantidas compatíveis com Cloudflare Access.

### Testes
- Suite ampliada para 69 testes automatizados cobrindo:
  - filtro de cliques reais;
  - política de referrer por tipo de rota;
  - recursos avançados (redirect type, go-live, expiração, senha, QR, grupos);
  - integração principal do Worker e configuração.

### Documentação
- Novos guias públicos adicionados:
  - `docs/click-policy.md`
  - `docs/password-links.md`
  - `docs/privacy.md`
  - `docs/retention.md`
  - `docs/ads-best-practices.md`
  - `docs/upgrading.md`
- `AI-START.md` expandido com quick start da 1.1.0, regras operacionais e checklist de bootstrap/upgrade.

## [1.0.0] - 2026-05-10

Primeira versão pública licenciada sob a GNU Affero General Public License v3.0 (AGPL-3.0), consolidando todo o histórico de desenvolvimento em uma base única.

### Adicionado
- Botão `Deploy to Cloudflare Workers` no `README.md` para publicação direta a partir do GitHub.
- Bootstrap idempotente do schema base do D1 na primeira operação que usa o banco.
- Proteção explícita para o acesso direto a `/admin.html`.
- Arquivo `AI-START.md` como ponto único de entrada para qualquer IA iniciar setup, atualização e operação do projeto.
- Catálogo de pedidos aceitos em `docs/ai-accepted-requests.md` e runbook canônico em `docs/ai-guided-operations.md`.
- Skill `.github/skills/boltlink-operations/SKILL.md` para fluxo operacional guiado.
- Workflow básico de CI em `.github/workflows/test.yml` executando `npm ci`, `git diff --check` e `npm test`.
- Contador visual de links criados no painel administrativo.
- Changelog e checklist de publicação para apoiar o release público no GitHub.

### Alterado
- Licença do projeto alterada para GNU Affero General Public License v3.0 (AGPL-3.0).
- Adicionados cabeçalhos de copyright e disclaimer (inglês e português) em todos os arquivos fonte.
- Isenção de responsabilidade (Disclaimer) explícita adicionada ao README e arquivos de código.
- Versionamento resetado para 1.0.0 para refletir o início da nova licença.
- A landing page pública passou a exibir a versão atual do projeto, alinhando a home ao rodapé já existente no painel administrativo.
- O fluxo de atualização passou a exigir um checklist pós-update com preservação de `wrangler.local.jsonc`, proteção dos overlays do projeto e validação de `cf-typegen`, `npm test` e da árvore sem `.git` herdado.
- O deploy one-click e o fluxo de Workers Builds passaram a usar `wrangler.jsonc` quando `WORKERS_CI=1` e `wrangler.local.jsonc` não existe no build.
- O wrapper de `wrangler` agora preserva `--config` explícito e continua exigindo `wrangler.local.jsonc` no uso local padrão.
- As melhorias visuais e de segurança da release anterior foram consolidadas em uma nova base de referência pública.
- O painel administrativo recebeu ajustes de UI/UX para ficar mais consistente com a landing page pública e com o restante da identidade visual.
- Os controles do admin ganharam microinterações leves, estados visuais mais claros e tratamento melhor para foco, hover, `active` e `disabled`.
- A exclusão de links passou a ser reversível por uma janela curta de desfazer, sem adicionar complexidade de backend.
- A landing page embutida no Worker foi alinhada ao mesmo sistema visual do painel.
- O hash simples de IP foi substituído por HMAC-SHA-256 quando `IP_HASH_SECRET` está configurado; sem o secret, `ip_hash` passa a ser gravado como `NULL`.
- `/api` exato passou a receber autenticação, rate limiting e roteamento pelo Worker antes de assets.
- `TEAM_DOMAIN` passou a exigir HTTPS sem fixar o sufixo do domínio.
- O deploy automático passou a preservar variáveis já configuradas no dashboard, evitando que `TEAM_DOMAIN` e `POLICY_AUD` sejam apagados em updates via GitHub ou botão da Cloudflare.
- Payloads JSON acima de 10KB passaram a ser recusados mesmo sem `Content-Length`.
- Respostas sensíveis em HTTPS passaram a enviar `Strict-Transport-Security`.
- O botão `Deploy to Cloudflare Workers` foi atualizado para o formato atual `deploy.workers.cloudflare.com/?url=`.
- `package.json` passou a descrever bindings para melhorar a experiência do deploy one-click.
- A landing page pública em `/` foi simplificada e o rodapé antigo com orientação de rotas foi removido.
- A documentação pública foi alinhada com a nova página raiz e com o endpoint técnico `/health`.
- `wrangler.jsonc` público foi preparado para deploy one-click com provisionamento automático de D1 e roteamento de assets administrativos passando primeiro pelo Worker.
- `wrangler.local.jsonc` agora pode ser sincronizado com novas chaves do template público sem perder overrides privados.
- `wrangler.jsonc` consolidado como template público sanitizado, com `wrangler.local.jsonc` reservado para operação local privada.
- `README.md` reestruturado para onboarding leigo, fluxo com IA, atualização segura do projeto e referências operacionais.
- `public/admin.html` refinado com ajustes visuais, remoção de dependências externas de fonte, melhorias de layout e correções de interação do slug.
- Testes tornados mais resilientes, parando de depender de texto visual frágil do admin.
- Metadados do projeto ajustados para a versão `1.0.0`.

### Segurança
- Rate limiting in-memory adicionado aos endpoints `/api/*` (30 req/min por IP).
- Limite de tamanho de payload JSON definido em 10KB.
- Comparação de API_KEY alterada para timing-safe.
- Campo `ip_hash` removido da resposta da API de stats (continua armazenado, mas não exposto).
- Middleware administrativo ajustado para falhar fechado fora de `localhost` quando Cloudflare Access não estiver configurado corretamente.
- Validação de sessão do Access endurecida para rejeitar `TEAM_DOMAIN` inválido ou configuração incompleta.
- `API_KEY` limitada a automações em `/api/*`, sem liberar acesso ao HTML do `/admin`.
- Respostas sensíveis passaram a enviar headers de endurecimento, incluindo `Content-Security-Policy`, `Cache-Control: no-store`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` e `Permissions-Policy`.
- Documentação de Access atualizada para refletir o comportamento fail-closed em produção.

### Privacidade
- Analytics mantidos assíncronos para não afetar latência do redirect.
- Persistência de `Referer` e `User-Agent` removida da tabela `stats`.
- Retenção de analytics reduzida a hash de IP, país e timestamp do evento.
- Documentação e arquitetura alinhadas à política de minimização de dados.

### Corrigido
- A sincronização do `wrangler.local.jsonc` deixou de herdar `keep_vars: true` do template público por padrão, preservando o comportamento esperado do deploy manual local.
- O deploy automático continua preservando `TEAM_DOMAIN` e `POLICY_AUD` do painel do Worker, enquanto o deploy manual local pode publicar esses valores a partir do `wrangler.local.jsonc`.
- Warning de regra `Text` para `**/*.sql` removido com `fallthrough: false` em `wrangler.jsonc`.
- Stack de testes atualizada para `@cloudflare/vitest-pool-workers@^0.16.3` e `vitest@^4.1.0`, removendo os alerts de vulnerabilidade reportados por `npm audit`.
- Pequenas inconsistências de raio, copy e movimento visual entre `public/admin.html` e `src/index.ts`.
- Fluxo de remoção no admin atualizado para permitir rollback local antes de chamar o `DELETE`.
- Documentação de privacidade atualizada para não tratar SHA-256 simples de IP como irreversível.
- Geração automática de slug ocorrendo ao focar campos do formulário do admin.
- Dimensão inconsistente do botão de pesquisa no painel.
- Espaçamento visual do bloco “Criar link”.
- Mutação de headers imutáveis em respostas de assets do Worker.
- Cache incorreto no admin servido por `ASSETS.fetch()`.
- Warning local de compatibilidade do runtime ajustando `compatibility_date` para uma data suportada pelo ambiente de teste atual.

### Documentação
- O fluxo guiado de atualização passou a exigir a preservação dos valores individualizados do `wrangler.jsonc` em projetos derivados, especialmente `name`, `routes`, `workers_dev`, `preview_urls` e bindings já conectados ao Worker em uso.
- O `RELEASE_NOTES.md` passou a ser tratado como nota da versão atual apenas; versões antigas continuam registradas no `CHANGELOG.md`.
- `README.md` e `docs/cloudflare-setup.md` atualizados para refletir o fallback explícito do deploy público, o troubleshooting do config local e a fonte de verdade de `TEAM_DOMAIN` e `POLICY_AUD` em cada fluxo.
- `AI-START.md`, `docs/ai-guided-operations.md` e o fluxo de release foram reforçados para preservar branding e overlays do usuário por padrão.
- `docs/architecture.md` atualizado com seção de rate limiting.
- `SECURITY.md` atualizado com novas regras de segurança.
- `AGENTS.md` atualizado com estrutura de arquivos.
- `README.md`, `docs/cloudflare-setup.md`, `docs/admin-auth.md`, `AI-START.md` e guias operacionais atualizados para refletir o fluxo one-click e o pós-deploy manual.
- Guias de setup, autenticação, arquitetura e segurança sincronizados com o comportamento real do código.
- Orientações explícitas sobre arquivos locais fora do Git, segredos por ambiente e uso de `.dev.vars.<environment>`.
- Regras de atribuição dos ativos visuais registradas no código, no `README` e na licença.

