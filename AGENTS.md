# AGENTS.md

## Candidata em desenvolvimento — 3.2.0

Este checkout contém a **3.2.0 candidata local**, ainda não publicada. A release oficial continua **3.1.1**, tag **v3.1.1**, congelada e reconciliada. A candidata reúne filtro recursivo de grupos, caminho hierárquico completo nos badges, edição bidirecional de UTMs e `ROOT_REDIRECT_URL` como Text opcional no setup. O Admin traz Dark Mode refinado, cards compactos e badges semânticas; o README apresenta o produto com screenshots atualizadas em Light, Dark e mobile e uma demonstração animada com dados fictícios. Sem migration nova: **MIGRATION_0007 = NOT REQUIRED**. Veja [Admin UX](docs/admin-ux.md).

## Release publicada — 3.1.1

A **3.1.1 está publicada**, identificada pela tag **v3.1.1**; é a release atual e latest do repositório. A release anterior **v3.1.0** permanece congelada. Este patch operacional aplica migrations D1 pendentes antes do Worker no fluxo padrão de deploy e amplia o guia Cloudflare Access. **MIGRATION_0007 = NOT REQUIRED**; migrations `0000`–`0006`, sem mudança funcional no produto.

Publicar tag/release é **source distribution** e não opera Cloudflare de clientes. Cada instalação executa o próprio `npm run deploy`, que aplica apenas migrations pendentes antes do Worker, e configura seu próprio Access. O guia completo está em [Cloudflare Access](docs/admin-auth.md).

A correção de compatibilidade da mesma 3.1.1 substitui apenas pontos e vírgulas em comentários das migrations históricas para o parser remoto D1/Wrangler. O SQL executável, o schema e os nomes `0000`–`0006` permanecem inalterados. Instalações novas usam os arquivos corrigidos; bancos que já registraram a cadeia não reaplicam essas migrations. A correção integra a v3.1.1 republicada e congelada. O fresh install D1 remoto foi validado pelo usuário, e o CI da main e da tag passou. Um segundo deploy não é requisito da release source distribution.

## Recursos preservados desde a 3.1.0

A **3.1.0**, agora release anterior congelada na tag **v3.1.0**, introduziu os recursos abaixo. A tag histórica **v3.0.0** também permanece congelada. A 3.1.0 adiciona Lixeira, restauração validada, exclusão definitiva com reutilização de slug e limpeza administrativa explícita com preview e retenção de 90 dias. Não há Cron automático. O export passa a conter somente links ativos; tombstones ficam fora do documento e dos limites de links, enquanto ativos inválidos continuam fail-closed. Import v1 legado com `disabled: true` continua aceito. **MIGRATION_0007 = NOT REQUIRED**; migrations permanecem `0000`–`0006`.

Contrato completo e operação no Admin: [Lixeira e recuperação](docs/trash-recovery.md). Os procedimentos correntes abaixo seguem a release `3.1.1`; a tag `v3.1.0` conserva o procedimento histórico sem migrations automáticas. Publicar código no Git/GitHub não atualiza instalações: deploy, D1 remoto e Access exigem autorização própria por instalação.


Este arquivo define regras para agentes de IA e assistentes automatizados que trabalhem neste repositório.

## Escopo do projeto

Aplicação de gerenciamento e redirecionamento de links baseada em Cloudflare Workers, com:

- redirect público por slug
- painel administrativo estático em `public/admin.html`
- CRUD de links em D1
- contagem agregada em `links.clicks_total`
- Split Test A/B stateless (**publicado na 3.0.0**; origem Fase 2 — migration `0004_ab_testing.sql`, ausente da release histórica `v2.2.1`)
- Smart Routing stateless por país/dispositivo em `links.smart_routing_rules` (**publicado na 3.0.0**; origem Fase 3 — migration `0005`, ausente da release histórica `v2.2.1`)
- destino opcional para links expirados em `links.expired_redirect_url` (**publicado na 3.0.0**; origem Fase 4 — migration `0006_expired_redirect.sql`, ausente da release histórica `v2.2.1`)
- redirect opcional da raiz (`GET /`) via variável `ROOT_REDIRECT_URL` (**publicado na 3.0.0**; origem Fase 4, sem D1)
- hierarquia de grupos em `link_groups.parent_id` (**publicado na 3.0.0**; origem Fase 5, sem migration nova: a coluna existe desde a `0002`)
- exportação administrativa da configuração lógica em BoltLink Portability JSON v1 via `GET /api/export` (**publicado na 3.0.0**; origem Fase 5, sem migration nova)
- importação administrativa dessa mesma configuração via `POST /api/import/preview` (somente leitura) e `POST /api/import/apply` (**publicado na 3.0.0**; origem Fase 5, sem migration nova)
- QR Code com diálogo de preview e download PNG/SVG no Admin (**publicado na 3.0.0**; origem Fase 5 — os endpoints `GET/POST /api/links/:slug/qrcode` e a coluna `has_qrcode` existem desde a base publicada, sem migration nova)
- autenticação administrativa via Cloudflare Access

### Bases de código que não podem ser confundidas

| Base | Como identificar | Migrations | Recursos extras |
| --- | --- | --- | --- |
| **Release atual publicada** (`3.1.1`) | tag `v3.1.1`, branch `main` (convergência verificada no gate de publicação/pós-publicação) | `0000` a `0006` | Lixeira + recuperação + exclusão definitiva/purge manual + export ativo + Split Test A/B + Smart Routing + destino de expiração + `ROOT_REDIRECT_URL` + hierarquia de grupos + exportação portátil + importação portátil + QR Code com preview e download PNG/SVG no painel |
| **Release anterior congelada** (`3.1.0`) | tag `v3.1.0` | `0000` a `0006` | mesmos recursos de produto; deploy sem migrations automáticas |
| **Baseline histórico do upgrade** (`v2.2.1`) | tag `v2.2.1` (`git rev-parse v2.2.1` → `8b3895e`) | `0000` a `0003` | — |
| Fase 2 (checkpoint histórico) | baseline local `23353a1` | `0000` a `0004` | Split Test A/B |
| Fase 3 (checkpoint congelado) | HEAD `548f179` | `0000` a `0005` | Fase 2 + Smart Routing |
| Fase 4 (checkpoint congelado) | HEAD `cdb9f83` | `0000` a `0006` | Fase 3 + destino de expiração + `ROOT_REDIRECT_URL` |
| Fase 5 (checkpoint pre-freeze) | `3670a44` sobre `cdb9f83` | `0000` a `0006` (sem migration nova) | Fase 4 + hierarquia de grupos + exportação portátil + importação portátil + QR Code — evoluiu para a release `3.0.0` |

A release atual publicada é a **`3.1.1`**, identificada pela tag `v3.1.1` na branch `main`. O patch preserva os recursos da 3.1.0 e corrige o processo de deploy, sem migration nova. A tag publicada e `main` devem convergir para o mesmo release commit; essa igualdade é um invariante operacional verificado externamente por Git/GitHub API nos gates de publicação e auditoria pós-publicação, sem exigir um SHA corrente literal neste documento. Ela mantém as migrations `0000` a `0006`, os recursos publicados desde a `3.0.0` e a Lixeira/recuperação introduzidas na `3.1.0`, sem migration nova. A `v3.1.0` é a **release anterior**; a `v2.2.1` é o **baseline histórico do upgrade** das features. São conceitos distintos: a release anterior imediata muda a cada publicação, o baseline histórico do upgrade muda apenas em novos upgrades major. A `v2.2.1` não contém a `0004`, o Split Test A/B, a `0005`, o Smart Routing nem o script `npm run dev-prepare`. Também não contém a `0006`, o destino de expiração nem o `ROOT_REDIRECT_URL` da Fase 4, e não contém a hierarquia de grupos segura nem a portabilidade da Fase 5 (a tabela `link_groups` existe na tag, mas sem a validação de ciclo, de profundidade, de delete e de concorrência, e não existem `GET /api/export`, `POST /api/import/preview` nem `POST /api/import/apply`). Documentação e testes devem manter essa separação; `test/smart-routing-admin.spec.ts` tem um scanner que falha quando um artefato aparece no escopo errado.

### Histórico dos gates 3.0.0 e publicação 3.1.0

- Baseline pre-freeze da Fase 5: `3670a44619751a80e6de61e0c928b080d99c0cb6` (`feat: add SVG QR download and polish dialog`), sobre o HEAD congelado da Fase 4 `cdb9f83`. A versão da release originada dessa linha é **`3.0.0`** (essa é a versão histórica; o checkout corrente está em `3.2.0` candidata).
- Gates congelados da Fase 5 (não reimplementar, não reabrir sem finding concreto): Gate 5.1 hierarquia de grupos (`a82dda5`), Gate 5.2 export portátil (`d8bb407`), microfix do Groups Drawer (`6de22f2`), Gate 5.3 import portátil (`d3f8818`), Gate 5.4 workflow de QR Code (`fe705fc`), Gate 5.4.1 QR UX + downloads PNG/SVG (`3670a44`).
- Gate 5.5 (integração final e freeze de documentação): **FROZEN**. Fechou o finding BL-54-04 e reconciliou a documentação; não adicionou feature, migration, bump de versão, tag nem deploy.
- Com o freeze do Gate 5.5, a Fase 5 ficou **FEATURE FROZEN**: nenhuma feature adicional deve ser iniciada, e a Phase 6 não pode ser iniciada dentro de um gate da Fase 5.
- **Phase 6 — Release Readiness: COMPLETE.** Gate 6.1 (auditoria global final) concluído com P0 = 0, P1 = 0 e P2 = 0; Gate 6.2 (correção dos blockers) concluído, fechando BL-61-01 e BL-61-02; Gate 6.3 (version finalization) concluído — versão `3.0.0` finalizada e os P3 BL-61-03, BL-61-04 e o wording "nullable" de `docs/upgrading.md` fechados; Gate 6.4 (local release commit) concluído — commit de preparação `6847e47` (`release: prepare 3.0.0`) sobre o pre-release baseline `04a6873`; Gate 6.5A (publication preflight): **RECLASSIFIED** — BL-65A-01 é **NOT APPLICABLE** (o finding assumia uma instalação canônica Cloudflare/D1 vinculada ao repositório-base, e ela não existe; Cloudflare login, D1/Worker remotos e production smoke não são requisito da release do repositório), e BL-65A-02 (wording de release não publicada no commit de preparação) foi fechado no Gate 6.5B; Gate 6.5B (final publication metadata) concluído — historicamente, finalizou a metadata no commit `60c8575` (`release: finalize 3.0.0`); **Gate 6.6 (publicação da release): PASSED** — na publicação inicial, a tag `v3.0.0` foi criada sobre `60c8575`, com push de `main` e da tag e GitHub Release concluídos. Modelo de distribuição: a release do repositório é **source distribution** (source commit + tag `v3.0.0` + push de `main` + push da tag + GitHub Release); Cloudflare deploy, migrations e D1 são **por instalação** e não fazem parte da release do repositório. Estado da release: **PUBLICADA**.
- **Phase 7 — Current-State Reconciliation (histórico da 3.0.0 congelada)**: Gate 7.2 concluído (BL-66-01); Gate 7.3 rejeitado; Gate 7.4 concluído (correções BL-73-01..04); Gate 7.5 aprovado; Gate 7.6 produziu o commit de correção; Gate 7.7 concluiu a republicação controlada da mesma `v3.0.0`. Gate 7.8 reconciliou a identificação corrente sem SHA literal (BL-77-01), sem bump, migration ou mudança funcional.
- A dívida técnica `TS7016` do módulo `qrcode` foi **aceita para a 3.0.0** como **não bloqueante** (runtime, bundle do Wrangler e suíte passam; o CI atual não usa `tsc` como gate de release).
- A release atual publicada é a **`3.1.1`** (tag `v3.1.1`, publicada no GitHub); nenhum documento pode afirmar que instalações foram atualizadas, que migrations remotas foram aplicadas por quem publica a tag, ou que existe Worker/D1/hostname/Cloudflare Account oficial — cada instalação é self-hosted e executa o próprio upgrade (`docs/upgrading.md`).

## Regra obrigatória para tarefas Cloudflare

Conhecimento sobre Workers, D1, Wrangler, Assets, Access, Observability e WAF pode ficar desatualizado rapidamente.

Antes de propor mudanças de infraestrutura, bindings, limites, deploy, logging, rate limit ou autenticação Cloudflare:

- consulte a documentação atual da Cloudflare
- confira especialmente Workers, Wrangler, D1, Static Assets, Cloudflare Access e WAF Rate Limiting Rules
- para limites e quotas, consulte a página oficial do produto correspondente
- para instâncias no plano gratuito, priorize opções gratuitas ou incluídas no limite gratuito antes de sugerir recursos pagos
- documente etapas operacionais fora da aplicação, como configurações no painel Cloudflare, no arquivo apropriado em `docs/`

## Configuração pública e local

- `wrangler.jsonc` é o template público e sanitizado
- `wrangler.local.jsonc` é a configuração privada local e não deve ser versionada
- não introduza `wrangler.toml`
- se bindings mudarem, rode `npm run cf-typegen`
- em `migrations/*.sql`, ponto e vírgula em statement SQL é permitido e normal, mas ponto e vírgula dentro de comentários `--` ou `/* ... */` é proibido, nas migrations existentes e futuras, para compatibilidade com o parser remoto D1/Wrangler; valide com `npm test -- --project node test/migration-comments.spec.ts`
- se schema mudar, crie uma nova migration; `schema.sql` é apenas o baseline da `0000_initial_schema.sql` e não deve receber colunas de features
- o runtime não pode executar `schema.sql`, criar/alterar colunas, aplicar migrations implicitamente nem reconstruir tabelas durante requests; banco não preparado deve falhar fechado com `503`
- na release 3.1.1, `npm run deploy` aplica migrations D1 remotas pendentes pelo binding `db_boltlink` antes de publicar; uma falha impede o deploy. No Workers Builds sem config privado, somente o apply remoto desse binding usa o template público; outros comandos D1 continuam exigindo config privado ou config explícito. Deploy command deve ser `npm run deploy`. Nunca execute esse script para validação local: ele altera o D1 remoto. A tag v3.1.0 conserva o deploy sem migrations automáticas.
- desenvolvimento local do Worker exige migrations no D1 do Wrangler: `npm run dev-prepare` (parte da release `3.0.0`, aplica a cadeia `0000`–`0006`) cobre isso; o script **não existe** no checkout histórico da tag `v2.2.1` (lá use `npm run wrangler -- d1 migrations apply ... --local`); `npm run dev-init` prepara apenas o SQLite auxiliar `.dev-env/db.sqlite3`, que o Worker não usa

## Restrições funcionais que devem ser preservadas

- o slug é imutável após a criação
- o redirect público deve responder antes da contagem
- o admin deve continuar protegido em `/admin`, `/api` e `/api/*`
- IPs não devem ser persistidos
- hashes estáveis de IP não devem existir no produto
- país, `User-Agent`, dispositivo derivado e regra selecionada não devem ser persistidos
- slugs de linhas existentes (ativos ou na Lixeira) e slugs de sistema continuam reservados; a 3.1.0 permite reutilização após exclusão definitiva/purge físico
- Smart Routing e Split Test A/B são mutuamente exclusivos
- links com Smart Routing configurado usam sempre `302` + `Cache-Control: no-store`
- Smart Routing não deve adicionar SELECT adicional, tabela auxiliar, JOIN, API externa nem contador por regra
- o lifecycle vence senha, A/B e Smart Routing: link expirado com destino válido responde `302` + `no-store`, sem destino responde `410` + `no-store`, e requests expirados não contam clique nem gravam no banco (Fase 4)
- `expiredRedirectUrl` requer `expiresAt`; limpar a expiração mantendo o destino é recusado, limpar os dois na mesma edição é a limpeza atômica permitida (Fase 4)
- `ROOT_REDIRECT_URL` é opcional e não secreta: válida faz `GET /` responder `302` + `no-store` sem tocar D1; ausente/inválida serve a landing; unknown slugs continuam `404` (Fase 4)
- a hierarquia de grupos usa somente `link_groups.parent_id`: sem migration, sem tabela auxiliar, sem closure table, sem materialized path e sem coluna `version` em grupos (Fase 5)
- `parentId` é o nome na escrita; `GET /api/groups` continua plano com `parent_id` e o Admin monta a árvore no cliente (Fase 5)
- grupo pai inexistente responde `404`; auto-parentesco e qualquer ciclo indireto respondem `409` sem escrita (Fase 5)
- `MAX_GROUP_DEPTH` é 16 com raiz em profundidade 1; `MOVE` mede a subárvore inteira e árvore legada acima do limite continua legível e reparável para cima (Fase 5)
- mudança de pai é um único `UPDATE` condicional com CTE recursiva: ciclo, profundidade e `expectedParentId` são decididos na mesma instrução que escreve, nunca com `SELECT` seguido de `UPDATE` (Fase 5)
- `expectedParentId` é obrigatório sempre que `parentId` é enviado; renomear sem `parentId` continua last-write-wins (Fase 5)
- `DELETE /api/groups/:id` é um `DELETE` condicional atômico: só remove grupo sem subgrupos e sem nenhum link, desabilitado inclusive; sem cascade e sem reparent automático (Fase 5)
- não existe exclusão automática de grupos: mover ou excluir o último link deixa o grupo no banco (Fase 5)
- grafo de grupos corrompido por SQL externo falha fechado com `409`, sem árvore parcial e sem reparo automático (Fase 5)
- o redirect público nunca consulta `link_groups` nem adiciona `JOIN`, CTE ou `PRAGMA` ao hot path (Fase 5)
- `GET /api/export` é `format: "boltlink-portability"` / `schemaVersion: 1`, com identidade de formato independente da versão do produto; o artefato é configuração lógica e **não** substitui backup do D1 (Fase 5)
- o export nunca inclui `password_hash`, métricas, `has_qrcode`, `version` nem IDs internos do D1: grupos viajam com `ref` local e links se vinculam por `groupRef` (Fase 5)
- na 3.1.0, o export seleciona apenas ativos (`disabled_at IS NULL`); tombstones ficam fora dos limites e não são validados. Linha ativa persistida que o BoltLink não aceitaria hoje falha o export inteiro com `409` controlado (Smart Routing corrompido, destino de expiração sem expiração, URL inválida, slug reservado, nome de grupo em forma não canônica — espaços nas pontas, só espaços ou acima de 120 caracteres, nunca normalizado —, ciclo/pai órfão em grupos, A/B inválido, linha híbrida A/B + Smart), sem skip, reparo ou documento parcial (Fase 5)
- limites do formato são 50 grupos, 100 links e 256 KiB em bytes UTF-8, medidos após a serialização; acima deles a resposta é `413` explícito e o documento nunca é truncado (Fase 5)
- o export é somente leitura no **request inteiro** (zero escritas e zero DDL no D1, inclusive no middleware: usa a readiness de schema somente leitura, então não cria `boltlink_metric_fence`; as demais rotas `/api` mantêm o bootstrap), usa o boundary administrativo de `/api` e responde com `Content-Disposition` de nome constante e `Cache-Control: no-store` (Fase 5)
- o import consome exatamente o documento que o export gera: `POST /api/import/preview` é somente leitura no request inteiro (zero `INSERT`/`UPDATE`/`DELETE`/DDL, inclusive no middleware) e `POST /api/import/apply` grava o documento inteiro em um único `batch` do D1, ou seja, em uma transação: o resultado é tudo ou nada, nunca partial import (Fase 5)
- o import não cria migration, não altera schema e não faz DDL implícito: banco não preparado falha fechado com `503` nas duas rotas (Fase 5)
- `apply` revalida o documento, as capabilities do destino, as colisões de slug e as senhas do zero; o preview é uma descrição da intenção e o estado do browser nunca é autoridade (Fase 5)
- colisão com qualquer slug reservado no destino — link ativo, desabilitado ou tombstone — bloqueia o import inteiro com `409` e zero escritas; não existe overwrite e não há merge de grupo por nome (Fase 5)
- link com `passwordProtected: true` exige uma nova senha em `replacementPasswords` no próprio apply, hasheada pelo mecanismo atual; sem ela (ou com senha para link não protegido) nada é escrito (Fase 5)
- o mapeamento `ref` lógico → id local usa ids relativos calculados dentro da transação, com o pai sempre antes do filho: sem migration, sem tabela temporária, sem closure table e sem nome/path como chave (Fase 5)
- o piso da alocação de id de grupo é `max(MAX(id), sqlite_sequence.seq)`, lido dentro de cada `INSERT`: um id que a tabela `AUTOINCREMENT` já gastou nunca é reutilizado, então um `links.group_id` apontando para grupo inexistente não pode ser adotado por um grupo importado (Fase 5)
- destino com link apontando para grupo inexistente bloqueia o import inteiro com `409` (`TARGET_GROUP_REFERENCE_CORRUPT`) no preview e no apply, com zero escritas: sem reparo, sem reparent e sem zerar `group_id`, e sem que um grupo importado "cure" o órfão por colisão de id (Fase 5)
- o corpo do import é decodificado em UTF-8 estrito: byte inválido responde `400` `INVALID_BODY` nas duas rotas, nunca U+FFFD, e o documento não é reinterpretado a partir de texto reparado (Fase 5)
- a falha do batch é classificada pela assinatura do erro (`UNIQUE constraint failed: links.slug`), nunca pelo estado lido depois: qualquer outra falha responde `500` controlado mesmo que exista slug ocupado no destino, e a leitura pós-falha apenas nomeia os conflitos já provados pela assinatura (Fase 5)
- o Admin descarta as senhas digitadas em toda falha terminal de apply (rede incluída), no sucesso, no close, no novo arquivo e no reset, e o apply exige preview aprovado para a seleção atual (`importSelection`/`generation`): resposta atrasada de um arquivo substituído nunca descreve o que o apply enviaria (Fase 5)
- feature realmente usada pelo documento que o destino não suporta bloqueia com `409` (`TARGET_CAPABILITY_MISSING`), sem degradar e sem auto-migrar; A/B no estado default não conta como uso (Fase 5)
- documento mais profundo que `MAX_GROUP_DEPTH` bloqueia com `409` (`GROUP_DEPTH_EXCEEDED`), documentado como limite de portabilidade de legado, sem bypass do invariante (Fase 5)
- métricas não são inventadas nem restauradas: links importados nascem com os defaults atuais (`clicks_total = 0`, `metric_epoch`/`ab_generation` do destino) (Fase 5)
- o import é cold/admin path: não altera `GET /:slug`, o fluxo de senha, `PUBLIC_REDIRECT_SQL`, `recordClick`, bot detection, A/B, Smart Routing, lifecycle nem o redirect da raiz (Fase 5)
- redirects públicos usam `Referrer-Policy: strict-origin`
- admin, API, home, gate de senha e respostas não redirect usam `Referrer-Policy: no-referrer`

## Estrutura recomendada para mudanças

- UI: `public/admin.html`
- API ou auth: `src/index.ts`
- hierarquia de grupos: `src/group-hierarchy.ts` (helpers de grafo e os statements atômicos) e `public/group-hierarchy-ui.js` (helpers de apresentação da árvore)
- exportação portátil: `src/portability.ts` (formato, validação, refs, limites e serializer) e `public/portability-ui.js` (helpers de apresentação do download)
- importação portátil: `src/portability-import.ts` (validação do documento, plano, blockers e os statements do batch) e `public/portability-import-ui.js` (helpers de apresentação do drawer de importação)
- rate limiting: `src/rate-limit.ts`
- banco: `migrations/` (autoridade); `schema.sql` (baseline da `0000` para ferramentas manuais)
- operação: `docs/`
- regras para IA: este arquivo e `AI-START.md`

## Operação guiada por IA

- use `AI-START.md` como ponto de entrada
- use `docs/ai-accepted-requests.md` como contrato de entrada
- use `docs/ai-guided-operations.md` como runbook principal
- mapeie linguagem natural para uma intenção aceita antes de executar ações
- para atualizações, trate `https://github.com/vitorgfaustino/boltlink` como fonte oficial
- preserve `wrangler.local.jsonc`, `public/admin.html`, `public/logo.png` e `public/favicon.ico` em projetos derivados
- se o projeto usa GitHub auto-deploy ou o Deploy Button, não copie `TEAM_DOMAIN`, `POLICY_AUD`, `API_KEY` ou `PASSWORD_SESSION_SECRET` para o template público nem para instruções que sobrescrevam valores do dashboard
- nesses fluxos, `wrangler.local.jsonc` não deve ser tratado como fonte de verdade para essas variáveis operacionais
- em deploy local via Wrangler, `TEAM_DOMAIN` e `POLICY_AUD` podem existir em `wrangler.local.jsonc`, mas `API_KEY` e `PASSWORD_SESSION_SECRET` devem preferir `.dev.vars` ou Cloudflare secrets
- não automatize a criação final do Cloudflare Access

## Regras de documentação pública

- não use nomes de clientes, empresas ou domínios privados
- use placeholders como `links.example.com`
- em arquivos versionados de configuração, use placeholders em vez de IDs, hostnames e credenciais reais
- quando alterar comportamento do produto, atualize a documentação correspondente

## Regra para mudanças de versão

Ao preparar uma nova versão do produto, a IA deve revisar e sincronizar pelo menos:

- `package.json`
- `README.md`
- `AI-START.md`
- `AGENTS.md`
- `CHANGELOG.md`
- `RELEASE_NOTES.md`
- `docs/`
- `public/` quando houver texto visível de versão, política pública ou comportamento alterado
- `migrations/` quando houver mudança de banco; não adicione colunas a `schema.sql`
- `wrangler.jsonc` e exemplos de ambiente quando houver mudança operacional
- `test/` (Especialmente `test/index.spec.ts`, onde strings de versão podem estar hardcoded nas asserções de testes da API)

Antes de concluir uma mudança de versão, a IA deve procurar referências antigas da versão anterior, recursos removidos e fluxos documentais desatualizados para não deixar material legal, operacional ou técnico para trás. Sempre rode `npm test` após um bump de versão para garantir que nenhum teste quebrou por esperar a versão antiga.

## Validação mínima

Para mudanças de código:

```bash
npm test
```

Para mudanças de bindings:

```bash
npm run cf-typegen
```

Para mudanças de banco:

- validar migrations localmente com Wrangler

## Segurança operacional

- não commitar `.dev.vars`, `.env` ou segredos
- não expor valores reais de `API_KEY`, `PASSWORD_SESSION_SECRET`, `TEAM_DOMAIN` ou `POLICY_AUD`
- não assumir que a proteção do Access fora do Worker elimina a validação do token dentro do Worker

## Prioridades ao implementar

1. preservar segurança e comportamento do redirect
2. manter o admin simples
3. preferir mudanças pequenas, testáveis e documentadas
4. evitar qualquer coleta ou persistência que aumente desnecessariamente a superfície LGPD

---

Release atual publicada: 3.1.1 · Tag: v3.1.1 · Release anterior: 3.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
