# Gate 10.2 — release readiness e auditoria de upgrade

Data: 2026-10-08. Resultado local: PASSED. Publicação pendente, sem autorização.

```text
BASE_OFFICIAL_SHA = 84ecacf1822f41c2fcc240d464dc4a0b43447d7a
BASE_10_1_SHA = 8b4d4b55fb46292f18dcdcce737f1d6a98b7bf34
BRANCH = codex/3.2.1-upgrade-safety
```

O SHA final é o commit de fechamento que contém este relatório, informado na entrega e consultável com `git rev-parse codex/3.2.1-upgrade-safety`. O Gate 10.1 permanece ancestral direto; nenhum rebase, alteração de main ou tag foi realizado.

A candidata local está versionada em **3.2.1**, em package, lockfile e respostas da aplicação derivadas de `APP_VERSION = packageJson.version`. A versão pública atual permanece na tag `v3.2.0`. Capturas, documentação histórica e relatório do Gate 10.1 foram preservados; não declaram publicação da candidata.

## Custódia inicial

Origem local cadastrada: `https://github.com/vitorgfaustino/boltlink.git`. HEAD e branch correspondiam exatamente ao contrato, com árvore limpa antes de editar. `main`, `origin/main` e `v3.2.0^{commit}` estavam em BASE_OFFICIAL_SHA. O objeto da tag anotada era `993f6ec1b2817cd3e82160f6c1d90949fbafb10a` e foi preservado. As verificações são dos refs locais; não houve atualização de refs via GitHub nem consulta operacional Cloudflare.

O delta original do Gate 10.1 foi inspecionado diretamente: 20 arquivos, helpers de configuração/roteamento, comandos locais, regressões e documentação. A auditoria não se baseou somente no relatório anterior.

## Findings reproduzidos e fechados

| Finding | Prioridade inicial | Evidência / correção | Estado |
| --- | --- | --- | --- |
| BL-102-01 | P1 | `--remote=true` e flags de config antes do comando chamavam o subprocesso mock com ID ausente. Agora comando e flags são normalizados uma vez no roteador; o preflight consome o mesmo descriptor | CLOSED |
| BL-102-02 | P2 | Worker name removido era aprovado com `--confirm-field name`. Remoção/vazio de identidade operacional e de D1 name/ID exige correção, sem bypass por confirmação | CLOSED |
| BL-102-03 | P2 | Duplicidades locais de KV sem lista upstream e chaves JSONC duplicadas eram aceitas. Validação percorre bindings, inclusive Durable Objects; parser rejeita chaves repetidas/escapadas equivalentes; chaves de protótipo permanecem dados | CLOSED |
| BL-102-04 | P2 | Entrada local incompleta com binding igual podia herdar ID/nome do upstream. Defaults de alvos remotos não são adotados para essa entrada; a ausência de ID passa a bloquear | CLOSED |
| BL-102-05 | P1 | Wrangler resolve por nome OU binding em ordem de array. Um D1 adicional com database_name igual ao alias db_boltlink podia receber a migration destinada ao binding canônico. Essa ambiguidade bloqueia antes do subprocesso | CLOSED |
| BL-102-06 | P2 | dev-prepare ainda interpretava config por Function e selecionava o primeiro D1. Agora usa parser de dados e binding canônico, com testes de reordenação, ambiguidade e JavaScript recusado | CLOSED |
| BL-102-07 | P2 | Wrangler 4.90.0 carrega dotenv antes de selecionar ambiente. Uma seleção implícita poderia divergir do preflight. Ela exige contexto explícito, sem extrair/logar valores secretos; --env vazio seleciona o nível superior | CLOSED |
| BL-102-08 | P3 | Teste público de rate limit dependia de 121 requests ocorrerem na mesma janela real. Relógio Date controlado e transição explícita de janela estabilizam o teste sem modificar produção | CLOSED |
| BL-102-09 | P3 | Checkout raso do CI não fornecia tag histórica. Workflow de testes usa fetch-depth 0, contents read e não persiste credenciais; hipótese reproduzida em clone exclusivamente local | CLOSED locally; execução GitHub pendente |
| BL-102-10 | P3 | Package/app ainda estavam na base. Bump local 3.2.1 consistente e notas/checklist preparados, sem anúncio de publicação | CLOSED |

Nenhuma chamada Wrangler real foi usada nas reproduções de deploy/migrations. A reprodução inicial de bypass utilizou `spawn` simulado, que apenas contou chamadas. As novas regressões também verificam zero subprocessos nos erros e preservação de secrets nos logs. As operações reais de Git usadas na simulação de CI foram limitadas a clone/fetch via `file://` da própria cópia local para um diretório temporário; não houve acesso GitHub.

## Contratos verificados

- **Config efetivo:** seleção pública em Builds no fluxo padrão, privada na CLI local e prioridade de `--config`/`-c`, formas com `=`, compactas e antes do comando. Ambientes por CLI/CLOUDFLARE_ENV seguem bindings não herdados. Flags ambíguas, cwd divergente e arquivos não regulares falham fechados.
- **Dotenv:** `.env` sem seletor de ambiente continua permitido. Se contiver seleção CLOUDFLARE_ENV, ou houver `--env-file`, o operador fornece ambiente explícito por CLI/processo. A proteção recusa adivinhação e mantém um único mecanismo de roteamento; não copia secrets para snapshots/relatórios.
- **D1:** binding único, ausência de alias conflitante, nome, UUID sintático não nulo e migrations_dir correto. UUID idêntico passa; removido bloqueia; alterado exige confirmação. UUID sintático não prova existência, conta ou associação ao D1 real.
- **Merge:** mesma identidade por binding, ordem/membership local e arrays sem chave semântica preservados. Reordenação, adição/remoção, duplicidade, nome alterado e D1/KV/R2 simultâneos têm regressões. Entrada incompleta não recebe silenciosamente alvo upstream.
- **Comparação:** `upgrade:check -- --before <snapshot> --after <config> [--confirm-field <categoria>]` é o contrato registrado. O comando é obrigatório para auto-deploy antes de push. Confirmar mudança intencional não autoriza publicação e não contorna identidade removida. Saída diferencia CONFIRMED de pendência.
- **Baseline:** arquivo ausente/argumento ausente nega aprovação automática e exige reconciliação. Guia mostra recuperação por `git log`/`git show` para snapshot privado, sem reescrever histórico, imprimir conteúdo ou fabricar IDs. Preflight não substitui comparação.
- **Cadeia:** preflight → migrations → deploy somente após sucesso. Falha de migration (exit 23) impede deploy; sucesso e ausência simulada de pendências (exit 0) seguem. O `npm run deploy` da instalação de trabalho nunca foi executado.

## Primeiro deploy e instalações existentes

| Cenário | Resultado local |
| --- | --- |
| Template antes de provisionar | Config oficial permanece sem UUID; types, dry-run e criação explicitamente simulada continuam permitidos |
| Config provisionado | UUID sintético válido permite migration/deploy fake na ordem correta |
| Upgrade perde UUID | Comparação/preflight bloqueiam, com zero chamadas remotas |
| UUID apenas no arquivo local em Builds | Config público escolhido; falha orienta restaurar arquivo do repositório derivado |
| Operador local / customizações | UUID/name/bindings locais preservados, arrays não trocam recursos; alterações críticas exigem correção ou confirmação revisada |

Não foi executada instalação real do Deploy Button. O comportamento de provisão é compatível com o template e as simulações; não há comprovação remota neste gate. Nenhum banco/Worker/DNS/Access/instalação de cliente foi modificado.

## Versionamento e documentação

Package e ambas as entradas de versão do lockfile estão em 3.2.1. Nenhuma dependência mudou. `src/index.ts` já deriva a versão do package; testes da landing e `/version` agora exigem 3.2.1. Não houve mudança de código no runtime, UI ou lógica funcional.

CHANGELOG e RELEASE_NOTES apresentam **Upgrade & Deploy Safety**, candidata com publicação pendente. Sem feature no Admin, migration, schema, secret obrigatório novo ou updates automáticos. AI-START e guias distinguem dependências, remote do cliente, upstream oficial, config local/Builds, migrations e push potencialmente mutável. O procedimento completo permanece canônico em `docs/upgrading.md`, com referências cruzadas.

O checklist futuro está em `docs/release-3.2.1-checklist.md`: confirmações locais, autorização, integração em main, push, CI, tag, Release e auditoria pública. Passos 8–15 não foram executados; reconciliar redação pública/scanners só no futuro gate autorizado.

## Testes e integridade

- Suíte final: **1330/1330 PASS**, 37 arquivos, zero skipped. Baseline 1290 preservado, 40 novas regressões para lacunas concretas.
- Focada final: **350/350 PASS**, cobrindo wrapper, regressões operacionais e scanner documental preexistente. Nenhum teste antigo foi afrouxado; mudanças antigas limitadas à versão esperada, parser seguro e relógio do rate limit.
- A primeira suíte completa após os ajustes iniciais passou 1323/1323. O complemento dev-prepare/dotenv motivou a suíte final; não houve falha funcional usada para buscar verde.
- `npm ls --depth=0 --offline`: PASS, exit 0.
- `npx --no-install tsc --noEmit`: exit 2, somente **TS7016 histórico do qrcode em src/index.ts:31**. Não é TypeScript zero erros; exceção aceita pelo contrato.
- `git diff --check`: PASS.
- Migrations 0000–0006 e schema byte-idênticos ao BASE_OFFICIAL_SHA. Nenhum SQL novo. `src/` e `public/` também byte-idênticos; mudança visível de versão deriva do package.
- Lockfile difere apenas nas duas entradas de versão do produto. Sem biblioteca nova ou instalação de dependências.
- CI local: tag v2.2.1 ausente em clone raso sem tags; disponível após histórico/tags obtidos somente do file:// local. Workflow remoto continua pendente e não foi disparado.
- Código de scripts não contém Function/eval para interpretar configurações. Preflight e comparação somente leitura foram executados inclusive pelos comandos npm reais em fixtures sem dependência Wrangler.

## Arquivos alterados no Gate 10.2

- `.github/workflows/test.yml`.
- `package.json`, `package-lock.json`.
- `scripts/config-utils.mjs`, `scripts/config-safety.mjs`, `scripts/wrangler-routing.mjs`, `scripts/wrangler.mjs`, `scripts/dev-prepare.mjs`.
- `test/upgrade-safety.spec.ts`, `test/wrangler.spec.ts`, `test/index.spec.ts`.
- `AGENTS.md`, `AI-START.md`, `README.md`, `CHANGELOG.md`, `RELEASE_NOTES.md`.
- `docs/ai-accepted-requests.md`, `docs/ai-guided-operations.md`, `docs/cloudflare-setup.md`, `docs/technical-reference.md`, `docs/upgrading.md`.
- `docs/release-3.2.1-checklist.md` e este relatório.

## Limitações remanescentes

CI no GitHub e primeira instalação Cloudflare continuam sem execução neste gate. Validação sintática não confirma D1 real. A causa histórica da perda na instalação relatada requer auditoria do Git dela. Snapshots confiáveis e confirmação/autorização do operador continuam necessários; o patch não é atualizador automático, não recupera IDs e não prova que git pull incorporou o upstream. TS7016 permanece dívida histórica aceita. Sem P0/P1/P2 aberto no escopo.

## Resultado

```text
VERSION = 3.2.1
RELEASE_STATUS = LOCAL_CANDIDATE
UPGRADE_SAFETY = VERIFIED
D1_PREFLIGHT = VERIFIED
WRANGLER_CONFIG_ROUTING = VERIFIED
CONFIG_MERGE_BY_BINDING = VERIFIED
UPGRADE_CHECK = REQUIRED_IN_AI_WORKFLOW
INSTALLATION_IDENTITY = PROTECTED
FIRST_DEPLOY_COMPATIBILITY = LOCALLY_VERIFIED
EXISTING_INSTALLATION_UPGRADE = LOCALLY_VERIFIED
MIGRATIONS_BEFORE_DEPLOY = VERIFIED
CHANGELOG = PREPARED
RELEASE_NOTES = PREPARED
RELEASE_CHECKLIST = PREPARED
TESTS = 1330/1330 PASS
TYPESCRIPT = HISTORICAL_TS7016_ONLY
MIGRATION_0007 = NOT_REQUIRED
MIGRATIONS_BYTE_DELTA = 0
SCHEMA_BYTE_DELTA = 0
P0 = 0
P1 = 0
P2 = 0
REMOTE_PUSH = NOT_PERFORMED
MAIN_MERGE = NOT_PERFORMED
TAG = NOT_CREATED
GITHUB_RELEASE = NOT_CREATED
CLOUDFLARE_DEPLOY = NOT_PERFORMED
REMOTE_D1 = NOT_MODIFIED
PUBLICATION_AUTHORIZATION = NOT_GRANTED
```

BOLTLINK v3.2.1 GATE 10.2 PASSED — RELEASE CANDIDATE READY, AWAITING EXPLICIT PUBLICATION AUTHORIZATION
