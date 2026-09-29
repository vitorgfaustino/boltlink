# Upgrading

## Escopo das três bases e das Fases 4 e 5 (Unreleased)

Os documentos abaixo descrevem cinco estados de código diferentes. Confirme em qual você está antes de seguir um procedimento:

| Base | Como identificar | Migrations | Recursos de produto |
| --- | --- | --- | --- |
| Publicada | tag `v2.2.1` (`git rev-parse v2.2.1` → `8b3895e`) | `0000` a `0003` | links, grupos, tags, QR code, senha, agenda/expiração |
| Fase 2 local | baseline local `23353a1`, não publicado | `0000` a `0004` | base publicada + Split Test A/B |
| Fase 3 congelada | HEAD `548f179`, Unreleased | `0000` a `0005` | Fase 2 + Smart Routing |
| Fase 4 congelada | HEAD `cdb9f83`, Unreleased | `0000` a `0006` | Fase 3 + destino de expiração + `ROOT_REDIRECT_URL` |
| Fase 5 (working tree) | working tree atual sobre `cdb9f83`, Unreleased | `0000` a `0006` (sem migration nova) | Fase 4 + hierarquia de grupos + exportação portátil + importação portátil + QR Code com preview e download PNG/SVG no painel |

Nenhum bump de versão acompanha estas correções: a tag publicada continua sendo `v2.2.1` e termina na `0003`.

## Upgrade para a versão publicada (v2.2.1)

Não há bindings novos. A release publicada termina na migration `0003_lgpd_minimization.sql`; um checkout da tag `v2.2.1` não possui os recursos das bases locais. Instalações alinhadas com a `0003` não precisam de migration nova. Aplique as migrations pendentes antes de publicar o Worker.

Os recursos do baseline local da Fase 2 e do estado Unreleased / Fase 3 estão descritos em seções próprias abaixo; nenhum dos dois faz parte da release publicada.

## Split Test A/B e migration 0004 (Phase 2 local, não publicado)

> Escopo: **baseline local da Fase 2** (`0004`). A tag publicada `v2.2.1` não contém esta migration nem o Split Test A/B.

O Split Test A/B adiciona a migration `0004_ab_testing.sql`. Ela é a fonte autoritativa das colunas A/B.

- O runtime não executa `schema.sql`, não cria/altera colunas, não aplica migrations implicitamente e não reconstrói tabelas; banco não preparado falha fechado com `503 Database schema is not initialized`.
- Em banco pré-0004, links normais continuam com redirect, lifecycle, senha e `clicks_total`; configurar A/B pela API retorna `400` pedindo a migration.
- Aplique a `0004` pelo fluxo normal de migrations antes de usar A/B em produção.
- Ordem recomendada: aplicar migrations → publicar/reiniciar o Worker → validar. Um isolate iniciado antes da migration revalida o schema e passa a usar fencing no request seguinte; o restart não é obrigatório para correção.
- Reaplicar migrations é seguro: o Wrangler responde `No migrations to apply!` quando já estão aplicadas.
- Instalações limpas do baseline local da Fase 2 aplicam a cadeia de migrations (`0000` a `0004`); `schema.sql` é apenas o baseline da `0000` para ferramentas manuais.
- Colunas legadas extras (`last_clicked_at`, `notes`, `stats`) podem permanecer após o upgrade; o runtime as ignora.

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

## Smart Routing e migration 0005 (Unreleased / Fase 3)

> Escopo: release publicada/baseline = **v2.2.1**. O procedimento abaixo está preparado para a **próxima release (Unreleased / Fase 3)**. Um checkout da tag `v2.2.1` não contém a migration `0005`.

O Smart Routing adiciona a migration `0005_smart_routing.sql`, fonte autoritativa da coluna `links.smart_routing_rules` (JSON em linha). Instalações limpas nesta branch de desenvolvimento aplicam a cadeia `0000` a `0005`.

- Em banco pré-0005, links normais continuam funcionando e a API retorna `400` explicando a migration ao tentar configurar Smart Routing; `GET /api/capabilities` reporta `smartRouting: false`.
- Aplique a `0005` pelo fluxo normal antes de configurar Smart Routing em produção.
- Ordem recomendada: backup → aplicar migrations (`0004` e `0005` quando aplicável) → publicar/atualizar o Worker → validar `GET /api/capabilities` → validar um redirect normal → configurar Smart Routing no Admin.
- O deploy não aplica migrations automaticamente; a aplicação é uma etapa operacional explícita.
- Um isolate iniciado antes da migration revalida a capability no request seguinte; o restart não é obrigatório.
- Smart Routing e Split Test A/B são mutuamente exclusivos e links com Smart Routing usam sempre `302` com `Cache-Control: no-store`.
- Links configurados antes do upgrade permanecem com `smart_routing_rules = NULL` (desativado) até serem configurados no Admin.

## Destino de expiração e migration 0006 (Unreleased / Fase 4)

> Escopo: **working tree da Fase 4** (sobre o HEAD congelado da Fase 3 `548f179`). A tag publicada `v2.2.1` não contém esta migration nem o destino de expiração.

O destino de expiração adiciona a migration `0006_expired_redirect.sql`, fonte autoritativa da coluna `links.expired_redirect_url` (TEXT, nullable). A mudança é additive: sem default, sem reescrita de dados e sem rebuild de tabela; linhas existentes permanecem `NULL`, o que preserva o comportamento anterior (link expirado responde `410`). Instalações limpas nesta working tree aplicam a cadeia `0000` a `0006`.

- Em banco pré-0006, links normais continuam funcionando integralmente; tentar configurar `expiredRedirectUrl` retorna `400` pedindo a migration, `GET /api/capabilities` reporta `expiredRedirect: false` e o Admin oculta a seção "Após expirar".
- Aplique a `0006` pelo fluxo normal **antes** de tentar configurar destino de expiração em produção.
- Ordem recomendada: backup → aplicar migrations pendentes (`0006`) → publicar/atualizar o Worker → validar `GET /api/capabilities` (`expiredRedirect: true`) → validar um redirect normal → configurar destinos no Admin quando desejado.
- Não há downtime obrigatório: a coluna é nullable e additive.
- Rollback benigno: banco em `0006` com código da Fase 3 ignora a coluna extra; nenhum dado é perdido e nenhum comportamento muda.
- O deploy não aplica migrations automaticamente; a aplicação é uma etapa operacional explícita, e o runtime nunca cria a coluna durante requests.

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

A Fase 4 também introduz a variável opcional `ROOT_REDIRECT_URL` (redirect da raiz), que não depende de migration nem de bindings novos: veja `README.md` e `docs/cloudflare-setup.md`.

## Hierarquia de grupos (Unreleased / Fase 5)

> Escopo: **working tree da Fase 5** (sobre o HEAD congelado da Fase 4 `cdb9f83`). A tag publicada `v2.2.1` **contém** a tabela `link_groups` com `parent_id` (migration `0002`), mas não contém nada desta seção.

- **Não há migration**: a Fase 5 usa `link_groups.parent_id`, com a FK auto-referente e o índice `idx_link_groups_parent_id` que já existem desde a `0002`. Nada para aplicar, nenhum binding novo e nenhuma coluna nova. Uma instalação em `0006` já tem o schema necessário.
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
- **Rollback**: voltar o código para a Fase 4 não exige nenhuma ação de banco — a Fase 5 não altera schema nem dados. O comportamento antigo volta junto com o código (inclusive a exclusão automática).

### Portabilidade de configuração: exportação e importação (Unreleased / Fase 5)

> Escopo: working tree da Fase 5. A tag publicada `v2.2.1` não possui `GET /api/export`, nem as rotas de importação, nem os botões `Exportar configuração` e `Importar configuração`.

- **Não há migration**: o export lê as colunas que já existem. Nenhum binding novo, nenhuma capability nova e nada para aplicar; uma instalação em `0006` (ou até em `0004`/`0005`) exporta com as capacidades que o banco já tem.
- **Aditivo do ponto de vista do upgrade**: as superfícies novas da Fase 5 são administrativas, e apenas três são rotas novas — `GET /api/export`, `POST /api/import/preview` e `POST /api/import/apply` — acompanhadas das ações `Exportar configuração` e `Importar configuração` no Admin e do diálogo de QR Code. O QR usa os endpoints `GET/POST /api/links/:slug/qrcode` e a hierarquia de grupos usa `GET/POST /api/groups`, `PATCH /api/groups/:id` e `DELETE /api/groups/:id`, todos já existentes na base publicada: a Fase 5 muda o contrato e a UI dessas rotas, não cria rotas novas. Nenhuma dessas superfícies é pública — todas ficam atrás do boundary administrativo de `/api` — e o redirect público `GET /:slug`, o CRUD e o lifecycle não ganham API nova por causa de grupos, portabilidade ou QR.
- **Sem impacto nos dados**: o endpoint é somente leitura — não atualiza `version`, timestamps, `has_qrcode`, contadores ou epochs, e não cria tabela de auditoria.
- **Falha fechado pode bloquear o export**: uma linha que o BoltLink não aceitaria hoje (Smart Routing corrompido, destino de expiração sem expiração, ciclo ou pai órfão em grupos, híbrido A/B + Smart Routing) faz o export inteiro responder `409` até ser corrigida. Nada é reparado automaticamente e o banco não é modificado. O limite do formato é 50 grupos, 100 links e 256 KiB.
- **Importação portátil (Gate 5.3)**: o Admin ganha a ação `Importar configuração`, em drawer próprio, que envia o documento para `POST /api/import/preview` (somente leitura, com resumo, colisões, bloqueios e senhas necessárias) e, após revisão, para `POST /api/import/apply`. Não há upload para serviço externo, não há dry-run gravando nada e não há remapeamento manual de IDs: o vínculo `ref` → id local é resolvido dentro da transação.
- **Import é tudo ou nada**: o apply grava grupos e links em um único `batch` do D1, então uma falha deixa o banco exatamente como estava. Colisão de slug bloqueia o import inteiro com `409` (sem overwrite e sem partial import), e o mesmo vale para feature usada que a instalação ainda não suporta, árvore acima de 16 níveis e grafo de grupos corrompido.
- **Import exige nova senha**: `passwordProtected: true` não carrega hash nem senha, então o apply pede uma senha nova por link protegido; sem ela nada é escrito e a senha antiga da origem não funciona. A senha viaja no corpo da requisição (nunca em log, URL, resposta ou storage do browser).
- **Import pode ser bloqueado por dados da própria instalação**: se o destino tiver algum link apontando para um grupo que não existe (um `group_id` deixado para trás por exclusão externa), as duas rotas respondem `409` (`TARGET_GROUP_REFERENCE_CORRUPT`) sem escrever nada. Nada é reparado automaticamente e nenhum grupo importado ocupa o id vago — corrija os links órfãos e repita. Ids de grupo importados nunca reutilizam um id que a sequência `AUTOINCREMENT` do destino já gastou.
- **Import não cria nem altera schema**: as duas rotas usam a readiness de schema somente leitura e respondem `503` num banco não preparado — nenhuma migration é aplicada implicitamente e nenhuma coluna é criada. O bloqueio de capability é por migration, não pela versão do formato do documento: um documento que usa A/B exige a `0004` ou posterior, um que usa Smart Routing exige a `0005` ou posterior e um que usa destino de expiração exige a `0006` ou posterior — A/B no estado default não conta como uso e, num documento que combina recursos, vale a migration mais alta exigida pelos recursos presentes. Na prática: uma base em `0004` aceita A/B mas recusa com `409` Smart Routing e destino de expiração; uma base em `0005` aceita A/B e Smart Routing mas recusa com `409` o destino de expiração; uma base em `0006` aceita os três. Atualizar as migrations é o caminho.
- **Rollback**: remover o código da Fase 5 não exige nenhuma ação de banco. As rotas e os botões deixam de existir; o export não gravou nada e o import, quando usado, gravou apenas links e grupos como qualquer criação pelo painel.

### QR Code no painel (Unreleased / Fase 5)

> Escopo: working tree da Fase 5. Os endpoints `GET/POST /api/links/:slug/qrcode` e a coluna `has_qrcode` existem desde a base publicada (`0001`); o que a Fase 5 acrescenta é o diálogo de preview e os downloads no painel. É evolução de funcionalidade e de UI — **não é migration de banco**: nada para aplicar, nenhum binding novo, nenhuma capability nova.

- **O que muda no upgrade é o painel**: a ação `QR Code` abre um diálogo com preview e três ações — copiar o short link, baixar **PNG** (rasterizado no navegador a partir do SVG, em 512×512) e baixar **SVG** (byte a byte o corpo que o Worker devolveu).
- **O QR codifica apenas a short URL pública**: quem escaneia entra no redirect normal, com senha, A/B, Smart Routing e lifecycle decididos pelo runtime; nenhum destino, segredo ou configuração do link vai para o código.
- **Preview e copiar link não escrevem nada.** `has_qrcode` continua sendo a memória operacional de que um QR foi obtido: só é escrita pelo `POST` que acompanha um download (PNG ou SVG), e o painel só anuncia "QR Ativo" quando a API confirma a escrita.
- **Nenhuma imagem é persistida**: o QR é derivável da short URL a qualquer momento, e a geração não conta clique. Depois de um import de configuração, o QR de cada link importado pode ser gerado de novo normalmente.
- **Rollback**: voltar o código para a Fase 4 não exige ação de banco; o diálogo deixa de existir e a ação `QR Code` anterior volta com o código.

## PASSWORD_SESSION_SECRET e links protegidos por senha

Esta versão passa a exigir `PASSWORD_SESSION_SECRET` para todo o recurso de links protegidos por senha. `API_KEY` deixou de ser fallback de sessão.

- Instalações sem links protegidos por senha: nenhuma ação necessária.
- Instalações com links protegidos por senha: configure `PASSWORD_SESSION_SECRET` como secret do Worker **antes** do upgrade/deploy desta versão.
- `API_KEY` não é mais utilizado para assinar sessões de links protegidos por senha.
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

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
