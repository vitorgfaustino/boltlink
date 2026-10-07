## BoltLink 3.2.0 — candidata, não publicada

- Badges do Admin exibem o caminho completo do grupo, com ellipsis visual, title e rótulo acessível integrais.
- Filtro administrativo inclui todos os descendentes, antes do limite de resultados e sem requests extras.
- Editor hidrata as cinco UTMs da URL e sincroniza alterações/remoções, preservando parâmetros não-UTM e fragmento.
- Deploy Button expõe `ROOT_REDIRECT_URL` como Text opcional, vazio por padrão, sem alterar o redirect existente.
- README começa pela apresentação do produto; procedimentos e detalhes de migrations passam à [referência técnica](docs/technical-reference.md).
- Base publicada e congelada: 3.1.1, tag v3.1.1. Nenhuma tag, publicação ou deploy da candidata neste gate.
- Migrations 0000–0006 intactas, sem mudança de schema. **MIGRATION_0007 = NOT REQUIRED**.

## BoltLink 3.1.1 — publicada

- Corrige o Deploy Button: `npm run deploy` aplica migrations D1 pendentes pelo binding `db_boltlink` antes do Worker; falha no apply impede deploy.
- Corrige a compatibilidade das migrations históricas com o parser remoto D1/Wrangler em instalação nova: somente comentários SQL, sem alteração do SQL executável, schema, nomes ou ordem da cadeia `0000`–`0006`. Correção local para a mesma versão 3.1.1, com validação D1 remota e republicação pendentes.
- Preserva `scripts/wrangler.mjs`; o wrapper permite o apply remoto desse binding no Workers Builds sem configuração privada.
- Instalação nova aplica `0000`–`0006`; instalações preparadas não reaplicam migrations; legados aplicam somente pendentes.
- Sem migration nova, schema ou mudança funcional: **MIGRATION_0007 = NOT REQUIRED**.
- A tag histórica `v3.1.0` não aplicava migrations no deploy. Publicar no GitHub continua source distribution e não opera o D1 de clientes.
- Regressões de scripts, fail-closed com runner mockado, configuração, versões e documentação operacional.
- Guia Cloudflare Access completo: uma aplicação/um AUD, paths administrativos, policy Allow por email, Team Domain, Application Audience, variáveis de runtime, validação e troubleshooting.

No Deploy Button, aceite `npm run deploy`. Em Workers Builds existente, confira Settings > Build > Deploy command e ajuste para esse script. Operação manual continua disponível: `npm run wrangler -- d1 migrations apply db_boltlink --remote`. Veja [Upgrade 3.1.1](docs/upgrading.md#upgrade-para-a-release-311).

## BoltLink 3.1.0 — publicada

- Rate limit administrativo ajustado para 120 requests por IP por janela de 60 segundos, local ao isolate; redirect público e tentativas de senha continuam independentes.
- Amplificação de requests da Lixeira reduzida: exclusão definitiva atualiza estado local e resumo; restore recarrega somente links ativos; purge consulta somente a Lixeira.
- HTTP 429 administrativo inclui `Retry-After`; o Admin informa o tempo de espera em pt-BR quando disponível.
- Documentação corrente reconciliada com a identidade publicada 3.1.0, sem SHA corrente literal.

Release atual publicada **3.1.0**, tag **v3.1.0**. Lixeira, recuperação, higiene de dados e melhorias no Admin; a release anterior **v3.0.0** permanece congelada.

- Admin mais flat, com Lixeira em offcanvas e Importar / Exportar consolidados em um drawer. Criar link integra o fluxo mobile, recolhido a cada abertura/reload e após salvar; desktop mantém o formulário visível. Teclado, ESC, foco e scroll seguem um padrão comum, sem alteração de API, schema ou migrations.
- Lixeira com restauração validada e preservação dos dados existentes.
- Exclusão definitiva libera o slug; o Admin exige confirmação e explica a irreversibilidade.
- Limpeza manual de tombstones com pelo menos 90 dias, precedida de preview; sem Cron automático.
- Export de configuração ativa, sem Lixeira e sem contar tombstones nos limites. Ativos inválidos continuam fail-closed; erro acionável no Admin.
- Formato Portability v1 mantido e documentos antigos com `disabled: true` ainda importáveis.
- Sem migration 0007, sem nova variável/binding e sem mudança no redirect público. Cadeia 0000–0006.
- Regressões de URL em create/PATCH/PUT/import, incluindo recusa de URL vazia no update.

Consulte [Lixeira e recuperação](docs/trash-recovery.md) para API, retenção, reutilização e operação. O portátil não substitui backup D1, incluindo a Lixeira.

## BoltLink 3.0.0

Notas da release **3.0.0**, cobrindo toda a mudança acumulada desde a release anterior `v2.2.1` (commit `8b3895e`, migrations `0000` a `0003`). **Baseline do upgrade:** `v2.2.1`. **Alvo:** `3.0.0` (tag `v3.0.0`). O major se justifica pelo breaking change administrativo em Groups descrito abaixo.

**Modelo de distribuição:** este repositório é a **base do produto**, e a release dele é distribuição de código — source commit, tag `v3.0.0`, push e GitHub Release. Não existe instalação canônica em Cloudflare vinculada ao repositório: o BoltLink é self-hosted e cada instalação tem o próprio Worker, D1, domínio, Cloudflare Access e secrets. Publicar a release no GitHub **não** faz deploy nem aplica migration em nenhuma instalação; backup, migrations (`0004` a `0006`), deploy e validação são etapas operacionais de **cada instalação**, conforme `docs/upgrading.md`.

### Breaking changes (API administrativa de grupos)

- `PATCH /api/groups/:id` passa a exigir a precondição `expectedParentId` sempre que `parentId` é enviado: mover sem informar o pai observado responde `400`, e um pai que mudou desde a leitura responde `409` em vez de sobrescrever a movimentação alheia. Renomear sem `parentId` continua last-write-wins.
- `DELETE /api/groups/:id` ficou mais conservador: só remove grupo sem subgrupos e sem nenhum link, **incluindo links desabilitados**. Antes do upgrade, um grupo com links desabilitados ou com subgrupos podia ser removido e os filhos eram promovidos a raiz pela FK — fluxos que dependiam da remoção antiga precisam ser revisados.
- Este breaking é **administrativo**: o contrato básico da short URL pública (`GET /:slug`) não muda.

### Split Test A/B

- Duas variantes por link: Control A (`target_url`) e Variant B (`ab_target_url`), com alocação stateless decidida por request (`ab_weight_b`, 1 a 99) — sem tabela auxiliar e sem estado por visitante.
- Runtime previsível: A/B responde sempre `302` com `Cache-Control: no-store`; bots e previews recebem o Control.
- Métricas **agregadas apenas**: `ab_clicks_a` e `ab_clicks_b` na própria linha do link. Nenhum dado individual (IP, `User-Agent`, país, visitante) é coletado ou persistido para o sorteio.
- Requer a migration `0004_ab_testing.sql`: sem ela o restante do produto funciona normalmente, a API recusa A/B com `400` e o Admin oculta a seção.
- Integrado à Portability: a configuração do teste viaja no documento portátil; as métricas não.

### Smart Routing

- Destino por país e/ou dispositivo com regras ordenadas (first-match-wins) e fallback no destino principal, em `links.smart_routing_rules` (JSON em linha) — sem SELECT adicional no redirect público.
- Privacidade preservada: país aproximado da Cloudflare e `User-Agent` são usados apenas em memória para escolher o destino; nada é persistido.
- Links com Smart Routing usam sempre `302` + `no-store`; exclusão mútua com A/B; migration `0005_smart_routing.sql`.

### Lifecycle, destino de expiração e redirect da raiz

- O lifecycle vence senha, A/B e Smart Routing: request de link expirado não exibe gate, não roda RNG, não avalia regras e faz **zero escritas** — nunca conta clique.
- Link expirado com destino configurado responde `302` + `no-store`; sem destino, `410` + `no-store`.
- `expiredRedirectUrl` requer `expiresAt`; limpar os dois na mesma edição é a limpeza atômica permitida. Migration `0006_expired_redirect.sql` (additive, nullable).
- `ROOT_REDIRECT_URL`: variável opcional e não secreta que redireciona `GET /` com `302` + `no-store` sem consultar o D1; ausente ou inválida serve a landing normal. Unknown slugs continuam `404`.

### Hardening de redirect, senha e operação

- O `POST /:slug` valida agendamento e expiração antes de decidir se um link possui senha.
- `version` e `privacidade` passam a ser slugs reservados.
- Filtros de métrica classificam User-Agents reconhecidos antes de aceitar `Sec-Fetch-Mode: navigate`, e reconhecem `Purpose`/`Sec-Purpose`/`X-Purpose` tokenizados (inclusive `prefetch;prerender`) — o redirect continua aberto para previews e crawlers, sem contaminar contadores.
- Links protegidos por senha: tipos inválidos no campo `password` respondem `400` sem mutação; o recurso segue exigindo `PASSWORD_SESSION_SECRET` configurado (`API_KEY` não é fallback) e falha fechado com `503` sem ele.

### Grupos hierárquicos e Groups Drawer

- Hierarquia sobre `link_groups.parent_id`, sem migration nova: limite de 16 níveis, auto-parentesco e ciclos respondem `409` sem escrita, e a movimentação é um único `UPDATE` condicional com CTE recursiva.
- Fim da exclusão automática de grupos: mover ou excluir o último link preserva o grupo; remover é sempre uma decisão explícita do operador.
- O painel `Grupos` vira um drawer com árvore expansível, caminho completo (`Clientes / Brasil / Campinas`), criação com grupo pai opcional e movimentação/exclusão validadas pelo backend.
- O redirect público continua sem consultar `link_groups`.

### Portabilidade de configuração (export e import)

- Novos `GET /api/export` e `POST /api/import/preview` / `POST /api/import/apply`, com as ações `Exportar configuração` e `Importar configuração` no Admin.
- Formato **BoltLink Portability JSON v1**: `format: "boltlink-portability"`, `schemaVersion: 1` — identidade de formato independente da versão do produto.
- O artefato é **configuração lógica** (destinos, tipo de redirect, tags, grupo, lifecycle, existência de senha, A/B, Smart Routing, tombstones) e **não é backup do D1**: métricas, `password_hash`, `has_qrcode`, `version` e IDs internos não viajam.
- Capability gates por migration: documento que usa A/B exige a `0004`, Smart Routing exige a `0005` e destino de expiração exige a `0006`; feature usada que falta bloqueia com `409`, sem degradar.
- Import é tudo ou nada (um único `batch` do D1), colisão de slug bloqueia sem overwrite, links protegidos exigem senha nova no apply e métricas não são inventadas nem restauradas.

### QR Code no painel

- A ação `QR Code` abre um diálogo com preview e três ações: copiar o short link, baixar **PNG** (rasterizado no navegador a partir do SVG, 512×512) e baixar **SVG** (byte a byte o corpo que o Worker devolve).
- O QR codifica apenas a short URL pública: quem escaneia entra no redirect normal, com senha, A/B, Smart Routing e lifecycle decididos pelo runtime — nenhum destino ou segredo vai para o código.
- `has_qrcode` é memória operacional, escrita apenas no download: sem QR analytics e sem imagem persistida.

### Migrations da release

Obrigatórias (o deploy não aplica migrations; a aplicação é etapa operacional explícita):

- `0004_ab_testing.sql` — Split Test A/B
- `0005_smart_routing.sql` — Smart Routing
- `0006_expired_redirect.sql` — `expired_redirect_url`

Sem migration nova (usam tabelas/colunas já existentes): hierarquia de grupos e Groups Drawer (`link_groups` da `0002`), Portability de configuração e QR Code com preview e downloads (endpoints e `has_qrcode` já existentes na base publicada).

### Impacto em clientes da API administrativa

Se você usa diretamente a API administrativa de Groups:

- revise o `PATCH /api/groups/:id`: envie `expectedParentId` junto de `parentId` e trate os novos `400`/`409` do contrato;
- revise fluxos que dependem do `DELETE /api/groups/:id`: grupo com subgrupos ou com qualquer link (desabilitado incluído) responde `409`, sem cascade e sem reparent.

Se você usa apenas o Admin UI: o painel já envia o contrato atual (inclusive `expectedParentId`), comprovado por código e testes — nenhuma ação além do upgrade normal.

### Privacidade

- O produto persiste **agregados** (`clicks_total`, `ab_clicks_a`/`ab_clicks_b`) e metadados operacionais de fencing (`metric_epoch`, `ab_generation`, `ab_started_at`); não persiste eventos individuais. Detalhes em `docs/retention.md`.
- IP, hash estável de IP, país, `User-Agent`, dispositivo derivado, regra selecionada e referrer individual continuam fora do banco.
- `password_hash` nunca sai no Portability; senhas de links protegidos são redefinidas no import.

### Known limitations / dívida técnica conhecida

- `TS7016` no módulo `qrcode` (sem `@types/qrcode`) — dívida técnica **aceita para a 3.0.0** e **não bloqueante**: o runtime, o bundle do Wrangler e a suíte completa passam, e o CI atual não usa `tsc` como gate de release. Não há declaração manual nem mudança de `tsconfig` só para zerar `tsc`; o runtime continua correto porque o módulo é resolvido pela entrada de browser que o bundle usa.
- Downgrade geral não é garantido: não existe procedimento testado de reversão das migrations; os casos benignos de voltar o código sem voltar o banco estão documentados em `docs/upgrading.md`.
- Produção ainda requer configuração correta do Cloudflare Access; a validação do token dentro do Worker não é substituída pela proteção fora dele.
- Scan online de advisory de vulnerabilidades não foi executado nesta release.

Os detalhes de implementação por fase (gates de trabalho) permanecem nas seções de trabalho abaixo.

## Unreleased - Fase 5 (hierarquia de grupos, portabilidade de configuração e QR Code)

Notas de trabalho da fase, mantidas como registro histórico dos gates de desenvolvimento; o consolidado desta release está no bloco 3.0.0 acima.

> Escopo: este bloco cobre a **working tree da Fase 5** (sobre o HEAD congelado da Fase 4 `cdb9f83`). A tabela `link_groups` com `parent_id` já existe na tag publicada `v2.2.1` (migration `0002`); o que não existe na tag é a integridade descrita aqui. A Fase 5 **não adiciona migration**.

### Destaques

- **Hierarquia sem migration nova**: a árvore usa apenas `link_groups.parent_id`, com a FK auto-referente e o índice que já existem desde a `0002`. Sem closure table, materialized path, nested sets, tabela auxiliar ou coluna `version` em grupos.
- **Sem ciclos**: auto-parentesco e qualquer ciclo indireto (`A → B → A`, `A → B → C → A`) respondem `409` e nada é escrito. O backend é a autoridade; a UI não é proteção suficiente.
- **Limite de 16 níveis**: raiz é profundidade 1. Criar sob profundidade 16 responde `409` sem linha parcial; mover mede a subárvore inteira, não só o nó movido. Árvore legada acima do limite continua legível e reparável para cima, mas manter ou aumentar a violação responde `409`.
- **Movimentação atômica e concorrência**: toda mudança de pai é **um único `UPDATE` condicional com CTE recursiva** — ciclo, profundidade e a precondição do pai observado são decididos na mesma instrução que grava, sem `SELECT` seguido de `UPDATE` desprotegido. `expectedParentId` é obrigatório sempre que `parentId` é enviado e um pai que mudou desde a leitura responde `409`; renomear sem `parentId` continua last-write-wins.
- **Exclusão só de grupo realmente vazio**: `DELETE /api/groups/:id` é um `DELETE` condicional atômico e remove apenas grupo sem subgrupos e sem nenhum link, **incluindo links desabilitados**. Com subgrupos ou links responde `409`, inexistente responde `404`, sem cascade e sem reparent automático.
- **Fim da exclusão automática**: o runtime não apaga mais grupos ao sair o último link ativo (`cleanupEmptyGroup` foi removido). Mover ou excluir o último link deixa o grupo no banco; remover um grupo é sempre uma decisão explícita do operador.
- **Falha fechado em grafo corrompido**: ciclo gravado por SQL externo faz `GET /api/groups` responder `409`, sem árvore parcial, sem loop e sem reparo automático.
- **Admin**: painel `Grupos` com árvore expansível, indentação, caminho completo (`Clientes / Brasil / Campinas`), criação com grupo pai opcional, movimentação com contexto de caminho e exclusão bloqueada pelo backend com erro compreensível — sem drag-and-drop e sem sort manual.
- **Redirect inalterado**: o hot path público continua com a mesma leitura de `links`, sem `JOIN` em `link_groups`, sem consulta ao grupo e sem custo adicional por clique.
- **Exportação portátil (Gate 5.2)**: `GET /api/export` gera o **BoltLink Portability JSON v1** (`format: "boltlink-portability"`, `schemaVersion: 1`) com a configuração lógica da instância e download pelo Admin em `Exportar configuração`.
- **Não é backup do banco**: o artefato transporta intenção administrativa — destino, tipo de redirect, tags, grupo, lifecycle, existência de senha, A/B e Smart Routing — e nada de métricas, hashes ou IDs internos. Recuperação integral de estado operacional continua sendo backup do D1.
- **Senha nunca sai**: o `password_hash` não é nem selecionado; o documento traz apenas `passwordProtected: true/false`. A importação exige uma **nova** senha para cada link protegido.
- **Importação portátil (Gate 5.3)**: `POST /api/import/preview` valida o arquivo sem escrever nada e `POST /api/import/apply` reconstrói a configuração. O Admin expõe os dois passos no drawer `Importar configuração`, com resumo, conflitos, bloqueios e campos de nova senha.
- **Import é tudo ou nada**: o documento inteiro (grupos de pai para filho, depois os links) vai em **um único `batch` do D1**, que é uma transação — uma falha em qualquer statement desfaz o import completo, então nunca existe partial import. O vínculo `ref` → id local é resolvido dentro da transação (ids relativos derivados de `max(MAX(id), sqlite_sequence.seq)`), sem migration, sem tabela temporária e sem nome/path como chave.
- **Id de grupo nunca é reciclado**: o bloco importado começa acima de tudo que a sequência `AUTOINCREMENT` do destino já gastou. Apagar os grupos mais novos derruba o `MAX(id)` mas não essa marca d'água, e como o D1 não aplica `links.group_id` como foreign key, um id reutilizado faria um link antigo passar a apontar em silêncio para um grupo importado.
- **Destino com referência órfã bloqueia**: se a instalação tem link apontando para grupo que não existe, o import inteiro responde `409` (`TARGET_GROUP_REFERENCE_CORRUPT`) no preview e no apply, sem reparo, sem reparent e sem zerar `group_id`.
- **Corpo ilegível é recusado**: o corpo precisa ser UTF-8 válido; byte inválido responde `400` (`INVALID_BODY`) em vez de ser reparado com U+FFFD e virar outro documento. Falha de batch que não seja a colisão de slug responde `500` controlado, sem SQL, stack ou binds — e nunca `SLUG_COLLISION` só porque existe slug ocupado no destino.
- **Drawer não guarda senha**: cada arquivo selecionado tem sua própria identidade, o apply exige preview aprovado para o arquivo que está na tela (resposta atrasada de um arquivo substituído é descartada) e toda falha terminal — inclusive de rede — esvazia os campos de senha.
- **Colisão bloqueia, nunca sobrescreve**: qualquer slug já reservado no destino (ativo, desabilitado ou tombstone) bloqueia o import inteiro com `409` e lista os conflitos; grupos do arquivo são sempre grupos novos, sem merge por nome. Import em instalação não vazia é permitido quando nada colide.
- **Feature que falta bloqueia, não degrada**: documento que usa A/B, Smart Routing ou destino de expiração num banco sem a migration correspondente responde `409` (`TARGET_CAPABILITY_MISSING`) — A/B no estado default não conta como uso. Árvore acima de 16 níveis responde `409` (`GROUP_DEPTH_EXCEEDED`), documentado como limite de portabilidade de legado, e grafo de destino corrompido responde `409` (`DESTINATION_HIERARCHY_CORRUPT`).
- **Preview somente leitura no request inteiro**: `POST /api/import/preview` não grava linha, não executa DDL e não instala `boltlink_metric_fence` (usa a readiness de schema somente leitura); banco não preparado responde `503` nas duas rotas, sem migration implícita.
- **Métricas começam de novo**: o documento não carrega contadores, então links importados nascem com os defaults do destino (`clicks_total = 0`, `metric_epoch`/`ab_generation` conforme o estado criado), como qualquer link criado no painel.
- **Sem IDs internos**: grupos recebem `ref` local ao documento (`g1`, `g2`, …) e os links apontam para eles por `groupRef`; nenhum `id` do D1 é necessário para reconstruir a árvore, e nomes repetidos continuam distintos.
- **Tombstones e ordem preservados**: links desabilitados continuam no documento (o slug permanece reservado), a ordem das tags é a do operador e as regras de Smart Routing viajam na ordem original, porque first-match-wins é semântico.
- **Falha fechado, nunca parcial**: qualquer linha inválida — Smart Routing corrompido, destino de expiração sem expiração, URL inválida, slug reservado, **nome de grupo em forma não canônica (espaços nas pontas, só espaços ou acima de 120 caracteres, nunca normalizado no export)**, grafo de grupos com ciclo ou pai órfão, A/B inválido ou linha híbrida A/B + Smart — recusa o export inteiro com `409`. Acima de 50 grupos, 100 links ou 256 KiB (bytes UTF-8) a resposta é `413`. O documento nunca é truncado, nunca recebe `null` no lugar de estado corrompido e nunca é parcial.
- **Determinismo e leitura consistente**: a mesma configuração produz o mesmo documento funcional (só `exportedAt` varia). Os dois `SELECT` viajam em um único `batch`, com a semântica que o D1 oferece para o batch; como o export também lê fora desse conjunto (contagem prévia e sondagens de capability), **não** há promessa de snapshot do request inteiro — a consistência vem da validação: os grupos são lidos antes dos links e uma corrida que criaria referência órfã responde `409` em vez de documento inconsistente.
- **Somente leitura no request inteiro**: o export não escreve nada no banco e não executa DDL — nem no middleware: ele usa a readiness de schema somente leitura, então a projeção `boltlink_metric_fence` que as demais rotas `/api` instalam **não** é criada ao pedir o export, inclusive no primeiro request em handle frio. Usa o mesmo boundary administrativo e o mesmo rate limit das outras rotas `/api`, e downloads usam nome de arquivo constante com `Cache-Control: no-store`.
- **QR Code com preview e downloads (Gates 5.4 e 5.4.1)**: o painel ganha um diálogo de preview com três ações — copiar o short link, baixar **PNG** (rasterizado no navegador a partir do SVG, em 512×512) e baixar **SVG** (byte a byte o corpo que o Worker devolveu). Os endpoints `GET/POST /api/links/:slug/qrcode` e a coluna `has_qrcode` existem desde a base publicada; a Fase 5 não adiciona migration.
- **O QR só codifica a short URL**: quem escaneia entra no redirect normal, com senha, A/B, Smart Routing e lifecycle decididos pelo runtime — nenhum destination, variante, alvo de roteamento ou segredo vai para o código.
- **`has_qrcode` é memória operacional, não analytics**: a flag só é escrita quando o operador baixa o QR (PNG ou SVG), nunca no preview nem ao copiar o link; a geração não conta clique e nenhuma imagem é persistida.
- **QR fora da portabilidade**: o documento portátil não carrega `has_qrcode` nem imagem de QR; depois de um import, o QR de cada link pode ser gerado de novo porque deriva da short URL.

## Unreleased - Fase 4 (destino de expiração e redirect da raiz)

Notas de trabalho da fase, mantidas como registro histórico dos gates de desenvolvimento; o consolidado desta release está no bloco 3.0.0 acima.

> Escopo: este bloco cobre a **working tree da Fase 4** (sobre o HEAD congelado da Fase 3 `548f179`): destino de expiração, migration `0006` e `ROOT_REDIRECT_URL`. Nada disso está na tag publicada `v2.2.1`, que termina na `0003`.

### Destaques

- **Destino após expiração**: um link com expiração pode responder `302` para uma URL escolhida pelo operador depois que expira, em vez do `410` padrão. O campo é opcional, requer expiração preenchida e aceita URL http/https.
- **Lifecycle acima de tudo**: link expirado não pede senha, não sorteia A/B, não avalia Smart Routing e não conta clique — a mesma resposta para humanos, bots e previews, com zero escritas no banco.
- **`410`/`302` sempre com `no-store`**: expiração é estado mutável; nenhum dos dois status é retido por cache.
- **Fail-safe em leitura**: valor persistido inválido (gravado manualmente) ou self-loop direto responde `410`, sem fallback para o destino principal e sem reescrever o valor.
- **`ROOT_REDIRECT_URL`**: variável opcional e não secreta que redireciona `GET /` com `302` + `no-store` sem consultar D1. Ausente ou inválida, a landing normal é servida; unknown slugs continuam `404`.
- **Migration 0006**: `0006_expired_redirect.sql` adiciona `expired_redirect_url TEXT` (additive, nullable, sem rewrite). Sem ela, o produto funciona e apenas o destino fica bloqueado (`400` na API, seção oculta no Admin); com banco em `0006` e código da Fase 3, o rollback é benigno.
- **Admin**: seção "Após expirar" com `Resposta padrão (410)` / `Redirecionar para URL`, oculta em instalações pré-`0006`; limpar a expiração remove o destino junto (limpeza atômica).
- **O que não muda**: unknown slugs continuam `404` (sem custom 404 e sem redirect global), links futuros e desabilitados continuam `404`, expiração por contagem de cliques continua fora de escopo e nenhuma métrica individual é adicionada.

## Unreleased - Smart Routing (Fase 3)

Notas de trabalho da fase, mantidas como registro histórico dos gates de desenvolvimento; o consolidado desta release está no bloco 3.0.0 acima.

> Escopo: este bloco cobre o **baseline local da Fase 2** (Split Test A/B, migration `0004`) e o **estado Unreleased da Fase 3** (Smart Routing, migration `0005`). Nenhum dos dois está na tag publicada `v2.2.1`, que termina na `0003`.

### Destaques

- **Smart Routing privacy-first**: escolha de destino por país e/ou dispositivo com regras ordenadas, first-match-wins e fallback no destino principal.
- **Sem dados de visitante**: país aproximado da Cloudflare e `User-Agent` são usados apenas em memória para selecionar o destino; país, user-agent, dispositivo derivado e regra escolhida não são persistidos.
- **Uma coluna, um SELECT**: regras ficam em `links.smart_routing_rules` (JSON em linha), sem tabela auxiliar, JOIN ou SELECT adicional no redirect.
- **Redirect previsível**: links com Smart Routing usam sempre `302` com `Cache-Control: no-store`, e bots/previews recebem sempre o fallback.
- **Editor no Admin**: ativar/desativar, adicionar/mover/remover regras (sem drag-and-drop), país via lista ISO local, limite de 20 regras e fallback somente leitura.
- **Exclusão mútua com A/B**: Smart Routing e Split Test A/B não coexistem; a troca acontece em um único `PATCH` atômico, e `301` fica indisponível enquanto Smart Routing estiver ativo.
- **Migration 0005**: `0005_smart_routing.sql` é a fonte autoritativa da coluna; o deploy não aplica migrations automaticamente.
- **Convergência sem restart**: o redirect público lê a linha com projeção schema-neutral, então um isolate aquecido antes da `0005` passa a rotear corretamente no request público seguinte, sem depender de um request Admin/API no mesmo isolate.
- **Corrupção preservada**: um valor persistido ilegível em `smart_routing_rules` deixa de ser tratado como "desativado" — a API informa `smartRoutingStatus: "invalid"` sem expor o valor cru, edições não relacionadas preservam os bytes e só a ação explícita de limpeza grava `NULL`.

## BoltLink 2.2.1 - UX Refinement & Keyboard Shortcuts

Esta atualização traz melhorias no controle por teclado, acessibilidade (WCAG), consistência visual nos templates de páginas públicas e de redirecionamento, e refinamentos de design para dispositivos móveis.

### Atalhos de Teclado & Facilidade de Uso
- **Atalhos no Painel**:
  - `/` foca instantaneamente na barra de pesquisa.
  - `Ctrl + Enter` submete o formulário de criação/edição.
  - `Esc` cancela a edição ativa ou fecha dropdowns abertos.
- **Busca Rápida**: Adicionado botão `×` para limpar a busca de forma instantânea.
- **Fluxo do Formulário**: O accordion agora permite apenas uma seção aberta por vez, diminuindo a carga cognitiva ao preencher ou editar links.

### Acessibilidade & Tipografia (WCAG)
- **Touch Targets**: Botões e menus suspensos no mobile redimensionados para o mínimo de `44px` (em conformidade com WCAG 2.5.5).
- **Contraste**: A cor de placeholders foi escurecida (`#52525b` → `#71717a`) para atender a taxa de contraste de ~4.5:1.
- **Tipografia Fluida**: Uso de `text-wrap: pretty` para evitar palavras isoladas em parágrafos e `text-wrap: balance` nos títulos principais.

### Alinhamento Estético e Responsivo
- **Consistência nos Worker Templates**: As páginas de Home e Password Gate geradas pelo Worker foram atualizadas com os tokens visuais padrão (radius, blur, motion com curvas cubic-bezier).
- **Responsividade no Mobile**: Adicionadas melhorias de espaçamento para telas de até 480px.
- **Aprimoramentos em Privacidade**: Alinhamento de design tokens em `privacidade.html`, substituição da barra lateral de títulos por sublinhados consistentes e suporte expandido a `prefers-reduced-motion`.

## BoltLink 2.2.0 - UI Redesign & Hardening

Esta atualização traz um pacote significativo de melhorias visuais e uma auditoria de segurança direcionada ao core do sistema.

### Destaques Visuais
O painel administrativo (`admin.html`, `admin.css`, `admin.js`) e as páginas públicas (`privacidade.html`, `index.ts`) foram reescritos para adotar uma estética premium, moderna e limpa.
- **Glassmorphism e Animações**: Interface aprimorada com sombras suaves, fundos em degradê e interações táteis (spring) nos botões.
- **Limpeza no Layout Mobile**: As ações por link ("QR Code", "Duplicar", etc.) foram agrupadas em um menu suspenso (`<details>`) para que em resoluções de smartphone (ex: 320px) o painel continue perfeitamente organizado sem empurrar elementos.
- **Typography e Cor**: Adoção de hierarquia sem serifas (system fonts) e substituição da antiga paleta ciano por um tom premium de azul (`#00A1F5`).

### Destaques de Segurança
A auditoria implementou um endurecimento na mecânica de autenticação de links isolados:
- **Mitigação de Timing Attack**: A verificação de senha de visitantes passou a utilizar comparação de tempo constante (`constantTimeEqual`).
- **Sessões Fail-Secure**: Removido o *fallback* de variável em memória para as sessões de senha. O operador é forçado a ter a variável `PASSWORD_SESSION_SECRET` configurada ao utilizar senha. Se não for informada, o worker lançará erro visando proteger a segurança global da sessão em um ambiente distribuído de datacenters.

## BoltLink 2.1.0 - Estrutura do Admin Separável
Esta versão reorganiza o painel administrativo extraindo CSS e JavaScript para arquivos separados, sem alterar comportamento de redirect, API ou autenticação.

O `admin.html` deixa de ser um arquivo monolítico de 2158 linhas e passa a carregar:
- `admin.css` — estilos com cache independente
- `admin.js` — lógica do painel com cache independente

A separação facilita manutenção, reduz o HTML para ~250 linhas e melhora a experiência de desenvolvimento sem introduzir build step, sem alterar o fluxo de deploy e sem impacto em instâncias já publicadas.

`admin.css` e `admin.js` são arquivos estáticos servidos diretamente pela infraestrutura da Cloudflare (requisições gratuitas e ilimitadas).

Os novos arquivos foram adicionados à lista de slugs reservados para evitar conflito com links criados pelo operador.

## BoltLink 2.0.1 - Free-first traffic hardening

Esta atualização mantém a baseline LGPD iniciada na v2.0.0 e foca em reduzir desperdício operacional no plano gratuito da Cloudflare.

### Destaques

- novo botão no admin para zerar `clicks_total` de um link ativo
- novo endpoint administrativo para reset individual de estatística agregada
- rejeição de slugs públicos inválidos antes de consultar D1
- rate limit em memória no redirect público para reduzir rajadas contra D1
- documentação nova para operação free-first em `docs/free-plan-traffic.md`

### O que não muda

- não volta a existir tabela `stats`
- não há histórico por data
- não há IP, hash de IP, país, referrer ou user-agent persistido
- excluir link continua sendo exclusão lógica com `disabled_at`

## BoltLink 2.0.0 - LGPD Baseline

BoltLink 2.0.0 é a nova baseline de privacidade do projeto.

Esta versão muda o produto para um modelo de minimização real de dados: o redirect continua rápido, a contagem continua existindo, mas o sistema deixa de manter analytics detalhado por evento e remove campos que aumentavam a superfície de tratamento sem serem essenciais para o objetivo principal.

### Destaques

- contagem apenas agregada em `clicks_total`
- remoção da tabela `stats`
- remoção de `IP_HASH_SECRET`
- remoção de `last_clicked_at`
- remoção de `notes`
- remoção do endpoint `/api/links/:slug/stats`
- remoção do endpoint `/api/maintenance/purge-stats`
- `Referrer-Policy: strict-origin` nos redirects públicos
- `Referrer-Policy: no-referrer` no admin, API e demais respostas
- `observability.enabled = false` no template público
- `upload_source_maps = false` no template público

### Impacto funcional

BoltLink continua suportando:

- redirect público por slug
- CRUD de links
- tags, grupos, QR code, agendamento e expiração
- proteção por senha
- Cloudflare Access no admin
- deploy por Wrangler local
- deploy guiado por IA
- one-click / GitHub auto-deploy

O que deixa de existir na linha 2.x:

- analytics por clique
- retenção de eventos
- hash estável de IP
- visualização do último clique
- notas internas livres no link

### Upgrade

A migration `0003_lgpd_minimization.sql` remove dados legados e reconstrói a tabela `links` no novo formato.

Fluxo recomendado:

```bash
git pull --ff-only
npm install
npm run wrangler:init
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm test
```

---

Release atual publicada: 3.1.1 · Tag: v3.1.1 · Release anterior: 3.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
