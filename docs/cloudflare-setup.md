# Setup na Cloudflare

Este guia cobre as três formas de operar o BoltLink v2.2.1:

- `Wrangler local`
- `AI-guided setup`
- `Deploy to Cloudflare Workers`

## Premissas da v2.2.1

- `wrangler.jsonc` continua sendo o template público
- `wrangler.local.jsonc` continua sendo a configuração privada local
- `observability.enabled` fica `false` por padrão
- `upload_source_maps` fica `false` por padrão
- não existe mais `IP_HASH_SECRET`
- a contagem é apenas agregada em `clicks_total`

## Cinco bases de código

| Base | Migrations | Recursos extras |
| --- | --- | --- |
| Publicada (tag `v2.2.1`, `8b3895e`) | `0000` a `0003` | — |
| Fase 2 local (`23353a1`, não publicado) | `0000` a `0004` | Split Test A/B |
| Fase 3 congelada (`548f179`) | `0000` a `0005` | Split Test A/B + Smart Routing |
| Fase 4 congelada (`cdb9f83`) | `0000` a `0006` | Fase 3 + destino de expiração + `ROOT_REDIRECT_URL` |
| Fase 5 working tree (esta working tree sobre `cdb9f83`) | `0000` a `0006` (sem migration nova) | Fase 4 + hierarquia de grupos + exportação portátil |

Os fluxos publicados abaixo usam apenas comandos que existem na tag. `npm run dev-prepare`, `0004`, `0005` e `0006` pertencem às seções locais. A hierarquia de grupos e a exportação portátil da Fase 5 não acrescentam migration: a primeira usa `link_groups.parent_id`, criado pela `0002`, e a segunda apenas lê colunas existentes.

## Fluxo A: Wrangler local (release publicada v2.2.1)

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

4. Aplicar migrations no D1 local usado pelo Worker. O runtime não cria schema; banco vazio responde `503 Database schema is not initialized`:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

A tag publicada `v2.2.1` aplica `migrations/0000` a `0003` por esse comando. Os recursos das bases locais (Fase 2 e Fase 3) têm seção própria adiante.

5. Para D1 remoto / upgrade:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

6. Rodar:

```bash
npm run dev
npm test
```

## Fluxo local de desenvolvimento (Phase 2 local)

No baseline local da Fase 2 (`23353a1`, não publicado) o script `npm run dev-prepare` aplica a cadeia de migrations (`0000` a `0004`) no D1 local do Wrangler (`.wrangler/state/v3/d1`):

```bash
npm run dev-prepare
npm run dev
```

`dev-prepare` não existe na tag `v2.2.1`; lá use o comando do Fluxo A.

## Fluxo local de desenvolvimento (Unreleased / Fase 3)

No HEAD congelado da Fase 3 (`548f179`), o mesmo `npm run dev-prepare` aplica a cadeia até `migrations/0005`:

```bash
npm run dev-prepare
npm run dev
```

## Fluxo local de desenvolvimento (Unreleased / Fase 4)

Na working tree atual da Fase 4 (sobre `548f179`), o mesmo `npm run dev-prepare` aplica a cadeia até `migrations/0006`:

```bash
npm run dev-prepare
npm run dev
```

## Fluxo B: AI-guided setup

Use `AI-START.md` como entrada única.

Pedidos recomendados:

- `Iniciar o Projeto`
- `Atualizar o Projeto`
- `Auditar estado operacional`
- `Aplicar migrations`

> Escopo: release publicada/baseline = **v2.2.1** (migrations até `0003`). Recursos Phase 2 local e Unreleased / Fase 3 têm seção própria adiante; não instrua operadores de um checkout da tag `v2.2.1` a procurar migrations ou recursos que não existem nela.

No checkout da tag, o pedido de atualização deve:

1. verificar `git status --short`
2. preservar `wrangler.local.jsonc` e overlays do projeto
3. atualizar dependências
4. rodar `npm run wrangler:init`
5. aplicar as migrations pendentes no D1 (local com `npm run wrangler -- d1 migrations apply ... --local`; remoto com `--remote -c wrangler.local.jsonc`); a `0003_lgpd_minimization.sql` remove `stats`, `last_clicked_at` e `notes` e é a última migration da release publicada `v2.2.1`.
6. rodar `npm test`

Nas bases locais (Fase 2 e Fase 3), substitua o passo 5 por `npm run dev-prepare`, que aplica a cadeia até a `0004` ou a `0005` conforme a base.

## Unreleased / Fase 3 (próxima release)

> Escopo: release publicada/baseline = **v2.2.1**. Esta seção descreve somente a branch de desenvolvimento; um checkout da tag `v2.2.1` não contém o Smart Routing nem a migration `0005_smart_routing.sql`.

Na branch de desenvolvimento:

- aplique também a `0005_smart_routing.sql` antes de configurar Smart Routing;
- valide `GET /api/capabilities` com `smartRouting: true`;
- configure Smart Routing no Admin.

## Unreleased / Fase 4 (working tree)

> Escopo: release publicada/baseline = **v2.2.1**. Esta seção descreve somente a working tree da Fase 4 (sobre o HEAD congelado da Fase 3 `548f179`); um checkout da tag `v2.2.1` não contém o destino de expiração nem a migration `0006_expired_redirect.sql`.

Na working tree da Fase 4:

- aplique também a `0006_expired_redirect.sql` antes de configurar destino de expiração (a API recusa `expiredRedirectUrl` com `400` em banco pré-`0006`);
- valide `GET /api/capabilities` com `expiredRedirect: true`;
- opcionalmente configure `ROOT_REDIRECT_URL` (variável `Text`, não é secret) para redirecionar `GET /`; ausente ou inválida, a landing normal é servida — valide a configuração após o deploy.

## Unreleased / Fase 5 (hierarquia de grupos e exportação portátil)

> Escopo: release publicada/baseline = **v2.2.1**. Esta seção descreve somente a working tree da Fase 5 (sobre o HEAD congelado da Fase 4 `cdb9f83`).

Na working tree da Fase 5:

- **não há etapa de migration nem binding novo**: a hierarquia usa `link_groups.parent_id`, criado pela `0002`, e o export apenas lê colunas existentes. As mesmas etapas do Fluxo A/B/C valem, sem passo adicional;
- `npm run dev-prepare` continua aplicando a cadeia até `0006`; a Fase 5 não adiciona `0007`;
- o Admin ganha o painel `Grupos` (árvore, criação com grupo pai opcional, mover, excluir) e a ação `Exportar dados`, e o redirect público continua sem consultar `link_groups`;
- `GET /api/export` está protegido pelo mesmo boundary de `/api` (Cloudflare Access, `requireAdmin` ou chave de API) e pelo mesmo rate limit administrativo: se a instalação usa Access, nada extra precisa ser configurado além da policy que já cobre `/api/*`;
- se a instância já tinha `link_groups.parent_id` editado à mão, valide a árvore antes de confiar no painel: um ciclo existente faz `GET /api/groups` responder `409` (falha fechado, sem reparo automático). Veja `docs/upgrading.md`;
- o contrato de `PATCH /api/groups/:id` exige `expectedParentId` sempre que `parentId` é enviado, e `DELETE /api/groups/:id` só remove grupo sem subgrupos e sem nenhum link (desabilitados incluídos). Automatizações que chamam essas rotas precisam ser atualizadas.

## Fluxo C: Deploy to Cloudflare Workers

O botão continua usando `wrangler.jsonc`.

O provisionamento/deploy inicial **não** prepara o schema D1. Até as migrations serem aplicadas, `/api/*` e os redirects respondem `503 Database schema is not initialized`.

Depois do deploy/provisionamento:

1. aplique as migrations no D1 remoto: `npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc`
2. valide `workers.dev` (API e redirect)
3. configure Cloudflare Access para `/admin`, `/admin.html`, `/api` e `/api/*`
4. preencha `TEAM_DOMAIN` e `POLICY_AUD`
5. opcionalmente configure `API_KEY`; configure `PASSWORD_SESSION_SECRET` se a instância usar links protegidos por senha
6. opcionalmente troque para domínio próprio

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

Para quem já está em produção e recebe atualização por GitHub/Deploy Button:

- o runtime não executa reconciliação de schema; colunas legadas extras são ignoradas e permanecem até uma migration explícita
- ordem suportada: migrations remotas → deploy/atualização do Worker → validação
- aplique as migrations pendentes no D1 remoto (a `0003_lgpd_minimization.sql` remove `stats`, `last_clicked_at` e `notes` e é a última migration da release publicada `v2.2.1`): `npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc`
- **Phase 2 local:** a `0004_ab_testing.sql` habilita o Split Test A/B e não existe no checkout da tag `v2.2.1`
- **Unreleased / Fase 3:** a `0005_smart_routing.sql` habilita Smart Routing e também não existe no checkout da tag `v2.2.1`
- **Unreleased / Fase 4:** a `0006_expired_redirect.sql` habilita o destino de expiração e também não existe no checkout da tag `v2.2.1`
- deploy sozinho não deixa a instalação operacional: até aplicar as migrations, API e redirects respondem `503 Database schema is not initialized`
- `wrangler.local.jsonc` não participa desse fluxo e não sobrescreve variáveis do ambiente de GitHub/Workers Builds

## Variaveis e secrets

- `TEAM_DOMAIN` e `POLICY_AUD` sao `Text`
- `API_KEY` e `PASSWORD_SESSION_SECRET` sao `Secret`
- `ROOT_REDIRECT_URL` (Unreleased / Fase 4) e opcional, do tipo `Text`, e **nao** e secret
- `PASSWORD_SESSION_SECRET` não é obrigatório para a instância inteira, mas é obrigatório para criar, adicionar senha ou servir links protegidos; links legados sem esse secret respondem HTTP 503

## Operacao no plano gratuito

Para reduzir solicitacoes desnecessarias sem depender de WAF pago:

- use dominio proprio em producao quando possivel
- no `wrangler.local.jsonc` da instancia real, defina `workers_dev: false`
- defina `preview_urls: false` para evitar URLs publicas de preview
- avalie Bot Fight Mode no painel Cloudflare
- mantenha admin e API atras de Cloudflare Access
- acompanhe `Security > Events` antes de bloquear pais ou origem inteira

Detalhes e fontes oficiais ficam em `docs/free-plan-traffic.md`.

## Observabilidade e logs

Por padrão, o template público não persiste logs do Worker.

Se o operador reativar logs, Logpush, source maps ou outra telemetria externa, isso passa a ser responsabilidade operacional dele.

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
