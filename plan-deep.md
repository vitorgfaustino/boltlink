# BoltLink — Plano de Evolução v1.1.0

## Filosofia do Projeto

BoltLink é um encurtador de links **transparente e mínimo**:

- **Capturar, encaminhar e esquecer** — dados de analytics (referrer, UTMs) pertencem ao destino (Google Analytics, Meta Pixel, etc.), não ao BoltLink
- **Facilitador, não barreira** — o admin ajuda a criar e gerir links, não substitui ferramentas de analytics
- **Arroz com feijão sólido** — simples, confiável, barato de operar, fácil de manter

---

## 1. Diagnóstico Consolidado

### 1.1 Fluxo de clique atual

```
GET /:slug → SELECT links → 302 Redirect → waitUntil(INSERT stats + UPDATE clicks_total)
```

**Problemas:**

- Nenhum filtro de bots, crawlers, prefetch, prerender, previews sociais
- `Referrer-Policy: no-referrer` em **todas** as respostas (inclusive redirects) — o destino NUNCA recebe referrer
- Schema atual de `links` não tem colunas de gestão (expiração, tags, notas, redirect 301/302)

### 1.2 Objetivo final

- **Redirecionamento transparente**: o destino recebe o `Referer` como se o link encurtado não existisse
- **Cliques reais**: apenas navegação humana de browser conta como clique
- **Gestão rica**: QR Code, expiração, tags, grupos, notas, redirect 301/302, duplicação, link preview
- **Custo sob controle**: sem desperdício de operações D1 com tráfego não humano

---

## 2. Análise de Impacto: Limites e Custos Cloudflare

### 2.1 Workers Free Plan

| Recurso | Limite | Risco |
|---------|--------|-------|
| Requests/dia | 100.000 | Médio — campanhas de ads podem estourar |
| CPU time/request | 10 ms | Baixo (redirect ~2ms, analytics ~1ms) |
| Subrequests/request | 50 | Baixo (3 operações D1 por redirect) |
| Memória | 128 MB | Baixo |
| Cron Triggers | 5 | Não serão utilizados neste projeto |

### 2.2 D1 Free Plan

| Recurso | Limite diário gratuito | Custo excedente (Workers Paid) |
|---------|------------------------|--------------------------------|
| Rows read | 5 milhões/dia | $0,001/milhão após 25B/mês |
| Rows written | 100.000/dia | $1,00/milhão após 50M/mês |
| Storage | 5 GB total | $0,75/GB-mês após 5 GB |

### 2.3 Custo D1 por clique (com filtro de bots)

Cada clique legítimo consome ~3 operações D1 (1 read + 2 writes). Com 100.000 cliques/mês:

- Reads: 100k × $0,001/M = **$0,0001**
- Writes: 200k × $1,00/M = **$0,20**

**Irrelevante.** O custo só escala se tráfego não humano não for filtrado.

### 2.4 O perigo real: tráfego não humano sem filtro

| Fonte | Impacto sem filtro |
|-------|---------------------|
| Googlebot (1000 links/dia) | +3.000 ops D1/dia desperdiçadas |
| Preview Facebook/Meta por post | +3 ops D1 por preview (falso clique) |
| WhatsApp/Telegram link preview | +3 ops D1 por mensagem enviada |
| Prefetch/prerender do navegador | +3 ops D1 que o usuário nunca viu |
| Uptime monitor (60s intervalo) | +4.320 ops D1/dia por monitor |
| Curl/wget/bots aleatórios | Variável |

**Estimativa conservadora:** 30-60% do tráfego total pode ser não humano. Filtrar ANTES do banco é a medida de maior impacto para reduzir custo.

### 2.5 Recomendações de mitigação de custo

1. **Filtro de elegibilidade antes do D1** (ver Fase 1) — prioridade máxima
2. **Índices existentes são adequados** — `idx_links_slug` cobre o SELECT principal
3. **Rate limit leve no redirect público** — opcional, 100 req/min por IP para mitigar abuso
4. **Cache de slugs 404** — Cache API para slugs inexistentes sob ataque repetido
5. **Workers Paid ($5/mês)** resolve todos os limites se o projeto crescer

---

## 3. Privacidade

### 3.1 O que NÃO armazenamos (e nunca armazenaremos)

| Dado | Status |
|------|--------|
| IP em texto puro | Não (apenas hash HMAC-SHA-256) |
| User-Agent bruto | Não |
| Referer (completo ou sanitizado) | Não — não armazenamos nada de referrer |
| UTMs | Não — apenas compõem a URL de destino no momento da criação |
| Cookies de rastreamento | Não |
| Headers `Sec-Fetch-*` | Não — uso transiente apenas para filtro de elegibilidade |

### 3.2 O que o destino recebe (não é responsabilidade do BoltLink)

Após o ajuste de `Referrer-Policy` no redirect, o navegador enviará o `Referer` ao destino. O BoltLink **não vê, não armazena e não processa** esse dado — apenas para de bloqueá-lo.

### 3.3 Rotação de IP_HASH_SECRET

Rotacionar o segredo invalida todos os hashes anteriores. O impacto é baixo para um encurtador simples (estatísticas antigas não são correlacionáveis com novas). O segredo fica protegido no cofre do Cloudflare (`wrangler secret put`).

**Decisão:** Manter fixo. O impacto de um vazamento é baixo (hashes HMAC-SHA-256 não são reversíveis sem o segredo, e ele vive no cofre do Cloudflare). A complexidade operacional da rotação não se justifica para este projeto.

---

## 4. Plano de Implementação

### Fase 1 — Filtro de Clique Real (Alta prioridade, estimativa: 2-3 dias)

#### 4.1 Novo módulo `src/click-filter.ts`

```typescript
export function isCountableClick(request: Request): boolean
```

Verificações em ordem (curto-circuito, em memória, sem acesso a D1):

1. Método !== GET → `false`
2. Header `Purpose: prefetch` ou `prerender` → `false`
3. Header `Sec-Purpose: prefetch` ou `prerender` → `false`
4. Header `X-Purpose: prefetch` ou `prerender` → `false`
5. Header `Sec-Fetch-Mode: navigate` → `true` (navegação real de browser)
6. User-Agent vazio ou ausente → `false`
7. User-Agent contém padrão de bot conhecido → `false` (ver lista abaixo)
8. `Sec-Fetch-Mode` ausente + User-Agent parece navegador → `true`
9. Demais casos → `false` (conservador)

**Lista de bots bloqueados** (constante exportada, centralizada, testável):

```
Googlebot, AdsBot-Google, APIs-Google, Mediapartners-Google,
facebookexternalhit, Facebot, Twitterbot, LinkedInBot,
Slackbot, Discordbot, WhatsApp, TelegramBot,
Applebot, Bingbot, DuckDuckBot, YandexBot,
curl, wget, httpie, python-requests, Go-http-client,
UptimeRobot, Pingdom, StatusCake, BetterUptime,
AhrefsBot, SemrushBot, Majestic, DotBot
```

#### 4.2 Ajuste no handler `GET /:slug`

```typescript
// Antes: sempre chama recordClick
// Depois:
if (isCountableClick(request)) {
  c.executionCtx.waitUntil(recordClick(...));
}
// Redirect 302 SEMPRE acontece, independente de contabilização
```

#### 4.3 Testes da Fase 1

| # | Cenário | Esperado |
|---|---------|----------|
| 1 | GET com UA Chrome → contabiliza | `isCountableClick` = true, clicks_total +1 |
| 2 | HEAD → não contabiliza | false, clicks_total inalterado |
| 3 | OPTIONS → não contabiliza | false, clicks_total inalterado |
| 4 | `Purpose: prefetch` → não contabiliza | false |
| 5 | `Sec-Purpose: prerender` → não contabiliza | false |
| 6 | `X-Purpose: prefetch` → não contabiliza | false |
| 7 | UA Googlebot → não contabiliza | false |
| 8 | UA facebookexternalhit → não contabiliza | false |
| 9 | UA vazio → não contabiliza | false |
| 10 | `Sec-Fetch-Mode: navigate` + UA Firefox → contabiliza | true |
| 11 | UA curl → não contabiliza | false |
| 12 | UA UptimeRobot → não contabiliza | false |
| 13 | Redirect 302 sempre retorna | Mesmo para requisições não contabilizadas |

---

### Fase 2 — Referrer Transparente (Alta prioridade, estimativa: 0,5 dia)

**Objetivo:** O destino final (Google Analytics, etc.) deve receber o `Referer` como se o link encurtado não existisse. Zero armazenamento no BoltLink.

#### 4.4 Ajuste em `applySecurityHeaders()`

Modificar `src/index.ts` para diferenciar por tipo de resposta e path:

```typescript
if (isAdminOrApiPath(path)) {
  response.headers.set("Referrer-Policy", "no-referrer");
} else if (isRedirectResponse(response)) {
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
} else {
  response.headers.set("Referrer-Policy", "no-referrer");
}
```

**Nenhum dado é armazenado.** Apenas o header HTTP de resposta muda.

#### 4.5 Documentar limitações

- Referrer depende do navegador, da página de origem e da política da plataforma
- HTTPS → HTTPS: referrer é enviado (origem apenas, devido a `strict-origin`)
- HTTP → HTTPS: referrer NÃO é enviado (comportamento padrão dos browsers)
- Apps mobile/nativos: podem não enviar referrer
- Para campanhas, **UTMs são a fonte mais confiável** de atribuição, superior ao referrer

#### 4.6 Testes da Fase 2

| # | Cenário | Header esperado |
|---|---------|-----------------|
| 1 | Redirect 302 público (`/:slug`) | `Referrer-Policy: strict-origin-when-cross-origin` |
| 2 | Admin `/admin` | `Referrer-Policy: no-referrer` |
| 3 | Admin `/admin.html` | `Referrer-Policy: no-referrer` |
| 4 | API `/api/links` | `Referrer-Policy: no-referrer` |
| 5 | API `/api/*` | `Referrer-Policy: no-referrer` |

---

### Fase 3 — Gerador de UTMs e QR Code (Alta prioridade, estimativa: 1,5 dia)

**Objetivo:** Facilitar a criação de links com UTMs e QR Code, sem armazenar nada de analytics no BoltLink.

#### 4.7 Gerador de UTMs (client-side, `public/admin.html`)

Formulário inline no painel de criação de link:

```
[URL de Destino (obrigatório): ________________________]
[utm_source:     ________________________] (presets: google, facebook, newsletter, twitter, linkedin)
[utm_medium:     ________________________] (presets: cpc, social, email, organic, banner)
[utm_campaign:   ________________________]
[utm_content:    ________________________] (opcional)
[utm_term:       ________________________] (opcional)

Preview: https://destino.com?utm_source=google&utm_medium=cpc&utm_campaign=black_friday

[Slug (opcional): ________] [Generate Slug]
```

A URL final submetida ao `POST /api/links` já inclui os UTMs como query params da `target_url`. Nenhuma coluna nova no banco. Nenhum armazenamento separado de UTMs.

#### 4.8 QR Code vinculado ao link (client-side + coluna de controle)

**Funcionamento:**

- Cada link tem um botão "QR Code" no card do admin
- O QR Code codifica a URL curta completa (ex: `https://short.domain/abc123`)
- Renderização via `<canvas>` no navegador, usando biblioteca pura e leve (~4 KB)
- Download disponível como PNG

**Vinculação persistente:**

- Coluna `has_qrcode INTEGER NOT NULL DEFAULT 0` em `links`
- Ao gerar o QR Code pela primeira vez, o flag é setado para `1`
- No admin, links com `has_qrcode = 1` exibem ícone/badge visual de QR Code
- O QR Code pode ser regenerado a qualquer momento (botão "Regenerate QR" sempre visível no card)
- Se o slug for imutável (regra do projeto), o QR Code é deterministicamente o mesmo — a regeneração apenas refaz o render

**Por que salvar o flag:**

- Permite identificar visualmente quais links têm QR Code associado
- Permite listar/filtrar links com QR Code
- Custo: 1 coluna INTEGER (irrisório)

#### 4.9 Aviso de domínios diferentes

Ao criar link onde o domínio do shortlink é diferente do domínio de destino, exibir warning discreto:

> Este link redireciona para um domínio diferente. Isso pode causar 'destination mismatch' em Google Ads. Para campanhas, prefira usar o domínio de destino diretamente.

#### 4.10 Testes da Fase 3

| # | Cenário | Esperado |
|---|---------|----------|
| 1 | Criar link com UTMs preenchidos | `target_url` salva com query string completa |
| 2 | Criar link sem UTMs | `target_url` salva normalmente, sem query params extras |
| 3 | Preview de URL com UTMs atualiza em tempo real | Campo preview reflete inputs |
| 4 | Gerar QR Code seta `has_qrcode = 1` | Flag atualizado no banco |
| 5 | Regenerar QR Code não duplica flag | `has_qrcode` permanece 1 |
| 6 | Download QR Code como PNG | Arquivo gerado com conteúdo válido |
| 7 | QR Code escaneável redireciona para destino correto | URL curta no QR é válida |
| 8 | Aviso de domínio diferente aparece | Somente quando domínios divergem |

---

### Fase 4 — Gestão de Links (Média-Alta prioridade, estimativa: 5-7 dias)

#### 4.11 Migration `0001_link_management.sql`

```sql
-- Colunas de gestão de links
ALTER TABLE links ADD COLUMN expires_at TEXT;
ALTER TABLE links ADD COLUMN go_live_at TEXT;
ALTER TABLE links ADD COLUMN redirect_type TEXT NOT NULL DEFAULT '302';
ALTER TABLE links ADD COLUMN tags TEXT;
ALTER TABLE links ADD COLUMN notes TEXT;
ALTER TABLE links ADD COLUMN has_qrcode INTEGER NOT NULL DEFAULT 0;

-- Índices para consultas de gestão
CREATE INDEX IF NOT EXISTS idx_links_tags ON links(tags);
CREATE INDEX IF NOT EXISTS idx_links_has_qrcode ON links(has_qrcode);
```

#### 4.12 Funcionalidades

| # | Recurso | Descrição | Origem |
|---|---------|-----------|--------|
| 4.12a | Expiração automática | Coluna `expires_at TEXT`. GET `/:slug` retorna **410 Gone** se `expires_at` passou e `disabled_at` está NULL | plan.md + plan01.md |
| 4.12b | Ativação programada | Coluna `go_live_at TEXT`. GET `/:slug` retorna **404** antes de `go_live_at` | plan.md + plan01.md |
| 4.12c | Redirect 301 vs 302 | Coluna `redirect_type TEXT DEFAULT '302'`. Escolha por link no admin | Ideia nova |
| 4.12d | Tags/categorias | Coluna `tags TEXT` (JSON array: `["promo","2026"]`). Filtro no admin. Busca por tag | Ambos os planos |
| 4.12e | Notas internas | Coluna `notes TEXT`. Campo textarea no admin. Nunca exposto na API pública | plan.md |
| 4.12f | Duplicar link | Botão "Duplicate" no card do link. Copia `target_url`, `redirect_type`, `tags`, `notes`. Sugere slug com sufixo `-2`, `-3` | plan.md |
| 4.12g | Busca avançada | `GET /api/links?search=X&tag=Y&has_qrcode=1`. Filtro combinado no admin | Ambos os planos |

#### 4.13 Regras de negócio

- **Slug imutável** mantido (já existente, não alterar)
- **Expiração > Go live**: se `expires_at` for anterior a `go_live_at`, rejeitar na criação/edição
- **Tags**: validadas como JSON array no servidor; rejeitar se não for array de strings
- **Notas**: limite de 2000 caracteres
- **Redirect type**: aceitar apenas `'301'` ou `'302'`
- **Duplicação**: slug sugerido é sempre novo (verifica disponibilidade)

#### 4.14 Testes da Fase 4

| # | Cenário | Esperado |
|---|---------|----------|
| 1 | GET link expirado | 410 Gone |
| 2 | GET link com go_live_at futuro | 404 |
| 3 | Criar link com expires_at < go_live_at | 400 Bad Request |
| 4 | GET link com redirect_type=301 | 301 Moved Permanently |
| 5 | GET link com redirect_type=302 (padrão) | 302 Found |
| 6 | Filtrar links por tag | Retorna apenas links com a tag |
| 7 | Criar link com tags inválidas (string solta) | 400 Bad Request |
| 8 | Notas não aparecem na API pública de redirect | Resposta não contém notes |
| 9 | Duplicar link cria novo com mesmo target_url | Link duplicado, slug diferente |
| 10 | Slug sugerido na duplicação não conflita | Slug com sufixo disponível |
| 11 | GET link com has_qrcode=0 | Comportamento normal, sem erro |

---

### Fase 5 — Recursos Avançados (Média prioridade, estimativa: 4-6 dias)

**Itens selecionados para implementação:**

| # | Recurso | Motivo |
|---|---------|--------|
| 5.7 | Link Preview no admin | Melhora a experiência de gestão sem custo operacional |
| 5.10 | Grupos/pastas de links | Organização essencial para múltiplos links |
| 5.11 | Links protegidos por senha | Caso de uso comum em links privados |
| 5.12 | Retenção configurável de stats | Reduz storage e mantém banco enxuto |

**Itens excluídos:** 5.1 (webhook), 5.3 (alertas de pico), 5.4 (detecção de tráfego suspeito), 5.8 (health check) — removidos por usarem Cron ou adicionarem complexidade desproporcional ao escopo do projeto.

#### 5.7 Link Preview no admin

**Descrição:** Ao colar ou digitar uma URL no campo de destino, o admin faz fetch da URL e exibe metadados Open Graph (título, descrição, imagem) como preview visual.

**Funcionamento:**
- Client-side: `fetch()` da URL de destino (ou endpoint proxy no Worker)
- Extração de tags `<meta property="og:*">` e `<title>`
- Exibição de card com thumbnail, título e descrição
- Fallback: se não houver OG tags, mostrar apenas o título da página

**Impacto no plano gratuito:**
- 1 subrequest por preview (admin-only, baixo volume)
- Zero operações D1 adicionais
- **Viável, baixíssimo impacto**

**Limitação:** Se a URL de destino tiver CORS restrito ou `X-Frame-Options`, o preview pode falhar. Nesse caso, exibir fallback silencioso (apenas domínio visível).

#### 5.10 Grupos/pastas de links

**Descrição:** Organizar links em grupos hierárquicos para facilitar a gestão de múltiplos links (ex: "Campanhas/2026/Q1", "Redes Sociais", "Links Internos").

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS link_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (parent_id) REFERENCES link_groups(id) ON DELETE SET NULL
);

ALTER TABLE links ADD COLUMN group_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_links_group_id ON links(group_id);
```

**Funcionalidades:**
- Criar, renomear, excluir grupos (exclusão só se vazio)
- Agrupar links arrastando no admin ou via select
- Filtrar visualização por grupo
- Breadcrumb de navegação entre grupos
- Grupos aninhados (parent_id) com profundidade máxima de 3 níveis

**Impacto no plano gratuito:**
- Nova tabela com poucas linhas (baixo storage)
- 1 SELECT extra ao listar links com grupo (com índice, < 1ms)
- **Viável, baixíssimo impacto**

#### 5.11 Links protegidos por senha

**Descrição:** Opção de adicionar senha a um link. Ao acessar, o usuário vê uma página de gate solicitando a senha antes do redirect.

**Schema:**
```sql
ALTER TABLE links ADD COLUMN password_hash TEXT;
```

**Funcionamento:**
- Senha hasheada com SHA-256 (Web Crypto API) + salt armazenado junto
- Ao acessar `/:slug` com senha: retorna HTML com formulário de senha (não faz redirect)
- Formulário via POST para `/:slug` com a senha no body
- Senha correta: redirect 302 para o destino
- Senha incorreta: mesma página com mensagem de erro
- Sessão: cookie httpOnly com JWT de curta duração (5 min) para não pedir senha repetidamente

**Página de gate (HTML inline no Worker):**
- Design consistente com o tema dark do BoltLink
- Campo de senha + botão "Acessar"
- Mensagem de erro inline (sem redirect)
- Sem dependência de assets externos

**Segurança:**
- Senha nunca armazenada em texto puro (hash + salt)
- Proteção contra brute force: rate limit específico (5 tentativas/min por IP)
- Cookie de sessão: `Secure; HttpOnly; SameSite=Lax; Max-Age=300`

**Impacto no plano gratuito:**
- SHA-256 via Web Crypto API (otimizado pela runtime, < 1ms CPU)
- 1 coluna extra no SELECT de links (irrisório)
- Rate limit em memória (mesmo padrão de `src/rate-limit.ts`)
- **Viável, baixo impacto**

#### 5.12 Retenção configurável de stats

**Descrição:** Permitir configurar por quanto tempo os dados de stats são mantidos. Stats antigos são removidos para economizar storage.

**Funcionamento (sem Cron):**

- Configuração no admin: "Reter stats por X dias" (padrão: 90 dias, opções: 30, 60, 90, 180, 365)
- **Limpeza lazy:** no fluxo de `recordClick()`, após cada escrita, verifica se o total de stats excede um threshold. Se sim, executa DELETE de stats com `clicked_at` anterior ao período de retenção
- **Botão manual:** no admin, botão "Purgar stats antigos" que executa DELETE imediato
- **Endpoint:** `POST /api/maintenance/purge-stats` que executa a limpeza sob demanda

**Lógica de limpeza lazy:**
```typescript
// Dentro de recordClick(), após INSERT:
const STATS_RETENTION_DAYS = 90; // configurável
const PURGE_CHECK_INTERVAL = 100; // a cada 100 writes

if (totalWritesSinceLastPurge >= PURGE_CHECK_INTERVAL) {
  const cutoff = new Date(Date.now() - STATS_RETENTION_DAYS * 86400000).toISOString();
  await database.prepare("DELETE FROM stats WHERE clicked_at < ?").bind(cutoff).run();
  totalWritesSinceLastPurge = 0;
}
```

**Impacto no plano gratuito:**
- DELETE conta como D1 write (rows written)
- Limpeza de 1.000 linhas = 1.000 writes = $0,001 no plano pago
- No Free, 1.000 writes é 1% do limite diário de 100.000
- A limpeza REDUZ storage, compensando o custo de write
- **Viável, baixo impacto — na verdade reduz custo total**

---

## 5. Schema Final Projetado

### 5.1 Tabela `links` (após Fase 5)

```sql
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  target_url TEXT NOT NULL,
  clicks_total INTEGER NOT NULL DEFAULT 0,
  last_clicked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  disabled_at TEXT,
  expires_at TEXT,                                    -- Fase 4 (0001)
  go_live_at TEXT,                                    -- Fase 4 (0001)
  redirect_type TEXT NOT NULL DEFAULT '302',          -- Fase 4 (0001)
  tags TEXT,                                          -- Fase 4 (0001)
  notes TEXT,                                         -- Fase 4 (0001)
  has_qrcode INTEGER NOT NULL DEFAULT 0,              -- Fase 4 (0001)
  group_id INTEGER,                                   -- Fase 5 (0002)
  password_hash TEXT,                                 -- Fase 5 (0002)
  version INTEGER NOT NULL DEFAULT 1
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug);
CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_tags ON links(tags);
CREATE INDEX IF NOT EXISTS idx_links_has_qrcode ON links(has_qrcode);
CREATE INDEX IF NOT EXISTS idx_links_group_id ON links(group_id);
```

### 5.2 Tabela `stats` (inalterada)

```sql
-- SEM NOVAS COLUNAS. Referrer, UTMs e User-Agent NÃO são armazenados.
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER,
  slug_snapshot TEXT NOT NULL,
  clicked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ip_hash TEXT,
  country TEXT,
  FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_stats_link_id_clicked_at ON stats(link_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_stats_slug_snapshot_clicked_at ON stats(slug_snapshot, clicked_at DESC);
```

### 5.3 Nova tabela `link_groups` (Fase 5)

```sql
CREATE TABLE IF NOT EXISTS link_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (parent_id) REFERENCES link_groups(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_link_groups_parent_id ON link_groups(parent_id);
```

### 5.4 Migrations versionadas

| Migration | Descrição | Tabelas afetadas |
|-----------|-----------|-------------------|
| `0000_initial_schema.sql` | Schema inicial (links + stats) | `links`, `stats` |
| `0001_link_management.sql` | Gestão: expires_at, go_live_at, redirect_type, tags, notes, has_qrcode | `links` |
| `0002_advanced_features.sql` | Grupos, senhas: link_groups, group_id, password_hash | `links`, `link_groups` |

---

## 6. Alteração de Rodapé (Footer)

### 6.1 Mudança solicitada

**Formato atual:**
```
V1.0.0 • Desenvolvido por Vitor Faustino • Licença AGPL-3.0
```

**Novo formato:**
```
© {ANO_DINÂMICO} • v{VERSAO_DINÂMICA} • Código-fonte AGPL-3.0
```

Onde:
- `{ANO_DINÂMICO}` é o ano corrente (ex: `2026`), obtido via `new Date().getFullYear()`
- `{VERSAO_DINÂMICA}` é a versão atual do sistema (ex: `1.1.0`), obtida da constante de versão
- "Código-fonte AGPL-3.0" é um link para `https://github.com/vitorgfaustino/boltlink`

### 6.2 Arquivos afetados

| Arquivo | Localização do footer |
|---------|----------------------|
| `public/admin.html` | Rodapé do painel administrativo |
| `src/index.ts` | Landing page (`GET /`) |

### 6.3 Implementação

**No admin (`public/admin.html`):**
```html
<footer>
  © <span id="footer-year"></span> • v<span id="footer-version"></span> •
  <a href="https://github.com/vitorgfaustino/boltlink" target="_blank" rel="noopener">
    Código-fonte AGPL-3.0
  </a>
</footer>
```

**No Worker (`src/index.ts`):**
- Constante `APP_VERSION` atualizada para `"1.1.0"`
- Template string do footer na landing page com ano dinâmico e versão dinâmica

### 6.4 Regra AGPL-3.0

Este rodapé é **obrigatório** e não pode ser removido ou alterado para ocultar a licença ou o link do repositório (conforme `AGENTS.md`). A personalização permitida limita-se a adições, nunca remoções dos elementos obrigatórios.

---

## 7. Estratégia de Versionamento e Rollback

### 7.1 Versionamento semântico

- Versão atual: **1.0.0**
- Versão planejada: **1.1.0** (minor — novas features aditivas, sem breaking changes na API)

### 7.2 Procedimento de commit pré-implementação

```bash
# 1. Garantir que tudo está limpo e testado
npm test

# 2. Criar tag de rollback na versão atual
git tag v1.0.0-rollback

# 3. Criar branch para a implementação
git checkout -b feat/v1.1.0

# 4. Implementar features por fase

# 5. Ao final, commitar com mensagem descritiva
git add -A
git commit -m "release: v1.1.0 — filtro de clique, referrer transparente, gerador de UTMs/QR Code, gestão de links"

# 6. Taguear a nova versão
git tag v1.1.0
```

### 7.3 Rollback

```bash
# Rollback de código (volta ao estado anterior):
git checkout v1.0.0-rollback

# Rollback de schema (opcional):
# D1 oferece Time Travel (point-in-time recovery):
# 7 dias de retenção no Free, 30 dias no Paid
# Isso permite restaurar o banco inteiro para antes da migration.
#
# Nota: colunas adicionadas por migrations são compatíveis
# com código antigo (colunas extras são ignoradas em D1).
# Portanto, rollback de código é suficiente na maioria dos casos;
# rollback de schema só é necessário se houver dados corrompidos.
```

### 7.4 Regra de push

**Nunca fazer push para o GitHub sem pedido expresso do usuário.** Commits são locais até que o push seja solicitado.

---

## 8. Documentação

### 8.1 Arquivos a criar

| Arquivo | Conteúdo |
|---------|----------|
| `CHANGELOG.md` | Histórico de versões (1.0.0 → 1.1.0), breaking changes (nenhum), novas features |
| `docs/click-policy.md` | Definição de clique contabilizável, lista de bots filtrados, headers utilizados |
| `docs/ads-best-practices.md` | Boas práticas para Google Ads e Meta Ads com BoltLink, riscos, exemplos |
| `docs/privacy.md` | Política de privacidade: o que coletamos, o que não coletamos, por quanto tempo |
| `docs/upgrading.md` | Guia de atualização 1.0.0 → 1.1.0: migrations, deploy, verificação |
| `docs/password-links.md` | Como funcionam links protegidos por senha: gate, cookie, segurança |
| `docs/retention.md` | Política de retenção de stats: como configurar, limpeza lazy, purga manual |

### 8.2 Arquivos a atualizar

| Arquivo | Mudanças |
|---------|----------|
| `README.md` | Features da v1.1.0, badges atualizados, links para nova documentação |
| `AGENTS.md` | Se necessário: novas regras sobre filtro de clique, proibição de armazenar referrer |
| `AI-START.md` | Instruções de bootstrap e atualização para v1.1.0 |
| `docs/architecture.md` | Fluxo de clique atualizado, schema completo, novas tabelas |
| `schema.sql` | Schema final refletindo `links`, `stats` e `link_groups` |
| `public/admin.html` | Novo footer, seções de UTM e QR Code, gestão de links |
| `src/index.ts` | Versão 1.1.0, novo footer na landing page, filtro de clique, referrer condicional |

### 8.3 AI-START.md — Conteúdo mínimo esperado

```markdown
# BoltLink — AI Quick Start

## Para bootstrap de projeto novo (v1.1.0)
1. Clone o repositório: git clone https://github.com/vitorgfaustino/boltlink.git
2. npm install
3. npm run setup
4. Configure wrangler.local.jsonc com seus bindings
5. npx wrangler d1 migrations apply db_boltlink --local
6. npm run cf-typegen
7. npm test
8. npm run deploy

## Para atualizar de v1.0.0 para v1.1.0
1. git fetch origin
2. git checkout v1.1.0
3. npm install
4. npm test
5. npx wrangler d1 migrations apply db_boltlink --remote
   (aplica 0001_link_management.sql e 0002_advanced_features.sql)
6. npm run cf-typegen
7. npm run deploy
8. Verifique no admin se o footer exibe "v1.1.0"

## Migrations
- 0000: schema inicial — links, stats
- 0001: gestão de links — expires_at, go_live_at, redirect_type, tags, notes, has_qrcode
- 0002: avançado — link_groups, group_id, password_hash

## Regras críticas (NUNCA violar)
- NÃO armazenar Referer (nem sanitizado, nem origin)
- NÃO armazenar User-Agent (uso transiente apenas para filtro)
- NÃO armazenar UTMs separadamente (apenas compor a target_url)
- NÃO usar Cron Triggers (não implementar recursos que dependam de Cron)
- NÃO remover o rodapé com licença AGPL-3.0 e link do GitHub
- NÃO fazer push para o GitHub sem pedido expresso do usuário
- NÃO alterar migrations já aplicadas em produção

## Footer obrigatório
© {ANO} • v{VERSAO} • Código-fonte AGPL-3.0 (link para https://github.com/vitorgfaustino/boltlink)
Ano e versão sempre dinâmicos. Link sempre presente.
```

---

## 9. Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| Bot sofisticado não detectado pelo filtro | Média | Baixo | Lista de bots pode ser atualizada sem deploy (variável de ambiente ou endpoint de configuração) |
| Estouro de 100k requests/dia (Free) | Média | Alto | Monitorar no dashboard Cloudflare; documentar opção de upgrade para Workers Paid ($5/mês) |
| Estouro de 100k writes/dia D1 (Free) | Baixa (com filtro) | Alto | Filtro de bots reduz >30% do tráfego; limpeza lazy (5.12) mantém storage baixo |
| Referrer não chega ao destino | Média | Baixo | Documentar dependência do navegador e plataforma; recomendar UTMs como fonte confiável |
| Migration quebra em produção | Baixa | Alto | Validar com `--local` antes de `--remote`; D1 Time Travel como safety net |
| Conflito de senha com rate limit | Baixa | Baixo | Rate limit de senha isolado do rate limit da API (namespaces diferentes no mapa) |
| Cookie de senha expira durante navegação | Baixa | Baixo | Renovar cookie a cada acesso bem-sucedido (sliding expiration de 5 min) |
| QR Code muito grande para links longos | Média | Baixo | Ajustar nível de correção de erro conforme tamanho; limite prático de ~100 caracteres no slug |

---

## 10. Cronograma

| Fase | Descrição | Estimativa | Dependências |
|------|-----------|------------|-------------|
| Fase 1 | Filtro de clique real | 2-3 dias | Nenhuma |
| Fase 2 | Referrer transparente | 0,5 dia | Nenhuma (paralelo com Fase 1) |
| Fase 3 | Gerador de UTMs + QR Code | 1,5 dia | Nenhuma (paralelo com Fase 1) |
| Fase 4 | Migration 0001 + gestão de links | 5-7 dias | Fase 1 concluída |
| Fase 5 | Grupos, senhas, preview, retenção (migration 0002) | 4-6 dias | Fase 4 concluída |
| — | Documentação + CHANGELOG + AI-START.md | 1-2 dias | Após todas as fases |
| **Total estimado** | | **14-20 dias** | |

---

## 11. Checkpoints de Validação

Após cada fase, executar obrigatoriamente:

```bash
npm test                     # Testes unitários e de integração
npm run cf-typegen           # Se bindings mudaram
npx wrangler d1 migrations apply db_boltlink --local  # Se schema mudou
```

Antes do deploy final:

```bash
npm test                     # Suite completa
npx wrangler d1 migrations apply db_boltlink --remote # Aplicar migrations em produção
npm run deploy               # Deploy do Worker
```

---

## 12. Resumo do que NÃO faz parte do escopo

| Item | Motivo da exclusão |
|------|--------------------|
| Armazenar referrer no banco | Dado pertence ao destino, não ao BoltLink |
| Armazenar UTMs no banco | UTMs compõem a URL de destino, não precisam de armazenamento separado |
| Dashboard de analytics no admin | Fora do escopo — ferramentas como Google Analytics fazem isso melhor |
| Webhook de eventos (5.1) | Adiciona complexidade de rede e custo de subrequests |
| Alertas de pico (5.3) | Depende de Cron (não utilizado neste projeto) |
| Detecção de tráfego suspeito (5.4) | Depende de análise contínua (excessivo para o escopo) |
| Health check de links (5.8) | Depende de Cron (não utilizado neste projeto) |
| Workers Analytics Engine | Overkill para o volume atual do projeto |
| Permissões por operador | Escopo atual é single-tenant |
| Rotação de IP_HASH_SECRET | Complexidade operacional não justificada para o risco |
| Cron Triggers de qualquer tipo | Não utilizar neste projeto |

---

v1.1.0
Criado por Vitor Faustino — vitorfaustino.com.br
