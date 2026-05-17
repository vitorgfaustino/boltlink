# AI-START

Este arquivo é a entrada única para qualquer IA operar o BoltLink v2.0.0.

## Leia nesta ordem

1. `AGENTS.md`
2. `docs/ai-accepted-requests.md`
3. `docs/ai-guided-operations.md`
4. `docs/cloudflare-setup.md`
5. `docs/admin-auth.md`
6. `docs/privacy.md`

## Estado do produto

- redirect público por slug
- painel administrativo estático
- D1 para links, grupos e contador agregado
- Cloudflare Access para `/admin`, `/admin.html`, `/api` e `/api/*`
- sem `stats`, sem `IP_HASH_SECRET`, sem `last_clicked_at`, sem `notes`
- redirects públicos usam `Referrer-Policy: strict-origin`

## Regras operacionais

- `wrangler.jsonc` é o template público
- `wrangler.local.jsonc` é a configuração privada local
- não criar `wrangler.toml`
- não persistir IP, hash de IP, país, referrer ou user-agent
- não automatizar a criação final do Cloudflare Access
- não sobrescrever branding e overlays do usuário sem confirmação

## Pedidos aceitos

Use apenas pedidos compatíveis com `docs/ai-accepted-requests.md`.

Os mais úteis na v2.0.0 são:

- `Iniciar o Projeto`
- `Atualizar o Projeto`
- `Aplicar migrations`
- `Auditar estado operacional`
- `Preparar Access`

## Upgrade para v2.0.0

Quando o usuário pedir atualização:

1. verificar `git status --short`
2. preservar `wrangler.local.jsonc`, `public/admin.html`, `public/logo.png` e `public/favicon.ico`
3. atualizar o código
4. rodar `npm install`
5. rodar `npm run wrangler:init`
6. aplicar `0003_lgpd_minimization.sql` no D1 quando o ambiente ainda estiver no schema antigo
7. rodar `npm test`

## Comandos de referência

Setup local:

```bash
npm install
npm run setup
```

Migration local:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

Migration remota:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```
