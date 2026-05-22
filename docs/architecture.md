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
6. Em paralelo, incrementa apenas `links.clicks_total` com `ctx.waitUntil()`.

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
- `version`

### Tabela `link_groups`

- `name`
- `parent_id`
- `created_at`

## Decisões preservadas

- slug continua imutável após criação
- redirect continua prioritário sobre contagem
- links deletados continuam em exclusão lógica
- zerar estatísticas é uma ação explícita e não acontece automaticamente na exclusão
- nenhuma persistência de IP, hash de IP, país, referrer, user-agent, `stats`, `last_clicked_at` ou `notes`

## Operação Cloudflare

- `wrangler.jsonc` continua sendo o template público
- `wrangler.local.jsonc` continua sendo a configuração privada local
- `assets.run_worker_first` continua protegendo o admin antes de servir assets
- `observability` e `upload_source_maps` ficam desligados por padrão para reduzir superfície de logs
- D1 pode ser criado com jurisdição na criação (`--jurisdiction=eu`) quando o operador precisar dessa restrição

## Rate limiting

- `/api` e `/api/*` continuam com rate limit em memória
- redirects públicos têm rate limit em memória antes da leitura D1
- o gate de senha usa chave derivada de IP apenas em memória
- para plano gratuito, consulte `docs/free-plan-traffic.md` antes de considerar recursos pagos

---

Versão 2.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
