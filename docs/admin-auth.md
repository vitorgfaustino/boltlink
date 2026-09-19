# Autenticação do Admin

BoltLink protege o painel e a API com Cloudflare Access e valida o token dentro do próprio Worker.

## Rotas protegidas

- `/admin`
- `/admin.html`
- `/api`
- `/api/*`

## Modos aceitos

1. `localhost`, `127.0.0.1` e `[::1]`
2. sessão válida do Cloudflare Access
3. `Authorization: Bearer <API_KEY>` apenas para `/api` e `/api/*`

## Validação do Worker

O Worker:

- prefere `Cf-Access-Jwt-Assertion`
- aceita `cf-access-token`
- aceita `CF_Authorization` por compatibilidade
- valida `issuer` com `TEAM_DOMAIN`
- valida `audience` com `POLICY_AUD`

## One-click e GitHub auto-deploy

Antes de validar a API, aplique as migrations no D1 remoto (`npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc`): sem isso `/api/*` e os redirects respondem `503 Database schema is not initialized`.

Depois do deploy:

- configure o aplicativo Access manualmente
- crie pelo menos uma policy `Allow`
- preencha `TEAM_DOMAIN` e `POLICY_AUD`

## Observação de responsabilidade

Cloudflare Access continua sendo componente operacional do deploy. O operador do ambiente é responsável pelas políticas de acesso, provedores de identidade, sessão, MFA e revisão periódica dessas regras.

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
