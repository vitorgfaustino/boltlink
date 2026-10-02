# Operação Guiada por IA

## Desenvolvimento local — 3.1.0

A **3.1.0 está em desenvolvimento, não publicada**. A última release publicada continua **v3.0.0**, congelada em `main`/tag `v3.0.0`. O novo ciclo adiciona Lixeira, restauração validada, exclusão definitiva com reutilização de slug e limpeza administrativa explícita com preview e retenção de 90 dias. Não há Cron automático. O export passa a conter somente links ativos; tombstones ficam fora do documento e dos limites de links, enquanto ativos inválidos continuam fail-closed. Import v1 legado com `disabled: true` continua aceito. **MIGRATION_0007 = NOT REQUIRED**; migrations permanecem `0000`–`0006`.

Contrato completo e operação no Admin: [Lixeira e recuperação](trash-recovery.md). Os procedimentos da release publicada abaixo continuam pertencendo à `3.0.0`; este ciclo não autoriza push, deploy, D1 remoto, tag ou GitHub Release.


> Escopo: release atual = **`3.0.0`** (tag `v3.0.0`, migrations `0000` a `0006`). A `0004` e o Split Test A/B (origem Fase 2), a `0005` e o Smart Routing (origem Fase 3), a `0006`, o destino de expiração e o `ROOT_REDIRECT_URL` (origem Fase 4) e a hierarquia de grupos de `link_groups`, a portabilidade de configuração (`GET /api/export`, `POST /api/import/preview`, `POST /api/import/apply`) e o QR Code com preview e downloads no painel (origem Fase 5, sem migration nova) estão **publicados na `3.0.0`** — não são experimentais nem local-only. A release anterior `v2.2.1` termina na `0003` e não contém nenhum deles; um checkout dessa tag tem procedimento histórico próprio.

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
5. aplicar as migrations no D1 local do Worker: `npm run dev-prepare` na release atual (`3.0.0`, cadeia `0000`–`0006`) ou `npm run wrangler -- d1 migrations apply <nome-ou-binding-real> --local` no checkout histórico da tag `v2.2.1`, que não tem `dev-prepare`
6. se houver produção remota gerida por CLI: aplicar as migrations remotas (`--remote -c wrangler.local.jsonc`) e só então publicar com `npm run deploy`
7. se o deploy for one-click/GitHub: provisionar/deploy inicial → migrations remotas → validar; deploy sozinho não prepara o schema (`503 Database schema is not initialized`)
8. `npm test`

## One-click e GitHub auto-deploy

Se o usuário opera por one-click ou GitHub:

- o runtime não executa reconciliação de schema: tabelas e colunas são responsabilidade exclusiva das migrations
- ordem suportada no provisionamento inicial: provisionar/deploy inicial → aplicar migrations no D1 remoto → validar/uso
- ordem suportada em ambiente já existente: migrations remotas → deploy → validar
- deploy sozinho não deixa a instalação operacional: até as migrations, `/api/*` e redirects respondem `503 Database schema is not initialized`
- aplique as migrations pendentes no D1 remoto, atribuindo cada uma à sua origem: vindo da release anterior `v2.2.1`, as pendentes são `0004` a `0006` — a `0004_ab_testing.sql` habilita o Split Test A/B (origem Fase 2), a `0005_smart_routing.sql` habilita Smart Routing (origem Fase 3) e a `0006_expired_redirect.sql` habilita o destino de expiração (origem Fase 4), todas publicadas na `3.0.0`; a `0003_lgpd_minimization.sql` remove `stats`, `last_clicked_at` e `notes` e encerra a linha `v2.2.1`
- o handoff obrigatório continua sendo Access

---

Versão em desenvolvimento: 3.1.0 · Release publicada: 3.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
