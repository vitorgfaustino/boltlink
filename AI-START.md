# AI-START

## Release publicada — 3.2.0

A **3.2.0 está publicada**, identificada pela tag **v3.2.0**; é a release atual e latest do repositório. A release anterior **v3.1.1** permanece congelada. Esta versão reúne filtro recursivo de grupos, caminho hierárquico completo nos badges, edição bidirecional de UTMs e `ROOT_REDIRECT_URL` como Text opcional no setup. O Admin traz Light e Dark refinados, cards compactos, badges semânticas e detalhes A/B sob demanda; o README apresenta screenshots atuais e uma demonstração animada com dados fictícios. **MIGRATION_0007 = NOT REQUIRED**; migrations `0000`–`0006` e schema preservados. Veja [Admin UX](docs/admin-ux.md).

Publicar tag/release é **source distribution** e não opera Cloudflare de clientes. Cada instalação executa o próprio `npm run deploy`, que aplica apenas migrations pendentes antes do Worker, e configura seu próprio Access. O guia completo está em [Cloudflare Access](docs/admin-auth.md).

A correção de compatibilidade da mesma 3.1.1 substitui apenas pontos e vírgulas em comentários das migrations históricas para o parser remoto D1/Wrangler. O SQL executável, o schema e os nomes `0000`–`0006` permanecem inalterados. Instalações novas usam os arquivos corrigidos; bancos que já registraram a cadeia não reaplicam essas migrations. A correção integra a v3.1.1 republicada e congelada. O fresh install D1 remoto foi validado pelo usuário, e o CI da main e da tag passou. Um segundo deploy não é requisito da release source distribution.

## Recursos preservados desde a 3.1.0

A **3.1.0**, release histórica congelada na tag **v3.1.0**, introduziu os recursos abaixo. A tag histórica **v3.0.0** também permanece congelada. A 3.1.0 adiciona Lixeira, restauração validada, exclusão definitiva com reutilização de slug e limpeza administrativa explícita com preview e retenção de 90 dias. Não há Cron automático. O export passa a conter somente links ativos; tombstones ficam fora do documento e dos limites de links, enquanto ativos inválidos continuam fail-closed. Import v1 legado com `disabled: true` continua aceito. **MIGRATION_0007 = NOT REQUIRED**; migrations permanecem `0000`–`0006`.

Contrato completo e operação no Admin: [Lixeira e recuperação](docs/trash-recovery.md). Os procedimentos correntes abaixo seguem a release `3.2.0`; a tag `v3.1.0` conserva o procedimento histórico sem migrations automáticas. Publicar código no Git/GitHub não atualiza instalações: deploy, D1 remoto e Access exigem autorização própria por instalação.


Este arquivo é a entrada única para qualquer IA operar o BoltLink (**3.2.0** é a release publicada atual — tag `v3.2.0`, branch `main`; `v3.1.1` é a release anterior e `v2.2.1` é o baseline histórico do upgrade das features) com segurança.

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

## Bases de código (não confundir)

A release atual publicada é a **`3.2.0`**, identificada pela tag `v3.2.0` na branch `main`. A 3.2.0 refina o Admin e o setup e preserva o deploy com migrations pendentes introduzido na 3.1.1, sem migration nova. A tag publicada e `main` devem convergir para o mesmo release commit; essa igualdade é um invariante operacional verificado externamente por Git/GitHub API nos gates de publicação e auditoria pós-publicação, sem exigir um SHA corrente literal neste documento. Ela mantém as migrations `0000` a `0006`, os recursos publicados desde a `3.0.0` e a Lixeira/recuperação introduzidas na `3.1.0`, sem migration nova. As Fases 2–5 são **origem histórica** do que ela publica, não estados ativos de desenvolvimento:

| Base | Como identificar | Migrations | Recursos extras |
| --- | --- | --- | --- |
| **Release atual publicada** (`3.2.0`) | tag `v3.2.0`, branch `main` (convergência verificada no gate de publicação/pós-publicação) | `0000` a `0006` | Lixeira + recuperação + exclusão definitiva/purge manual + export ativo + Split Test A/B + Smart Routing + destino de expiração + `ROOT_REDIRECT_URL` + hierarquia de grupos + exportação portátil + importação portátil + QR Code com preview e download PNG/SVG no painel |
| **Release anterior congelada** (`3.1.1`) | tag `v3.1.1` | `0000` a `0006` | recursos anteriores às melhorias de Admin/setup da 3.2.0; deploy com migrations pendentes |
| **Baseline histórico do upgrade** (`v2.2.1`) | tag real: `git rev-parse v2.2.1` → `8b3895e` | `0000` a `0003` | — |
| Fase 2 (checkpoint histórico) | baseline local `23353a1` | `0000` a `0004` | Split Test A/B |
| Fase 3 (checkpoint congelado) | HEAD `548f179` | `0000` a `0005` | Fase 2 + Smart Routing |
| Fase 4 (checkpoint congelado) | HEAD `cdb9f83` | `0000` a `0006` | Fase 3 + destino de expiração + `ROOT_REDIRECT_URL` |
| Fase 5 (checkpoint pre-freeze) | `3670a44` sobre `cdb9f83` | `0000` a `0006` (sem migration nova) | Fase 4 + hierarquia de grupos + exportação portátil + importação portátil + QR Code — evoluiu para a release `3.0.0` |

Não chame a `v2.2.1` de release atual: a release anterior imediata é `v3.1.1`; `v2.2.1` é o **baseline histórico do upgrade**. A `v2.2.1` não contém a `0004`, o Split Test A/B, a `0005` nem o Smart Routing, e também não contém o script `npm run dev-prepare`. Também não contém a `0006`, o destino de expiração nem o `ROOT_REDIRECT_URL` da Fase 4, e não contém a integridade de hierarquia de grupos nem a exportação portátil da Fase 5 (a tag tem a tabela `link_groups` desde a `0002`, mas sem validação de ciclo, profundidade, delete ou concorrência, e não existe `GET /api/export`).

Release atual publicada (`3.2.0`, tag `v3.2.0`):

- redirect público por slug
- painel administrativo estático
- D1 para links, grupos e contador agregado
- Cloudflare Access para `/admin`, `/admin.html`, `/api` e `/api/*`
- contagem apenas agregada em `links.clicks_total`
- política pública em `/privacidade`
- Split Test A/B por link (Control A = `target_url`, Variant B = `ab_target_url`), stateless e com contadores agregados — origem Fase 2, migration `0004_ab_testing.sql`
- Smart Routing por país/dispositivo com primeira regra compatível vencendo e fallback no destino principal — origem Fase 3, migration `0005_smart_routing.sql`
- destino opcional para links expirados (`expiredRedirectUrl` / `links.expired_redirect_url`): link expirado com destino válido responde `302` + `no-store`, sem destino responde `410` + `no-store`, sem gate de senha, sem roteamento e sem contagem — origem Fase 4, migration `0006_expired_redirect.sql`
- redirect opcional da raiz via variável de ambiente `ROOT_REDIRECT_URL` (`GET /` → `302` + `no-store` sem consultar D1) — origem Fase 4
- hierarquia de grupos em `link_groups.parent_id`, sem migration nova (a coluna existe desde a `0002`) — origem Fase 5
- `parentId` é o nome na escrita; `GET /api/groups` continua plano com `parent_id` e o Admin monta a árvore no cliente — origem Fase 5
- ciclo, profundidade, delete e concorrência decididos em um único statement condicional, nunca com `SELECT` seguido de `UPDATE`/`INSERT` — origem Fase 5
- exportação administrativa da configuração lógica (`GET /api/export`) no formato `boltlink-portability` v1, somente leitura no request inteiro: sem `password_hash`, sem métricas, sem IDs internos (grupos usam `ref` local e links usam `groupRef`), sem DDL no primeiro request em handle frio (não cria `boltlink_metric_fence`, ao contrário das demais rotas `/api`); não é backup do D1 — origem Fase 5
- importação administrativa da mesma configuração (`POST /api/import/preview` e `POST /api/import/apply`), sem migration nova: o preview é somente leitura e o apply grava o documento em um único `batch` (tudo ou nada), exige nova senha para cada link protegido, bloqueia com `409` colisão de slug, feature que o banco não suporta e árvore acima de 16 níveis, e não restaura métricas — origem Fase 5
- QR Code com diálogo de preview e download PNG/SVG no painel: o QR codifica apenas a short URL pública (nunca o destination nem segredos), a geração é cold path administrativo que não conta clique nem persiste imagem, e `has_qrcode` continua sendo memória operacional escrita só quando o operador baixa o QR em PNG ou SVG — preview e copiar link não escrevem nada (origem Fase 5; os endpoints `GET/POST /api/links/:slug/qrcode` e a coluna `has_qrcode` existem desde a base publicada `0001`)

### Histórico dos gates 3.0.0 e publicação 3.1.0

- Baseline pre-freeze da Fase 5: `3670a44619751a80e6de61e0c928b080d99c0cb6` (`feat: add SVG QR download and polish dialog`), sobre o HEAD congelado da Fase 4 `cdb9f83`. Essa linha evoluiu para a release `3.0.0` (essa é a versão histórica; o checkout corrente está na release `3.2.0`).
- Gates congelados da Fase 5 (não reimplementar, não reabrir sem finding concreto): Gate 5.1 hierarquia de grupos (`a82dda5`), Gate 5.2 export portátil (`d8bb407`), microfix do Groups Drawer (`6de22f2`), Gate 5.3 import portátil (`d3f8818`), Gate 5.4 workflow de QR Code (`fe705fc`), Gate 5.4.1 QR UX + downloads PNG/SVG (`3670a44`).
- Gate 5.5 (integração final e freeze de documentação): **FROZEN**. Fechou o finding BL-54-04 e reconciliou a documentação, sem feature nova, sem migration, sem bump de versão, sem tag e sem deploy.
- **Phase 6 — Release Readiness: COMPLETE**, terminando em **Gate 6.6 (publicação): PASSED** — na publicação inicial, a tag `v3.0.0` foi criada sobre `60c8575`, com push de `main` e da tag e GitHub Release concluídos. A `v3.0.0` **já possui tag e GitHub Release**; Cloudflare/D1 continuam per-installation.
- **Phase 7 — Current-State Reconciliation (histórico da 3.0.0 congelada)**: Gate 7.2 concluído (BL-66-01); Gate 7.3 rejeitado; Gate 7.4 concluído (correções BL-73-01..04); Gate 7.5 aprovado; Gate 7.6 produziu o commit de correção; Gate 7.7 concluiu a republicação controlada da mesma `v3.0.0`. Gate 7.8 reconciliou a identificação corrente sem SHA literal (BL-77-01), sem bump, migration ou mudança funcional.
- **Modelo de distribuição da release do repositório**: source commit + tag `v3.2.0` + push + GitHub Release. Não existe Worker, D1, hostname, Cloudflare Account, deploy ou migration remota oficiais: cada instalação é self-hosted e executa o próprio backup, as próprias migrations e o próprio deploy. Cloudflare login **não** é requisito para publicar o repositório.
- Ao retomar o trabalho, o estado é: **release `3.2.0` publicada** (tag `v3.2.0`, branch `main`); a linha 3.0.0 permanece congelada e os gates das Phases 6–7 são históricos. Publicar a tag não significa que instalações foram atualizadas — deploy e migrations são por instalação.
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
- para desenvolvimento local do Worker na release (`3.2.0`), rode `npm run dev-prepare` (aplica as migrations `0000`–`0006` no D1 do Wrangler) antes de `npm run dev`; no checkout histórico da tag `v2.2.1` esse script não existe, use `npm run wrangler -- d1 migrations apply ... --local`

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
7. aplicar migrations locais (na release `3.2.0`: `npm run dev-prepare`; no checkout histórico da tag `v2.2.1`: `npm run wrangler -- d1 migrations apply ... --local`)
8. se houver autorização para deploy remoto da release 3.2.0, usar `npm run deploy`: aplica as migrations pendentes antes do Worker; no Deploy Button/Workers Builds, manter esse Deploy command após o provisionamento do D1
9. rodar `npm test`
10. parar antes da criação final do Access

Se o pedido for iniciar o projeto apenas localmente para testes manuais, a IA deve preparar o D1 local do Worker **antes** de `npm run dev`:

```bash
npm run dev-prepare   # release 3.2.0: aplica 0000–0006 no D1 local do Worker
```

`npm run dev-prepare` aplica as migrations no D1 local usado pelo `wrangler dev` (`.wrangler/state/v3/d1`). Sem isso o Worker responde `503 Database schema is not initialized`. No checkout histórico da tag `v2.2.1` esse script não existe; use `npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local`.

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
8. aplicar migrations locais (`npm run dev-prepare` na release atual; `npm run wrangler -- d1 migrations apply ... --local` no checkout histórico da tag `v2.2.1`)
9. se o deploy remoto for operado por CLI e estiver autorizado: usar `npm run deploy` da release 3.2.0 (migrations pendentes antes do Worker)
10. se o deploy for GitHub auto-deploy ou Deploy Button: conferir Deploy command = `npm run deploy`; o script aplica migrations antes de publicar, sem etapa manual posterior obrigatória
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

No checkout da release **3.2.0**, aceite/mantenha `npm run deploy` como Deploy command. O Deploy Button detecta esse script; em Workers Builds já configurado, confira **Settings > Build > Deploy command** e ajuste para `npm run deploy`. Um comando direto `wrangler deploy` não executa o script de migrations.

```text
npm run deploy
  -> npm run db:migrations:apply
     -> node scripts/wrangler.mjs d1 migrations apply db_boltlink --remote
  -> somente após sucesso: node scripts/wrangler.mjs deploy
```

Após provisionar o D1, o fluxo padrão aplica as migrations pendentes antes de publicar o Worker. O binding permanece `db_boltlink` mesmo que o operador escolha outro nome físico. No Workers Builds (`WORKERS_CI=1`), sem config privado, o wrapper usa `wrangler.jsonc` tanto no apply remoto quanto no deploy; na CLI local ambos usam `wrangler.local.jsonc`.

Na tag histórica **v3.1.0**, o deploy não aplicava migrations automaticamente; banco vazio exigia aplicação manual e respondia `503 Database schema is not initialized`. A **3.1.1** corrige esse processo. O runtime continua sem aplicar migrations durante requests.

Depois do deploy/provisionamento concluído:

1. valide `workers.dev` (API e redirect)
2. configure [uma única aplicação Access](docs/admin-auth.md) para `/admin`, `/admin/*`, `/admin.html`, `/api` e `/api/*`
3. preencha `TEAM_DOMAIN` e `POLICY_AUD`
4. opcionalmente configure `API_KEY`; configure `PASSWORD_SESSION_SECRET` se a instância usar links protegidos por senha
5. opcionalmente configure domínio próprio

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

Setup local com banco SQLite de apoio (release `3.2.0`):

```bash
npm install
npm run setup
npm run dev-prepare   # migrations 0000–0006 no D1 local usado pelo Worker (não existe na tag v2.2.1)
npm run dev-init      # opcional: SQLite auxiliar em .dev-env/
npm run dev
```

No checkout histórico da tag `v2.2.1`, substitua `dev-prepare` por `npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local`.

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

Release atual publicada: 3.2.0 · Tag: v3.2.0 · Release anterior: 3.1.1
Criado por Vitor Faustino - vitorfaustino.com.br
