# Segurança

## Regras mínimas

- nunca versionar segredos, tokens, `.env`, `.dev.vars` ou `wrangler.local.jsonc`
- nunca publicar valores reais de `API_KEY`, `TEAM_DOMAIN` ou `POLICY_AUD`
- manter o painel administrativo protegido por Cloudflare Access em produção
- usar `API_KEY` apenas para automações internas em `/api` e `/api/*`
- não persistir IP, hash de IP, `Referer`, `User-Agent`, país, `stats`, `last_clicked_at` ou `notes`
- manter payload JSON limitado a 10KB

## Escopo de proteção atual

- `/admin`, `/admin.html`, `/api` e `/api/*` são rotas autenticadas
- o redirect público `/:slug` permanece aberto por definição
- o Worker valida o JWT do Access com JWKS remoto
- fora de `localhost`, admin e API falham fechados até que Access ou `API_KEY` válido esteja configurado

## Logs e observabilidade

- `observability.enabled` fica `false` por padrão no template público
- `upload_source_maps` fica `false` por padrão
- se o operador ativar Workers Logs, Logpush ou outra telemetria, isso passa a ser responsabilidade operacional dele

## Segredos e configuração

- use `wrangler secret put API_KEY` para segredos reais
- use `.dev.vars` apenas localmente
- trate `wrangler.jsonc` como template público
- trate `wrangler.local.jsonc` como configuração privada

## D1 e jurisdição

- D1 já documenta jurisdição na criação do banco
- se o operador precisar restringir o banco a uma região, crie o banco com `--jurisdiction=eu`
- essa escolha só pode ser feita na criação do banco

## Evolução recomendada

- mover rate limits públicos para Cloudflare WAF Rate Limiting Rules
- manter ambientes separados por estágio
- testar negação de acesso do admin em CI

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
