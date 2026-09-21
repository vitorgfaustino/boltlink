# Operação Guiada por IA

> Escopo: release publicada = **v2.2.1** (tag real, migrations até `0003`). O baseline local da **Fase 2** adiciona a `0004` e o Split Test A/B; o estado **Unreleased (Fase 3)** adiciona a `0005` e o Smart Routing. As referências a esses dois estados abaixo valem apenas nas bases locais, nunca no checkout da tag.

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
5. aplicar as migrations no D1 local do Worker: `npm run dev-prepare` nas bases locais (Fase 2 e Fase 3) ou `npm run wrangler -- d1 migrations apply <nome-ou-binding-real> --local` no checkout da tag `v2.2.1`, que não tem `dev-prepare`
6. se houver produção remota gerida por CLI: aplicar as migrations remotas (`--remote -c wrangler.local.jsonc`) e só então publicar com `npm run deploy`
7. se o deploy for one-click/GitHub: provisionar/deploy inicial → migrations remotas → validar; deploy sozinho não prepara o schema (`503 Database schema is not initialized`)
8. `npm test`

## One-click e GitHub auto-deploy

Se o usuário opera por one-click ou GitHub:

- o runtime não executa reconciliação de schema: tabelas e colunas são responsabilidade exclusiva das migrations
- ordem suportada no provisionamento inicial: provisionar/deploy inicial → aplicar migrations no D1 remoto → validar/uso
- ordem suportada em ambiente já existente: migrations remotas → deploy → validar
- deploy sozinho não deixa a instalação operacional: até as migrations, `/api/*` e redirects respondem `503 Database schema is not initialized`
- aplique as migrations pendentes no D1 remoto, atribuindo cada uma à sua base: a `0003_lgpd_minimization.sql` remove `stats`, `last_clicked_at` e `notes` e encerra a release publicada `v2.2.1`; a `0004_ab_testing.sql` habilita o Split Test A/B no baseline local da Fase 2; a `0005_smart_routing.sql` habilita Smart Routing no estado Unreleased / Fase 3
- o handoff obrigatório continua sendo Access

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
