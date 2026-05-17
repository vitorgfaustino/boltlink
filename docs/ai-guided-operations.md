# Operação Guiada por IA

## Objetivo

Levar o usuário do setup ao upgrade sem adivinhar dados e sem ultrapassar os checkpoints manuais da Cloudflare.

## Regras canônicas

- leia `AI-START.md` primeiro
- use `docs/ai-accepted-requests.md` como contrato
- preserve `wrangler.jsonc` como template público
- preserve `wrangler.local.jsonc` como configuração privada local
- preserve overlays do projeto do usuário
- não automatize a criação final do Cloudflare Access
- não reintroduza `stats`, `IP_HASH_SECRET`, `last_clicked_at` ou `notes`

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

## Upgrade v2.0.0

Quando o pedido for `Atualizar o Projeto`:

1. `git status --short`
2. `git pull --ff-only` quando estiver seguro
3. `npm install`
4. `npm run wrangler:init`
5. `npm run wrangler -- d1 migrations apply <nome-ou-binding-real> --local`
6. se houver produção remota gerida por CLI, repetir com `--remote -c wrangler.local.jsonc`
7. `npm test`

## One-click e GitHub auto-deploy

Se o usuário opera por one-click ou GitHub:

- o código novo já reconcilia schema legado em runtime
- ainda assim, a migration `0003_lgpd_minimization.sql` continua sendo o caminho recomendado
- o handoff obrigatório continua sendo Access

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
