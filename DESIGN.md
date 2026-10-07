---
name: BoltLink
description: Gerenciador de links com privacidade por padrão — painel operacional, redirect estável, zero tracking.
colors:
  primary: "#00A1F5"
  primary-hover: "#008cd6"
  bg: "#09090b"
  text: "#f4f4f5"
  text-secondary: "#e4e4e7"
  muted: "#a1a1aa"
  danger: "#ef4444"
typography:
  display:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "clamp(1.8rem, 4vw, 2.4rem)"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    letterSpacing: "-0.02em"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.94rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.88rem"
    fontWeight: 600
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace"
    fontSize: "1.06rem"
    fontWeight: 700
rounded:
  xs: "6px"
  sm: "8px"
  md: "12px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.bg}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
    typography: "{typography.label}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "#fca5a5"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  card:
    backgroundColor: "rgba(255,255,255,0.03)"
    rounded: "{rounded.md}"
    padding: "20px"
  input:
    backgroundColor: "rgba(0,0,0,0.25)"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
---

# Design System: BoltLink

## Admin — 3.1.0 publicada (Gates 8.6–8.6.4)

Esta seção prevalece sobre os exemplos históricos da base 3.0.0 abaixo. Branding e identidade azul permanecem; o Gate 8.6.4 adota mono leve e temas Light/Dark. No Dark, Criar link e Links ativos usam superfície principal discreta (fundo branco a 1.8%, borda a 6.5%, radius 12px), sem sombra/blur. Registros têm fundo ligeiramente mais claro (3.5%), borda suave, radius 8px, padding 16px (12px em mobile estreito) e gap 12px (16px até 900px). Não há terceiro nível de cards: accordions continuam leves, com divisores, e métricas são itens independentes com flex-wrap e gap, sem pontuação separadora órfã; chips comunicam estado. Grupos usam badge de contexto com raio 6px, padding 4px 8px, fundo/borda discretos e só o nome visível (o rótulo acessível mantém “Grupo:”).

Toolbar agrupa três ferramentas com alturas/raios coerentes. Busca e filtro formam uma seção separada dos resultados por espaço e divisor. Footer tem distância própria da lista.

URL, Variante B e slug são truncados apenas visualmente: uma linha acima de 900px, duas até 900px. Ver mais / Ver menos aparece somente após medição real de overflow, recalculada após render, resize e carregamento de fontes. Texto integral continua no DOM para tecnologia assistiva; o botão usa aria-expanded/controls e funciona por teclado. Expansão não altera dado, API nem payload. O botão Copiar original mantém o link curto integral; Copiar destino usa a URL original completa mesmo recolhida, inclusive para a Variante B.

Tags reutilizam a mesma medição e expansão do conteúdo: uma linha desktop, até duas mobile, sem transformar cada tag em pill. Copiar destino usa cor de apoio, fonte menor e indicação ↳; a Variante B tem rótulo próprio acima da URL. Até 900px, estados precedem a grade de três ações iguais (Copiar, Editar, Mais opções), todas com altura mínima 44px; métricas e tags vêm depois. Desktop preserva as ações no topo e a densidade existente.

Até 900px, Criar link é heading expansível, inicialmente recolhido e sem estado persistido. Fechado, o mesmo painel mede 62px (padding vertical 8px + controle 44px + bordas), sem underline ou margem inferior no heading; aberto, recupera o formulário no próprio container. Desktop mantém duas colunas. Grupos, Lixeira e Importar / Exportar preservam o offcanvas de até 30rem, largura total no mobile, overlay, ESC, trap de foco, fundo inert e scroll interno. Importar / Exportar mantém seções verticais e status junto à exportação. Nenhuma mudança de backend, schema, migration, retenção ou portabilidade neste refinamento.

Cópia tem feedback local por controle: check + “Copiado” no sucesso, “Falhou” no erro, com restauração após 1800ms e timers independentes/renovados por clique. O conteúdo normal reserva a mesma caixa; o feedback sobreposto não altera largura, altura nem a grade de ações. Um status polite exclusivo anuncia link curto, destino ou Variante B sem expor URLs em falhas. Press usa escala 0.98 com transição curta; reduced motion remove transform/transition sem remover confirmação.

### Terminal-light typography — Gate 8.6.4

Mono global leve, inclusive parágrafos, controles e drawers: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", Consolas, "Liberation Mono", monospace`. Não existem IBM Plex Mono/Geist Mono distribuídas no projeto; foi escolhida a stack nativa, sem assets de fonte, CDN, download ou dependência nova. A comparação real com o Gate 8.6.3 em desktop/mobile manteve a leitura confortável, portanto não foi necessária estratégia híbrida.

Body 400, 0.9rem, line-height 1.55, tracking natural; parágrafos 0.9rem/1.6 com até 75ch. Headings, botões e labels usam 500–600; sem pesos 700/800. Título principal 2.2rem/1.2, 1.7rem até 480px, tracking -0.025em/-0.02em. Headings de painel 1.125rem; slug 1.06rem/600; métricas têm números tabulares. Campos herdam a família e mantêm peso 400.

A largura maior da mono exige dois ajustes locais: padding menor nas ferramentas até 360px; toolbar em duas colunas entre 901–1050px, com Importar / Exportar na linha inteira. A grade mobile Copiar / Editar / Mais opções continua com três colunas iguais e altura mínima 44px, inclusive no estado Copiado. URL/slug/tags mantêm clamps e expansão medida, sem alteração dos valores copiados.

### Light/Dark — Gate 8.6.4

Uma autoridade: `data-theme` no elemento `html`. `public/admin.css` centraliza todas as cores em custom properties; componentes não contêm literais de cor. Os dois temas definem os mesmos papéis cromáticos: fundo/mesh, superfície principal, card, input, readonly, bordas, textos, acento/on-accent, seleção, badges, links, perigo/sucesso/aviso, menus, popovers, drawers, overlays e sombras. Raio, espaçamento, tipografia e geometria são compartilhados. O branco fixo no canvas de QR em `admin.js` é a quiet zone do artefato escaneável, independente do tema.

| Papel | Dark | Light |
| --- | --- | --- |
| Fundo | `#09090b` e gradientes existentes | `#f3f5f8` → `#eef2f7` |
| Painel / card | branco a 1.8% / 3.5% | `#ffffff` / `#f5f7fb` |
| Drawer / dialog | `#0b0d10` | `#ffffff` |
| Input | preto a 25% | `#f1f4f8` |
| Texto / muted | `#f4f4f5` / `#a1a1aa` | `#162131` / `#526177` |
| Acento / hover | `#00A1F5` / `#008cd6` | `#006cad` / `#005b92` |
| Texto sobre acento | `#09090b` | `#ffffff` |
| Sucesso / erro | `#86efac` / `#fca5a5` | `#187143` / `#a82431` |

Dark preserva seus valores de superfícies, azul, menus e overlays. Bordas de input e foco sólido ganham contraste suficiente; pesos/leading mudam pela direção tipográfica. Light usa separação tonal e borda discreta entre página, painel, cards e inputs; drawers elevados usam overlay escuro. O mesmo logo é legível nos dois temas. Texto e placeholders têm contraste mínimo 4.5:1 nas superfícies testadas; contorno de input ≥3:1. Outline de foco de 2px com offset 3px funciona em ambos.

O seletor compacto fica no header ao lado do logo, com botões reais Light/Dark, nomes acessíveis “Tema claro”/“Tema escuro”, `aria-pressed`, teclado e alvos de 44px. O bootstrap síncrono inline no head resolve a preferência antes do stylesheet/body: aceita apenas `light`/`dark` em `localStorage["boltlink-theme"]`, ignora valores inválidos e usa `prefers-color-scheme`. Define também `theme-color`; CSS aplica `color-scheme` para controles nativos. Nenhum request, cookie ou escrita D1 é usado para o tema.

Sem escolha explícita, eventos do sistema atualizam o tema. Após escolha manual, o sistema não a substitui. Storage bloqueado não impede renderização; falha de gravação mantém a escolha na página atual, sem prometer persistência após reload. A troca não anima a página inteira e respeita as regras existentes de reduced motion. A validação em 320/360/390/430/768/1024/1440 nos dois temas encontrou geometria igual, sem overflow; drawers, QR, menus e feedback herdam os tokens.

## 1. Overview

**Creative North Star: "O Farol Discreto"**

O BoltLink é um painel operacional que vive no escuro. O fundo é near-black (`#09090b`) com véus sutis de azul — não como decoração, mas como profundidade. Sobre essa base, um único acento ciano (`#00A1F5`) age como farol: marca onde agir, confirma o que foi feito, indica o que está ativo. Nada compete com ele porque nada mais tem cor saturada.

A interface rejeita o espetáculo. Não há gradientes em texto, não há cards coloridos, não há métricas brigando por atenção. Cada elemento existe para uma tarefa: criar link, buscar slug, copiar URL, ver contagem agregada. A beleza está na contenção — o que não está na tela importa tanto quanto o que está.

O tom é técnico mas não frio. A fonte do sistema elimina carregamento externo. A font mono aparece onde a precisão importa: slugs, previews de URL, contadores. O cursor piscante no título não é afetação; é um aceno ao operador que reconhece um terminal.

**Key Characteristics:**
- Tema escuro como fundação, não como opção
- Um acento. Só um. Ciano operacional.
- Transparência e blur como profundidade, não como truque
- Fontes do sistema — zero webfonts, zero latência
- Tipografia mono para dados técnicos; sans para interface
- Movimento rápido, curvas ease-out — sem bounce, sem elastic

## 2. Colors

A paleta é mínima por decisão estratégica. O acento ciano carrega toda a carga semântica; os neutros existem para dar contraste e hierarquia sem competir.

### Primary
- **Ciano Operacional** (`#00A1F5`): O farol. Usado em botões primários, links, indicadores de foco, contadores ativos, e o underline decorativo de 2rem sob headings de painel. Também aparece como glow difuso no background (via `radial-gradient` com baixa opacidade) e como brilho de texto no título principal (`text-shadow` com opacidade 0.15).
- **Ciano Hover** (`#008cd6`): Estado hover/focus do acento principal. Tom mais escuro e assertivo.

### Neutral
- **Fundo Near-Black** (`#09090b`): A tela. Não é preto puro — tem um leve azul na composição que mantém o tema escuro respirando. Usado como `background-color` do `body`.
- **Superfície Translúcida** (`rgba(255,255,255,0.03)`): Background de painéis e cards. Transparente o suficiente para herdar os gradientes do fundo; sólido o suficiente para definir área.
- **Superfície Elevada** (`rgba(255,255,255,0.05)`): Hover de cards e painéis. Clareamento sutil.
- **Superfície de Input** (`rgba(0,0,0,0.25)`): Fundo de campos de formulário. Mais escuro que o painel para indicar área editável.
- **Linha** (`rgba(255,255,255,0.08)`): Bordas de painéis, cards, inputs, separadores. Presente mas não dominante.
- **Linha Hover** (`rgba(0,161,245,0.3)`): Borda de card em hover/focus. Aciona o acento como indicador de estado.
- **Texto Primário** (`#f4f4f5`): Corpo de texto, labels, headings. Contraste ≥12:1 contra o fundo.
- **Texto Secundário** (`#e4e4e7`): Contadores, badges, texto de apoio em cards.
- **Texto Atenuado** (`#a1a1aa`): Placeholders, ajuda contextual, metadados, rodapé. Contraste ≥4.6:1 contra o fundo.

### Estados
- **Perigo** (`#ef4444`): Links expirados, ações destrutivas, notas de pendência. Usado com moderação — apenas onde a atenção é crítica.
- **Sucesso** (`#86efac`): Confirmações de salvamento, status de operações bem-sucedidas.

**The One Light Rule.** O Ciano Operacional é o único acento cromático do sistema. Nenhuma outra cor saturada aparece na interface. Estados de perigo e sucesso usam vermelho e verde com saturação reduzida e contexto limitado (pills, status text, badges). Se uma nova cor aparecer, a pergunta não é "qual cor?" — é "por que o farol não basta?"

## 3. Typography

**Display/Body Font:** System UI stack (`system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`)
**Mono Font:** UI Monospace stack (`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`)

**Character:** A sans do sistema é familiar e invisível — o operador não percebe a fonte, percebe a tarefa. A mono aparece onde a exatidão importa: slugs, previews de URL, código. O contraste entre as duas não é decorativo; é semântico.

### Hierarchy
- **Display** (800, `clamp(1.8rem, 4vw, 2.4rem)`, line-height 1.1, letter-spacing -0.04em): Título principal da página. Aparece uma vez, no hero. O letter-spacing negativo dá coesão sem sacrificar legibilidade (mínimo -0.04em — nunca mais apertado). Inclui `text-shadow` com glow ciano e cursor piscante como elemento de identidade.
- **Title** (700, `1.125rem`, letter-spacing -0.02em): Headings de seção e painel. Inclui underline decorativo de 2rem em `--accent` via `::after`. Suficiente para hierarquizar sem gritar.
- **Body** (400, `0.94rem`, line-height 1.6): Texto corrido, descrições, help text expandido. Cor `--muted` por padrão; `--text` quando é conteúdo principal. Largura máxima implícita pela largura do painel (~65-75ch no painel de formulário).
- **Label** (600, `0.88rem`): Labels de formulário, itens de menu, contadores. Sempre visível, sempre acima do campo.
- **Mono** (700, `1.06rem`): Slugs em cards. Também usada em previews de URL (400, `0.82rem`) e placeholders de código. A mono é o indicador visual de "isto é um dado técnico, não prosa."

**The Mono Is Meaning Rule.** Toda vez que a font mono aparece, ela carrega um dado técnico: slug, URL preview, código. Nunca usar mono para texto de interface ou conteúdo editorial. A troca de sans para mono é um sinal semântico, não estilístico.

## 4. Elevation

O sistema usa camadas com transparência e blur, não sombras pesadas. A profundidade vem de três mecanismos combinados:

1. **Transparência progressiva**: painéis (`rgba(255,255,255,0.03)`) → hover (`rgba(255,255,255,0.05)`) → inputs (`rgba(0,0,0,0.25)`). Cada camada altera sua opacidade para se destacar ou recuar.
2. **Blur de fundo**: painéis usam `backdrop-filter: blur(24px)`. O conteúdo atrás do painel fica desfocado, criando separação sem borda dura.
3. **Sombra de profundidade**: `0 20px 40px rgba(0,0,0,0.4)` — sombra ampla e difusa, sem borda nítida. Não projeta o painel para fora da tela; apenas o descola do fundo.

### Shadow Vocabulary
- **Sombra de Superfície** (`0 20px 40px rgba(0,0,0,0.4)`): Painéis e dropdowns. Difusa, sem offset lateral, apenas profundidade.
- **Sombra de Destaque** (`0 0 0 1px rgba(0,161,245,0.05), 0 0 16px rgba(0,161,245,0.12), 0 10px 24px rgba(0,0,0,0.35)`): Cards em hover. Adiciona um anel sutil de acento + glow difuso.

**The Float-By-Default Rule.** Painéis flutuam com blur e transparência. Cards em repouso têm sombra sutil; em hover, ganham anel de acento e glow. Nenhuma superfície é completamente plana; todas têm pelo menos `backdrop-filter` e uma borda semitransparente. O sistema é "flutuante" por natureza — a profundidade está na transparência, não na sombra.

## 5. Components

### Buttons
- **Shape:** Todos os botões usam raio de 8px (`--radius-sm`). Sem cantos vivos, sem pills.
- **Primary:** Fundo Ciano Operacional (`#00A1F5`) com texto near-black (`#09090b`) e um inset highlight branco (`inset 0 1px 0 rgba(255,255,255,0.2)`) para definição. Padding `10px 16px`, altura mínima 46px. Hover: escurece para `#008cd6` e adiciona `box-shadow: 0 0 16px` com `--accent-soft`. Active: `scale(0.98)`.
- **Secondary:** Fundo transparente, borda `--line`, texto `--text`. Hover: fundo `rgba(255,255,255,0.04)`, borda clareia. Active: `scale(0.98)`.
- **Danger:** Fundo transparente, borda `rgba(239,68,68,0.2)`, texto `#fca5a5`. Hover: fundo `rgba(239,68,68,0.08)`, texto branco. Reservado para ações destrutivas.
- **Compact:** Altura reduzida (40px), padding `8px 12px`, fonte `0.84rem`. Usado em ações auxiliares (Gerar slug, Criar grupo).
- **Focus:** `box-shadow: 0 0 0 4px var(--accent-soft)` via `:focus-visible`. Anel de 4px com transparência — visível sem ser agressivo.
- **Disabled:** `opacity: 0.6`, cursor `wait`. Sem hover, sem active.

### Cards (Link Items)
- **Shape:** Raio 12px (`--radius`), padding 20px, borda `--line`.
- **Background:** `--surface` (translúcido), hover → `--surface-hover`.
- **Shadow:** Em repouso, `0 4px 12px rgba(0,0,0,0.2)`. Em hover/focus, `--shadow-glow` (anel de acento + glow + profundidade).
- **Layout:** Flex column com gap 16px. Topo reorganiza para row em ≥700px (slug info à esquerda, ações à direita).
- **Animation:** `card-in`: 200ms ease-out, translateY(6px) → 0, opacity 0 → 1.
- **States:** `is-pending` (link expirado/desativado): borda avermelhada, fundo com leve tom de danger, opacidade 0.8.

### Inputs / Fields
- **Style:** Fundo `--surface-strong`, borda `--line`, raio 8px, altura mínima 46px, padding `10px 14px`.
- **Placeholder:** Cor `#52525b` (contraste suficiente contra fundo escuro).
- **Focus:** Borda muda para `--accent`, `box-shadow: 0 0 0 4px var(--accent-soft)`.
- **Hover (não focado):** Borda clareia para `rgba(255,255,255,0.15)`.
- **Readonly:** Fundo mais escuro, texto `--muted`, cursor `not-allowed`.
- **Select:** Mesmo estilo de input. Dropdown nativo mantido.

### Chips / Pills
- **Counter Pill:** `border-radius: 999px`, padding `6px 12px`, borda `rgba(0,161,245,0.2)`, fundo `rgba(0,161,245,0.08)`. Número forte em Ciano Operacional.
- **Group Badge:** `border-radius: 999px`, padding `3px 8px`, borda `rgba(0,161,245,0.25)`, fundo `rgba(0,161,245,0.08)`, texto `#b1f0ff`.
- **Metric Pill:** `border-radius: 999px`, padding `4px 10px`, fundo `rgba(255,255,255,0.04)`, borda `--line`. Para tags e metadados em cards.

### Dropdown (More Actions)
- **Trigger:** Botão quadrado 40×40px com borda `--line`, ícone de três pontos (SVG). Active: `scale(0.95)`.
- **Menu:** `position: absolute`, top `calc(100% + 6px)`, right 0, fundo `rgba(15,15,20,0.96)`, borda `--line`, raio 8px, blur `20px`. Padding interno 6px, gap 4px entre itens.
- **Animation:** `dropdown-in`: 150ms ease-out, opacity 0 → 1, translateY(4px) → 0, scale(0.95) → 1.
- **Items:** Botões full-width com fundo transparente, altura 38px, padding `8px 12px`. Hover: fundo `rgba(255,255,255,0.05)`.

### Search
- **Shell:** Input com ícone de lupa à esquerda (position absolute, left 14px). Padding-left 40px para não sobrepor ícone.
- **Layout:** Row principal (input + botão de busca) + row secundária (label "Filtrar por grupo" + select). Em ≤640px, filtro colapsa para coluna única.
- **Filtro:** continua significando associação direta ao grupo escolhido; a opção "Sem grupo" é um sentinela separado e subgrupos não entram por padrão.

### Group Tree (painel `Grupos`, release 3.0.0; origem Fase 5)
- **Painel:** ocupa as duas colunas do `.layout` (`grid-column: 1 / -1`) para não alterar a grade formulário + links.
- **Estrutura:** listas aninhadas (`ul` dentro do `li` pai) em vez de indentação calculada; cada linha é um `.group-node` com botão de expandir/recolher (só quando há filhos), nome, caminho completo e ações `Mover` / `Excluir`.
- **Toggle:** botão real com `aria-expanded` e `aria-label` nomeando o grupo, com o estado visível no glifo (`▸` / `▾`).
- **Formas:** `fieldset.group-form` para "Criar grupo" (nome + grupo pai opcional) e "Mover grupo" (grupo, novo pai e caminho atual), lado a lado a partir de 768px.
- **Erros:** um único `#group-status` com `aria-live="polite"`; uma recusa da API mantém a linha na tela e apenas reporta o motivo.

### Details / Accordion
- **Summary:** Cursor pointer, peso 700, cor `--text-secondary`. Hover: cor `--accent`. Chevron customizado via `::after` com borda rotacionada (não usa `::marker` nativo).
- **Open:** Fundo `rgba(255,255,255,0.03)`, borda `rgba(0,161,245,0.2)`. Chevron rotaciona -135deg.
- **Content:** Gap 14px entre fields internos.

### Split Test A/B
- **Container:** Accordion `Split Test A/B` dentro do formulário, com toggle (`checkbox-row`), input de URL para Variant B e um `select` de Traffic Allocation com presets (90/10, 75/25, 50/50, 25/75, 10/90). Quando a capability `abTesting` é falsa (instalação pré-`0004`), a seção fica oculta com uma nota curta e o formulário volta ao payload normal da Fase 1.
- **Redirect:** ativar A/B força `302` no select e desabilita `301` enquanto o toggle estiver ligado; o backend é a autoridade final e rejeita A/B + `301` com `400`.
- **Copy:** usa apenas `Control A`, `Variant B`, `Traffic Allocation`, `Cliques A`, `Cliques B` e `Distribuição observada`. Nunca `conversion`, `winner` ou `significância estatística`.
- **Results:** métricas no card do link (pills `--metric`) quando o teste está ativo e também quando encerrado com histórico (`Split A/B Encerrado`, `Resultados do último teste`), no mesmo estilo dos demais metadados. Por não existir snapshot da configuração antiga, alocação e Variant B atuais nunca são exibidos como parte dos resultados históricos; quando configurados, aparecem separados como `Próximo teste`. Sem gráficos, sem segunda cor, sem destaque visual de "vencedor".
- **Restraint:** um único toggle e um único percentual. A/B/C/D, sticky sessions e seleção automática de vencedor ficam fora de escopo.

### Smart Routing
- **Container:** Accordion `Smart Routing` dentro do formulário, com toggle (`checkbox-row`), lista ordenada de regras e botão `Adicionar regra`. Cada regra tem país, dispositivo e destino, mais ações `Mover para cima`, `Mover para baixo` e `Remover`. Quando a capability `smartRouting` é falsa (instalação pré-`0005`), a seção fica oculta com uma nota curta e o payload não recebe o campo.
- **Storage:** uma única coluna JSON na própria linha (`links.smart_routing_rules`). Não há tabela secundária, JOIN auxiliar ou SELECT adicional no redirect.
- **Ordering:** a ordem da lista é a prioridade. As regras são avaliadas de cima para baixo e a primeira compatível vence; o fallback é sempre `target_url` e aparece como leitura somente. Botões mover/remover substituem drag-and-drop para manter acessibilidade e mobile.
- **Redirect:** ativar Smart Routing força `302` e desabilita `301` enquanto o toggle estiver ligado; o backend rejeita Smart Routing + `301` com `400`. Links configurados respondem sempre `302` com `Cache-Control: no-store`.
- **Conflict:** Smart Routing e Split Test A/B são mutuamente exclusivos. Ativar um desativa o outro localmente e o `PATCH` final é único, preservando a atomicidade administrativa. Um estado persistido ambíguo é exibido como `configuração ambígua` no card, sem reparo automático.
- **Copy:** `País`, `Dispositivo`, `Destino`, `Fallback`, `Qualquer país`, `Qualquer dispositivo`. UI-only fields (id de linha) nunca são enviados à API.
- **Restraint:** no máximo 20 regras, sem país/device analytics, sem contador por regra, sem UTM injection e sem sticky routing.

### Após expirar (destino de expiração, release 3.0.0; origem Fase 4)
- **Container:** fieldset `Após expirar` dentro do bloco de agendamento/expiração do formulário, com radios `Resposta padrão (410)` e `Redirecionar para URL` e input de URL habilitado apenas na segunda opção. Quando a capability `expiredRedirect` é falsa (instalação pré-`0006`), a seção fica oculta com uma nota curta apontando a migration pendente e o payload não recebe o campo.
- **Coupling:** o destino só existe com expiração preenchida. Sem "Expira em", os radios ficam desabilitados/ocultos e a limpeza da expiração remove o destino junto (limpeza atômica na mesma edição, sem request intermediário).
- **Copy:** `Após expirar`, `Resposta padrão (410)`, `Redirecionar para URL`, `Destino após expiração`. Sem nomes de coluna (`expired_redirect_url`) na UI; o nome técnico do campo (`expiredRedirectUrl`) aparece apenas em contexto de API.
- **Restraint:** um único destino, sem variance por país/dispositivo (isso é Smart Routing, feature separada e mutuamente independente), sem preview de métrica de expiração — requests expirados não geram métrica.

## 6. Do's and Don'ts

### Do:
- **Do** usar o Ciano Operacional como único acento cromático. Se precisar de ênfase, use peso, tamanho ou posição — nunca uma segunda cor saturada.
- **Do** usar a font mono para slugs, previews de URL, e dados técnicos. A troca sans → mono carrega significado.
- **Do** manter painéis com `backdrop-filter: blur(24px)` e fundo translúcido. A profundidade vem da transparência, não de sombras duras.
- **Do** usar `var(--muted)` para texto de apoio e metadados. A hierarquia de três níveis (text → text-secondary → muted) cobre todas as necessidades de ênfase.
- **Do** respeitar `prefers-reduced-motion`. Toda animação e transição deve ter fallback instantâneo.
- **Do** usar o underline de 2rem em `--accent` sob headings de painel como marcador de seção. Consistente e discreto.

### Don't:
- **Don't** usar dashboards de analytics coloridos e sobrecarregados como referência. O BoltLink não é um dashboard de métricas; é um painel operacional. Múltiplas cores de gráfico, cards com gradientes e métricas competindo por atenção são proibidos.
- **Don't** introduzir uma segunda cor saturada. Se parecer que precisa de verde, vermelho, ou laranja como acento adicional, a solução está em hierarquia visual, não em cor.
- **Don't** usar `border-left` ou `border-right` maior que 1px como faixa colorida decorativa em cards, headings, ou callouts. É o marcador visual de UI gerada por IA. Use fundo com transparência do acento ou o underline `::after` padrão.
- **Don't** usar gradientes em texto (`background-clip: text`). O texto é sempre cor sólida. Ênfase vem de peso, tamanho, ou posição.
- **Don't** usar glassmorphism como textura decorativa genérica. O blur nos painéis do BoltLink serve para profundidade funcional (separar camadas), não para estética "vidro fosco".
- **Don't** usar `z-index` com valores arbitrários (999, 9999). A escala semântica é: dropdown (8) → card hover (20) → dropdown menu (100).
- **Don't** adicionar animações com bounce, elastic, ou curvas de entrada chamativas. A curva padrão é `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out-quart). Sempre.
- **Don't** usar mais de 6rem no `clamp()` máximo de headings. Acima disso a página grita.
- **Don't** usar `letter-spacing` menor que `-0.04em` em headings display. Letras coladas não é "design" — é erro de legibilidade.

Release atual publicada: 3.1.1 · Tag: v3.1.1 · Release anterior: 3.1.0
