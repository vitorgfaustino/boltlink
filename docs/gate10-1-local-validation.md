# Gate 10.1 — validação local de upgrade e deploy

Data: 2026-10-08. Resultado: PASSED, revisão local requerida.

BASE_SHA = `84ecacf1822f41c2fcc240d464dc4a0b43447d7a`

Branch: `codex/3.2.1-upgrade-safety`. O SHA final é o commit que contém este relatório, informado na entrega e consultável com `git rev-parse codex/3.2.1-upgrade-safety`.

A **3.2.1 é candidata local, não publicada**.

A release publicada, main e tag permanecem na base. Package, lockfile e versão visível da aplicação continuam em `3.2.0`, sem bump neste gate operacional. A finalização de versão fica para um gate próprio. Não foi alterada nenhuma instalação.

## Problema e causas comprovadas

Na base, `runWranglerCli` encaminhava a migration remota ao Wrangler sem conferir o UUID. Em Builds sem arquivo privado, o roteador selecionava o config público mesmo sem ID. O erro aparecia somente no Wrangler. Não há evidência neste gate de que um upgrade sobrescreveu o arquivo na instalação relatada: essa hipótese precisa do histórico Git dela.

O merge da base combinava arrays de objetos pela posição quando tinham o mesmo tamanho. Reprodução com dois bindings em ordem invertida demonstrou perda de `migrations_dir` no binding BoltLink e atribuição desse default ao outro binding. A candidata combina defaults somente pela mesma chave `binding`, preservando lista/ordem local e recursos personalizados. Arrays sem essa chave usam o overlay integral. Duplicidade semântica bloqueia o merge.

A seleção explícita é identificada e preservada, incluindo `-c`/`--config` e formas com `=`. Builds escolhe config público para apply padrão e publicação, mesmo com arquivo local presente; CLI local usa config privado. Ambientes selecionados por CLI ou `CLOUDFLARE_ENV` têm seus próprios bindings D1 não herdados. A checagem somente leitura usa esse mesmo roteamento e o merge em memória.

O preflight verifica binding único, nome de banco, UUID e migrations_dir antes de spawn. Erros não serializam valores da configuração. JSONC é interpretado como dados, sem execução de JavaScript e sem exibir conteúdo em erros do parser. `upgrade:check` compara identidade/configuração antes/depois sem Wrangler: remoção de UUID bloqueia; diferenças operacionais exigem confirmação explícita por categoria. Ele não é um atualizador nem recupera automaticamente um snapshot ausente.

## Reprodução solicitada

Fixture sintética: `WORKERS_CI=1`, Worker `cliente-boltlink`, D1 `cliente-db`, config público sem UUID e arquivo local com UUID válido. Nenhum identificador real foi utilizado.

| Estado | Config usado | Resultado | Migrations/Worker |
| --- | --- | --- | --- |
| UUID apenas no local | `wrangler.jsonc` | `REMOTE_D1_DATABASE_ID_MISSING`, exit 1 | zero chamadas |
| UUID restaurado somente no público | `wrangler.jsonc` | preflight aprovado | fake Wrangler recebeu migrations e depois deploy |
| Migration simulada falha (exit 23) | `wrangler.jsonc` | cadeia interrompida | deploy não chamado |

A cadeia `npm run deploy` foi executada apenas em diretórios temporários com o wrapper real e um executável fake Wrangler, sem dependência Wrangler real nesses diretórios. O fake somente registra argumentos/retorna status. O `npm run deploy` desta instalação nunca foi executado.

## Validação

- `npm test`: **1290/1290 PASS**, 37 arquivos, zero skipped, 53 testes novos sobre baseline de 1237.
- Cobertura nova T01–T16: Builds sem/com ID, seleção local/explícita, template antes/depois de provisionar, UUID inválido/nulo, binding ausente/duplicado, UUID removido/alterado, nome do Worker alterado, merge por binding e preservação real em filesystem, zero spawn no erro, ausência de secrets nos logs e cadeia npm fail-closed com subprocesso fake.
- Cobertura adicional: ambientes CLI/variável, migrations_dir incorreto, preflight sem escrita, flags ambíguas, dry-run negado, parsing JSONC sem execução e confirmação por campo na CLI de comparação.
- Focada final: 310/310 PASS (wrapper, novas regressões e scanner documental existente).
- `npm ls --depth=0 --offline`: PASS, exit 0; nenhuma instalação/alteração de dependência.
- `npx --no-install tsc --noEmit`: exit 2, **somente TS7016 histórico em src/index.ts:31, módulo qrcode**, permitido pelo contrato. Não declarado como TypeScript limpo.
- `git diff --check`: PASS.
- Comparação de bytes com BASE_SHA: sete migrations `0000`–`0006` e schema idênticos. `src/`, `public/` e lockfile também preservados.
- Main continua no BASE_SHA. A tag anotada `v3.2.0`, objeto `993f6ec1b2817cd3e82160f6c1d90949fbafb10a`, continua resolvendo para o BASE_SHA.

A primeira tentativa completa no sandbox parou por EPERM de loopback/log local; a mesma suíte foi autorizada com acesso local. A primeira execução completa teve um finding de redação no scanner de identidade, corrigido sem alterar o scanner, e uma falha temporal no teste preexistente de rate limit. A execução final após correção documental passou integralmente.

## Compatibilidade e limitações

| Cenário | Evidência local |
| --- | --- |
| A: primeiro Deploy Button | template permanece sem UUID, etapas anteriores à migration aceitas; fixture provisionada passa |
| B: derivado provisionado | comparação exige preservação/confirmacão de identidade, ID removido bloqueia |
| C: operador local | arquivo privado selecionado, nome/ID/vars/bindings preservados na sincronização |
| D: customizações | comparação de rotas, vars, KV, R2, services, queues, Durable Objects e campos personalizados; merge não troca identidades |

Não houve deploy real do Deploy Button. UUID sintaticamente válido não prova existência, propriedade ou associação ao banco de produção. Não houve auditoria do histórico da instalação afetada. Não há sincronização automática com upstream e `git pull --ff-only` não prova incorporação da versão oficial.

Findings resolvidos: ausência de preflight, merge por posição, seleção de Builds influenciada pelo arquivo local e contrato documental incompleto. Sem blocker aberto no escopo.

Finding informativo: o teste preexistente de rate limit depende de 121 requests caírem na mesma janela de um minuto. Reprodução determinística no runtime preservado: request 121 é negado na mesma janela, mas permitido após virar a janela. A falha inicial é compatível com essa condição; seu instante exato não foi instrumentado. Nenhum runtime/teste existente de rate limit foi alterado. TS7016 permanece dívida histórica aceita.

## Documentação e arquivos alterados

Contrato canônico e recuperação: `docs/upgrading.md`. Fluxo AI identifica cliente/upstream, versões, método de publicação, working tree, branches, base comum e estratégia; compara configs privados antes/depois; exige testes/preflight/diff/destino e autorização antes de push potencialmente mutável. A orientação para UUID somente local transfere apenas campos operacionais revisados para o config de Builds, sem copiar todo o arquivo privado nem secrets.

Arquivos:

- `scripts/config-utils.mjs`, `scripts/config-safety.mjs`, `scripts/wrangler-routing.mjs`, `scripts/wrangler.mjs`.
- `package.json` (somente dois comandos locais novos), `wrangler.jsonc` (somente comentários), `vitest.config.mts`.
- `test/upgrade-safety.spec.ts`, `test/wrangler.spec.ts` (asserções de caminho explícito agora conhecido; proteção mantida).
- `AI-START.md`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `RELEASE_NOTES.md`.
- `docs/ai-guided-operations.md`, `docs/ai-accepted-requests.md`, `docs/upgrading.md`, `docs/cloudflare-setup.md`, `docs/technical-reference.md`, este relatório.

## Confirmações

```text
VERSION = 3.2.1_CANDIDATE
UPGRADE_SAFETY = IMPLEMENTED
WORKERS_BUILD_CONFIG = VALIDATED
LOCAL_CONFIG = PRESERVED
D1_ID_MISSING = FAIL_CLOSED
D1_ID_CHANGED = REQUIRES_CONFIRMATION
WORKER_NAME_CHANGED = REQUIRES_CONFIRMATION
UPSTREAM_UPDATE_CONTRACT = DOCUMENTED
DEPLOY_BUTTON_COMPATIBILITY = TESTED_LOCALLY
MIGRATIONS_BEFORE_DEPLOY = PRESERVED

MIGRATION_0007 = NOT_REQUIRED
MIGRATIONS_BYTE_DELTA = 0
SCHEMA_BYTE_DELTA = 0

REMOTE_PUSH = NOT_PERFORMED
MAIN_MERGE = NOT_PERFORMED
TAG = NOT_CREATED
GITHUB_RELEASE = NOT_CREATED
CLOUDFLARE_DEPLOY = NOT_PERFORMED
REMOTE_D1 = NOT_MODIFIED
PUBLICATION_AUTHORIZATION = NOT_GRANTED
```

BOLTLINK v3.2.1 GATE 10.1 PASSED — UPGRADE SAFETY IMPLEMENTED, LOCAL REVIEW REQUIRED
