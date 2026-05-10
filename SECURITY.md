# Segurança

Este projeto lida com operação administrativa e redirect público. Por isso, algumas regras de segurança devem ser tratadas como obrigatórias.

## Regras mínimas

- Nunca versionar segredos, tokens, `.env`, `.dev.vars` ou arquivos equivalentes.
- Nunca publicar valores reais de `API_KEY`, `IP_HASH_SECRET`, `TEAM_DOMAIN` ou `POLICY_AUD` em exemplos públicos.
- Manter o painel administrativo protegido por Cloudflare Access em produção.
- Usar `API_KEY` apenas para automações internas e controladas em `/api` e `/api/*`.
- Usar `IP_HASH_SECRET` como secret para gerar HMAC-SHA-256 de IP; sem esse secret, o Worker não grava identificador derivado de IP.
- Não persistir `Referer` ou `User-Agent` brutos nos analytics.
- Rate limiting in-memory ativo em `/api` e `/api/*` (30 req/min por IP).
- Payloads JSON limitados a 10KB.

## Escopo de proteção atual

- `/admin`, `/admin.html`, `/api` e `/api/*` devem ser rotas autenticadas.
- O redirect público `/:slug` permanece aberto por definição de produto.
- O Worker valida o JWT do Access com JWKS remoto.
- Fora de `localhost`, o admin e a API devem falhar fechados até que Cloudflare Access ou `API_KEY` válido esteja configurado.
- `API_KEY` não deve conceder acesso ao HTML do admin; esse acesso continua reservado ao fluxo humano via Access.

## Segredos e configuração

- Use `wrangler secret put API_KEY` para segredos reais.
- Use `wrangler secret put IP_HASH_SECRET` para manter hashes de IP úteis sem expor IP puro nem hash simples.
- Use `.dev.vars` apenas localmente.
- Considere `wrangler.jsonc` como template público e auditável.
- Use `wrangler.local.jsonc` para `database_id`, `TEAM_DOMAIN` e `POLICY_AUD` quando precisar manter valores reais fora do Git.
- Nunca versionar `wrangler.local.jsonc`.
- Antes de publicar o repositório, substitua quaisquer IDs e hostnames reais por placeholders seguros.
- Se houver ambientes nomeados, não reutilize a mesma `API_KEY` nem o mesmo `IP_HASH_SECRET` entre `staging` e `production`.

## Reporte responsável

Se você identificar uma falha de segurança, não publique detalhes sensíveis em issues públicas antes de uma análise inicial.

Canal inicial recomendado:

- vitorfaustino.com.br

## Recomendações para evolução futura

- Adicionar ambientes separados por estágio.
- Definir rotação periódica de `API_KEY`.
- Definir rotação planejada de `IP_HASH_SECRET`, sabendo que a rotação quebra a comparação histórica entre hashes antigos e novos.
- Adicionar testes automatizados para cenários de autenticação negada.
- Estabelecer processo formal de disclosure antes do lançamento público.

---

Versão 1.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
