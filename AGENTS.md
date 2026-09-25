# AGENTS.md

Este arquivo define regras para agentes de IA e assistentes automatizados que trabalhem neste repositório.

## Escopo do projeto

Aplicação de gerenciamento e redirecionamento de links baseada em Cloudflare Workers, com:

- redirect público por slug
- painel administrativo estático em `public/admin.html`
- CRUD de links em D1
- contagem agregada em `links.clicks_total`
- Split Test A/B stateless (**Phase 2 local**; migration `0004_ab_testing.sql`, ausente da tag publicada)
- Smart Routing stateless por país/dispositivo em `links.smart_routing_rules` (**Unreleased / Fase 3**; migration `0005`, ausente da tag publicada)
- destino opcional para links expirados em `links.expired_redirect_url` (**Unreleased / Fase 4**; migration `0006_expired_redirect.sql`, ausente da tag publicada)
- redirect opcional da raiz (`GET /`) via variável `ROOT_REDIRECT_URL` (**Unreleased / Fase 4**, sem D1)
- hierarquia de grupos em `link_groups.parent_id` (**Unreleased / Fase 5**, sem migration nova: a coluna existe desde a `0002`)
- exportação administrativa da configuração lógica em BoltLink Portability JSON v1 via `GET /api/export` (**Unreleased / Fase 5**, sem migration nova)
- autenticação administrativa via Cloudflare Access

### Cinco bases de código que não podem ser confundidas

| Base | Como identificar | Migrations | Recursos extras |
| --- | --- | --- | --- |
| Publicada | tag `v2.2.1` (`git rev-parse v2.2.1` → `8b3895e`) | `0000` a `0003` | — |
| Fase 2 local | baseline local `23353a1`, não publicado | `0000` a `0004` | Split Test A/B |
| Fase 3 congelada | HEAD `548f179`, Unreleased | `0000` a `0005` | Split Test A/B + Smart Routing |
| Fase 4 congelada | HEAD `cdb9f83`, Unreleased | `0000` a `0006` | Fase 3 + destino de expiração + `ROOT_REDIRECT_URL` |
| Fase 5 working tree | working tree atual sobre `cdb9f83`, Unreleased | `0000` a `0006` (sem migration nova) | Fase 4 + hierarquia de grupos + exportação portátil |

A tag publicada `v2.2.1` **não** é o baseline local da Fase 2: ela não contém a `0004`, o Split Test A/B, a `0005`, o Smart Routing nem o script `npm run dev-prepare`. Também não contém a `0006`, o destino de expiração nem o `ROOT_REDIRECT_URL` da Fase 4, e não contém a hierarquia de grupos segura nem a exportação portátil da Fase 5 (a tabela `link_groups` existe na tag, mas sem a validação de ciclo, de profundidade, de delete e de concorrência, e não existe `GET /api/export`). Documentação e testes devem manter essa separação; `test/smart-routing-admin.spec.ts` tem um scanner que falha quando um artefato aparece no escopo errado.

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
- se schema mudar, crie uma nova migration; `schema.sql` é apenas o baseline da `0000_initial_schema.sql` e não deve receber colunas de features
- o runtime não pode executar `schema.sql`, criar/alterar colunas, aplicar migrations implicitamente nem reconstruir tabelas durante requests; banco não preparado deve falhar fechado com `503`
- desenvolvimento local do Worker exige migrations no D1 do Wrangler; nas bases locais (Fase 2, Fase 3 e Fase 4) isso é `npm run dev-prepare`, que **não existe** no checkout da tag `v2.2.1` (lá use `npm run wrangler -- d1 migrations apply ... --local`); `npm run dev-init` prepara apenas o SQLite auxiliar `.dev-env/db.sqlite3`, que o Worker não usa

## Restrições funcionais que devem ser preservadas

- o slug é imutável após a criação
- o redirect público deve responder antes da contagem
- o admin deve continuar protegido em `/admin`, `/api` e `/api/*`
- IPs não devem ser persistidos
- hashes estáveis de IP não devem existir no produto
- país, `User-Agent`, dispositivo derivado e regra selecionada não devem ser persistidos
- slugs reservados não devem ser reutilizados
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
- linha persistida que o BoltLink não aceitaria hoje falha o export inteiro com `409` controlado (Smart Routing corrompido, destino de expiração sem expiração, URL inválida, slug reservado, nome de grupo em forma não canônica — espaços nas pontas, só espaços ou acima de 120 caracteres, nunca normalizado —, ciclo/pai órfão em grupos, A/B inválido, linha híbrida A/B + Smart), sem skip, reparo ou documento parcial (Fase 5)
- limites do formato são 50 grupos, 100 links e 256 KiB em bytes UTF-8, medidos após a serialização; acima deles a resposta é `413` explícito e o documento nunca é truncado (Fase 5)
- o export é somente leitura no **request inteiro** (zero escritas e zero DDL no D1, inclusive no middleware: usa a readiness de schema somente leitura, então não cria `boltlink_metric_fence`; as demais rotas `/api` mantêm o bootstrap), usa o boundary administrativo de `/api` e responde com `Content-Disposition` de nome constante e `Cache-Control: no-store` (Fase 5)
- não existe import nesta entrega: nenhum `/api/import`, upload, dry-run ou coleta de senha (Fase 5)
- redirects públicos usam `Referrer-Policy: strict-origin`
- admin, API, home, gate de senha e respostas não redirect usam `Referrer-Policy: no-referrer`

## Estrutura recomendada para mudanças

- UI: `public/admin.html`
- API ou auth: `src/index.ts`
- hierarquia de grupos: `src/group-hierarchy.ts` (helpers de grafo e os statements atômicos) e `public/group-hierarchy-ui.js` (helpers de apresentação da árvore)
- exportação portátil: `src/portability.ts` (formato, validação, refs, limites e serializer) e `public/portability-ui.js` (helpers de apresentação do download)
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

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
