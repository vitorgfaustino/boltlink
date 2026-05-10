# Checklist de Release no GitHub

Use este checklist antes de tornar o repositório público ou publicar a release `1.0.0`.

## Metadados sugeridos do repositório

### Descrição curta

`URL shortener serverless com Cloudflare Workers, D1, painel admin protegido e operação guiada por IA.`

### Website

- Se houver domínio público ativo, usar o hostname principal do projeto.
- Se ainda não houver domínio, usar a URL do repositório ou deixar em branco temporariamente.

### Topics sugeridos

- `cloudflare-workers`
- `cloudflare-d1`
- `url-shortener`
- `serverless`
- `hono`
- `zero-trust`
- `cloudflare-access`
- `workers`
- `typescript`

## Checklist técnico antes do release

- Confirmar que `wrangler.jsonc` está sanitizado e sem valores reais.
- Confirmar que o `README.md` expõe o botão `Deploy to Cloudflare Workers` com instruções de pós-deploy coerentes.
- Confirmar que a documentação deixa explícito que o fluxo one-click convive com o setup manual e guiado por IA local.
- Confirmar que `wrangler.local.jsonc`, `.dev.vars` e `.wrangler/` não serão enviados ao GitHub.
- Rodar `npm test`.
- Rodar `git diff --check`.
- Confirmar que `schema.sql` e `migrations/` estão sincronizados.
- Confirmar que `README.md`, `SECURITY.md`, `docs/admin-auth.md` e `docs/cloudflare-setup.md` refletem o comportamento atual do código.
- Confirmar que `CHANGELOG.md` descreve a release `1.0.0`.

## Checklist de segurança antes do release

- Verificar que nenhum valor real de `API_KEY`, `IP_HASH_SECRET`, `TEAM_DOMAIN`, `POLICY_AUD`, `database_id` ou domínio privado aparece em arquivos versionados.
- Confirmar que `/admin` não é liberado apenas com `API_KEY`.
- Confirmar que `/admin.html` também não fica acessível sem passar pela autenticação esperada.
- Confirmar que `API_KEY` é tratada como secret e separada por ambiente.
- Confirmar que a coleta de analytics não persiste `Referer`, `User-Agent` nem IP puro.
- Confirmar que `IP_HASH_SECRET` é tratado como secret opcional e não aparece em arquivos versionados com valor real.
- Confirmar que os assets visuais mantêm a atribuição ao projeto original.

## Sugestão de tag e release

- Tag: `v1.0.0`
- Título: `BoltLink 1.0.0`

## Sugestão de texto curto para a release

`Release de refinamento do BoltLink com UI do admin mais consistente, microinterações leves, rollback de exclusão no painel e a base operacional pública já consolidada em Cloudflare Workers.`

## Observação operacional

Se o projeto for usar ambientes nomeados no Wrangler depois da publicação, replique explicitamente `vars`, bindings e secrets por ambiente. Esses blocos não são herdados automaticamente.

No fluxo one-click, documente sempre quais etapas continuam manuais após o botão: principalmente Access, segredos opcionais e domínio próprio.
