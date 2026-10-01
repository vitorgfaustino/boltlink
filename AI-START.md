# AI-START

Este arquivo é a entrada única para qualquer IA operar o BoltLink (versão **3.0.0**; a release anterior publicada é `v2.2.1`) com segurança.

O objetivo dele é permitir que a IA:

- inicie um projeto novo corretamente
- atualize uma instalação existente sem quebrar overlays e configuração local
- entenda quando deve parar e entregar handoff manual ao usuário
- saiba como tratar deploy local, GitHub auto-deploy e one-click

Se a IA recebeu apenas este arquivo, ela deve conseguir orientar ou executar o fluxo operacional sem inventar dados sensíveis nem pular checkpoints importantes.

## Leitura obrigatória

Leia nesta ordem antes de agir:

1. `AGENTS.md`
2. `docs/ai-accepted-requests.md`
3. `docs/ai-guided-operations.md`
4. `docs/cloudflare-setup.md`
5. `docs/admin-auth.md`
6. `docs/privacy.md`

## Cinco bases de código (não confundir)

Existem cinco estados distintos. A tag publicada **não** é igual ao baseline local:

| Base | Como identificar | Migrations | Recursos extras |
| --- | --- | --- | --- |
| **Publicada** (`v2.2.1`) | tag real: `git rev-parse v2.2.1` → `8b3895e` | `0000` a `0003` | — |
| **Fase 2 local** | baseline local `23353a1`, **não publicado** | `0000` a `0004` | Split Test A/B |
| **Fase 3 congelada** | HEAD `548f179`, **Unreleased** | `0000` a `0005` | Split Test A/B + Smart Routing |
| **Fase 4 congelada** | HEAD `cdb9f83`, **Unreleased** | `0000` a `0006` | Fase 3 + destino de expiração + `ROOT_REDIRECT_URL` |
| **Fase 5 working tree** | working tree atual sobre `cdb9f83`, **Unreleased** | `0000` a `0006` (sem migration nova) | Fase 4 + hierarquia de grupos + exportação portátil + importação portátil + QR Code com preview e download PNG/SVG no painel |

Não chame o baseline local da Fase 2 de "v2.2.1 publicada": a tag publicada não contém a `0004`, o Split Test A/B, a `0005` nem o Smart Routing, e também não contém o script `npm run dev-prepare`. Também não contém a `0006`, o destino de expiração nem o `ROOT_REDIRECT_URL` da Fase 4, e não contém a integridade de hierarquia de grupos nem a exportação portátil da Fase 5 (a tag tem a tabela `link_groups` desde a `0002`, mas sem validação de ciclo, profundidade, delete ou concorrência, e não existe `GET /api/export`).

Publicada (v2.2.1):

- redirect público por slug
- painel administrativo estático
- D1 para links, grupos e contador agregado
- Cloudflare Access para `/admin`, `/admin.html`, `/api` e `/api/*`
- contagem apenas agregada em `links.clicks_total`
- política pública em `/privacidade`

Phase 2 local (`23353a1`, não publicado):

- Split Test A/B por link (Control A = `target_url`, Variant B = `ab_target_url`), stateless e com contadores agregados
- migration `0004_ab_testing.sql` como fonte autoritativa das colunas A/B

Unreleased / Fase 3 (somente nesta branch de desenvolvimento):

- Smart Routing por país/dispositivo com primeira regra compatível vencendo e fallback no destino principal
- migration `0005_smart_routing.sql`

Unreleased / Fase 4 (HEAD congelado `cdb9f83`):

- destino opcional para links expirados (`expiredRedirectUrl` / `links.expired_redirect_url`): link expirado com destino válido responde `302` + `no-store`, sem destino responde `410` + `no-store`, sem gate de senha, sem roteamento e sem contagem
- redirect opcional da raiz via variável de ambiente `ROOT_REDIRECT_URL` (`GET /` → `302` + `no-store` sem consultar D1)
- migration `0006_expired_redirect.sql`

Unreleased / Fase 5 (working tree atual sobre o HEAD congelado da Fase 4 `cdb9f83`):

- hierarquia de grupos em `link_groups.parent_id`, sem migration nova (a coluna existe desde a `0002`)
- `parentId` é o nome na escrita; `GET /api/groups` continua plano com `parent_id` e o Admin monta a árvore no cliente
- ciclo, profundidade, delete e concorrência decididos em um único statement condicional, nunca com `SELECT` seguido de `UPDATE`/`INSERT`
- exportação administrativa da configuração lógica (`GET /api/export`) no formato `boltlink-portability` v1, somente leitura no request inteiro: sem `password_hash`, sem métricas, sem IDs internos (grupos usam `ref` local e links usam `groupRef`), sem DDL no primeiro request em handle frio (não cria `boltlink_metric_fence`, ao contrário das demais rotas `/api`); não é backup do D1
- importação administrativa da mesma configuração (`POST /api/import/preview` e `POST /api/import/apply`), sem migration nova: o preview é somente leitura e o apply grava o documento em um único `batch` (tudo ou nada), exige nova senha para cada link protegido, bloqueia com `409` colisão de slug, feature que o banco não suporta e árvore acima de 16 níveis, e não restaura métricas
- QR Code com diálogo de preview e download PNG/SVG no painel: o QR codifica apenas a short URL pública (nunca o destination nem segredos), a geração é cold path administrativo que não conta clique nem persiste imagem, e `has_qrcode` continua sendo memória operacional escrita só quando o operador baixa o QR em PNG ou SVG — preview e copiar link não escrevem nada (Unreleased / Fase 5; os endpoints e a coluna existem desde a base publicada)

### Status de desenvolvimento (Fase 5 congelada; Phase 6 em andamento)

- Baseline pre-freeze: `3670a44619751a80e6de61e0c928b080d99c0cb6` (`feat: add SVG QR download and polish dialog`), sobre o HEAD congelado da Fase 4 `cdb9f83`. A versão desta release é **`3.0.0`** (o `package.json` está em `3.0.0`).
- Gates congelados da Fase 5 (não reimplementar, não reabrir sem finding concreto): Gate 5.1 hierarquia de grupos (`a82dda5`), Gate 5.2 export portátil (`d8bb407`), microfix do Groups Drawer (`6de22f2`), Gate 5.3 import portátil (`d3f8818`), Gate 5.4 workflow de QR Code (`fe705fc`), Gate 5.4.1 QR UX + downloads PNG/SVG (`3670a44`).
- Gate 5.5 (integração final e freeze de documentação): **FROZEN**. Fecha o finding BL-54-04 e reconcilia a documentação, sem feature nova, sem migration, sem bump de versão, sem tag e sem deploy.
- Com o freeze do Gate 5.5, a Fase 5 está **FEATURE FROZEN**: nenhuma feature adicional deve ser iniciada, e a Phase 6 não pode ser iniciada dentro de um gate da Fase 5.
- **Phase 6 — Release Readiness (em andamento)**: Gate 6.1 (auditoria global final) concluído com P0 = 0, P1 = 0 e P2 = 0; Gate 6.2 (correção dos blockers) concluído, fechando BL-61-01 e BL-61-02; Gate 6.3 (version finalization) **FINALIZED LOCALLY**, com a versão `3.0.0` finalizada (e os P3 BL-61-03, BL-61-04 e o wording "nullable" de `docs/upgrading.md` fechados); Gate 6.4 (local release commit) **FINALIZED LOCALLY** — commit local de preparação da release `6847e47` (`release: prepare 3.0.0`), sobre o pre-release baseline `04a6873`; Gate 6.5A (publication preflight): **RECLASSIFIED** — BL-65A-01 é **NOT APPLICABLE** (o finding assumia uma instalação canônica Cloudflare/D1 vinculada ao repositório-base, e ela não existe), e BL-65A-02 (wording de release não publicada no commit de preparação) foi fechado no Gate 6.5B; Gate 6.5B (final publication metadata) **FINALIZED LOCALLY** — a metadata de publicação final está neste commit, que é o alvo da tag `v3.0.0`. Estado: **NOT TAGGED / NOT PUSHED**. Next: GitHub publication (tag `v3.0.0`, push de `main` e da tag, GitHub Release).
- **Modelo de distribuição da release do repositório**: source commit + tag `v3.0.0` + push + GitHub Release. Não existe Worker, D1, hostname, Cloudflare Account, deploy ou migration remota oficiais: cada instalação é self-hosted e executa o próprio backup, as próprias migrations e o próprio deploy. Cloudflare login **não** é requisito para publicar o repositório.
- Ao retomar o trabalho, o estado é: **Phase 5 FEATURE FROZEN**, Phase 6 com a **metadata de publicação finalizada** aguardando a publicação no GitHub (tag `v3.0.0` + push + GitHub Release), **versão `3.0.0`**. Não invente SHA futuro; e publicar a tag não significa que instalações foram atualizadas — deploy e migrations são por instalação.
- A dívida técnica `TS7016` do módulo `qrcode` foi **aceita para a 3.0.0** como **não bloqueante**.

O produto não mantém:

- `stats`
- `IP_HASH_SECRET`
- `last_clicked_at`
- `notes`
- IP persistido
- hash estável de IP
- país por visitante
- dispositivo derivado por visitante
- regra de Smart Routing selecionada
- `Referer` persistido
- `User-Agent` persistido

## Regras fixas

- `wrangler.jsonc` é o template público
- `wrangler.local.jsonc` é a configuração privada local
- não criar `wrangler.toml`
- não automatizar a criação final do Cloudflare Access
- não sobrescrever branding e overlays do usuário sem confirmação
- não reintroduzir `stats`, `IP_HASH_SECRET`, `last_clicked_at` ou `notes`
- para redução de tráfego no Worker, usar `docs/free-plan-traffic.md` e priorizar opções gratuitas
- o slug continua imutável
- o redirect público continua respondendo antes da contagem
- redirects públicos usam `Referrer-Policy: strict-origin`
- admin, API, home, gate de senha e respostas não redirect usam `Referrer-Policy: no-referrer`
- sempre que fizer um bump de versão (ex: editar `package.json`), procure por strings da versão antiga nos arquivos de teste (`test/index.spec.ts`) e atualize-as, rodando `npm test` para garantir que as asserções não quebrem.
- `migrations/` é a autoridade do schema; o runtime não cria colunas, não executa `schema.sql` e não aplica migrations implicitamente
- Smart Routing e Split Test A/B são mutuamente exclusivos; links com Smart Routing usam sempre `302` + `Cache-Control: no-store`
- Smart Routing usa `links.smart_routing_rules` (JSON em linha), com um único SELECT e sem tabela auxiliar, JOIN ou API externa
- país, User-Agent, dispositivo derivado e regra selecionada nunca são persistidos; Smart Routing não tem contador por regra
- configuração Smart Routing persistida e ilegível é corrupção **preservada**, não "desativada": a API informa `smartRoutingStatus: "invalid"` (sem expor o valor cru), edições não relacionadas não podem apagá-la e só uma ação explícita de limpeza grava `NULL`
- o lifecycle vence senha, A/B e Smart Routing: link expirado com destino válido responde `302` + `no-store`, sem destino responde `410` + `no-store`, e requests expirados não contam clique nem gravam no banco (Fase 4)
- `ROOT_REDIRECT_URL` é opcional e não secreta: válida faz `GET /` responder `302` + `no-store` sem tocar D1; ausente/inválida serve a landing; unknown slugs continuam `404` (Fase 4)
- para desenvolvimento local do Worker **nas bases locais (Fase 2, Fase 3 e Fase 4)**, rode `npm run dev-prepare` (migrations no D1 do Wrangler) antes de `npm run dev`; no checkout da tag `v2.2.1` esse script não existe, use `npm run wrangler -- d1 migrations apply ... --local`

## Como interpretar pedidos

Use apenas intenções compatíveis com `docs/ai-accepted-requests.md`.

As principais são:

- `Iniciar o Projeto`
- `Continuar configuração do projeto`
- `Atualizar o Projeto`
- `Aplicar migrations`
- `Auditar estado operacional`
- `Publicar no workers.dev`
- `Publicar com o botão da Cloudflare`
- `Preparar Access`

Se o pedido vier em linguagem natural, primeiro mapeie para uma dessas intenções antes de executar qualquer ação.

## Pergunta obrigatória antes de publicação ou atualização

A IA deve sempre perguntar ou descobrir:

`Como você publica o projeto?`

Métodos aceitos:

1. `GitHub auto-deploy`
2. `Deploy local com Wrangler`
3. `Ambos`
4. `Primeira publicação`

Essa resposta muda:

- onde `TEAM_DOMAIN` e `POLICY_AUD` vivem
- se a migration remota será executada por CLI ou só orientada
- se a atualização depende de `git pull` local ou de push para o GitHub

## Árvore de decisão para iniciar um projeto

Antes de qualquer `npm install`, a IA deve descobrir:

1. a pasta atual já é a raiz final do projeto?
2. a pasta atual já possui `.git` do usuário?
3. os arquivos do BoltLink já estão presentes nessa raiz?

Regras:

- se a pasta atual já for a raiz final do usuário com `.git`, nunca criar clone aninhado
- se a IA precisar obter o projeto do upstream, usar origem temporária fora da árvore final
- nunca deixar `.git` do upstream dentro do projeto final do usuário
- se a pasta final já estiver preenchida, ler antes de sobrescrever qualquer coisa

Fluxo para `Iniciar o Projeto`:

1. confirmar a raiz final
2. verificar se já existe `.git`
3. obter o conteúdo do projeto sem clone aninhado
4. rodar `npm install`
5. rodar `npm run setup`
6. se o usuário quiser banco explícito, criar D1 com `npm run wrangler -- d1 create ... --update-config`
7. aplicar migrations locais (nas bases locais da Fase 2/Fase 3/Fase 4: `npm run dev-prepare`; no checkout da tag `v2.2.1`: `npm run wrangler -- d1 migrations apply ... --local`)
8. se o destino for remoto, aplicar as migrations no D1 (`--remote -c wrangler.local.jsonc`) antes de publicar/validar; no Deploy Button, o provisionamento inicial **não** substitui esse passo
9. rodar `npm test`
10. parar antes da criação final do Access

Se o pedido for iniciar o projeto apenas localmente para testes manuais, a IA deve preparar o D1 local do Worker **antes** de `npm run dev`:

```bash
npm run dev-prepare   # existe apenas nas bases locais (Fase 2, Fase 3 e Fase 4)
```

`npm run dev-prepare` aplica as migrations no D1 local usado pelo `wrangler dev` (`.wrangler/state/v3/d1`). Sem isso o Worker responde `503 Database schema is not initialized`. No checkout da tag `v2.2.1` esse script não existe; use `npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local`.

Opcionalmente, para navegação/experimentação com um SQLite auxiliar:

```bash
npm run dev-init
```

Esse comando cria `.dev-env/db.sqlite3` (migrations + seed) e **não** é o banco do Worker. O diretório `.dev-env/` é ignorado pelo Git e não deve ser tratado como artefato versionado.

## Fluxo para atualizar instalações existentes

Esse fluxo precisa cobrir tanto instalações novas quanto legadas.

Quando o pedido for `Atualizar o Projeto`, a IA deve:

1. rodar `git status --short`
2. identificar mudanças locais que precisam ser preservadas
3. preservar explicitamente:
   - `wrangler.local.jsonc`
   - `public/admin.html`
   - `public/logo.png`
   - `public/favicon.ico`
   - valores individualizados do `wrangler.jsonc`, se o projeto derivado já os tiver alterado
4. verificar como o projeto publica
5. se estiver seguro, rodar `git pull --ff-only`
6. rodar `npm install`
7. rodar `npm run wrangler:init`
8. aplicar migrations locais (`npm run dev-prepare` nas bases locais; `npm run wrangler -- d1 migrations apply ... --local` no checkout da tag `v2.2.1`)
9. se o deploy remoto for operado por CLI: aplicar as migrations remotas (`--remote -c wrangler.local.jsonc`) e só então publicar com `npm run deploy`
10. se o deploy for GitHub auto-deploy ou Deploy Button: após o provisionamento/deploy inicial, aplicar as migrations remotas antes de validar; deploy sozinho não deixa a instalação operacional (`503 Database schema is not initialized`)
11. rodar `npm test`

## Upgrade específico para legados anteriores à v2.0.0

Projetos antigos podem ainda conter:

- tabela `stats`
- colunas `last_clicked_at` e `notes`
- documentação ou config anterior à baseline LGPD

Nesses casos:

- a migration relevante é `migrations/0003_lgpd_minimization.sql`
- o runtime não executa reconciliação de schema; colunas legadas extras são ignoradas e permanecem até uma migration explícita
- a migration `0003_lgpd_minimization.sql` continua sendo o caminho suportado

Comandos:

Migration local:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

Migration remota:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

## Diferença entre os três modos de operação

### 1. Wrangler local

Usado quando o operador publica manualmente da própria máquina.

Fluxo mínimo:

```bash
npm install
npm run setup
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run dev
npm test
```

### 2. AI-guided setup

A IA deve:

- mapear o pedido para uma intenção aceita
- perguntar só o dado faltante seguinte
- explicar qualquer comando mutável antes de rodar
- parar nos checkpoints manuais da Cloudflare

### 3. One-click / GitHub auto-deploy

O botão e o auto-deploy continuam usando `wrangler.jsonc`.

O provisionamento/deploy inicial **não** prepara o schema D1. Até as migrations serem aplicadas, `/api/*` e os redirects respondem `503 Database schema is not initialized`.

Depois do deploy/provisionamento:

1. aplicar as migrations no D1 remoto: `npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc`
2. validar `workers.dev` (API e redirect)
3. configurar Access para `/admin`, `/admin.html`, `/api` e `/api/*`
4. preencher `TEAM_DOMAIN` e `POLICY_AUD`
5. opcionalmente configurar `API_KEY`; configurar `PASSWORD_SESSION_SECRET` se a instância usar links protegidos por senha
6. opcionalmente trocar para domínio próprio

Não existe mais etapa de publicar `IP_HASH_SECRET`.

Regras para esses valores:

- se o projeto usa GitHub auto-deploy ou o Deploy Button, `wrangler.local.jsonc` nao deve fornecer `TEAM_DOMAIN`, `POLICY_AUD`, `API_KEY` ou `PASSWORD_SESSION_SECRET`
- nesses fluxos, `TEAM_DOMAIN` e `POLICY_AUD` vivem como texto no dashboard e `API_KEY`/`PASSWORD_SESSION_SECRET` vivem como secrets no dashboard
- se o projeto publica com Wrangler local, `TEAM_DOMAIN` e `POLICY_AUD` podem existir em `wrangler.local.jsonc`
- em deploy local, `API_KEY` e `PASSWORD_SESSION_SECRET` devem viver em `.dev.vars` para desenvolvimento ou em secrets do Worker para o ambiente implantado
- `PASSWORD_SESSION_SECRET` pode ficar ausente quando a instância não usa links protegidos; API e admin recusam criar ou adicionar senha sem esse secret

## Checkpoints manuais obrigatórios

A IA deve parar e entregar handoff quando a tarefa depender de:

- criação final do Cloudflare Access
- policy `Allow` do Access
- revisão de DNS/rota no dashboard
- decisão jurídica sobre o conteúdo final da política de privacidade da instância

## Arquivos que a IA deve tratar como canônicos

- `AGENTS.md`
- `AI-START.md`
- `docs/ai-accepted-requests.md`
- `docs/ai-guided-operations.md`
- `docs/cloudflare-setup.md`
- `docs/admin-auth.md`
- `docs/privacy.md`
- `migrations/` (autoridade do schema)
- `schema.sql` (baseline da `0000`, não executado pelo runtime)
- `wrangler.jsonc`

## Comandos de referência

Setup local:

```bash
npm install
npm run setup
```

Setup local com banco SQLite de apoio (bases locais da Fase 2, Fase 3 e Fase 4):

```bash
npm install
npm run setup
npm run dev-prepare   # migrations no D1 local usado pelo Worker (não existe na tag v2.2.1)
npm run dev-init      # opcional: SQLite auxiliar em .dev-env/
npm run dev
```

No checkout da tag `v2.2.1`, substitua `dev-prepare` por `npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local`.

Criar D1 com update do config local:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config
```

Criar D1 com jurisdição:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config --jurisdiction=eu
```

Migration local:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

Migration remota:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

Validação:

```bash
npm test
```

## Resultado esperado

Se a IA seguir este arquivo corretamente, ela deve conseguir:

- iniciar projetos novos sem clone aninhado
- atualizar projetos legados preservando overlays e configs locais
- aplicar migrations corretas da linha `2.0.0`
- respeitar o modelo de publicação do usuário
- parar nos checkpoints manuais corretos

---

Versão 3.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
