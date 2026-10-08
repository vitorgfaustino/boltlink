# Catálogo de Pedidos Aceitos pela IA

## Candidata em desenvolvimento — 3.2.0

Este checkout contém a **3.2.0 candidata local**, ainda não publicada. A release oficial continua **3.1.1**, tag **v3.1.1**, congelada e reconciliada. A candidata reúne filtro recursivo de grupos, caminho hierárquico completo nos badges, edição bidirecional de UTMs e `ROOT_REDIRECT_URL` como Text opcional no setup. O Admin traz Dark Mode refinado, cards compactos e badges semânticas; o README apresenta o produto com screenshots atualizadas em Light, Dark e mobile e uma demonstração animada com dados fictícios. Sem migration nova: **MIGRATION_0007 = NOT REQUIRED**. Veja [Admin UX](admin-ux.md).

## Release publicada — 3.1.1

A **3.1.1 está publicada**, identificada pela tag **v3.1.1**; é a release atual e latest do repositório. A release anterior **v3.1.0** permanece congelada. Este patch operacional aplica migrations D1 pendentes antes do Worker no fluxo padrão de deploy e amplia o guia Cloudflare Access. **MIGRATION_0007 = NOT REQUIRED**; migrations `0000`–`0006`, sem mudança funcional no produto.

Publicar tag/release é **source distribution** e não opera Cloudflare de clientes. Cada instalação executa o próprio `npm run deploy`, que aplica apenas migrations pendentes antes do Worker, e configura seu próprio Access. O guia completo está em [Cloudflare Access](admin-auth.md).

## Recursos preservados desde a 3.1.0

A **3.1.0**, agora release anterior congelada na tag **v3.1.0**, introduziu os recursos abaixo. A tag histórica **v3.0.0** também permanece congelada. A 3.1.0 adiciona Lixeira, restauração validada, exclusão definitiva com reutilização de slug e limpeza administrativa explícita com preview e retenção de 90 dias. Não há Cron automático. O export passa a conter somente links ativos; tombstones ficam fora do documento e dos limites de links, enquanto ativos inválidos continuam fail-closed. Import v1 legado com `disabled: true` continua aceito. **MIGRATION_0007 = NOT REQUIRED**; migrations permanecem `0000`–`0006`.

Contrato completo e operação no Admin: [Lixeira e recuperação](trash-recovery.md). Os procedimentos correntes abaixo seguem a release `3.1.1`; a tag `v3.1.0` conserva o procedimento histórico sem migrations automáticas. Publicar código no Git/GitHub não atualiza instalações: deploy, D1 remoto e Access exigem autorização própria por instalação.


## Regras de uso

- leia `AI-START.md` primeiro
- não invente valores do usuário
- faça uma pergunta por vez quando faltar contexto
- preserve `wrangler.local.jsonc` e overlays do projeto
- não reintroduza coleta detalhada de analytics

## Catálogo

| Chave | Frases aceitas | O que pode automatizar | Onde parar |
| --- | --- | --- | --- |
| `iniciar_projeto` | `Iniciar o Projeto`, `start the project` | setup local, geração do config privado, D1 local, testes | antes da criação final do Access |
| `continuar_configuracao` | `Continuar configuração do projeto`, `retomar setup` | retomar próximo passo e corrigir config | em qualquer checkpoint manual |
| `atualizar_projeto` | `Atualizar o Projeto`, `pull latest version` | atualizar código, dependências, `wrangler.local.jsonc`, migrations e testes | antes de sobrescrever mudanças locais |
| `aplicar_migrations` | `Aplicar migrations`, `rodar migrations` | aplicar migrations local e/ou remoto | se o banco alvo estiver indefinido |
| `gerenciar_lixeira` | `Restaurar link`, `Excluir definitivamente`, `Limpar itens antigos` | inspecionar Lixeira, validar restore, preparar preview | exclusão definitiva/purge exige intenção explícita; mostrar preview antes da limpeza |
| `manter_codigo_local` | `Corrigir código`, `Testar localmente` | corrigir e testar o contrato da release corrente | push, tag e GitHub Release exigem autorização explícita; deploy e D1 remoto têm escopo próprio |
| `auditar_estado_operacional` | `Auditar estado operacional`, `check status` | revisar config, docs e pendências | não há parada especial |
| `publicar_workers_dev` | `Publicar no workers.dev`, `deploy inicial` | deploy padrão e validação pública | antes de Access |
| `publicar_com_deploy_button` | `Deploy to Cloudflare Workers`, `usar o botão de deploy` | revisar template público e preparar pós-deploy | antes da criação final do Access |
| `configurar_dominio_customizado` | `Configurar domínio`, `usar domínio próprio` | revisar `wrangler.local.jsonc`, DNS e checklist | antes do dashboard |
| `preparar_access` | `Preparar Access`, `proteger admin` | orientar Access e validar variáveis | sempre antes da criação final |

## Notas da linha atual

- não existe mais `IP_HASH_SECRET`
- a release atual publicada é a `3.1.1` (tag `v3.1.1`, migrations `0000` a `0006`); a release histórica `v2.2.1` (tag real) termina na `0003_lgpd_minimization.sql`. A `0004` (Split Test A/B, origem Fase 2), a `0005` (Smart Routing, origem Fase 3) e a `0006` + `ROOT_REDIRECT_URL` (origem Fase 4) estão publicadas desde a `3.0.0`
- a hierarquia de grupos da Fase 5 não adiciona migration: ela usa `link_groups.parent_id`, criado pela `0002`. `PATCH /api/groups/:id` com `parentId` exige `expectedParentId`, e `409` (ciclo, profundidade, delete não vazio, pai desatualizado, grafo corrompido) é resultado normal da API, não falha a esconder
- a exportação portátil da Fase 5 (`GET /api/export`, formato `boltlink-portability` v1) também não adiciona migration e é somente leitura no **request inteiro**, não apenas no handler: `409` significa estado persistido que o BoltLink não aceitaria hoje (incluindo nome de grupo em forma não canônica, que nunca é normalizado no export) e `413` significa acima dos limites do formato (50 grupos, 100 links ou 256 KiB); o JSON não substitui backup do D1
- a importação portátil da Fase 5 (`POST /api/import/preview` e `POST /api/import/apply`) consome exatamente o documento do export e também não adiciona migration. O preview é somente leitura no request inteiro (zero escrita, zero DDL, zero bootstrap de schema) e o apply grava o documento em um **único `batch`** — uma transação, portanto tudo ou nada. `400` significa documento malformado (chave desconhecida, tipo errado, referência órfã, ciclo, slug duplicado) ou corpo que não é UTF-8 válido (recusado, nunca reparado com U+FFFD), `409` significa que o destino não aceita o documento como está (colisão de slug com link ativo/desabilitado/tombstone, link do destino apontando para grupo inexistente, feature usada que o banco não suporta, árvore acima de 16 níveis, grafo de destino corrompido, `PASSWORD_SESSION_SECRET` ausente, senha de substituição faltando) e `413` significa acima dos limites do formato. Falha de batch que não seja a `UNIQUE` de `links.slug` responde `500` controlado, nunca `SLUG_COLLISION`. O import nunca sobrescreve slug, nunca faz merge de grupo por nome, nunca reutiliza um id que a sequência `AUTOINCREMENT` do destino já gastou, nunca restaura métricas e exige nova senha para cada link protegido; no drawer, o apply exige preview aprovado para o mesmo arquivo mostrado e toda falha terminal descarta as senhas digitadas
- o QR Code do painel (Fase 5) é o diálogo de preview com download em PNG e SVG sobre os endpoints `GET/POST /api/links/:slug/qrcode` e a coluna `has_qrcode`, que existem desde a base publicada: o QR codifica só a short URL pública, a geração é cold path administrativo que não conta clique, e o `POST` que marca `has_qrcode` acontece quando o operador baixa o QR (PNG ou SVG) — preview e copiar link não escrevem nada; nenhuma imagem é persistida e nada de QR entra no export/import
- o endpoint `/api/links/:slug/stats` não faz mais parte do produto
- o endpoint `/api/maintenance/purge-stats` não faz mais parte do produto
- para pedido de teste local/manual na release atual, a IA deve aplicar migrations no D1 local do Worker com `npm run dev-prepare` (cadeia `0000`–`0006`) antes de `npm run dev`; no checkout histórico da tag `v2.2.1` esse script não existe e o comando é `npm run wrangler -- d1 migrations apply ... --local`
- `npm run dev-init` é opcional em qualquer base e cria apenas o SQLite auxiliar `.dev-env/db.sqlite3`

---

Release atual publicada: 3.1.1 · Tag: v3.1.1 · Release anterior: 3.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
