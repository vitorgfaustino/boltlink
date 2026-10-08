# Publicação futura — BoltLink v3.2.1 — Upgrade & Deploy Safety

A **3.2.1 é candidata local, não publicada**. O Gate 10.3 congela código e documentação para revisão do proprietário. Este checklist não concede autorização. A release pública atual permanece **v3.2.0**. GitHub source distribution e operações Cloudflare por instalação são escopos separados.

```text
BASE_OFFICIAL_SHA = 84ecacf1822f41c2fcc240d464dc4a0b43447d7a
BASE_10_2_SHA = b7dca0b30413f545ade5a1d34bb4c2841b9db819
BRANCH = codex/3.2.1-upgrade-safety
PUBLICATION_AUTHORIZATION = NOT_GRANTED
CI_REMOTE = PENDING_PUBLICATION
FIRST_DEPLOY_REMOTE_VALIDATION = NOT_PERFORMED
```

O SHA congelado é o commit local que contém o [relatório do Gate 10.3](gate10-3-local-validation.md), registrado na entrega. No próximo gate, confirme esse SHA literal com o proprietário; não deduza autorização a partir do nome da branch.

## Sequência obrigatória do próximo gate autorizado

| Passo | Ação / evidência necessária | Ambiente |
| --- | --- | --- |
| 1 | Obter autorização explícita para destino, SHA, integração, push, tag e Release. Confirmar se o GitHub tem auto-deploy, pois push pode operar uma instalação | Proprietário / GitHub |
| 2 | Conferir SHA congelado, ancestralidade dos Gates 10.1/10.2/10.3 e árvore limpa; zero P0/P1/P2 aberto | Local |
| 3 | Atualizar refs por leitura e conferir main/origin/main/v3.2.0 na base oficial; v3.2.1 e sua Release ausentes. Avanço concorrente bloqueia integração | GitHub / local |
| 4 | Aplicar somente as substituições documentais abaixo, preservando showcase e versões históricas | Local |
| 5 | Rodar npm test, dependências offline, TypeScript e diff check após essa atualização; aceitar somente TS7016 histórico | Local |
| 6 | Criar commit definitivo de metadata, se necessário, e apresentar seu novo SHA para autorização concreta de publicação | Local / proprietário |
| 7 | Integrar por fast-forward na main, sem reset/rebase/force e sem sobrescrever trabalho alheio | Local |
| 8 | Conferir remoto novamente e executar push de main sem force | GitHub, somente autorizado |
| 9 | Aguardar CI da main no SHA definitivo; os dois testes de tags históricas devem executar, sem skips | GitHub |
| 10 | Criar tag anotada v3.2.1 no mesmo SHA e enviá-la, somente após CI da main aprovado | Local / GitHub, somente autorizado |
| 11 | Aguardar CI da tag no mesmo SHA; não declarar aprovação antecipada | GitHub |
| 12 | Criar GitHub Release estável/latest com título e notas definitivas da seção 3.2.1 | GitHub, somente autorizado |
| 13 | Verificar igualdade SHA de main/origin/main/tag/Release, tag anotada, CI, ausência de draft/prerelease e latest | GitHub / local |
| 14 | Comparar arquivos públicos com o commit definitivo, validar links/documentação, screenshots e GIF preservados | GitHub / local |

**Nenhuma publicação, integração na main, tag, push, PR, Release (mesmo draft), deploy ou migration remota pode ser executada no Gate 10.3.** Cloudflare deploy continua fora do escopo da publicação do repositório oficial. Falha de CI ou divergência de refs interrompe a sequência; não mover tags para buscar aprovação.

## Substituições documentais futuras

- Nos blocos correntes de README, AI-START, AGENTS e docs operacionais: candidata → release publicada; versão atual v3.2.0 → v3.2.1; v3.2.0 → release anterior onde pertinente. Atualizar rodapés correntes e referências à versão operada. Preservar histórico, relatórios de gates e capturas identificadas como v3.2.0.
- CHANGELOG: substituir o marcador sem data do bloco da candidata 3.2.1 pela data real da publicação autorizada, sem antecipar data. A substituição preparada é:

```text
CHANGELOG 3.2.1: Unreleased — candidata de manutenção → data real da publicação
```
- RELEASE_NOTES: remover o estado de candidata somente no gate autorizado; usar o título `BoltLink v3.2.1 — Upgrade & Deploy Safety` e conservar as limitações reais.
- Atualizar título/âncora do contrato de upgrade e todos os links correspondentes se a âncora mudar. Conferir README, AI-START, AGENTS, CHANGELOG, RELEASE_NOTES, docs e textos visíveis em public. Package, lockfile e APP_VERSION já estão em 3.2.1.
- Reconciliar constantes/padrões de identidade dos scanners documentais, em especial `test/smart-routing-admin.spec.ts`; nunca remover verificações históricas ou afrouxar a separação de escopos.
- Preservar migrations 0000–0006, schema, assets, branding, Deploy Button e funcionalidades. **MIGRATION_0007 = NOT_REQUIRED**. Nenhuma versão 3.2.2 neste fluxo.

## Comandos preparados — não executar neste gate

Roteiro para o próximo gate, após autorização. Substitua SHAs e IDs entre `<...>` por evidências concretas; não cole placeholders no shell. Cada etapa depende da aprovação da anterior.

```bash
# Preflight por leitura no próximo gate
git status --porcelain=v1
git rev-parse HEAD main origin/main 'v3.2.0^{}'
git merge-base --is-ancestor b7dca0b30413f545ade5a1d34bb4c2841b9db819 <SHA_CONGELADO_AUTORIZADO>
git fetch origin --tags
git ls-remote origin refs/heads/main refs/tags/v3.2.0 'refs/tags/v3.2.0^{}' refs/tags/v3.2.1
gh api repos/vitorgfaustino/boltlink/releases
# Se main/origin/main ou a tag da base divergirem, parar.
```

Depois das substituições documentais, execute separadamente e registre os exits:

```bash
npm test
npm ls --depth=0 --offline
npx --no-install tsc --noEmit
git diff --check
git diff 84ecacf1822f41c2fcc240d464dc4a0b43447d7a -- migrations schema.sql
```

TypeScript pode retornar exit 2 **somente** pelo TS7016 histórico de qrcode; erro novo bloqueia. Stage deve usar a lista explícita de arquivos revisados, nunca adicionar configs privados ou snapshots. Faça o commit de metadata e obtenha autorização do SHA definitivo antes da integração/publicação.

```bash
# Somente após aprovação do SHA definitivo e base inalterada
git switch main
git merge --ff-only <SHA_DEFINITIVO_AUTORIZADO>
git push origin main
gh run list --workflow test.yml --commit <SHA_DEFINITIVO_AUTORIZADO> --json databaseId,headSha,headBranch,status,conclusion,event
gh run watch <ID_CI_MAIN> --exit-status
# Confirmar o run de push da main e suas contagens antes de continuar.
git tag -a v3.2.1 <SHA_DEFINITIVO_AUTORIZADO> -m "BoltLink v3.2.1 — Upgrade & Deploy Safety"
git push origin refs/tags/v3.2.1
gh run list --workflow test.yml --commit <SHA_DEFINITIVO_AUTORIZADO> --json databaseId,headSha,headBranch,status,conclusion,event
gh run watch <ID_CI_TAG> --exit-status
# Preparar o arquivo de notas só com a seção definitiva 3.2.1, com newlines reais.
gh release create v3.2.1 --repo vitorgfaustino/boltlink --verify-tag --latest --title "BoltLink v3.2.1 — Upgrade & Deploy Safety" --notes-file /private/tmp/boltlink-3.2.1-release-notes.md
```

```bash
# Auditoria pós-publicação, somente por leitura
git rev-parse main origin/main 'v3.2.1^{}'
git cat-file -t v3.2.1
git ls-remote origin refs/heads/main refs/tags/v3.2.1 'refs/tags/v3.2.1^{}'
gh api repos/vitorgfaustino/boltlink/releases/tags/v3.2.1
gh api repos/vitorgfaustino/boltlink/releases/latest
gh run view <ID_CI_MAIN> --log
gh run view <ID_CI_TAG> --log
```

Logs/metadata devem provar o mesmo SHA, ambos os CIs aprovados e zero skips históricos. Confira arquivos e links nas URLs públicas de main e da tag; contagem de links não comprova disponibilidade de destinos externos. Registre evidências indisponíveis sem declarar validação.

## Limites de comprovação

CI da main/tag, Release/latest e arquivos publicados dependem do GitHub após autorização. Provisionamento real do Deploy Button e associação UUID → D1 correto dependem da instalação Cloudflare e de autorização própria; não são comprovados por mocks nem pela publicação source distribution. O workflow mantém `fetch-depth: 0`, `contents: read`, `persist-credentials: false` e nenhum job de deploy.

Cada instalação existente segue separadamente o [upgrade seguro](upgrading.md#upgrade-seguro--candidata-321): baseline confiável, comparação obrigatória de configurações, preflight, testes, diff e autorização antes de push/auto-deploy. IDs perdidos exigem recuperação individual; não há correção ou atualização automática, nem regeneração de secrets.
