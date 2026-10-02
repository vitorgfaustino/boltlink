# Lixeira e recuperação — 3.1.0

A versão **3.1.0 está publicada** (tag **v3.1.0**) e é a release atual do repositório. A release anterior **v3.0.0** permanece congelada. Cada instalação executa sua própria atualização; publicar a release não atualiza instalações por si só.

## Navegação do Admin — Gate 8.6

A página principal concentra cabeçalho, Criar link e Links ativos. As ferramentas **Gerenciar grupos**, **Lixeira** e **Importar / Exportar** ficam em offcanvas, com overlay, botão fechar, ESC, focus trap, retorno ao botão de abertura e bloqueio de interação/scroll no fundo. Apenas uma superfície modal pode ficar aberta por vez. No desktop, a largura é limitada a 30rem; em telas menores, usa toda a largura disponível.

**Importar / Exportar** abre um drawer único: exportação primeiro, com status junto ao botão, e importação abaixo, com seleção, preview, avisos, blockers, senhas e apply existentes. O export continua contendo somente configuração ativa; a Lixeira permanece fora do documento.

Até 900px, **Criar link** é uma seção expansível no fluxo da página. Começa recolhida em cada abertura/reload, sem persistência de abertura; salvar ou cancelar recolhe novamente. Editar revela o formulário. Acima desse breakpoint, o formulário permanece visível em uma coluna ao lado de Links ativos. Gerador de UTMs, Opções avançadas, Teste A/B e Smart Routing continuam disponíveis conforme as capabilities da instalação.

Seções do formulário e itens de links usam espaçamento e divisores, reduzindo cards e bordas aninhadas. O tema escuro, azul e identidade BoltLink permanecem. A mudança é de apresentação e navegação: nenhuma API, regra de retenção, formato de portabilidade, schema ou migration nova.

## Ciclo do link

`DELETE /api/links/:slug` move o link para a Lixeira usando `links.disabled_at`. A lista ativa continua filtrando `disabled_at IS NULL`; o redirect público continua respondendo `404` para itens na Lixeira. A configuração, os hashes de senha, as métricas, o QR, o grupo e o lifecycle ficam armazenados. Enquanto a linha existir, o slug está reservado. Tentar criá-lo novamente responde `409` com `SLUG_IN_TRASH` e orientação para restaurar ou excluir definitivamente.

No Admin, abra **Lixeira** na área de ações de Links ativos. O conteúdo abre somente em um offcanvas lateral, com scroll interno; não aparece abaixo da lista ativa. O contador mostra o total de links excluídos; a busca aceita slug, destino ou tags. A lista tem páginas de até 100 itens, com Anterior/Próxima. Cada item mostra slug, destino, exclusão em UTC e grupo quando disponível.

**Restaurar** revalida a configuração persistida segundo as regras atuais de URL, slug, tags, lifecycle, A/B, Smart Routing e grupos. Estado inválido responde `409`, sem reparar nem reativar o registro. Links protegidos exigem o `PASSWORD_SESSION_SECRET` já usado pelo produto. A gravação confere identidade, versão, configuração e grafo de grupos observado; se algo mudar durante a operação, responde `409` para recarregar e tentar de novo. Restauração limpa `disabled_at`, renova `updated_at` e incrementa `version`; não reseta dados. Um link expirado permanece expirado depois de restaurado e segue seu lifecycle normal.

**Excluir definitivamente** pede confirmação, remove fisicamente apenas uma linha que esteja na Lixeira e libera o slug imediatamente. A operação não pode ser desfeita pelo painel. A reutilização cria uma nova linha, com novos identificadores e defaults; não recupera dados do link apagado. QR codes e materiais antigos que contêm aquele slug passam a apontar para o novo link quando ele for recriado. O operador decide se a reutilização é apropriada.

Excluir definitivamente ou limpar o último link de um grupo não apaga o grupo. A exclusão de grupos continua explícita e condicionada à ausência de qualquer link ou subgrupo.

## Requests e limite administrativo

A exclusão definitiva remove o item do estado local e faz apenas `DELETE` + um `GET /api/trash/purge-preview` para atualizar os contadores; não recarrega links ativos nem grupos. As páginas podem ficar com menos itens durante a sequência. Quando existe página seguinte, Próxima passa a ser Atualizar página: recompõe a página corrente sob demanda antes de avançar, evitando pular itens deslocados pelo offset após remoção. Anterior ou uma nova busca também consultam a listagem sob demanda. Restore remove o item local, consulta o resumo e recarrega somente links ativos. Purge volta à página 1 e consulta somente listagem e resumo da Lixeira.

A API administrativa compartilha 120 requests por IP por janela de 60 segundos em `/api` e `/api/*`. O Admin atual usa leituras de Groups, Trash, Portability e Capabilities; 30/min era insuficiente para esse fluxo. O limite continua protegendo contra rajadas locais e não substitui autenticação ou Cloudflare Access, nem é uma proteção forte contra abuso distribuído: o store é in-memory e local ao isolate. O redirect público permanece com budget independente de 120/min; tentativas de senha têm outro limiter.

HTTP 429 preserva `{ "error": "Rate limit exceeded" }` e inclui `Retry-After` com os segundos restantes até a próxima janela, arredondados para cima. O Admin traduz esse tempo para pt-BR; sem header válido, usa a mensagem de espera existente, sem timer ou bloqueio permanente. Referência de isolamento de memória: [Cloudflare Workers](https://developers.cloudflare.com/workers/reference/how-workers-works/).

## Retenção e limpeza manual

`TRASH_RETENTION_DAYS = 90` em `src/trash.ts` é a única autoridade de retenção. Elegibilidade: `disabled_at <= agora UTC - 90 dias`, incluindo o instante exato do cutoff. Ativos nunca são elegíveis. Datas legadas com offset são comparadas como instantes; valores numéricos, datas sem fuso, datas impossíveis ou timestamps que o SQLite não consegue interpretar permanecem na Lixeira para inspeção e exclusão individual.

Não há Cron, limpeza automática, variável de ambiente nem reserva permanente de slugs nesta versão. Retenção significa **elegibilidade**, não prazo máximo de armazenamento: um item pode permanecer após 90 dias até o operador agir.

**Limpar itens antigos** primeiro consulta o preview, que informa total na Lixeira, elegíveis, cutoff UTC e retenção. O Admin exibe o número e pede confirmação explícita. Cancelar não escreve. Confirmar executa um único `DELETE` condicional, com cutoff recalculado no servidor; o preview não autoriza uma lista congelada nem é fonte de verdade. A quantidade efetivamente removida é a retornada pela API. Um item restaurado antes do DELETE permanece ativo; um item que alcance 90 dias entre preview e confirmação pode ser incluído. Falha de rede exige atualizar e obter outro preview antes de repetir.

## API administrativa

Todas as rotas usam a autenticação Access/API existente, o rate limiter administrativo e `Cache-Control: no-store`. Não existe rota pública nova, autenticação paralela ou delete por GET. A readiness das rotas da Lixeira apenas inspeciona schema; banco não preparado responde `503`, sem DDL implícito.

| Operação | Contrato |
| --- | --- |
| `GET /api/trash?search=...&page=1` | Apenas excluídos; `{ links, total, search, page, hasMore }`. Página começa em 1. Sem `password_hash`, segredo ou Smart Routing cru inválido. |
| `POST /api/trash/:slug/restore` | Valida e restaura; `{ ok, slug, version }`. Ativo/inexistente: `404`; configuração inválida/concorrência: `409`. |
| `DELETE /api/trash/:slug` | DELETE físico condicionado a `disabled_at IS NOT NULL`; `{ ok, slug, slugAvailable: true }`. Ativo/inexistente: `404`. |
| `GET /api/trash/purge-preview` | Request inteiro somente leitura; `{ total, eligible, cutoff, retentionDays }`. |
| `POST /api/trash/purge` | Um DELETE condicionado ao cutoff novo; `{ ok, removed, cutoff, retentionDays }`. |

## Portabilidade ativa e compatibilidade

**Exportação de configuração contém apenas links ativos; a Lixeira não faz parte do documento portátil.** `GET /api/export` seleciona e conta `disabled_at IS NULL`: tombstones não entram nos limites de links/bytes e tombstone inválido não bloqueia export. Grupos continuam sendo configuração explícita do operador, inclusive grupos vazios; todos os grupos e os links ativos continuam sujeitos às invariantes e aos limites existentes. Link ativo inválido continua recusando o documento inteiro com `409`; limites continuam `413`, sem truncar.

O erro de export inclui `code` aditivo, além de `error`. O Admin traduz códigos conhecidos para orientação segura e pode identificar um slug válido, usando texto, sem apresentar SQL, stack ou valores crus desconhecidos.

`format: "boltlink-portability"` e `schemaVersion: 1` permanecem. Não houve incompatibilidade estrutural: exports atuais levam `disabled: false` e o import continua aceitando documentos v1 antigos com `disabled: true`, criando esses links na Lixeira. Tais links não reaparecem no próximo export ativo. Colisões com qualquer linha existente continuam bloqueando o import; após remoção física, o slug pode ser importado ou criado de novo.

O documento portátil nunca substitui backup D1, especialmente para recuperar Lixeira, hashes, métricas e metadados operacionais.

## Schema e verificação local

**MIGRATION REQUIRED: NO. MIGRATION_0007 = NOT REQUIRED.** O schema existente já representa o ciclo inteiro com `disabled_at`; migrations continuam **0000–0006** e `schema.sql` permanece baseline da `0000`. Não há novo binding, secret, configuração Cloudflare ou mudança no hot path público.

Testes locais de desenvolvimento:

```bash
npm ci
npm test
npx tsc --noEmit
node --check public/trash-ui.js
node --check public/admin.js
node --check public/portability-ui.js
git diff --check
```

O único erro TypeScript previamente aceito é `TS7016` de `qrcode`. O cenário legado de destino sem ponto no hostname está coberto em `test/trash.spec.ts`, junto a retenção inclusiva, zero-write de preview, reutilização de slug e corridas de restore/purge. A validação local não implanta Worker nem aplica migrations remotas.
