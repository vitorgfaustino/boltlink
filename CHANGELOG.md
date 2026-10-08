# Changelog

## [3.2.1] - Unreleased — candidata de manutenção

### Upgrade & Deploy Safety

- Preflight D1 bloqueia UUID ausente/inválido, binding ou alvo ambíguo antes de chamar Wrangler; informa o arquivo efetivo.
- Roteamento compartilhado para Builds, CLI local, config/ambiente explícito e flags booleanas, incluindo opções antes do comando.
- Merge por binding preserva identidade, ordem e recursos locais; entradas incompletas não adotam IDs de outro alvo. Duplicidades em bindings/JSONC falham fechadas.
- `upgrade:check` exige correção de identidade removida e confirmação explícita de mudanças operacionais; baseline ausente nega aprovação automática.
- Fluxo orientado por IA identifica cliente/upstream e exige comparação, preflight, testes, diff/destino e autorização antes de push potencialmente mutável. Recuperação de D1 documentada sem recriação de banco.
- Versionamento local finalizado em 3.2.1, publicação pendente. Nenhuma feature no Admin, migration, schema ou secret obrigatório novo; instalações não são atualizadas automaticamente.
- Teste de rate limit estabilizado com relógio controlado, sem alteração da regra de produção. CI de testes recebe histórico/tags e usa somente permissão de leitura.
- Freeze local: comparação bloqueia também remoções parciais de bindings/identificadores; `.env.local` não pode selecionar ambiente após o preflight; aliases longos/camel-case não contornam o preflight e comandos D1 implicitamente remotos também validam a configuração antes do Wrangler.

## [3.2.0] - 2026-10-07

- Badges do Admin exibem o caminho completo do grupo, com ellipsis visual, title e rótulo acessível integrais.
- Filtro administrativo inclui todos os descendentes, antes do limite de resultados e sem requests extras.
- Editor hidrata as cinco UTMs da URL e sincroniza alterações/remoções, preservando parâmetros não-UTM e fragmento.
- Deploy Button expõe `ROOT_REDIRECT_URL` como Text opcional, vazio por padrão, sem alterar o redirect existente.
- README começa pela apresentação do produto; procedimentos e detalhes de migrations passam à [referência técnica](docs/technical-reference.md).
- Admin com Dark Mode refinado, cards compactos e badges semânticas: A/B, Smart Routing e QR Code têm cores fixas; grupos e tags permanecem neutros.
- Showcase com nove screenshots atualizadas em Light, Dark e mobile e GIF demonstrativo, usando dados fictícios.
- Expansor A/B mais legível e layout responsivo refinado, com ações mobile e quebra de badges.
- Migrations 0000–0006 intactas, sem mudança de schema. **MIGRATION_0007 = NOT REQUIRED**.

## [3.1.1] - 2026-10-07

- Corrige o Deploy Button: `npm run deploy` aplica migrations D1 pendentes pelo binding `db_boltlink` antes do Worker; falha no apply impede deploy.
- Corrige a compatibilidade das migrations históricas com o parser remoto D1/Wrangler em instalação nova: somente comentários SQL, sem alteração do SQL executável, schema, nomes ou ordem da cadeia `0000`–`0006`. Correção integrada à v3.1.1 republicada e congelada; fresh install D1 remoto validado pelo usuário e CI de main e da tag aprovado.
- Preserva `scripts/wrangler.mjs`; o wrapper permite o apply remoto desse binding no Workers Builds sem configuração privada.
- Instalação nova aplica `0000`–`0006`; instalações preparadas não reaplicam migrations; legados aplicam somente pendentes.
- Sem migration nova, schema ou mudança funcional: **MIGRATION_0007 = NOT REQUIRED**.
- A tag histórica `v3.1.0` não aplicava migrations no deploy. Publicar no GitHub continua source distribution e não opera o D1 de clientes.
- Regressões de scripts, fail-closed com runner mockado, configuração, versões e documentação operacional.
- Guia Cloudflare Access completo: uma aplicação/um AUD, paths administrativos, policy Allow por email, Team Domain, Application Audience, variáveis de runtime, validação e troubleshooting.

## [3.1.0] - 2026-10-02

- Rate limit administrativo ajustado para 120 requests por IP por janela de 60 segundos, local ao isolate; redirect público e tentativas de senha continuam independentes.
- Amplificação de requests da Lixeira reduzida: exclusão definitiva atualiza estado local e resumo; restore recarrega somente links ativos; purge consulta somente a Lixeira.
- HTTP 429 administrativo inclui `Retry-After`; o Admin informa o tempo de espera em pt-BR quando disponível.
- Documentação corrente reconciliada com a identidade publicada 3.1.0, sem SHA corrente literal.

- Admin mais flat, com Lixeira em offcanvas e Importar / Exportar consolidados em um drawer. Criar link integra o fluxo mobile, recolhido a cada abertura/reload e após salvar; desktop mantém o formulário visível. Teclado, ESC, foco e scroll seguem um padrão comum, sem alteração de API, schema ou migrations.
- Lixeira administrativa com busca e paginação; restore valida configuração e concorrência, preservando métricas, senha, QR, grupo e lifecycle.
- Exclusão definitiva somente de tombstones, liberando slug; colisão de create com Lixeira responde `SLUG_IN_TRASH`.
- Retenção interna de 90 dias com preview read-only e purge manual condicional; sem Cron ou operação remota.
- Export somente de links ativos; erros com `code` e orientação segura no Admin. Formato v1 e import legado `disabled: true` preservados.
- URL vazia enviada por PATCH/PUT é recusada em vez de ser tratada como campo ausente. Mesma autoridade de URL em create, update, restore e import.
- Sem migration 0007: cadeia 0000–0006, sem binding novo. Release histórica v3.1.0; v3.0.0 permanece congelada.

## [3.0.0] - 2026-09-29

> Este bloco cobre toda a mudança acumulada desde a tag `v2.2.1`, que termina na migration `0003`: o Split Test A/B (**Fase 2**, migration `0004`), o Smart Routing (**Fase 3**, migration `0005`), o destino de expiração + `ROOT_REDIRECT_URL` (**Fase 4**, migration `0006`) e a **Fase 5** (hierarquia de grupos, portabilidade de configuração e QR Code com preview e downloads, sem migration nova). O major se justifica pelo breaking change administrativo em Groups, descrito abaixo. A release do repositório é distribuição de código: cada instalação é self-hosted e executa o próprio backup, as próprias migrations e o próprio deploy — publicar a tag não atualiza nem migra nenhuma instalação automaticamente.

### Adicionado

- Split Test A/B por link com Control A (`target_url`) e Variant B (`ab_target_url`), distribuição stateless por requisição e contadores agregados `ab_clicks_a`/`ab_clicks_b`
- migration `0004_ab_testing.sql` como fonte autoritativa das colunas A/B; o runtime não pré-aplica a migration e mantém links normais funcionando em banco pré-0004
- migrations como única autoridade do schema: instalação limpa = aplicar `0000` a `0006`; `schema.sql` passa a ser apenas o baseline da `0000` para ferramentas manuais
- UI de Split Test A/B no admin (toggle, Variant B, presets de Traffic Allocation) e exibição de Cliques A/B e Distribuição observada, inclusive após o teste ser encerrado
- validação fail-fast de `abEnabled`/`abTargetUrl`/`abWeightB` (1 a 99) sem partial mutation
- `ab_generation`/`metric_epoch` para fencing de métricas atrasadas e concorrência otimista (`version`) nos updates administrativos
- testes determinísticos de split (RNG injetado), geração, late write, reset, concorrência, cache, senha + A/B, duplicação, instalação limpa e upgrade
- Smart Routing privacy-first por link: regras ordenadas de país/dispositivo com first-match-wins e fallback em `target_url`, usando `links.smart_routing_rules` (JSON em linha) e país/dispositivo apenas em memória
- editor de Smart Routing no Admin com regras ordenadas (mover para cima/baixo, remover), país via lista ISO local com `Intl.DisplayNames` quando disponível, `Qualquer país`/`Qualquer dispositivo`, fallback somente leitura e limite de 20 regras
- capability-aware UI: a seção Smart Routing só aparece quando `smartRouting=true`; instalações pré-`0005` não recebem o campo no payload
- migration `0005_smart_routing.sql` como fonte autoritativa de `links.smart_routing_rules`; instalação limpa = aplicar `0000` a `0005`
- exclusão mútua entre Smart Routing e Split Test A/B, e bloqueio de `301` quando Smart Routing está ativo, com transição atômica em um único `PATCH`
- redirect público integrado: Smart Routing usa sempre `302` + `Cache-Control: no-store`, bot/preview/prefetch sempre no fallback, e estado híbrido/corrompido falha seguro em `target_url` com métrica somente `clicks_total`
- hot path sem SELECT adicional, sem tabela auxiliar, sem API externa e sem PRAGMA por clique; testes de SQL instrumentado (cold vs warm) e provas de zero parse/classificação/RNG em bots e híbridos
- destino de expiração por link (`expiredRedirectUrl` / `links.expired_redirect_url`): opcional, requer `expiresAt`, URL http/https; link expirado com destino válido responde `302` + `no-store`, sem destino responde `410` + `no-store`
- lifecycle vence senha, A/B e Smart Routing: request de link expirado não exibe gate de senha, não roda RNG, não avalia regras, não classifica bot/humano e executa zero escritas — nunca conta clique
- destino de expiração revalidado em read-time pela política compartilhada de destinos: valor persistido inválido, não http/https ou self-loop direto responde `410`, sem fallback para `target_url` e sem reescrever o valor armazenado
- migration `0006_expired_redirect.sql` como fonte autoritativa de `links.expired_redirect_url` (additive, nullable, sem rewrite e sem rebuild); instalação limpa = aplicar `0000` a `0006`; banco pré-`0006` mantém o CRUD normal com `expiredRedirectUrl` recusado (`400`)
- `ROOT_REDIRECT_URL`, variável opcional e não secreta: `GET /` com valor válido responde `302` + `no-store` sem consultar D1; ausente/inválida/auto-referente serve a landing (fail-safe silencioso); unknown slugs, `/admin`, `/api`, `/health`, `/privacidade` e assets não mudam
- UI de destino de expiração no Admin: seção "Após expirar" com `Resposta padrão (410)` e `Redirecionar para URL`, disponível apenas com expiração preenchida, oculta quando `expiredRedirect=false` (pré-`0006`), com limpeza atômica de expiração + destino na mesma edição
- `GET /api/capabilities` informa `expiredRedirect` ao Admin (indicador de schema da `0006`, não feature flag de produto)
- `PATCH` de destino de expiração com invariante de estado final: campo ausente preserva, `null` limpa, URL válida substitui; limpar `expiresAt` mantendo o destino retorna `400`; limpar os dois juntos é permitido
- duplicar um link continua nascendo ativo: não copia `expiresAt`, `goLiveAt`, senha nem `expiredRedirectUrl`; `reset-clicks` preserva expiração e destino de expiração
- integridade da hierarquia de grupos sobre `link_groups.parent_id` (Unreleased / Fase 5): auto-parentesco e qualquer ciclo indireto respondem `409` sem escrita, decididos por CTE recursiva no próprio statement
- limite operacional `MAX_GROUP_DEPTH = 16` com raiz em profundidade 1: `POST` sob profundidade 16 responde `409` sem linha parcial e `MOVE` mede a subárvore inteira (grupo + descendentes); árvore legada acima do limite continua legível e reparável para cima
- movimentação de grupo com precondição de concorrência `expectedParentId`, obrigatória sempre que `parentId` é enviado: um pai que mudou desde a leitura responde `409` em vez de sobrescrever o move alheio, e o rename sem `parentId` mantém last-write-wins (sem coluna `version` em grupos)
- `DELETE /api/groups/:id` passa a ser um `DELETE` condicional atômico: só remove grupo sem subgrupos e sem nenhum link, links desabilitados incluídos; com subgrupos ou links responde `409`, inexistente responde `404`, sem cascade e sem reparent automático
- leitura de árvore corrompida falha fechado: ciclo gravado por SQL externo faz `GET /api/groups` responder `409` sem árvore parcial, sem loop e sem reparo automático
- Admin ganha painel de grupos com árvore expansível, indentação, caminho completo (`Clientes / Brasil / Campinas`), criação com grupo pai opcional, movimentação com `expectedParentId` e exclusão bloqueada pelo backend com erro explícito
- `test/group-hierarchy.spec.ts` e `test/group-hierarchy-admin.spec.ts` cobrem contrato de `parentId`, ciclos, profundidade, delete, corrupção, concorrência com dois handles, teto `O(N)` da montagem da árvore e ausência de HTML sink para nome/caminho de grupo
- formato portátil **BoltLink Portability JSON v1** (`format: "boltlink-portability"`, `schemaVersion: 1`), com identidade de formato independente da versão do produto e `exportedAt` apenas informativo
- `GET /api/export` exporta a **configuração lógica** da instância — não é backup do D1: grupos com `ref` local ao documento e vínculo por `groupRef`, links identificados por `slug`, destino, tipo de redirect, tags, grupo, tombstone (`disabled`), lifecycle, flag de senha e configuração de A/B e Smart Routing
- exportação sem credenciais: `password_hash` não é selecionado (o `SELECT` calcula `passwordProtected`) e métricas (`clicks_total`, `ab_clicks_*`, `ab_started_at`, `metric_epoch`, `ab_generation`), `has_qrcode`, `version` e IDs internos do D1 ficam de fora por projeção, não por filtro posterior
- estado persistido inválido falha o export inteiro com `409` e mensagem controlada: slug reservado ou malformado, URL inválida, `redirect_type` fora de `301`/`302`, tags fora do contrato, lifecycle inválido (inclusive expiração antes do go-live), destino de expiração sem expiração, grupo inexistente, nome de grupo em forma não canônica (espaços nas pontas, só espaços ou acima de 120 caracteres — nunca normalizado para um valor que o banco não contém), grafo de grupos com ciclo ou pai órfão, A/B inválido, Smart Routing corrompido (nunca convertido em "desativado") e linha híbrida A/B + Smart Routing
- limites do formato centralizados em `src/portability.ts`: 50 grupos, 100 links e 256 KiB medidos em bytes UTF-8 após a serialização do documento real. No limite o export passa; acima responde `413` explícito, **nunca** truncando, pulando linha ou devolvendo documento parcial
- leitura consistente sem alegar snapshot único do request: os dois `SELECT` viajam em um único `batch` (com a semântica que o D1 oferece para o batch), mas o export também lê fora desse conjunto (contagem prévia e sondagens de capability), então o gate não promete snapshot isolation do request inteiro — a consistência final vem da validação das referências: grupos são lidos antes dos links e o documento só é emitido quando todo `groupRef`/`parentRef` resolve naquela leitura; uma corrida que criaria referência órfã responde `409` em vez de documento inconsistente
- export é somente leitura e administrativo no **request inteiro**, não só no handler: usa a readiness de schema somente leitura, então nem o middleware cria objetos (a projeção `boltlink_metric_fence` que a readiness de bootstrap instala nas demais rotas `/api` não é criada ao pedir o export, inclusive no primeiro request em handle frio), zero escritas no D1, mesmo `requireAdmin`/Access/chave de API e o mesmo rate limit das outras rotas `/api`, `Content-Disposition: attachment` com nome constante (`boltlink-export.json`) e `Cache-Control: no-store`
- Admin ganha a ação `Exportar configuração`, que baixa o JSON por blob autenticado com o nome vindo de `Content-Disposition` (fallback constante) e mostra recusas pelo status do painel; nenhum dado persistido vai para HTML sink
- importação portátil em `src/portability-import.ts`: `POST /api/import/preview` (somente leitura) e `POST /api/import/apply` consomem exatamente o documento do export, com validação estrita por campo (chave desconhecida e tipo errado respondem `400`, nada é coercido: `"302"` não vira `302`) e erro estruturado limitado a 20 entradas com o caminho do campo (`links[3].targetUrl`)
- import é **tudo ou nada**: o documento inteiro vai em um único `batch` do D1 — grupos em ordem topológica (pai antes de filho) e depois os links, na ordem do documento — e uma falha em qualquer statement desfaz o import completo, sem partial import
- vínculo `ref` → id local resolvido dentro da transação, sem migration, sem tabela temporária e sem nome/path como chave: cada grupo é inserido com id derivado pela própria instrução a partir do piso `max(MAX(id), sqlite_sequence.seq)` e o pai é endereçado pela distância constante do plano; a sequência `AUTOINCREMENT` continua correta depois do bloco importado
- alocação de id nunca reutiliza um id que a tabela `AUTOINCREMENT` do destino já gastou: apagar os grupos mais novos derruba `MAX(id)` mas não a marca d'água da sequência, e `links.group_id` não tem foreign key aplicada pelo D1 — usar `MAX(id) + 1` faria um link antigo passar a apontar em silêncio para um grupo importado
- `TARGET_GROUP_REFERENCE_CORRUPT`: destino com link apontando para grupo inexistente bloqueia o import inteiro com `409` no preview e no apply, com zero escritas, sem reparo, sem reparent e sem zerar `group_id` — um grupo importado nunca "cura" o órfão por colisão de id
- corpo em UTF-8 estrito nas duas rotas: byte inválido responde `400` (`INVALID_BODY`) em vez de ser substituído por U+FFFD pelo decodificador padrão, que transformaria um arquivo corrompido em outro documento — ainda válido — com o texto reparado
- falha do batch classificada pela assinatura do erro (`UNIQUE constraint failed: links.slug`), nunca pelo estado lido depois: uma falha alheia (trigger, coluna ausente, banco travado) responde `500` controlado mesmo quando existe slug ocupado no destino, sem vazar SQL, stack ou binds, e a atomicidade continua garantindo zero partial import
- colisão com qualquer slug reservado no destino (ativo, desabilitado ou tombstone) bloqueia o import inteiro com `409` e lista limitada de conflitos; sem overwrite, sem `INSERT OR REPLACE` e sem merge de grupo por nome — o comentário do formato é append-only para grupos e no-overwrite para slugs
- import bloqueia com `409` sem degradar nem auto-migrar: feature realmente usada que o destino não suporta (`TARGET_CAPABILITY_MISSING`, e A/B no estado default **não** conta como uso), árvore acima de `MAX_GROUP_DEPTH` (`GROUP_DEPTH_EXCEEDED`, limite de portabilidade de legado documentado), grafo de grupos de destino corrompido (`DESTINATION_HIERARCHY_CORRUPT`) e `PASSWORD_SESSION_SECRET` ausente com link protegido no documento
- links `passwordProtected: true` exigem nova senha em `replacementPasswords` no apply, hasheada pelo mecanismo atual: sem ela (ou com senha para link não protegido, em formato que não seja string não vazia) nada é escrito; a senha nunca é persistida em claro, devolvida na resposta, registrada em log, colocada na URL ou guardada no storage do navegador
- `POST /api/import/preview` é somente leitura no **request inteiro** (zero `INSERT`/`UPDATE`/`DELETE`, zero DDL e nenhum bootstrap de schema: as duas rotas usam a readiness somente leitura, então não criam `boltlink_metric_fence`), e o preview responde `503` num banco não preparado sem aplicar migration implicitamente
- limites do formato valem nas duas direções: mais de 50 grupos, mais de 100 links ou documento acima de 256 KiB (bytes UTF-8 medidos após a serialização) respondem `413` sem truncar; o mesmo esquema de status do export é mantido (`400` documento malformado, `409` destino/requisito, `413` limites, `503` banco não preparado)
- métricas não são inventadas nem restauradas: links importados nascem com os defaults do destino (`clicks_total = 0`, `metric_epoch`, `ab_generation` conforme o split criado), `has_qrcode`/`version`/timestamps são gerados pelo destino e o tombstone mantém a reserva do slug
- Admin ganha o drawer `Importar configuração` (segundo off-canvas à direita, espelhando o de grupos e mutuamente exclusivo com ele): seleção de arquivo com validação de tamanho, preview com resumo e aviso de que métricas não fazem parte da exportação, lista de conflitos e bloqueios, um campo `type=password`/`autocomplete=new-password` por link protegido e botão de apply habilitado somente com preview válido, zero bloqueios, zero colisões e todas as senhas preenchidas
- identidade de seleção no drawer (`createImportSelection`): arquivo novo, reset, close e reabertura avançam uma geração e derrubam o preview aprovado, cada resposta só pinta o painel enquanto a geração que a pediu for a atual (a requisição anterior ainda é cancelada com `AbortController`, mas cancelamento pode chegar tarde e a geração é a autoridade) e o apply exige preview aprovado para a seleção corrente — a resposta atrasada de um arquivo substituído nunca descreve o que o apply enviaria
- a aprovação termina com a tentativa (`endImportAttempt`): recusa, falha de transporte ou sucesso revogam o preview aprovado (`revokePreview`), limpam o estado da revisão e descartam as senhas, então o apply não fica habilitado nem autorizável depois de um desfecho e o caminho de volta é sempre um preview novo
- mapa de senhas construído sem protótipo (`Object.create(null)`): `__proto__` é slug válido pela política atual e `passwords["__proto__"] = …` em um objeto comum escreveria um protótipo em vez de uma propriedade, fazendo o `JSON.stringify` perder a senha; `constructor` e `prototype` seguem o mesmo caminho, sem poluir protótipo nenhum
- nenhuma senha digitada sobrevive à tentativa: toda falha terminal de apply (status ou rede), o sucesso, o close, o arquivo novo e o reset esvaziam os campos e removem os nós, e o apply volta a exigir preview e digitação novas
- fluxo do drawer é honesto em sucesso e em falha: apply bloqueado contra duplo submit, "Configuração importada com sucesso" com grupos e links criados seguido de recarga de lista/grupos/filtros sem reload, "Nenhuma alteração foi aplicada" em recusa **reconhecida** (garantido pela transação), estado final declarado desconhecido em falha de rede **e em qualquer resposta que não seja um envelope do contrato** — o veredito vem do status **mais** um corpo que seja o contrato, e não basta o JSON parsear: `{}`, `{"ok": true}` sem as contagens e `{"ok": false}` sem envelope são tratados como desconhecido, então um `200` com corpo truncado ou um objeto estranho nunca vira "nada foi aplicado" (a importação pode ter sido gravada) —, arquivo novo descarta preview/senhas/erros e nenhum valor do arquivo passa por `innerHTML` — tudo entra por `textContent`
- `test/portability-import.spec.ts` e `test/portability-import-admin.spec.ts` cobrem preview sem escrita (com handle instrumentado), envelope e limites, coerção recusada, corpo não-UTF-8, refs/ciclos/profundidade, colisão e tombstone, capabilities por nível de migration, banco frio (`503`), atomicidade com corrida injetada entre a checagem e o batch, não-reúso de id gasto pela sequência `AUTOINCREMENT`, órfão de grupo no destino, classificação causal da falha do batch (colisão real versus erro alheio, com trigger e com driver), round-trip export→import→export, round-trip protegido com senha nova (incluindo slug `__proto__`), hot path servindo a configuração importada, boundary de auth e o contrato de acessibilidade dos dois drawers
- `test/portability-export.spec.ts` e `test/portability-export-admin.spec.ts` cobrem formato, refs, tombstone, senha sentinela, exclusão de métricas e IDs internos, corrupção, limites, bytes UTF-8, determinismo, auth, headers, zero write, corrida entre leituras e hot path congelado
- diálogo de QR Code no painel com preview e downloads em PNG e SVG (Unreleased / Fase 5, Gates 5.4 e 5.4.1): o Worker continua devolvendo o SVG sob demanda (`Cache-Control: no-store`) e o navegador rasteriza o PNG em 512×512; o SVG baixado é byte a byte o corpo do endpoint, e o QR codifica apenas a short URL pública — nunca o destination, a Variant B, um alvo de Smart Routing ou segredo
- `has_qrcode` continua memória operacional, não analytics: a escrita pelo `POST /api/links/:slug/qrcode` acontece quando o operador baixa o QR (PNG ou SVG) — preview e copiar link não escrevem nada —, o painel só anuncia "QR Ativo" quando a API confirma a escrita, e uma confirmação atrasada não vaza para o diálogo de outro link; a geração é cold path administrativo que não conta clique e nenhuma imagem é persistida
- `test/qrcode.spec.ts` e `test/qrcode-admin.spec.ts` cobrem os endpoints publicados (slug reservado `400`, inexistente/tombstone `404`), o contrato do `POST`, o preview por data URL, os downloads PNG/SVG, a revogação dos object URLs e a identidade do diálogo por slug/generation

### Removido

- `cleanupEmptyGroup`: o runtime deixou de apagar grupos automaticamente (Unreleased / Fase 5). O comportamento antigo removia um grupo vazio quando o último link ativo saía dele, ignorando subgrupos e links desabilitados; agora mover ou excluir o último link preserva o grupo e a remoção é sempre explícita (`DELETE /api/groups/:id`)
- o campo de criação rápida de grupo no formulário de link: criar grupo (com grupo pai opcional) passou para o painel `Grupos`, mantendo o formulário de link apenas com a associação `Grupo`

### Corrigido

- escrita de métrica atrasada não contamina mais a nova geração A/B nem ressuscita um reset manual
- `PATCH`/`PUT` concorrentes retornam `409` em vez de persistir configuração A/B inválida
- runtime não cria nenhuma coluna (A/B ou de features) e não executa `schema.sql`: banco vazio falha fechado com `503 Database schema is not initialized` até as migrations serem aplicadas, então a cadeia `0000`→`0004` aplica sem `duplicate column` (`BL-AB-003-R1`)
- A/B nunca emite `301` cacheável: sempre `302` com `Cache-Control: no-store`, e a API rejeita A/B + `301`
- RNG do split só é executado quando existe A/B ativo e acesso humano elegível
- runtime não executa mais rebuild destrutivo de tabela: colunas legadas extras (`last_clicked_at`, `notes`, `stats`) são ignoradas e permanecem até uma migration explícita, eliminando a corrida entre rebuild e migration (`BL-AB-015`)
- capability negativa não fica cacheada: um isolate iniciado antes da `0004` passa a usar fencing assim que a migration é aplicada
- results de um teste encerrado continuam visíveis no admin sem associar alocação/Variant B atuais aos counters históricos; configuração futura aparece separada como "Próximo teste"
- clique capturado antes da migration `0004` usa fence execution-time (`boltlink_metric_fence`): não ressuscita reset mesmo quando a migration e o reset chegam depois do SQL legado já ter sido escolhido, e um bootstrap iniciado pré-`0004` não consegue rebaixar a view real promovida pela migration (promoção `SHIM → REAL` é exclusiva da migration; runtime só faz `CREATE VIEW IF NOT EXISTS`)
- `GET /api/capabilities` informa `abTesting` ao Admin; antes da `0004` o painel oculta A/B e mantém create/edit normais sem campos A/B
- README deixa explícito que migrations são autoritativas e que o runtime não cria colunas A/B
- scripts `dev-validate-phase-*` usam `--testNamePattern` (Vitest 4) com `--passWithNoTests`
- fluxo local deixa explícito que `npm run dev-init` prepara apenas o SQLite auxiliar `.dev-env/db.sqlite3`; o Worker usa o D1 local do Wrangler, preparado por `npm run dev-prepare` antes de `npm run dev`; mensagem final do `dev-init` e fluxos one-click/remotos sincronizados (provisionar/deploy inicial não substitui migrations remotas) (`BL-AB-016`)
- o redirect público deixou de depender de cache de capability por isolate: a linha principal é lida com projeção schema-neutral (`SELECT *`) e a presença da coluna é observada a cada request, então um isolate aquecido antes da `0005` converge sozinho no próximo request público — sem `PRAGMA` por clique e sem depender de afinidade com um request Admin/API (`BL-SR-GLOBAL-001`)
- configuração Smart Routing persistida e ilegível deixou de ser confundida com "desativada": a API expõe `smartRoutingStatus` (`disabled`/`valid`/`invalid`) sem revelar o valor cru, o Admin mantém o estado como corrupção preservada, edições não relacionadas não enviam o campo e só a ação explícita de limpeza grava `NULL`; a validação de híbrido passou a rejeitar apenas híbrido novo ou reescrito, preservando o fail-safe de linhas já híbridas (`BL-SR-GLOBAL-002`)
- documentação separada em três bases explícitas — tag publicada `v2.2.1` (até `0003`), baseline local da Fase 2 (`0004`) e working tree da Fase 3 (`0005`) — e o scanner de documentação passou a proteger também o limite publicado vs. artefatos da Fase 2 (`0004`, A/B, `ab_enabled`, `ab_target_url`, `dev-prepare`) (`BL-SR-GLOBAL-003`)
- exportação portátil da Fase 5 (Gate 5.2, rodada de correção 1, ainda Unreleased): nome de grupo persistido em forma não canônica passou a recusar o export inteiro com `409` em vez de viajar como está — a validação é a paridade exata com o contrato de escrita (`trim`, não vazio, teto de 120 caracteres), reutilizada de `src/group-hierarchy.ts` em vez de duplicada, sem normalizar o valor no export
- `GET /api/export` passou a ser somente leitura no **request inteiro**: a readiness de schema foi separada em validação somente leitura (`sqlite_master`/`PRAGMA`) e bootstrap que cria objetos, e a rota usa apenas a primeira, então o primeiro request em handle frio (inclusive contra schema `0003`) não executa DDL nem cria `boltlink_metric_fence`; as demais rotas `/api` continuam com o bootstrap e o hot path do redirect não mudou
- testes do export passaram a fixar o shape exato do documento por nível de migration (`0003`–`0006`) e para todas as entradas, com asserção explícita de `Object.keys(...).sort()`, para que propriedade extra ou ID interno adicionado ao documento falhe a suíte em vez de vazar silenciosamente

### Segurança e comportamento

- lifecycle do `POST /:slug` agora valida agendamento e expiração antes de decidir se um link não possui senha
- rotas fixas `version` e `privacidade` passam a fazer parte da fonte central de slugs reservados
- filtros de métricas classificam User-Agents reconhecidos antes de aceitar `Sec-Fetch-Mode: navigate`; o redirect continua aberto para previews e crawlers
- links protegidos só podem ser criados ou receber senha quando `PASSWORD_SESSION_SECRET` está configurado; `API_KEY` não é fallback
- tipos inválidos no campo `password` passam a responder HTTP 400 sem qualquer mutação; somente string não vazia adiciona senha e somente `null` remove
- filtros de métricas reconhecem `Purpose`/`Sec-Purpose`/`X-Purpose` tokenizados, incluindo valores compostos como `prefetch;prerender`
- CI usa Node 22, compatível com o lockfile atual

### Operação

- removida injeção de desenvolvimento localhost do asset público do admin
- rótulo do contador do admin agora informa que exibe links ativos retornados pela API
- documentação de capacidade Free, política de cliques, segredo de sessão e referrer foi sincronizada

## [2.2.1] - 2026-06-12

### Alterado
- Side-stripe removido dos headings em `public/privacidade.html` (substituído por underline `::after` consistente com admin).
- Tokens CSS de `privacidade.html` alinhados com `admin.css` (radius, accent-soft, blur, motion).
- Empty state do painel reescrito para texto neutro (funciona em desktop e mobile).
- Contador renomeado de "Links criados" para "Total de links".
- Accordion do formulário agora permite apenas uma seção aberta por vez (reduz carga cognitiva).
- Tokens duplicados nos templates server-side (`renderHomePage`, `renderPasswordGate`) sincronizados com `admin.css`/DESIGN.md (radius 12px, cubic-bezier motion, `--font`, blur 24px, tokens faltantes adicionados).
- Raw motion (`150ms ease`, `200ms ease`) substituído por `var(--motion-fast)`/`var(--motion-medium)` nos templates do Worker.
- Touch targets em mobile ajustados para 44px (WCAG 2.5.5) nos botões compactos e dropdown trigger.
- Contraste de placeholder melhorado (`#52525b` → `#71717a`) para atingir ~4.5:1.
- `text-wrap: pretty` adicionado a parágrafos para reduzir órfãs tipográficas.

### Adicionado
- Atalhos de teclado no painel: `/` foca busca, `Ctrl+Enter` submete formulário, `Esc` cancela edição/fecha dropdowns.
- Botão `×` para limpar busca rapidamente.
- `text-wrap: balance` no heading principal.
- `:focus-visible` no link da topbar da página de privacidade.
- `prefers-reduced-motion` cobre `transform` na página de privacidade.
- Breakpoints mobile (`max-width: 480px`) nos templates `renderHomePage()` e `renderPasswordGate()`.

## [2.2.0] - 2026-05-29

### Adicionado
- Redesign visual premium (dark tech aesthetic) utilizando custom properties, glassmorphism e animações suaves.
- Menu dropdown interativo (`<details>`) no painel administrativo mobile para agrupar ações secundárias de forma limpa.
- Omitida a variável `passwordSessionFallbackSecret`. O sistema agora segue uma arquitetura fail-secure explícita e lançará um erro se o recurso de senha for ativado sem a correta configuração do segredo estático.

### Alterado
- Melhoria de Segurança: Mitigação de timing attacks em `verifyPassword` usando `constantTimeEqual` ao invés de comparação em tempo variável.
- Otimização do design responsivo com reorganização de tabelas e botões no admin UI, prevenindo overflow de texto em telas médias.
- Remoção de botão "Acessar Painel" público da página inicial (home) em prol de uma interface mais fluida para usuários finais.
- Refino da paleta de cores globais com azul (#00A1F5) de maior contraste e estética premium.

## [2.1.0] - 2026-05-22
- Added: public/admin.css extracted from inline <style> block for independent caching
- Added: public/admin.js extracted from inline <script> block for maintainability
- Changed: admin.html loads CSS and JS as external files via <link> and <script src>
- Added: admin.css and admin.js to reserved slug set

## [2.0.1] - 2026-05-21

### Adicionado

- endpoint administrativo para zerar `clicks_total` de um link ativo
- botão no painel para zerar estatísticas agregadas por link
- guia `docs/free-plan-traffic.md` com medidas gratuitas para reduzir tráfego indesejado

### Alterado

- redirects públicos rejeitam slugs fora do padrão antes da leitura D1
- redirects públicos aplicam rate limit em memória antes da leitura D1 para reduzir rajadas no banco
- documentação explica que exclusão de link é lógica e não limpa eventos porque eventos não existem na v2.0.0

## [2.0.0] - 2026-05-17

### Breaking

- removida a tabela `stats`
- removido `IP_HASH_SECRET`
- removido `last_clicked_at`
- removido `notes`
- removido o endpoint `/api/links/:slug/stats`
- removido o endpoint `/api/maintenance/purge-stats`

### Alterado

- cliques passam a ser contados apenas em `links.clicks_total`
- redirects públicos passam a usar `Referrer-Policy: strict-origin`
- admin e API continuam `no-referrer`
- o bootstrap do Worker agora reconcilia schema legado para o modelo LGPD
- `observability.enabled` passa a `false` no template público
- `upload_source_maps` passa a `false` no template público

### Banco

- `schema.sql` consolidado sem `stats`, `last_clicked_at` e `notes`
- nova migration `0003_lgpd_minimization.sql`

### Documentação

- fluxos Wrangler, AI-start e one-click reescritos para a nova baseline
- guias de upgrade e privacidade atualizados

---

Release atual publicada: 3.1.1 · Tag: v3.1.1 · Release anterior: 3.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
