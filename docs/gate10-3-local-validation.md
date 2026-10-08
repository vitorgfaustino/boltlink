# Gate 10.3 — final release freeze e publication preflight

Data: 2026-10-08. Candidata **3.2.1 congelada localmente**, publicação sem autorização. A release pública atual permanece **v3.2.0**.

```text
BASE_OFFICIAL_SHA = 84ecacf1822f41c2fcc240d464dc4a0b43447d7a
BASE_10_1_SHA = 8b4d4b55fb46292f18dcdcce737f1d6a98b7bf34
BASE_10_2_SHA = b7dca0b30413f545ade5a1d34bb4c2841b9db819
BRANCH = codex/3.2.1-upgrade-safety
```

O FINAL_FREEZE_SHA é o único commit local de fechamento que contém este relatório, informado na entrega. A identidade de um documento versionado não incorpora seu próprio SHA. Consulte o commit que contém este arquivo e confira o SHA literal entregue antes de autorizar qualquer publicação.

## Custódia e consultas remotas somente leitura

Checkout correto, origin oficial `https://github.com/vitorgfaustino/boltlink.git`, branch e HEAD exatos do contrato, árvore inicialmente limpa. Gates 10.1 e 10.2 presentes em ancestralidade linear, sem merge entre a base oficial e a candidata. Não houve reset, rebase ou troca de branch.

Refs locais main/origin/main e tag v3.2.0 resolvem à base oficial. `git ls-remote` confirmou o mesmo SHA no GitHub e preservação do objeto anotado da tag. A consulta `gh api repos/vitorgfaustino/boltlink/releases` confirmou v3.2.0 estável, sem draft/prerelease, Release ID 406290463, e ausência de Release v3.2.1. Nenhuma tag v3.2.1 local/remota foi encontrada. Não foi necessário fetch; a consulta remota não atualizou refs locais. Nenhum avanço concorrente observado.

A primeira consulta GitHub foi impedida por DNS na sandbox; a mesma leitura autorizada funcionou com rede permitida. Isso não constituiu escrita remota.

## Delta auditado contra a base oficial

O delta final fica restrito a **Upgrade & Deploy Safety**:

| Categoria | Arquivos da candidata |
| --- | --- |
| Scripts operacionais | scripts/config-utils.mjs, scripts/config-safety.mjs, scripts/wrangler-routing.mjs, scripts/wrangler.mjs, scripts/dev-prepare.mjs |
| Testes | test/upgrade-safety.spec.ts, test/wrangler.spec.ts, test/index.spec.ts |
| Configuração | wrangler.jsonc (somente comentários), vitest.config.mts (projeto node dos testes operacionais) |
| GitHub Actions | .github/workflows/test.yml |
| Versionamento | package.json e package-lock.json; aplicação e /version derivam APP_VERSION do package |
| Documentação | AGENTS.md, AI-START.md, README.md, CHANGELOG.md, RELEASE_NOTES.md; docs/ai-accepted-requests.md, ai-guided-operations.md, cloudflare-setup.md, technical-reference.md, upgrading.md, release-3.2.1-checklist.md e relatórios gate10-1/10-2/10-3-local-validation.md |

`src/`, `public/`, migrations 0000–0006 e schema.sql permanecem byte-idênticos à base. Nenhum delta em Admin, API de links, QR Code, Smart Routing, A/B, grupos, UTMs, auth, redirects ou métricas. Sem SQL novo, feature, dependência nova ou secret obrigatório novo. O lockfile difere da base somente nas duas versões do produto.

O corpo comercial do README anterior à licença, incluindo imagens, GIF, links, recursos e Deploy Button, foi comparado literalmente com a base e preservado. O aviso técnico de candidata foi movido para Estado das versões. Assets não foram regenerados.

## Findings reproduzidos e fechados neste gate

| Finding | Prioridade inicial | Evidência e correção | Estado |
| --- | --- | --- | --- |
| BL-103-01 | P2 | Comparação aprovava com confirmação a remoção parcial de KV, seu ID e D1 name em baseline sem ID. Agora remoções de campos/recursos são detectadas recursivamente; listas são comparadas por identidade, inclusive ambientes e Durable Objects. Reordenação e mudança intencional de alvo continuam exigindo confirmação, sem bypass para remoção | CLOSED |
| BL-103-02 | P1 | Fixture com D1 válido no nível superior e `.env.local` selecionando ambiente sem binding retornou exit 0 e uma chamada mock. Wrangler 4.90.0 carrega `.env` e `.env.local` antes de resolver ambiente. Ambos os seletores implícitos agora exigem contexto explícito | CLOSED |
| BL-103-03 | P1 | `deploy --e=production` validava o nível superior e chamava o mock apesar do ambiente incompleto. O parser yargs também aceita --c, --dryRun e --envFile; a mistura --dry-run com --dryRun=false tornava dryRun false. Esses aliases agora recebem a mesma validação, inclusive duplicidades/negação e posições de flags | CLOSED |
| BL-103-04 | P2 | D1 delete/insights são implicitamente remotos, mas estavam fora da classificação sem --remote. Agora exigem o preflight antes do subprocesso; regressões verificam zero chamadas com ID ausente. Nenhuma operação D1 real foi executada | CLOSED |
| BL-103-05 | P3 | Aviso de candidata estava na primeira dobra do README. Movido para a seção técnica, com corpo comercial preservado byte a byte | CLOSED |
| BL-103-06 | P3 | Checklist não detalhava comandos, atualização documental, novo SHA definitivo e checkpoints completos de CI/tag/Release. Roteiro futuro foi preparado com operações dependentes de autorização | CLOSED |

As reproduções usaram somente dados sintéticos, comparação local, parser local e subprocessos simulados. Nenhum teste antigo foi removido ou afrouxado. Foram adicionadas **27 regressões**, incluindo remoção parcial com reposição por outro binding, IDs vazios, ambiente, CLI real de comparação, logs sem valores privados, aliases e dotenv.

## Contratos de segurança verificados

- D1: database_id ausente, UUID inválido/nulo, binding ausente/duplicado, database_name conflitante e migrations_dir divergente bloqueiam antes de spawn. A saída identifica o arquivo efetivo e categorias de erro, sem valores privados.
- Configuração: merge pelo mesmo binding, membership/ordem local preservados, duplicidades recusadas, nenhuma adoção de ID/name upstream por entrada local incompleta. JSONC é interpretado como dados, sem Function/eval. Identidade removida requer correção, sem confirmação que a contorne.
- Roteamento: Workers Builds usa público no apply/deploy padrão mesmo com privado presente; CLI local respeita privado; config explícito tem prioridade. Flags antes/depois, formas compactas, aliases longos, ambiente CLI/CLOUDFLARE_ENV e precedência dotenv têm regressões. D1 não herda bindings do nível superior em ambiente nomeado.
- Upgrade por IA: identifica projeto cliente/upstream oficial, versões, método de publicação e estratégia antes da integração. Preserva snapshots privados, Worker/D1/bindings/domínios/rotas/overlays/branding/configs/secrets, sem regenerar secrets. `upgrade:check` é obrigatório antes do push; baseline ausente nega aprovação automática. `git pull --ff-only` não prova incorporação do upstream.
- Deploy: o script mantém preflight → migrations remotas pendentes → somente após sucesso, Worker. Fixtures isoladas executam o npm script real com executável Wrangler falso: ID ausente gera zero operações; migration exit 23 impede Worker; sucesso e zero pendências permitem a chamada simulada de deploy. O `npm run deploy` real deste checkout nunca foi executado.
- Deploy Button: template público continua sem database_id. Provisionamento sintético, instalação individualizada, perda de ID e execução privada local têm cobertura. Primeiro provisionamento remoto não foi executado nem declarado comprovado.
- CI: workflow somente de testes, fetch-depth 0, contents read, persist-credentials false, sem credenciais novas ou job de deploy. Tags históricas estão disponíveis localmente e seus testes não foram pulados. CI remoto continua pendente; nenhum push para testá-lo.
- Versão: package, ambas as entradas do lockfile, landing, /version e asserções ficam em 3.2.1. Documentação corrente distingue candidata de v3.2.0 publicada. Nenhum bump para 3.2.2 ou alteração de versões históricas.

Documentação oficial conferida nesta auditoria: [Wrangler config/ambientes](https://developers.cloudflare.com/workers/wrangler/configuration/), [Workers Builds e WORKERS_CI](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Deploy Button/provisionamento e migrations por binding](https://developers.cloudflare.com/workers/platform/deploy-buttons/) e [comandos D1](https://developers.cloudflare.com/workers/wrangler/commands/d1/). Comportamento dos aliases e dotenv também foi confrontado com o código instalado do Wrangler 4.90.0; nenhuma inferência local é tratada como evidência de provisionamento remoto.

## Validação e intercorrências

A primeira suíte restrita parou antes das asserções em EPERM de logs/loopback. O mesmo comando com acesso local permitido passou o baseline **1330/1330**, 37 arquivos, zero skipped. TypeScript mostrou somente a assinatura histórica aceita.

A focada operacional passou 111/111 após as primeiras correções e 118/118 após o complemento de aliases. A suíte completa com todas as 27 regressões passou 1356 testes e falhou uma asserção documental: o marcador do CHANGELOG citado em prosa no checklist era interpretado como estado corrente. A instrução futura foi tornada explícita como exemplo de substituição; o scanner permaneceu inalterado. Essa mudança concreta motivou a validação final, sem rerun cego nem waiver novo.

Validação final da candidata:

- `npm test`: **1357/1357 PASS**, 37 arquivos, zero skipped.
- `npm ls --depth=0 --offline`: exit 0, dependências consistentes.
- `npx --no-install tsc --noEmit`: exit 2, somente **TS7016 histórico de qrcode em src/index.ts:31**. Não é TypeScript limpo.
- `git diff --check`: exit 0.
- Comparação contra a base: src/public/migrations/schema sem delta; versão 3.2.1 consistente; template sem UUID e showcase preservado.

## Riscos remanescentes classificados

| Risco / limitação | Classificação neste gate | Tratamento |
| --- | --- | --- |
| Primeiro Deploy Button sem validação remota desta candidata | Risco aceito pelo contrato, não bloqueante | Registrar NOT_PERFORMED; não extrapolar mocks |
| UUID válido não comprova associação ao D1 correto | Limitação operacional | Operador confere banco/conta da instalação |
| Instalações existentes não são atualizadas automaticamente | Limitação do modelo source distribution | Upgrade separado, comparações, testes e autorização por instalação |
| Instalação que perdeu IDs exige recuperação individual | Limitação operacional | Histórico/backup confiável e recuperação documentada; não criar D1 substituto |
| CI remoto só ocorre após publicação autorizada | Dependência futura do GitHub, não bloqueante local | PENDING_PUBLICATION; confirmar main/tag no próximo gate |
| upgrade:check depende de baseline confiável | Requisito bloqueante por instalação quando ausente | MANUAL_RECONCILIATION_REQUIRED; nenhuma fabricação de snapshot |

Nenhum P0/P1/P2 permanece aberto no escopo auditado. Recuperação automática de IDs e updater automático não integram esta release.

## Freeze e handoff

Alterados somente neste Gate 10.3: scripts/config-safety.mjs, scripts/wrangler-routing.mjs, test/upgrade-safety.spec.ts, README.md, CHANGELOG.md, RELEASE_NOTES.md, docs/upgrading.md, docs/release-3.2.1-checklist.md e este relatório. Um único commit local de fechamento; árvore final limpa. Não há PR, tag ou Release nova.

O [checklist final](release-3.2.1-checklist.md) contém autorização, SHA/base, substituições documentais futuras, testes após promoção, commit definitivo, integração segura, push sem force, CI main, tag anotada, CI tag, Release estável/latest e auditoria pública de arquivos/links. As etapas de GitHub e Cloudflare estão identificadas como dependências externas. Os comandos futuros foram somente escritos, não executados.

```text
VERSION = 3.2.1
RELEASE_STATUS = FROZEN_LOCAL_CANDIDATE
UPGRADE_SAFETY = VERIFIED
D1_PREFLIGHT = VERIFIED
WRANGLER_CONFIG_ROUTING = VERIFIED
CONFIG_MERGE_BY_BINDING = VERIFIED
UPGRADE_CHECK = REQUIRED
INSTALLATION_IDENTITY = PROTECTED
FIRST_DEPLOY_COMPATIBILITY = LOCALLY_VERIFIED
FIRST_DEPLOY_REMOTE_VALIDATION = NOT_PERFORMED
EXISTING_INSTALLATION_UPGRADE = LOCALLY_VERIFIED
MIGRATIONS_BEFORE_DEPLOY = VERIFIED
CHANGELOG = READY
RELEASE_NOTES = READY
RELEASE_CHECKLIST = READY
TESTS = 1357/1357 PASS
TYPESCRIPT = HISTORICAL_TS7016_ONLY
CI_REMOTE = PENDING_PUBLICATION
MIGRATION_0007 = NOT_REQUIRED
MIGRATIONS_BYTE_DELTA = 0
SCHEMA_BYTE_DELTA = 0
P0 = 0
P1 = 0
P2 = 0
MAIN = UNCHANGED
ORIGIN_MAIN = UNCHANGED
TAG_v3.2.0 = PRESERVED
REMOTE_PUSH = NOT_PERFORMED
MAIN_MERGE = NOT_PERFORMED
TAG_v3.2.1 = NOT_CREATED
GITHUB_RELEASE = NOT_CREATED
CLOUDFLARE_DEPLOY = NOT_PERFORMED
REMOTE_D1 = NOT_MODIFIED
PUBLICATION_AUTHORIZATION = NOT_GRANTED
```

BOLTLINK v3.2.1 GATE 10.3 PASSED — RELEASE CANDIDATE FROZEN, AWAITING EXPLICIT PUBLICATION AUTHORIZATION
