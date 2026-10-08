# Setup na Cloudflare

## Release publicada — 3.2.1

A **3.2.1 está publicada**, identificada pela tag **v3.2.1**; é a release atual e latest do repositório. A release anterior **v3.2.0** permanece congelada. Esta versão de manutenção acrescenta preflight D1, seleção consistente da configuração Wrangler, merge por identidade de binding e comparação obrigatória das configurações no upgrade. Mantém os recursos de links e o Admin refinado da 3.2.0. **MIGRATION_0007 = NOT REQUIRED**; migrations `0000`–`0006` e schema preservados. Nenhum secret obrigatório novo ou atualização automática de instalações.

Publicar tag/release é **source distribution** e não opera Cloudflare de clientes. Cada instalação executa o próprio `npm run deploy`, que aplica apenas migrations pendentes antes do Worker, e configura seu próprio Access. O guia completo está em [Cloudflare Access](admin-auth.md).

A correção de compatibilidade da mesma 3.1.1 substitui apenas pontos e vírgulas em comentários das migrations históricas para o parser remoto D1/Wrangler. O SQL executável, o schema e os nomes `0000`–`0006` permanecem inalterados. Instalações novas usam os arquivos corrigidos; bancos que já registraram a cadeia não reaplicam essas migrations. A correção integra a v3.1.1 republicada e congelada. O fresh install D1 remoto foi validado pelo usuário, e o CI da main e da tag passou. Um segundo deploy não é requisito da release source distribution.

## Recursos preservados desde a 3.1.0

A **3.1.0**, release histórica congelada na tag **v3.1.0**, introduziu os recursos abaixo. A tag histórica **v3.0.0** também permanece congelada. A 3.1.0 adiciona Lixeira, restauração validada, exclusão definitiva com reutilização de slug e limpeza administrativa explícita com preview e retenção de 90 dias. Não há Cron automático. O export passa a conter somente links ativos; tombstones ficam fora do documento e dos limites de links, enquanto ativos inválidos continuam fail-closed. Import v1 legado com `disabled: true` continua aceito. **MIGRATION_0007 = NOT REQUIRED**; migrations permanecem `0000`–`0006`.

Contrato completo e operação no Admin: [Lixeira e recuperação](trash-recovery.md). Os procedimentos correntes abaixo seguem a release `3.2.1`; a tag `v3.1.0` conserva o procedimento histórico sem migrations automáticas. Publicar código no Git/GitHub não atualiza instalações: deploy, D1 remoto e Access exigem autorização própria por instalação.


Este guia cobre as três formas de operar este checkout da release **`3.2.1`**:

- `Wrangler local`
- `AI-guided setup`
- `Deploy to Cloudflare Workers`

## Premissas da release atual (v3.2.1)

O upgrade **3.2.0 → 3.2.1** acrescenta preflight D1 e comparação segura de configurações, sem migration nova, e preserva o apply de pendentes antes do Worker. O Admin mantém filtro recursivo, caminhos completos e edição sincronizada de UTMs; `ROOT_REDIRECT_URL` continua como Text opcional no setup inicial. **MIGRATION_0007 = NOT REQUIRED**. Para instalações anteriores, aplique somente as migrations ainda pendentes conforme [Upgrading](upgrading.md).

- `wrangler.jsonc` continua sendo o template público
- `wrangler.local.jsonc` continua sendo a configuração privada local
- `observability.enabled` fica `false` por padrão
- `upload_source_maps` fica `false` por padrão
- não existe mais `IP_HASH_SECRET`
- a contagem é apenas agregada em `clicks_total`

## Bases de código

| Base | Migrations | Recursos extras |
| --- | --- | --- |
| **Release atual publicada** (`3.2.1`, tag `v3.2.1`) | `0000` a `0006` | Split Test A/B + Smart Routing + destino de expiração + `ROOT_REDIRECT_URL` + hierarquia de grupos + portabilidade de configuração (exportação e importação) + QR Code com preview e download PNG/SVG no painel |
| Baseline histórico do upgrade (tag `v2.2.1`, `8b3895e`) | `0000` a `0003` | — |
| Fase 2 (checkpoint histórico, `23353a1`) | `0000` a `0004` | Split Test A/B |
| Fase 3 (checkpoint congelado, `548f179`) | `0000` a `0005` | Fase 2 + Smart Routing |
| Fase 4 (checkpoint congelado, `cdb9f83`) | `0000` a `0006` | Fase 3 + destino de expiração + `ROOT_REDIRECT_URL` |
| Fase 5 (checkpoint pre-freeze, `3670a44` sobre `cdb9f83`) | `0000` a `0006` (sem migration nova) | Fase 4 + hierarquia de grupos + portabilidade + QR Code — evoluiu para a `3.0.0` |

Os fluxos desta página seguem a release 3.2.1. A hierarquia de grupos, a portabilidade de configuração e o QR Code não acrescentam migration sobre a `0006`: a primeira usa `link_groups.parent_id`, criado pela `0002`; a segunda lê colunas existentes e grava links/grupos como qualquer criação pelo painel; o QR usa os endpoints e a coluna `has_qrcode` que existem desde a base publicada.

## Fluxo A: Wrangler local (release v3.2.1)

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

5. Para deploy remoto autorizado da release 3.2.1, após backup e conferência do D1 em `wrangler.local.jsonc`:

```bash
npm run deploy
```

O script aplica somente migrations pendentes pelo binding `db_boltlink` antes de publicar o Worker. Para inspeção/manutenção, a operação manual continua disponível:

```bash
npm run wrangler -- d1 migrations apply db_boltlink --remote
```

6. Rodar:

```bash
npm run dev
npm test
```

### Procedimento histórico: checkout da release histórica (v2.2.1)

A tag `v2.2.1` é a release histórica, mantida aqui como referência de lineage. Naquele checkout a cadeia de migrations termina na `0003_lgpd_minimization.sql` e o script de preparação local do D1 não existe, então a cadeia é aplicada manualmente:

```bash
npm install
npm run setup
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run dev
npm test
```

## Fluxo local de desenvolvimento (release v3.2.1)

No desenvolvimento local da release `3.2.1`, o script `npm run dev-prepare` aplica a cadeia completa de migrations (`0000` a `0006`) no D1 local do Wrangler (`.wrangler/state/v3/d1`):

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

> Escopo: release atual = **`3.2.1`** (migrations `0000` a `0006`). Não instrua operadores de um checkout histórico da tag `v2.2.1` a procurar migrations ou recursos que não existem nela; para aquele checkout, o procedimento é o histórico do Fluxo A.

No checkout da release atual, o pedido de atualização deve:

1. verificar `git status --short`
2. preservar `wrangler.local.jsonc` e overlays do projeto
3. atualizar dependências
4. rodar `npm run wrangler:init`
5. aplicar as migrations pendentes no D1 (local com `npm run dev-prepare`; remoto com `npm run wrangler -- d1 migrations apply ... --remote -c wrangler.local.jsonc`); vindo da release histórica `v2.2.1`, as pendentes são `0004` a `0006` e a `0003_lgpd_minimization.sql` é a última daquela release.
6. rodar `npm test`

## Recursos publicados desde a 3.0.0 e migrations

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
- opcionalmente configure `ROOT_REDIRECT_URL` (nova na `3.0.0`; variável `Text`, não é secret) para redirecionar `GET /`; ausente ou inválida, a landing normal é servida. Na 3.2.1, o campo aparece no setup inicial do Deploy Button com valor vazio: deixe-o vazio para manter a página inicial. Na tag histórica v3.1.1, adicione a variável no dashboard após o deploy.

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

No checkout da release **3.2.1**, aceite/mantenha `npm run deploy` como Deploy command. O Deploy Button detecta esse script; em Workers Builds já configurado, confira **Settings > Build > Deploy command** e ajuste para `npm run deploy`. Um comando direto `wrangler deploy` não executa o script de migrations.

```text
npm run deploy
  -> npm run db:migrations:apply
     -> node scripts/wrangler.mjs d1 migrations apply db_boltlink --remote
  -> somente após sucesso: node scripts/wrangler.mjs deploy
```

Após provisionar o D1, o fluxo padrão aplica as migrations pendentes antes de publicar o Worker. O binding permanece `db_boltlink` mesmo que o operador escolha outro nome físico. Na release 3.2.1, no Workers Builds (`WORKERS_CI=1`), mesmo com config privado presente, o wrapper usa `wrangler.jsonc` tanto no apply remoto quanto no deploy; na CLI local ambos usam `wrangler.local.jsonc`. `--config` explícito prevalece. Antes de operações remotas, rode o [preflight e a comparação](upgrading.md#upgrade-seguro--321).

Na tag histórica **v3.1.0**, o deploy não aplicava migrations automaticamente; banco vazio exigia aplicação manual e respondia `503 Database schema is not initialized`. A **3.1.1** corrige esse processo. O runtime continua sem aplicar migrations durante requests.

Depois do deploy/provisionamento concluído:

1. valide `workers.dev` (API e redirect)
2. configure [uma única aplicação Access](admin-auth.md) para `/admin`, `/admin/*`, `/admin.html`, `/api` e `/api/*`
3. preencha `TEAM_DOMAIN` e `POLICY_AUD`
4. opcionalmente configure `API_KEY`; configure `PASSWORD_SESSION_SECRET` se a instância usar links protegidos por senha
5. opcionalmente configure domínio próprio

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
- na release 3.2.1, o Deploy command `npm run deploy` aplica migrations pendentes e só então publica o Worker; erro de migration interrompe a publicação
- vindo da `v2.2.1`, as pendentes são `0004` a `0006`; vindo da 3.1.0 com a cadeia aplicada, não há migration a reaplicar
- a `0004_ab_testing.sql` habilita o Split Test A/B (origem Fase 2), a `0005_smart_routing.sql` habilita Smart Routing (origem Fase 3) e a `0006_expired_redirect.sql` habilita o destino de expiração (origem Fase 4). Nenhuma das três existe no checkout da tag `v2.2.1`; todas foram publicadas na `3.0.0`.
- a hierarquia de grupos, a portabilidade de configuração e o QR Code (origem Fase 5, publicados na `3.0.0`) não acrescentam migration sobre a `0006`: nada além do fluxo acima
- na tag histórica v3.1.0, deploy sem preparação manual deixava API e redirects em `503 Database schema is not initialized`; o patch 3.1.1 corrige o fluxo padrão
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

Release atual publicada: 3.2.1 · Tag: v3.2.1 · Release anterior: 3.2.0
Criado por Vitor Faustino - vitorfaustino.com.br
