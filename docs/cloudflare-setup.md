# Setup na Cloudflare

Este guia cobre as três formas de operar o BoltLink na release atual **`3.0.0`**:

- `Wrangler local`
- `AI-guided setup`
- `Deploy to Cloudflare Workers`

## Premissas da release atual (v3.0.0)

- `wrangler.jsonc` continua sendo o template público
- `wrangler.local.jsonc` continua sendo a configuração privada local
- `observability.enabled` fica `false` por padrão
- `upload_source_maps` fica `false` por padrão
- não existe mais `IP_HASH_SECRET`
- a contagem é apenas agregada em `clicks_total`

## Bases de código

| Base | Migrations | Recursos extras |
| --- | --- | --- |
| **Release atual publicada** (`3.0.0`, tag `v3.0.0`, commit `60c8575`) | `0000` a `0006` | Split Test A/B + Smart Routing + destino de expiração + `ROOT_REDIRECT_URL` + hierarquia de grupos + portabilidade de configuração (exportação e importação) + QR Code com preview e download PNG/SVG no painel |
| Release anterior (tag `v2.2.1`, `8b3895e`) | `0000` a `0003` | — |
| Fase 2 (checkpoint histórico, `23353a1`) | `0000` a `0004` | Split Test A/B |
| Fase 3 (checkpoint congelado, `548f179`) | `0000` a `0005` | Fase 2 + Smart Routing |
| Fase 4 (checkpoint congelado, `cdb9f83`) | `0000` a `0006` | Fase 3 + destino de expiração + `ROOT_REDIRECT_URL` |
| Fase 5 (checkpoint pre-freeze, `3670a44` sobre `cdb9f83`) | `0000` a `0006` (sem migration nova) | Fase 4 + hierarquia de grupos + portabilidade + QR Code — evoluiu para a `3.0.0` |

Os fluxos desta página seguem a release atual. A hierarquia de grupos, a portabilidade de configuração e o QR Code não acrescentam migration sobre a `0006`: a primeira usa `link_groups.parent_id`, criado pela `0002`; a segunda lê colunas existentes e grava links/grupos como qualquer criação pelo painel; o QR usa os endpoints e a coluna `has_qrcode` que existem desde a base publicada.

## Fluxo A: Wrangler local (release atual v3.0.0)

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
npm run dev-prepare
```

`npm run dev-prepare` faz parte da release `3.0.0` e aplica a cadeia completa (`0000` a `0006`) no D1 local do Wrangler (`.wrangler/state/v3/d1`). O comando por nome de banco também continua disponível:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

5. Para D1 remoto / upgrade:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

6. Rodar:

```bash
npm run dev
npm test
```

### Procedimento histórico: checkout da release anterior (v2.2.1)

A tag `v2.2.1` é a release anterior, mantida aqui como referência de lineage. Naquele checkout a cadeia de migrations termina na `0003_lgpd_minimization.sql` e o script de preparação local do D1 não existe, então a cadeia é aplicada manualmente:

```bash
npm install
npm run setup
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run dev
npm test
```

## Fluxo local de desenvolvimento (release atual v3.0.0)

No desenvolvimento local da release `3.0.0`, o script `npm run dev-prepare` aplica a cadeia completa de migrations (`0000` a `0006`) no D1 local do Wrangler (`.wrangler/state/v3/d1`):

```bash
npm run dev-prepare
npm run dev
```

Os checkpoints históricos de desenvolvimento aplicavam cadeias mais curtas no mesmo script: o baseline local da Fase 2 (`23353a1`) parava na `0004`, o HEAD congelado da Fase 3 (`548f179`) na `0005` e o HEAD congelado da Fase 4 (`cdb9f83`) na `0006` — essas fases são origem histórica dos recursos, publicados juntos na `3.0.0`.

## Fluxo B: AI-guided setup

Use `AI-START.md` como entrada única.

Pedidos recomendados:

- `Iniciar o Projeto`
- `Atualizar o Projeto`
- `Auditar estado operacional`
- `Aplicar migrations`

> Escopo: release atual = **`3.0.0`** (migrations `0000` a `0006`). Não instrua operadores de um checkout histórico da tag `v2.2.1` a procurar migrations ou recursos que não existem nela; para aquele checkout, o procedimento é o histórico do Fluxo A.

No checkout da release atual, o pedido de atualização deve:

1. verificar `git status --short`
2. preservar `wrangler.local.jsonc` e overlays do projeto
3. atualizar dependências
4. rodar `npm run wrangler:init`
5. aplicar as migrations pendentes no D1 (local com `npm run dev-prepare`; remoto com `npm run wrangler -- d1 migrations apply ... --remote -c wrangler.local.jsonc`); vindo da release anterior `v2.2.1`, as pendentes são `0004` a `0006` e a `0003_lgpd_minimization.sql` é a última daquela release.
6. rodar `npm test`

## Recursos da release 3.0.0 e migrations

### Smart Routing e migration 0005 (origem Fase 3)

> Escopo: release `3.0.0` (migration `0005`, introduzida originalmente na Fase 3 e publicada desde a `3.0.0`). Um checkout da tag `v2.2.1` não contém o Smart Routing nem a migration `0005_smart_routing.sql`.

Na release atual:

- aplique também a `0005_smart_routing.sql` antes de configurar Smart Routing (em instalação vinda da `v2.2.1`, ela é uma das pendentes do fluxo de upgrade);
- valide `GET /api/capabilities` com `smartRouting: true`;
- configure Smart Routing no Admin.

### Destino de expiração, `ROOT_REDIRECT_URL` e migration 0006 (origem Fase 4)

> Escopo: release `3.0.0` (migration `0006`, introduzida originalmente na Fase 4 e publicada desde a `3.0.0`). Um checkout da tag `v2.2.1` não contém o destino de expiração nem a migration `0006_expired_redirect.sql`.

Na release atual:

- aplique também a `0006_expired_redirect.sql` antes de configurar destino de expiração (a API recusa `expiredRedirectUrl` com `400` em banco pré-`0006`);
- valide `GET /api/capabilities` com `expiredRedirect: true`;
- opcionalmente configure `ROOT_REDIRECT_URL` (nova na `3.0.0`; variável `Text`, não é secret) para redirecionar `GET /`; ausente ou inválida, a landing normal é servida — valide a configuração após o deploy.

### Hierarquia de grupos, portabilidade de configuração e QR Code (origem Fase 5, sem migration)

> Escopo: release `3.0.0`, sem migration nova sobre a `0006` (recursos introduzidos originalmente na Fase 5 e publicados desde a `3.0.0`).

Na release atual:

- **não há etapa de migration nem binding novo**: a hierarquia usa `link_groups.parent_id`, criado pela `0002`, e o export apenas lê colunas existentes. As mesmas etapas do Fluxo A/B/C valem, sem passo adicional;
- `npm run dev-prepare` aplica a cadeia até `0006`; a release `3.0.0` não adiciona `0007`;
- o Admin tem o painel `Grupos` (árvore, criação com grupo pai opcional, mover, excluir), a ação `Exportar configuração` e o drawer `Importar configuração`, e o redirect público continua sem consultar `link_groups`;
- `POST /api/import/preview` e `POST /api/import/apply` ficam no mesmo boundary de `/api` (Cloudflare Access, `requireAdmin` ou chave de API) e no mesmo rate limit administrativo: se a instalação usa Access, nada extra precisa ser configurado além da policy que já cobre `/api/*`. O import não pede binding, secret ou variável nova — links protegidos continuam exigindo apenas `PASSWORD_SESSION_SECRET`;
- `GET /api/export` está protegido pelo mesmo boundary de `/api` (Cloudflare Access, `requireAdmin` ou chave de API) e pelo mesmo rate limit administrativo: se a instalação usa Access, nada extra precisa ser configurado além da policy que já cobre `/api/*`;
- o QR Code do painel (diálogo com preview e downloads em PNG e SVG) usa os endpoints `GET/POST /api/links/:slug/qrcode` e a coluna `has_qrcode`, que existem desde a base publicada: nada de infraestrutura nova. O `POST` que marca `has_qrcode` acontece quando o operador baixa o QR (PNG ou SVG) — preview e copiar link não escrevem nada — e a geração é cold path administrativo que não conta clique nem persiste imagem;
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
- jamais use o valor do `API_KEY` como `PASSWORD_SESSION_SECRET`: a `3.0.0` nao aceita mais o `API_KEY` para sessao de senha, e o secret da senha deve ser dedicado

## Upgrade one-click / GitHub auto-deploy

Para quem já está em produção e recebe atualização por GitHub/Deploy Button:

- o runtime não executa reconciliação de schema; colunas legadas extras são ignoradas e permanecem até uma migration explícita
- ordem suportada: migrations remotas → deploy/atualização do Worker → validação
- para sair da release anterior `v2.2.1` e chegar na atual `3.0.0`, aplique as migrations pendentes no D1 remoto: `npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc`. As pendentes vindo da `v2.2.1` são `0004` a `0006` (a `0003_lgpd_minimization.sql`, que remove `stats`, `last_clicked_at` e `notes`, é a última daquela release)
- a `0004_ab_testing.sql` habilita o Split Test A/B (origem Fase 2), a `0005_smart_routing.sql` habilita Smart Routing (origem Fase 3) e a `0006_expired_redirect.sql` habilita o destino de expiração (origem Fase 4). Nenhuma das três existe no checkout da tag `v2.2.1`; todas foram publicadas na `3.0.0`.
- a hierarquia de grupos, a portabilidade de configuração e o QR Code (origem Fase 5, publicados na `3.0.0`) não acrescentam migration sobre a `0006`: nada além do fluxo acima
- deploy sozinho não deixa a instalação operacional: até aplicar as migrations, API e redirects respondem `503 Database schema is not initialized`
- `wrangler.local.jsonc` não participa desse fluxo e não sobrescreve variáveis do ambiente de GitHub/Workers Builds

## Variaveis e secrets

Nenhuma variável ou secret novo é obrigatório para todas as instalações ao atualizar `v2.2.1` → `3.0.0`: o upgrade obrigatório é backup do D1 + migrations pendentes `0004`–`0006` + deploy/validação. Matriz de variáveis (referência autoritativa com o passo a passo em `docs/upgrading.md`):

| Name | Type | Obrigatória? | Quando | Mudança na 3.0.0? |
| --- | --- | --- | --- | --- |
| `TEAM_DOMAIN` | `Text` | quando o Cloudflare Access está configurado | proteção de `/admin` e `/api` | não — sem mudança |
| `POLICY_AUD` | `Text` | quando o Cloudflare Access está configurado | proteção de `/admin` e `/api` | não — sem mudança |
| `APP_TIMEZONE` | `Text` | opcional | timezone dos campos de agenda; fallback/default `America/Sao_Paulo` | não — sem mudança |
| `PASSWORD_SESSION_SECRET` | `Secret` | apenas quando a instalação usa/cria/serve links protegidos por senha | assinar sessões do gate de senha; a variável já existia na `v2.2.1`, mas lá o `API_KEY` servia de fallback — a `3.0.0` removeu esse fallback e passou a exigir o secret dedicado; se já configurado, preserve o valor existente e **não** gere um novo | **sim** — o fallback de `API_KEY` foi removido (a variável em si já existia) |
| `API_KEY` | `Secret` | opcional | apenas automação administrativa; na `3.0.0` não assina mais sessão do gate de senha | não — segue opcional (perdeu o papel de fallback de sessão) |
| `ROOT_REDIRECT_URL` | `Text` | opcional | apenas para quem quer redirect de `GET /` (`302` + `no-store`, sem D1); ausente/inválida serve a landing | **sim** |

- `TEAM_DOMAIN` e `POLICY_AUD` sao `Text`
- `API_KEY` e `PASSWORD_SESSION_SECRET` sao `Secret`
- `ROOT_REDIRECT_URL` (nova na `3.0.0`) e opcional, do tipo `Text`, e **nao** e secret
- `PASSWORD_SESSION_SECRET` não é obrigatório para a instância inteira, mas é obrigatório para criar, adicionar senha ou servir links protegidos; a variável existia na `v2.2.1` (onde o `API_KEY` podia servir de fallback) e a `3.0.0` removeu esse fallback: uma instalação que usava links protegidos e dependia só do `API_KEY` precisa criar o `PASSWORD_SESSION_SECRET` dedicado **antes** de publicar o Worker da `3.0.0`; links legados sem esse secret respondem HTTP 503

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

Versão 3.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
