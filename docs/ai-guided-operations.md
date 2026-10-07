# Operação Guiada por IA

## Release candidate — 3.1.1 (não publicada)

Este checkout prepara a **3.1.1**, candidata local do Gate 8.11, sem tag ou GitHub Release. A última release publicada continua sendo **3.1.0** (`v3.1.0`), congelada.

O patch corrige o processo de deploy: `npm run deploy` executa `npm run db:migrations:apply` antes de publicar o Worker e interrompe o fluxo se a aplicação falhar. O comando usa o binding `db_boltlink`, preserva o wrapper e aplica somente migrations pendentes. **MIGRATION_0007 = NOT REQUIRED**; cadeia `0000`–`0006` inalterada.

Publicar tag/release no GitHub é **source distribution** e não toca D1 de ninguém. Quando uma instalação executa seu próprio `npm run deploy`, as migrations pendentes do D1 daquela instalação são aplicadas antes do Worker. Deploy e D1 remoto continuam exigindo autorização por instalação.

## Release publicada — 3.1.0

A **3.1.0 está publicada**, identificada pela tag **v3.1.0**; é a release atual e latest do repositório. A release anterior **v3.0.0** permanece congelada em sua própria tag. A 3.1.0 adiciona Lixeira, restauração validada, exclusão definitiva com reutilização de slug e limpeza administrativa explícita com preview e retenção de 90 dias. Não há Cron automático. O export passa a conter somente links ativos; tombstones ficam fora do documento e dos limites de links, enquanto ativos inválidos continuam fail-closed. Import v1 legado com `disabled: true` continua aceito. **MIGRATION_0007 = NOT REQUIRED**; migrations permanecem `0000`–`0006`.

Contrato completo e operação no Admin: [Lixeira e recuperação](trash-recovery.md). Os procedimentos correntes abaixo seguem a candidata `3.1.1`; a tag `v3.1.0` conserva o procedimento histórico sem migrations automáticas. Publicar código no Git/GitHub não atualiza instalações: deploy, D1 remoto e Access exigem autorização própria por instalação.


> Escopo: release atual = **`3.1.0`** (tag `v3.1.0`, migrations `0000` a `0006`). A `0004` e o Split Test A/B (origem Fase 2), a `0005` e o Smart Routing (origem Fase 3), a `0006`, o destino de expiração e o `ROOT_REDIRECT_URL` (origem Fase 4) e a hierarquia de grupos de `link_groups`, a portabilidade de configuração (`GET /api/export`, `POST /api/import/preview`, `POST /api/import/apply`) e o QR Code com preview e downloads no painel (origem Fase 5, sem migration nova) estão **publicados na `3.0.0`** — não são experimentais nem local-only. A release histórica `v2.2.1` termina na `0003` e não contém nenhum deles; um checkout dessa tag tem procedimento histórico próprio.

## Objetivo

Levar o usuário do setup ao upgrade sem adivinhar dados e sem ultrapassar os checkpoints manuais da Cloudflare.

## Regras canônicas

- leia `AI-START.md` primeiro
- use `docs/ai-accepted-requests.md` como contrato
- preserve `wrangler.jsonc` como template público
- preserve `wrangler.local.jsonc` como configuração privada local
- preserve overlays do projeto do usuário
- em GitHub auto-deploy e Deploy Button, trate o dashboard da Cloudflare como origem de `TEAM_DOMAIN`, `POLICY_AUD`, `API_KEY` e `PASSWORD_SESSION_SECRET`
- em deploy local via Wrangler, aceite `TEAM_DOMAIN` e `POLICY_AUD` no `wrangler.local.jsonc`, mas trate `API_KEY` e `PASSWORD_SESSION_SECRET` como secrets em `.dev.vars` ou no Worker
- não automatize a criação final do Cloudflare Access
- não reintroduza `stats`, `IP_HASH_SECRET`, `last_clicked_at` ou `notes`
- para redução de tráfego, consulte `docs/free-plan-traffic.md` e priorize opções gratuitas antes de sugerir recursos pagos

## Protocolo padrão

1. confirmar capacidade real de operar no ambiente
2. classificar a intenção do usuário
3. verificar a raiz correta do projeto
4. ler o estado do Git antes de atualizar
5. executar apenas o que for automatizável
6. parar nos checkpoints manuais da Cloudflare
7. validar com `npm test` quando houver mudança de código

## Métodos de publicação

Pergunta obrigatória:

`Como você publica o projeto?`

Opções:

- GitHub auto-deploy
- Deploy local com Wrangler
- Ambos
- Primeira publicação

## Upgrade da versão atual

Quando o pedido for `Atualizar o Projeto`:

1. `git status --short`
2. `git pull --ff-only` quando estiver seguro
3. `npm install`
4. `npm run wrangler:init`
5. aplicar as migrations no D1 local do Worker: `npm run dev-prepare` na candidata (`3.1.1`, cadeia `0000`–`0006`) ou `npm run wrangler -- d1 migrations apply <nome-ou-binding-real> --local` no checkout histórico da tag `v2.2.1`, que não tem `dev-prepare`
6. com autorização remota por instalação: `npm run deploy` da candidata 3.1.1 aplica migrations pendentes antes de publicar o Worker
7. no one-click/GitHub: D1 provisionado → `npm run deploy` (migrations → Worker) → validar; conferir o Deploy command no Workers Builds
8. `npm test`

## One-click e GitHub auto-deploy

Se o usuário opera por one-click ou GitHub:

- o runtime não executa reconciliação de schema: tabelas e colunas são responsabilidade exclusiva das migrations
- na candidata 3.1.1: provisionar D1 → `npm run deploy` → migrations pendentes → Worker → validar
- em ambiente existente: `npm run deploy` aplica apenas as pendentes antes de publicar; sem pendências, segue normalmente
- na tag histórica v3.1.0, deploy não aplicava migrations; a preparação manual era necessária para evitar `503 Database schema is not initialized`
- em Workers Builds, manter Deploy command = `npm run deploy`; comandos diretos de deploy ignoram essa etapa
- aplique as migrations pendentes no D1 remoto, atribuindo cada uma à sua origem: vindo da release histórica `v2.2.1`, as pendentes são `0004` a `0006` — a `0004_ab_testing.sql` habilita o Split Test A/B (origem Fase 2), a `0005_smart_routing.sql` habilita Smart Routing (origem Fase 3) e a `0006_expired_redirect.sql` habilita o destino de expiração (origem Fase 4), todas publicadas na `3.0.0`; a `0003_lgpd_minimization.sql` remove `stats`, `last_clicked_at` e `notes` e encerra a linha `v2.2.1`
- o handoff obrigatório continua sendo Access

---

Release atual publicada: 3.1.0 · Tag: v3.1.0 · Release anterior: 3.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
