# Upgrading

## Candidata em desenvolvimento — 3.2.0

Este checkout contém a **3.2.0 candidata local**, ainda não publicada. A release oficial continua **3.1.1**, tag **v3.1.1**, congelada e reconciliada. A candidata reúne filtro recursivo de grupos, caminho hierárquico completo nos badges, edição bidirecional de UTMs e `ROOT_REDIRECT_URL` como Text opcional no setup. O Admin traz Dark Mode refinado, cards compactos e badges semânticas; o README apresenta o produto com screenshots atualizadas em Light, Dark e mobile e uma demonstração animada com dados fictícios. Sem migration nova: **MIGRATION_0007 = NOT REQUIRED**. Veja [Admin UX](admin-ux.md).

## Release publicada — 3.1.1

A **3.1.1 está publicada**, identificada pela tag **v3.1.1**; é a release atual e latest do repositório. A release anterior **v3.1.0** permanece congelada. Este patch operacional aplica migrations D1 pendentes antes do Worker no fluxo padrão de deploy e amplia o guia Cloudflare Access. **MIGRATION_0007 = NOT REQUIRED**; migrations `0000`–`0006`, sem mudança funcional no produto.

Publicar tag/release é **source distribution** e não opera Cloudflare de clientes. Cada instalação executa o próprio `npm run deploy`, que aplica apenas migrations pendentes antes do Worker, e configura seu próprio Access. O guia completo está em [Cloudflare Access](admin-auth.md).

A correção de compatibilidade da mesma 3.1.1 substitui apenas pontos e vírgulas em comentários das migrations históricas para o parser remoto D1/Wrangler. O SQL executável, o schema e os nomes `0000`–`0006` permanecem inalterados. Instalações novas usam os arquivos corrigidos; bancos que já registraram a cadeia não reaplicam essas migrations. A correção integra a v3.1.1 republicada e congelada. O fresh install D1 remoto foi validado pelo usuário, e o CI da main e da tag passou. Um segundo deploy não é requisito da release source distribution.

## Recursos preservados desde a 3.1.0

A **3.1.0**, agora release anterior congelada na tag **v3.1.0**, introduziu os recursos abaixo. A tag histórica **v3.0.0** também permanece congelada. A 3.1.0 adiciona Lixeira, restauração validada, exclusão definitiva com reutilização de slug e limpeza administrativa explícita com preview e retenção de 90 dias. Não há Cron automático. O export passa a conter somente links ativos; tombstones ficam fora do documento e dos limites de links, enquanto ativos inválidos continuam fail-closed. Import v1 legado com `disabled: true` continua aceito. **MIGRATION_0007 = NOT REQUIRED**; migrations permanecem `0000`–`0006`.

Contrato completo e operação no Admin: [Lixeira e recuperação](trash-recovery.md). Os procedimentos correntes abaixo seguem a release `3.1.1`; a tag `v3.1.0` conserva o procedimento histórico sem migrations automáticas. Publicar código no Git/GitHub não atualiza instalações: deploy, D1 remoto e Access exigem autorização própria por instalação.


## Escopo das bases de código (release 3.1.1)

Os documentos abaixo descrevem estados de código diferentes. Confirme em qual você está antes de seguir um procedimento:

| Base | Como identificar | Migrations | Recursos de produto |
| --- | --- | --- | --- |
| Release atual | tag `v3.1.1` (este repositório) | `0000` a `0006` | links, grupos, tags, QR code, senha, agenda/expiração, Split Test A/B, Smart Routing, destino de expiração, `ROOT_REDIRECT_URL`, hierarquia de grupos, portabilidade (exportação e importação) e QR Code com preview e downloads no painel |
| Release anterior congelada | tag `v3.1.0` | `0000` a `0006` | mesmos recursos de produto; deploy sem migrations automáticas |
| Baseline histórico do upgrade | tag `v2.2.1` (`git rev-parse v2.2.1` → `8b3895e`) | `0000` a `0003` | links, grupos, tags, QR code, senha, agenda/expiração |
| Checkpoint histórico da Fase 2 | baseline local `23353a1` | `0000` a `0004` | baseline v2.2.1 + Split Test A/B |
| Checkpoint histórico da Fase 3 | HEAD `548f179` | `0000` a `0005` | Fase 2 + Smart Routing |
| Checkpoint histórico da Fase 4 | HEAD `cdb9f83` | `0000` a `0006` | Fase 3 + destino de expiração + `ROOT_REDIRECT_URL` |

A release `3.1.1` é a última versão publicada deste repositório (tag `v3.1.1`); a release anterior é `v3.1.0`, congelada. `v2.2.1` permanece baseline histórico das migrations `0004`–`0006`. O upgrade é executado **por cada instalação**: publicar a release no repositório não aplica migrations nem faz deploy em nenhuma instalação.

## Upgrade histórico 3.0.0 → 3.1.0

Com a cadeia `0000`–`0006` já aplicada, atualize apenas o código para a tag `v3.1.0`, preservando configuração privada, overlays, bindings e secrets existentes. Faça backup integral do D1, instale as dependências, execute os testes, publique pelo processo normal da instalação e valide links ativos, Lixeira, restauração e portabilidade. Preserve `PASSWORD_SESSION_SECRET`; não o regenere apenas pelo upgrade. **MIGRATION_0007 = NOT REQUIRED**: nenhuma migration, binding ou variável nova para esta atualização. Não há Cron automático.

Instalações anteriores à 3.0.0 seguem o fluxo de migrations abaixo antes de executar código que depende delas. Os recursos e mudanças de secrets introduzidos na 3.0.0 continuam necessários na 3.1.0.

## Upgrade para a release 3.1.1

A 3.1.1 corrige somente o processo de deploy. Faça backup integral do D1 antes de executar o script, preserve overlays/configuração privada/bindings/secrets, atualize o código para a tag `v3.1.1` e rode `npm install` e `npm test`. Não regenere secrets apenas por esse patch.

Com autorização da instalação, execute `npm run deploy`: `npm run db:migrations:apply` aplica as pendentes pelo binding `db_boltlink` e, somente se tiver sucesso, o wrapper publica o Worker. Em Workers Builds, configure **Settings > Build > Deploy command** como `npm run deploy`; no Deploy Button, aceite o script detectado. Configurações existentes com `npx wrangler deploy` precisam desse ajuste para usar o novo fluxo.

| Estado do D1 | Resultado antes de publicar o Worker |
| --- | --- |
| Nova instalação, D1 provisionado vazio | aplica `0000`–`0006` e deixa o banco preparado |
| Instalação 3.1.0 com a cadeia aplicada | informa ausência de pendências; nenhuma migration é reaplicada |
| Instalação antiga | aplica somente as pendentes; da `v2.2.1`, são `0004`–`0006` |

O Wrangler registra migrations aplicadas em `d1_migrations`. Rodar o comando novamente consulta esse histórico e não reaplica as concluídas. Se uma migration falhar, ela é revertida e as anteriores bem-sucedidas permanecem aplicadas; o `&&` impede o deploy do Worker. Corrija a causa e use o histórico do D1 antes de retomar. Nenhuma migration nova: **MIGRATION_0007 = NOT REQUIRED**, cadeia `0000`–`0006`.

A operação manual `npm run wrangler -- d1 migrations apply db_boltlink --remote` continua disponível para manutenção no alvo autorizado; não é etapa adicional obrigatória do Deploy Button padrão da 3.1.1. O desenvolvimento local continua usando `npm run dev-prepare`.

A tag histórica **v3.1.0** não executava migrations automaticamente. Publicar uma release no GitHub continua sendo **source distribution**: nenhuma tag/release aplica migrations em clientes. Cada instalação executa seu próprio fluxo e valida o próprio Worker/D1.

Referências oficiais: [Deploy Button e migrations por binding](https://developers.cloudflare.com/workers/platform/deploy-buttons/#best-practices), [Workers Builds / Deploy command](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#deploy-command), [Wrangler D1 migrations apply](https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations-apply).

## Upgrade para a versão 3.0.0

> Escopo: procedimento histórico da release `3.0.0` (deploy sem migrations automáticas, também na tag `v3.1.0`); para a release `3.1.1`, use o fluxo acima. Fluxo operacional consolidado da release `3.0.0`, partindo da release histórica `v2.2.1` (commit `8b3895e`, migrations `0000` a `0003`). Este repositório é a base do produto e sua release é distribuição de código: não existe instalação canônica em Cloudflare, e o upgrade abaixo é executado **por cada instalação**, no próprio Worker e D1. As seções por migration abaixo permanecem como referência; este é o fluxo único.

1. **Backup do D1 antes das migrations.** Faça backup do estado do banco conforme o procedimento da instância, antes de aplicar qualquer migration. O **Portability Export não é backup**: o documento `boltlink-portability` carrega apenas configuração lógica, sem métricas, sem hashes e sem IDs internos — a recuperação integral do estado operacional continua sendo backup do D1.
2. **Atualize o código:**

   ```bash
   git pull --ff-only
   npm install
   npm run wrangler:init
   ```

3. **Aplique as migrations pendentes `0004` a `0006` antes de publicar o novo Worker.** As três são additive (colunas novas adicionadas pelas migrations, sem rewrite nem rebuild de tabela; a `0004` adiciona também colunas `NOT NULL DEFAULT`, preenchidas pelo valor default nas linhas existentes) e o deploy não as aplica — a aplicação é etapa operacional explícita:

   ```bash
   npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
   npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
   ```

   Migrations antes do Worker minimiza a janela de código novo sobre schema antigo: sem as colunas, as features novas falham fechado (`400`/`503` conforme o recurso), enquanto colunas novas sob código antigo são simplesmente ignoradas. Reaplicar é seguro (`No migrations to apply!`).
4. **Confirme bindings e secrets.** Não há bindings novos desde a `v2.2.1` — e nenhuma variável ou secret novo é obrigatório para todas as instalações nesta atualização: o obrigatório do upgrade é backup do D1 + migrations pendentes `0004`–`0006` + deploy/validação. Para links protegidos por senha existe um requisito **condicional**: confirme `PASSWORD_SESSION_SECRET` antes do deploy (casos A/B/C abaixo da tabela).

   | Name | Type | Required? | When | Changed in 3.0.0? |
   | --- | --- | --- | --- | --- |
   | `TEAM_DOMAIN` | Text | quando o Cloudflare Access está configurado | proteção de `/admin` e `/api` | existente, sem mudança |
   | `POLICY_AUD` | Text | quando o Cloudflare Access está configurado | proteção de `/admin` e `/api` | existente, sem mudança |
   | `APP_TIMEZONE` | Text | opcional | timezone dos campos de agenda; fallback/default `America/Sao_Paulo` | existente, sem mudança |
   | `PASSWORD_SESSION_SECRET` | Secret | apenas quando a instalação usa/cria/serve links protegidos por senha | assinar sessões do gate de senha; sem ele o gate falha `503`; a variável já existia na `v2.2.1`, mas lá o `API_KEY` servia de fallback — a `3.0.0` removeu esse fallback e passou a exigir o secret dedicado; se já configurado, preserve o valor existente e **não** gere um novo | **sim** — o fallback de `API_KEY` foi removido (a variável em si já existia) |
   | `API_KEY` | Secret | opcional | apenas automação administrativa; na `3.0.0` não assina mais sessão do gate de senha | existente — perdeu o papel de fallback de sessão |
   | `ROOT_REDIRECT_URL` | Text | opcional | apenas para quem quer redirect de `GET /` (`302` + `no-store`, sem D1); ausente/inválida serve a landing | **NEW / OPTIONAL** |

   O caso de senha em detalhe (vale para o fluxo inteiro do upgrade):

   - **A. instalação com links protegidos que já tem `PASSWORD_SESSION_SECRET`**: preserve o valor existente. Não rotacione, não regenere e não substitua o secret apenas por causa do upgrade.
   - **B. instalação com links protegidos que dependia apenas do `API_KEY`**: na `v2.2.1` o `API_KEY` podia assinar as sessões do gate de senha; na `3.0.0` não pode mais. Crie o `PASSWORD_SESSION_SECRET` **antes** de publicar o Worker da `3.0.0` — sem ele, criar link com senha responde `400` e o gate de senha responde `503`. Gere um valor aleatório novo e dedicado (por exemplo `openssl rand -hex 32`); não copie o valor do `API_KEY`.
   - **C. instalação sem links protegidos por senha**: não precisa criar esse secret apenas pelo upgrade; o requisito só passa a valer se o recurso for usado.

   Em resumo: `ROOT_REDIRECT_URL` é a única variável nova — opcional. `PASSWORD_SESSION_SECRET` não é novo, mas **mudou na `3.0.0`**: existia na `v2.2.1` (onde o `API_KEY` podia servir de fallback) e agora é exigido para links protegidos, sem fallback. `TEAM_DOMAIN`/`POLICY_AUD` seguem variáveis existentes condicionais ao Access, `APP_TIMEZONE` é existente/opcional com default e `API_KEY` é existente/opcional para automação.
5. **Publique o Worker e os Assets** (`npm run deploy` ou o fluxo que a instância já usa).
6. **Valide o Admin**: login via Cloudflare Access, painel abre e `GET /api/capabilities` reporta `abTesting`, `smartRouting` e `expiredRedirect` como `true`.
7. **Smoke de redirects**: um link normal responde com o redirect configurado; unknown slug continua `404`; se configurado, valide senha, A/B, Smart Routing, expiração (`410` ou destino `302`) e o redirect da raiz.
8. **Valide as superfícies administrativas novas**: árvore de grupos (criar/mover/excluir), `Exportar configuração`, `Importar configuração` (preview antes do apply) e o diálogo de QR Code (preview, PNG, SVG).

### Impacto em clientes da API administrativa (Groups)

Se você usa diretamente a API administrativa de grupos:

- revise o `PATCH /api/groups/:id`: `expectedParentId` é obrigatório sempre que `parentId` é enviado (`400` sem a precondição; `409` quando o pai observado mudou);
- revise o `DELETE /api/groups/:id`: grupo com subgrupos ou com qualquer link, desabilitado incluído, responde `409` — não há mais remoção de grupo ocupado nem promoção de filhos a raiz;
- trate os novos `400`/`409` conforme o contrato acima.

Se você usa apenas o Admin UI: o painel já envia o contrato atual (inclusive `expectedParentId`), comprovado por código e testes — nenhuma ação além do upgrade normal.

### Rollback e downgrade

- Voltar o código sem mexer no banco é benigno nos casos documentados: banco em `0006` sob código anterior (sem o destino de expiração) ignora a coluna extra; groups, portabilidade e QR não alteram schema (detalhes nas seções por feature abaixo).
- **Downgrade geral não é garantido**: não existe procedimento testado de reversão das migrations `0004` a `0006`; restaurar o backup do D1 do passo 1 é o caminho documentado.

## Procedimento histórico: upgrade para a v2.2.1

Procedimento da release histórica `v2.2.1`, mantido como referência para quem opera um checkout dessa tag. Para atualizar da `v2.2.1` até a release atual, use o fluxo consolidado acima.

Não há bindings novos. A `v2.2.1` termina na migration `0003_lgpd_minimization.sql`; um checkout da tag `v2.2.1` não possui os recursos das bases locais. Instalações alinhadas com a `0003` não precisam de migration nova. Aplique as migrations pendentes antes de publicar o Worker.

Os recursos descritos nas seções seguintes pertencem à release `3.0.0`; nenhum deles faz parte da `v2.2.1`.

## Split Test A/B e migration 0004 (release 3.0.0)

> Escopo: release `3.0.0` (migration `0004`). A release histórica `v2.2.1` não contém esta migration nem o Split Test A/B; o recurso foi introduzido no checkpoint de desenvolvimento da Fase 2 (`23353a1`).

O Split Test A/B adiciona a migration `0004_ab_testing.sql`. Ela é a fonte autoritativa das colunas A/B.

- O runtime não executa `schema.sql`, não cria/altera colunas, não aplica migrations implicitamente e não reconstrói tabelas; banco não preparado falha fechado com `503 Database schema is not initialized`.
- Em banco pré-0004, links normais continuam com redirect, lifecycle, senha e `clicks_total`; configurar A/B pela API retorna `400` pedindo a migration.
- Aplique a `0004` pelo fluxo normal de migrations antes de usar A/B em produção.
- Ordem recomendada: aplicar migrations → publicar/reiniciar o Worker → validar. Um isolate iniciado antes da migration revalida o schema e passa a usar fencing no request seguinte; o restart não é obrigatório para correção.
- Reaplicar migrations é seguro: o Wrangler responde `No migrations to apply!` quando já estão aplicadas.
- Instalações limpas na release `3.0.0` aplicam a cadeia completa (`0000` a `0006`); `schema.sql` é apenas o baseline da `0000` para ferramentas manuais.
- Colunas legadas extras (`last_clicked_at`, `notes`, `stats`) podem permanecer após o upgrade; o runtime as ignora.

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

## Smart Routing e migration 0005 (release 3.0.0)

> Escopo: release `3.0.0` (migration `0005`). A `0005` faz parte do caminho de upgrade `v2.2.1` → `3.0.0` e é aplicada quando ainda estiver pendente naquela instalação. Um checkout da tag `v2.2.1` não contém a migration `0005`.

O Smart Routing adiciona a migration `0005_smart_routing.sql`, fonte autoritativa da coluna `links.smart_routing_rules` (JSON em linha). Instalações limpas na release `3.0.0` aplicam a cadeia completa (`0000` a `0006`).

- Em banco pré-0005, links normais continuam funcionando e a API retorna `400` explicando a migration ao tentar configurar Smart Routing; `GET /api/capabilities` reporta `smartRouting: false`.
- Aplique a `0005` pelo fluxo normal antes de configurar Smart Routing em produção.
- Ordem recomendada: backup → aplicar migrations (`0004` e `0005` quando aplicável) → publicar/atualizar o Worker → validar `GET /api/capabilities` → validar um redirect normal → configurar Smart Routing no Admin.
- Nas tags históricas v3.0.0/v3.1.0, o deploy não aplicava migrations automaticamente; na release 3.1.1, `npm run deploy` aplica as pendentes antes do Worker.
- Um isolate iniciado antes da migration revalida a capability no request seguinte; o restart não é obrigatório.
- Smart Routing e Split Test A/B são mutuamente exclusivos e links com Smart Routing usam sempre `302` com `Cache-Control: no-store`.
- Links configurados antes do upgrade permanecem com `smart_routing_rules = NULL` (desativado) até serem configurados no Admin.

## Destino de expiração e migration 0006 (release 3.0.0)

> Escopo: release `3.0.0` (migration `0006`). A release histórica `v2.2.1` não contém esta migration nem o destino de expiração.

O destino de expiração adiciona a migration `0006_expired_redirect.sql`, fonte autoritativa da coluna `links.expired_redirect_url` (TEXT, nullable). A mudança é additive: sem default, sem reescrita de dados e sem rebuild de tabela; linhas existentes permanecem `NULL`, o que preserva o comportamento anterior (link expirado responde `410`). Instalações limpas na release `3.0.0` aplicam a cadeia `0000` a `0006`.

- Em banco pré-0006, links normais continuam funcionando integralmente; tentar configurar `expiredRedirectUrl` retorna `400` pedindo a migration, `GET /api/capabilities` reporta `expiredRedirect: false` e o Admin oculta a seção "Após expirar".
- Aplique a `0006` pelo fluxo normal **antes** de tentar configurar destino de expiração em produção.
- Ordem recomendada: backup → aplicar migrations pendentes (`0006`) → publicar/atualizar o Worker → validar `GET /api/capabilities` (`expiredRedirect: true`) → validar um redirect normal → configurar destinos no Admin quando desejado.
- Não há downtime obrigatório: a coluna é nullable e additive.
- Rollback benigno: banco em `0006` com código anterior (sem o destino de expiração) ignora a coluna extra; nenhum dado é perdido e nenhum comportamento muda.
- Nas tags históricas v3.0.0/v3.1.0, o deploy não aplicava migrations automaticamente; na release 3.1.1, `npm run deploy` aplica as pendentes antes do Worker. O runtime nunca cria a coluna durante requests.

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

A release `3.0.0` também introduz a variável opcional `ROOT_REDIRECT_URL` (redirect da raiz), que não depende de migration nem de bindings novos: veja `README.md` e `docs/cloudflare-setup.md`.

## Hierarquia de grupos (release 3.0.0)

> Escopo: release `3.0.0`, sem migration nova. A release histórica `v2.2.1` **contém** a tabela `link_groups` com `parent_id` (migration `0002`), mas não contém nada desta seção.

- **Não há migration**: a release `3.0.0` usa `link_groups.parent_id`, com a FK auto-referente e o índice `idx_link_groups_parent_id` que já existem desde a `0002`. Nada para aplicar, nenhum binding novo e nenhuma coluna nova. Uma instalação em `0006` já tem o schema necessário.
- **O que muda no upgrade é comportamento, não schema.** Se a instalação já convivia com `link_groups.parent_id` gravado à mão, aplique as mudanças e valide: ciclos existentes passam a falhar fechado (veja abaixo).
- **Falha fechado em grafo corrompido**: um ciclo gravado por SQL externo (ou `parent_id` apontando para grupo ausente) faz `GET /api/groups` responder `409` e o Admin mostrar o erro, sem árvore parcial e sem reparo automático. Antes de confiar no painel, verifique a árvore:

```sql
-- Ciclos: um grupo que alcança a si mesmo subindo a cadeia de parent_id.
SELECT id, name, parent_id FROM link_groups;
```

  Repare o ciclo com um `UPDATE` administrativo explícito (o runtime nunca corrige a árvore sozinho) e recarregue o painel.
- **Árvore legada acima de 16 níveis continua legível** e pode ser reparada movendo subárvores para cima; uma operação que mantém ou aumenta a violação responde `409`.
- **Mudança de contrato em `PATCH /api/groups/:id`**: sempre que `parentId` for enviado, `expectedParentId` passa a ser obrigatório (o pai que o cliente observou; `null` para raiz). Um cliente que hoje manda apenas `parentId` recebe `400`; um move com pai desatualizado recebe `409`. Renomear sem `parentId` continua last-write-wins.
- **Mudança de contrato em `DELETE /api/groups/:id`**: só remove grupo sem subgrupos e sem nenhum link, links desabilitados incluídos. Antes, um grupo com links desabilitados ou com subgrupos podia ser removido e os filhos eram promovidos a raiz pela FK `ON DELETE SET NULL`.
- **Exclusão automática removida**: o runtime não apaga mais um grupo quando o último link ativo sai dele. Grupos que antes "sumiam" sozinhos passam a permanecer e devem ser removidos explicitamente quando não forem mais usados.
- **Rollback**: voltar o código para a `v2.2.1` não exige nenhuma ação de banco — a release `3.0.0` não altera schema nem dados para a hierarquia de grupos. O comportamento antigo volta junto com o código (inclusive a exclusão automática).

### Portabilidade de configuração: exportação e importação (release 3.0.0)

> Escopo: release `3.0.0`, sem migration nova. A release histórica `v2.2.1` não possui `GET /api/export`, nem as rotas de importação, nem os botões `Exportar configuração` e `Importar configuração`.

- **Não há migration**: o export lê as colunas que já existem. Nenhum binding novo, nenhuma capability nova e nada para aplicar; uma instalação em `0006` (ou até em `0004`/`0005`) exporta com as capacidades que o banco já tem.
- **Aditivo do ponto de vista do upgrade**: as superfícies novas da release `3.0.0` são administrativas, e apenas três são rotas novas — `GET /api/export`, `POST /api/import/preview` e `POST /api/import/apply` — acompanhadas das ações `Exportar configuração` e `Importar configuração` no Admin e do diálogo de QR Code. O QR usa os endpoints `GET/POST /api/links/:slug/qrcode` e a hierarquia de grupos usa `GET/POST /api/groups`, `PATCH /api/groups/:id` e `DELETE /api/groups/:id`, todos já existentes na base publicada: a release `3.0.0` muda o contrato e a UI dessas rotas, não cria rotas novas. Nenhuma dessas superfícies é pública — todas ficam atrás do boundary administrativo de `/api` — e o redirect público `GET /:slug`, o CRUD e o lifecycle não ganham API nova por causa de grupos, portabilidade ou QR.
- **Sem impacto nos dados**: o endpoint é somente leitura — não atualiza `version`, timestamps, `has_qrcode`, contadores ou epochs, e não cria tabela de auditoria.
- **Falha fechado pode bloquear o export**: uma linha que o BoltLink não aceitaria hoje (Smart Routing corrompido, destino de expiração sem expiração, ciclo ou pai órfão em grupos, híbrido A/B + Smart Routing) faz o export inteiro responder `409` até ser corrigida. Nada é reparado automaticamente e o banco não é modificado. O limite do formato é 50 grupos, 100 links e 256 KiB.
- **Importação portátil (Gate 5.3)**: o Admin ganha a ação `Importar configuração`, em drawer próprio, que envia o documento para `POST /api/import/preview` (somente leitura, com resumo, colisões, bloqueios e senhas necessárias) e, após revisão, para `POST /api/import/apply`. Não há upload para serviço externo, não há dry-run gravando nada e não há remapeamento manual de IDs: o vínculo `ref` → id local é resolvido dentro da transação.
- **Import é tudo ou nada**: o apply grava grupos e links em um único `batch` do D1, então uma falha deixa o banco exatamente como estava. Colisão de slug bloqueia o import inteiro com `409` (sem overwrite e sem partial import), e o mesmo vale para feature usada que a instalação ainda não suporta, árvore acima de 16 níveis e grafo de grupos corrompido.
- **Import exige nova senha**: `passwordProtected: true` não carrega hash nem senha, então o apply pede uma senha nova por link protegido; sem ela nada é escrito e a senha antiga da origem não funciona. A senha viaja no corpo da requisição (nunca em log, URL, resposta ou storage do browser).
- **Import pode ser bloqueado por dados da própria instalação**: se o destino tiver algum link apontando para um grupo que não existe (um `group_id` deixado para trás por exclusão externa), as duas rotas respondem `409` (`TARGET_GROUP_REFERENCE_CORRUPT`) sem escrever nada. Nada é reparado automaticamente e nenhum grupo importado ocupa o id vago — corrija os links órfãos e repita. Ids de grupo importados nunca reutilizam um id que a sequência `AUTOINCREMENT` do destino já gastou.
- **Import não cria nem altera schema**: as duas rotas usam a readiness de schema somente leitura e respondem `503` num banco não preparado — nenhuma migration é aplicada implicitamente e nenhuma coluna é criada. O bloqueio de capability é por migration, não pela versão do formato do documento: um documento que usa A/B exige a `0004` ou posterior, um que usa Smart Routing exige a `0005` ou posterior e um que usa destino de expiração exige a `0006` ou posterior — A/B no estado default não conta como uso e, num documento que combina recursos, vale a migration mais alta exigida pelos recursos presentes. Na prática: uma base em `0004` aceita A/B mas recusa com `409` Smart Routing e destino de expiração; uma base em `0005` aceita A/B e Smart Routing mas recusa com `409` o destino de expiração; uma base em `0006` aceita os três. Atualizar as migrations é o caminho.
- **Rollback**: remover o código da release `3.0.0` não exige nenhuma ação de banco. As rotas e os botões deixam de existir; o export não gravou nada e o import, quando usado, gravou apenas links e grupos como qualquer criação pelo painel.

### QR Code no painel (release 3.0.0)

> Escopo: release `3.0.0`, sem migration nova. Os endpoints `GET/POST /api/links/:slug/qrcode` e a coluna `has_qrcode` existem desde a base publicada (`0001`); o que a release `3.0.0` acrescenta é o diálogo de preview e os downloads no painel. É evolução de funcionalidade e de UI — **não é migration de banco**: nada para aplicar, nenhum binding novo, nenhuma capability nova.

- **O que muda no upgrade é o painel**: a ação `QR Code` abre um diálogo com preview e três ações — copiar o short link, baixar **PNG** (rasterizado no navegador a partir do SVG, em 512×512) e baixar **SVG** (byte a byte o corpo que o Worker devolveu).
- **O QR codifica apenas a short URL pública**: quem escaneia entra no redirect normal, com senha, A/B, Smart Routing e lifecycle decididos pelo runtime; nenhum destino, segredo ou configuração do link vai para o código.
- **Preview e copiar link não escrevem nada.** `has_qrcode` continua sendo a memória operacional de que um QR foi obtido: só é escrita pelo `POST` que acompanha um download (PNG ou SVG), e o painel só anuncia "QR Ativo" quando a API confirma a escrita.
- **Nenhuma imagem é persistida**: o QR é derivável da short URL a qualquer momento, e a geração não conta clique. Depois de um import de configuração, o QR de cada link importado pode ser gerado de novo normalmente.
- **Rollback**: voltar o código para a `v2.2.1` não exige ação de banco; o diálogo deixa de existir e a ação `QR Code` anterior volta com o código.

## PASSWORD_SESSION_SECRET e links protegidos por senha

Esta versão exige `PASSWORD_SESSION_SECRET` para todo o recurso de links protegidos por senha. A variável **já existia na `v2.2.1`**, mas lá o gate aceitava `PASSWORD_SESSION_SECRET || API_KEY`: o `API_KEY` podia assinar as sessões do gate de senha como fallback. Na `3.0.0` esse fallback foi removido — o secret dedicado é a única fonte, e a mudança é de obrigatoriedade, não de variável nova.

- **A. instalação com links protegidos que já tem `PASSWORD_SESSION_SECRET`**: preserve o valor existente. Não rotacione, não regenere e não substitua o secret apenas por causa do upgrade — a troca de valor invalida as sessões de senha já emitidas.
- **B. instalação com links protegidos que dependia apenas do `API_KEY`** (funcionava na `v2.2.1` por causa do fallback): crie o `PASSWORD_SESSION_SECRET` como secret do Worker **antes** do upgrade/deploy desta versão, com um valor aleatório novo e dedicado (por exemplo `openssl rand -hex 32`); não copie o valor do `API_KEY`.
- **C. instalações sem links protegidos por senha**: nenhuma ação necessária; o secret só passa a ser exigido se o recurso for usado.
- `API_KEY` não é mais utilizado para assinar sessões de links protegidos por senha; segue opcional para automação administrativa.
- Links protegidos legados sem `PASSWORD_SESSION_SECRET` falham fechados com HTTP 503, tanto no `GET` quanto no `POST`, sem redirect e sem cookie de sessão.
- HTTP 503 significa configuração pendente no servidor; não é senha incorreta nem link inexistente.
- Não existe fallback inseguro: sem o secret, o recurso fica indisponível em vez de degradar.

Fluxo normal:

1. Atualize o codigo:

```bash
git pull --ff-only
npm install
npm run wrangler:init
npm test
```

## Upgrade legado para v2.0.0

Esta versão é breaking change de produto e schema.

Ela remove:

- `stats`
- `IP_HASH_SECRET`
- `last_clicked_at`
- `notes`
- endpoint `/api/links/:slug/stats`
- endpoint `/api/maintenance/purge-stats`

## Passo a passo

1. Atualize o código:

```bash
git pull --ff-only
npm install
```

2. Recrie ou sincronize o config local:

```bash
npm run wrangler:init
```

3. Aplique migrations localmente:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

4. Se o deploy for manual e já houver ambiente remoto:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

5. Valide:

```bash
npm test
```

## GitHub auto-deploy e one-click

Se você atualiza pelo GitHub ou pelo botão:

- o runtime não executa reconciliação de schema: colunas legadas extras são ignoradas, mas continuam no banco até uma migration explícita
- a migration continua sendo o caminho suportado

## Impacto funcional

- a contagem continua existindo em `clicks_total`
- o referrer público passa a ser apenas `strict-origin`
- métricas detalhadas deixam de existir por padrão

---

Release atual publicada: 3.1.1 · Tag: v3.1.1 · Release anterior: 3.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
