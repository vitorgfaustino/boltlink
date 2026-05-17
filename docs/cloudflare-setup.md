# Setup na Cloudflare

Este guia cobre as três formas de operar o BoltLink v2.0.0:

- `Wrangler local`
- `AI-guided setup`
- `Deploy to Cloudflare Workers`

## Premissas da v2.0.0

- `wrangler.jsonc` continua sendo o template público
- `wrangler.local.jsonc` continua sendo a configuração privada local
- `observability.enabled` fica `false` por padrão
- `upload_source_maps` fica `false` por padrão
- não existe mais `IP_HASH_SECRET`
- a contagem é apenas agregada em `clicks_total`

## Fluxo A: Wrangler local

1. `npm install`
2. `npm run setup`
3. Se for criar banco novo explicitamente:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config
```

Se precisar de jurisdição D1 na criação:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config --jurisdiction=eu
```

4. Aplicar migrations:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

5. Para upgrade remoto:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

6. Rodar:

```bash
npm run dev
npm test
```

## Fluxo B: AI-guided setup

Use `AI-START.md` como entrada única.

Pedidos recomendados:

- `Iniciar o Projeto`
- `Atualizar o Projeto`
- `Auditar estado operacional`
- `Aplicar migrations`

Na v2.0.0, o pedido de atualização deve:

1. verificar `git status --short`
2. preservar `wrangler.local.jsonc` e overlays do projeto
3. atualizar dependências
4. rodar `npm run wrangler:init`
5. aplicar `0003_lgpd_minimization.sql` no D1 quando o ambiente ainda estiver em schema antigo
6. rodar `npm test`

## Fluxo C: Deploy to Cloudflare Workers

O botão continua usando `wrangler.jsonc`.

Depois do deploy:

1. valide `workers.dev`
2. configure Cloudflare Access para `/admin`, `/admin.html`, `/api` e `/api/*`
3. preencha `TEAM_DOMAIN` e `POLICY_AUD`
4. opcionalmente configure `API_KEY` e `PASSWORD_SESSION_SECRET`
5. opcionalmente troque para domínio próprio

Não existe mais etapa de publicar `IP_HASH_SECRET`.

Se voce nao usa links protegidos por senha, `PASSWORD_SESSION_SECRET` pode ficar ausente.
Se voce usa GitHub auto-deploy ou o Deploy Button, configure `TEAM_DOMAIN` e `POLICY_AUD` como texto no dashboard e `PASSWORD_SESSION_SECRET` como `Secret`.
Se voce publica com Wrangler local, `TEAM_DOMAIN` e `POLICY_AUD` podem existir no `wrangler.local.jsonc`, mas `PASSWORD_SESSION_SECRET` deve ficar em `.dev.vars` para desenvolvimento e em Cloudflare Secret para o Worker implantado.

Comandos simples para gerar `PASSWORD_SESSION_SECRET` e `API_KEY`:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

Sugestao:

- gere um valor para `PASSWORD_SESSION_SECRET`
- gere outro valor diferente para `API_KEY`
- nao reutilize o mesmo token para os dois bindings

## Upgrade one-click / GitHub auto-deploy

Para quem já está em produção e recebe atualização por GitHub:

- o código novo já reconcilia schema legado em runtime
- ainda assim, a forma recomendada é aplicar a migration `0003_lgpd_minimization.sql`
- o efeito do upgrade é remover `stats`, `last_clicked_at` e `notes`
- `wrangler.local.jsonc` não participa desse fluxo e não sobrescreve variáveis do ambiente de GitHub/Workers Builds

## Variaveis e secrets

- `TEAM_DOMAIN` e `POLICY_AUD` sao `Text`
- `API_KEY` e `PASSWORD_SESSION_SECRET` sao `Secret`
- `PASSWORD_SESSION_SECRET` nao e obrigatorio para a instancia inteira; ele so e recomendado quando houver links protegidos por senha em producao

## Observabilidade e logs

Por padrão, o template público não persiste logs do Worker.

Se o operador reativar logs, Logpush, source maps ou outra telemetria externa, isso passa a ser responsabilidade operacional dele.

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
