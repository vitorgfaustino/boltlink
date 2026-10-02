# Phase 8 — relatório de implementação local

## 1. BASELINE

- Branch: `main`.
- Na época da abertura deste ciclo, a baseline verificada de HEAD / `origin/main` / tag `v3.0.0` foi `e515344a7c42699905523e8942e9ac0ac9038548`.
- Worktree e index: limpos antes da edição; sem mudanças inesperadas.
- Versão: `3.0.0`.
- `npm ci`, `npm ls --depth=0`, `git diff --check`: concluídos.
- `npm test`: **940/940**, **29 arquivos**.
- Primeiro teste no sandbox falhou antes das asserções por `listen EPERM 127.0.0.1`; o comando idêntico passou com loopback autorizado.
- Warnings existentes: allow-scripts para esbuild, fsevents, sharp e workerd; não foram introduzidas dependências.
- `npx tsc --noEmit`: somente `TS7016` de `qrcode`, dívida técnica aceita antes deste ciclo.

## 2. NEW VERSION

- Versão de desenvolvimento: **3.1.0**, consistente em package.json e nas duas identidades do produto no lockfile.
- Branch local: `dev/3.1.0-trash-recovery`.
- Última release publicada: **v3.0.0**, congelada e sem mudança de refs.
- Referências históricas de 3.0.0 e versões de dependências preservadas.

## 3. ARCHITECTURE

- Soft delete existente preservado: `DELETE /api/links/:slug` preenche `disabled_at`.
- Lixeira: somente `disabled_at IS NOT NULL`; ativos e público continuam excluindo tombstones.
- Restore: reusa a validação persistida de portabilidade e a política runtime de URL/slug; confere identidade, versão, campos validados e grafo de grupos no UPDATE. Limpa disabled_at, renova updated_at, incrementa version. Preserva todos os demais dados.
- Hard delete: DELETE físico condicionado a tombstone; nunca apaga ativo.
- Retenção: constante única de 90 dias; cutoff UTC inclusivo, ISO com fuso e data civil válida. Valores ambíguos ficam para inspeção/exclusão individual.
- Purge: preview somente leitura no request inteiro; aplicação com um DELETE condicional e cutoff recalculado. Sem Cron.
- Slug reuse: permitido após remoção física. Identidade e defaults novos; materiais antigos com o slug passam a seguir o novo link.
- Grupos permanecem sob controle explícito; remover o último tombstone não apaga o grupo.

## 4. MIGRATION

**MIGRATION REQUIRED: NO. MIGRATION_0007 = NOT REQUIRED.**

`disabled_at` já representa o ciclo inteiro. Migrations finais: **0000–0006**, sem alterações. Schema, bindings e configuração pública preservados. A cadeia completa foi aplicada com Wrangler **apenas em D1 temporário local em /private/tmp**, para inspeção do Admin.

## 5. API

Adicionadas:

- `GET /api/trash?search=...&page=1`: busca e paginação de até 100 itens, total e hasMore; sem hash/secret.
- `POST /api/trash/:slug/restore`: validação e recuperação com proteção de concorrência.
- `DELETE /api/trash/:slug`: exclusão definitiva somente de tombstone.
- `GET /api/trash/purge-preview`: total, elegíveis, cutoff e retentionDays; zero escrita/DDL.
- `POST /api/trash/purge`: removed, cutoff e retentionDays; elegibilidade decidida no DELETE.

Alteradas:

- `POST /api/links`: colisão com Lixeira responde `409 SLUG_IN_TRASH`, incluindo colisão UNIQUE ocorrida depois da leitura inicial.
- `PATCH`/`PUT /api/links/:slug`: URL enviada vazia é recusada, sem confundir ausência com vazio.
- `GET /api/export`: seleciona/conta apenas ativos e adiciona `code` aos erros controlados.

Todas as novas rotas usam o boundary administrativo, autenticação e limiter existentes. Banco não preparado: `503`. Redirect público e import não tiveram implementação funcional alterada.

## 6. ADMIN

Lixeira expansível com contador, busca, paginação, destino, data UTC e grupo. Restore validado; exclusão definitiva exige confirmação explícita. Limpeza mostra preview e confirmação separada, com cancelar e estado de rede/erro. Conteúdo persistido é inserido como texto; slugs são codificados nas URLs. Estados de loading bloqueiam ações duplicadas e respostas antigas de listagem são descartadas. Importação legada atualiza o contador da Lixeira.

Inspeção real no Worker local: lista/contador, restore inválido `409`, restore válido `200` com atualização dos ativos, preview de limpeza e apresentação móvel. Viewport móvel: largura do documento igual à viewport, sem overflow horizontal. Purge/hard delete destrutivos foram verificados por testes automatizados sobre fixtures, sem executar limpeza de dados de instalação pelo navegador.

## 7. EXPORT

- Trash included: **NO**.
- Tombstones inválidos não bloqueiam export nem consomem limites de links/bytes.
- Ativo inválido: **409 fail-closed**, sem documento parcial; grupos continuam integralmente validados.
- Legacy compatibility: formato v1 mantido, import aceita disabled:true; esses itens entram na Lixeira e ficam fora de exportações posteriores.
- SchemaVersion 2: **NOT REQUIRED**, sem incompatibilidade estrutural.
- Mensagem no Admin identifica código/slug seguros e orienta correção; SQL, stack e texto cru desconhecido não são ecoados.

## 8. URL VALIDATION

A autoridade permanece `normalizeTargetUrl`. Regressões por create, PATCH, PUT e import preview/apply:

- Recusadas: `https://sem-ponto/`, `http://localhost/`, FTP, javascript, URL relativa/sem esquema, vazio e URL malformada.
- Aceitas: HTTPS com domínio, subdomínio/caminho e HTTP com domínio.
- Update inválido não muda a linha.

## 9. LEGACY TOMBSTONE TEST

Cenário exato `SbEgchM`, destino `https://s0f90s9f0s/`, disabled_at `2026-05-07T12:14:40.969Z`: **PASSED**. Não aparece nos ativos; aparece na Lixeira; export passa; restore recusa `INVALID_TARGET_URL`; hard delete funciona; mesmo slug pode ser criado novamente.

## 10. TESTS

- Full suite final, após npm ci com lockfile correto: **999/999**, **31 arquivos**, 59 testes líquidos adicionais.
- Focados Lixeira API/Admin: **57/57**, 2 arquivos. Os ajustes finais de singular/plural também passaram na full suite.
- TypeScript: **somente TS7016 de qrcode**, nenhum erro novo; não alegado como tsc verde.
- Static: node --check nos três JS públicos alterados e git diff --check: **PASSED**.
- Regressões existentes: A/B, Smart Routing, expired redirect, lifecycle, Groups, portability import e QR: **PASSED** na full suite.
- Evidência adversarial: configuração/identidade/grupos alterados entre validação e restore; restore entre preview/DELETE; corte exato de 90 dias; datas numéricas/sem fuso/impossíveis; preview em handle frio sem fence; banco não preparado; autenticação antes do D1; paginação acima de 100; erro de rede/cancelamento/XSS no controlador real da UI.

## 11. FILES CHANGED

- `AGENTS.md`
- `AI-START.md`
- `CHANGELOG.md`
- `README.md`
- `RELEASE_NOTES.md`
- `docs/ai-accepted-requests.md`
- `docs/ai-guided-operations.md`
- `docs/architecture.md`
- `docs/cloudflare-setup.md`
- `docs/phase8-local-validation.md`
- `docs/privacy.md`
- `docs/retention.md`
- `docs/trash-recovery.md`
- `docs/upgrading.md`
- `package-lock.json`
- `package.json`
- `public/admin.css`
- `public/admin.html`
- `public/admin.js`
- `public/portability-ui.js`
- `public/trash-ui.js`
- `src/index.ts`
- `src/portability.ts`
- `src/trash.ts`
- `test/index.spec.ts`
- `test/portability-export-admin.spec.ts`
- `test/portability-export.spec.ts`
- `test/portability-import.spec.ts`
- `test/trash-admin.spec.ts`
- `test/trash.spec.ts`
- `vitest.config.mts`

## 12. LOCAL COMMITS

Os Gates 8.1–8.5 foram integrados em um único commit local após validação do conjunto, com assunto `feat: add 3.1.0 trash recovery`. O SHA final é informado na entrega e pode ser consultado em `git log -1` na branch local. Nenhum push.

## 13. REMOTE OPERATIONS

| Operação | Quantidade |
| --- | --- |
| Push | 0 |
| Deploy | 0 |
| Escritas D1 remoto | 0 |
| Migrations remotas | 0 |
| Tag | 0 |
| GitHub Release | 0 |

Nenhuma alteração Cloudflare. As escritas de teste e migrations de preview foram exclusivamente locais. `main`, `origin/main` e `v3.0.0` permanecem no FINAL_SHA da baseline. Estado GitHub/Cloudflare remoto não foi consultado nem alterado neste ciclo.

## 14. FINDINGS

P0/P1/P2/P3 abertos encontrados nesta implementação: **0/0/0/0**. Isto registra revisão local e evidência de testes; não representa uma auditoria independente de release.

Finding concreto fechado: **BL-80-01 (P2)** — PATCH/PUT tratavam URL vazia como campo ausente. Corrigido com presença explícita e regressão que exige 400 e linha inalterada.

**TECH_DEBT:** TS7016 do módulo qrcode, preexistente e aceito. Avisos de install scripts preexistentes. Nenhum novo erro TypeScript.

## 15. STATUS

**BOLTLINK v3.1.0 DEVELOPMENT CYCLE — TRASH, RECOVERY AND DATA HYGIENE IMPLEMENTED LOCALLY — READY FOR REVIEW**

Publicação e operação remota não fazem parte desta entrega.
