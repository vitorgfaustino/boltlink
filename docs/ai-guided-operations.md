# Operação Guiada por IA

## Release publicada — 3.2.1

A **3.2.1 está publicada**, identificada pela tag **v3.2.1**; é a release atual e latest do repositório. A release anterior **v3.2.0** permanece congelada. Esta versão de manutenção acrescenta preflight D1, seleção consistente da configuração Wrangler, merge por identidade de binding e comparação obrigatória das configurações no upgrade. Mantém os recursos de links e o Admin refinado da 3.2.0. **MIGRATION_0007 = NOT REQUIRED**; migrations `0000`–`0006` e schema preservados. Nenhum secret obrigatório novo ou atualização automática de instalações.

Publicar tag/release é **source distribution** e não opera Cloudflare de clientes. Cada instalação executa o próprio `npm run deploy`, que aplica apenas migrations pendentes antes do Worker, e configura seu próprio Access. O guia completo está em [Cloudflare Access](admin-auth.md).

## Recursos preservados desde a 3.1.0

A **3.1.0**, release histórica congelada na tag **v3.1.0**, introduziu os recursos abaixo. A tag histórica **v3.0.0** também permanece congelada. A 3.1.0 adiciona Lixeira, restauração validada, exclusão definitiva com reutilização de slug e limpeza administrativa explícita com preview e retenção de 90 dias. Não há Cron automático. O export passa a conter somente links ativos; tombstones ficam fora do documento e dos limites de links, enquanto ativos inválidos continuam fail-closed. Import v1 legado com `disabled: true` continua aceito. **MIGRATION_0007 = NOT REQUIRED**; migrations permanecem `0000`–`0006`.

Contrato completo e operação no Admin: [Lixeira e recuperação](trash-recovery.md). Os procedimentos correntes abaixo seguem a release `3.2.1`; a tag `v3.1.0` conserva o procedimento histórico sem migrations automáticas. Publicar código no Git/GitHub não atualiza instalações: deploy, D1 remoto e Access exigem autorização própria por instalação.


> Escopo: release atual = **`3.2.1`** (tag `v3.2.1`, migrations `0000` a `0006`). A `0004` e o Split Test A/B (origem Fase 2), a `0005` e o Smart Routing (origem Fase 3), a `0006`, o destino de expiração e o `ROOT_REDIRECT_URL` (origem Fase 4) e a hierarquia de grupos de `link_groups`, a portabilidade de configuração (`GET /api/export`, `POST /api/import/preview`, `POST /api/import/apply`) e o QR Code com preview e downloads no painel (origem Fase 5, sem migration nova) estão **publicados na `3.0.0`** — não são experimentais nem local-only. A release histórica `v2.2.1` termina na `0003` e não contém nenhum deles; um checkout dessa tag tem procedimento histórico próprio.

## Objetivo

Levar o usuário do setup ao upgrade sem adivinhar dados e sem ultrapassar os checkpoints manuais da Cloudflare.

## Regras canônicas

- leia `AI-START.md` primeiro
- use `docs/ai-accepted-requests.md` como contrato
- na origem oficial, preserve `wrangler.jsonc` como template público; na instalação derivada, preserve os valores operacionais provisionados desse arquivo
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

Quando o pedido for `Atualizar o Projeto`, siga o [contrato canônico](upgrading.md#upgrade-seguro--321) e o fluxo de `AI-START.md`. Identifique cliente/upstream, versões, método de publicação, branches, base comum e estratégia de integração antes de alterar código. Faça snapshots privados e comparação antes/depois do config público e local, preserve overlays e secrets, execute testes e o preflight no contexto real.

`git pull --ff-only` não é uma estratégia completa de integração com o upstream. Baseline anterior ausente nega aprovação automática e exige reconciliação manual; a comparação e `upgrade:check` são obrigatórios antes do push. UUID/identidade removidos bloqueiam; alterações operacionais exigem confirmação explícita. Em auto-deploy, push pode publicar o Worker e aplicar migrations: configuração, diff, destino e autorização do operador são checkpoints obrigatórios antes dele. Em deploy local, aguarde autorização remota por instalação antes de `npm run deploy`. Conflitos operacionais nunca devem ser resolvidos aceitando o template automaticamente.

## One-click e GitHub auto-deploy

Se o usuário opera por one-click ou GitHub:

- o runtime não executa reconciliação de schema: tabelas e colunas são responsabilidade exclusiva das migrations
- na release 3.2.1: provisionar D1 → `npm run deploy` → migrations pendentes → Worker → validar
- em ambiente existente: `npm run deploy` aplica apenas as pendentes antes de publicar; sem pendências, segue normalmente
- na tag histórica v3.1.0, deploy não aplicava migrations; a preparação manual era necessária para evitar `503 Database schema is not initialized`
- em Workers Builds, manter Deploy command = `npm run deploy`; comandos diretos de deploy ignoram essa etapa
- aplique as migrations pendentes no D1 remoto, atribuindo cada uma à sua origem: vindo da release histórica `v2.2.1`, as pendentes são `0004` a `0006` — a `0004_ab_testing.sql` habilita o Split Test A/B (origem Fase 2), a `0005_smart_routing.sql` habilita Smart Routing (origem Fase 3) e a `0006_expired_redirect.sql` habilita o destino de expiração (origem Fase 4), todas publicadas na `3.0.0`; a `0003_lgpd_minimization.sql` remove `stats`, `last_clicked_at` e `notes` e encerra a linha `v2.2.1`
- o handoff obrigatório continua sendo Access

---

Release atual publicada: 3.2.1 · Tag: v3.2.1 · Release anterior: 3.2.0
Criado por Vitor Faustino - vitorfaustino.com.br
