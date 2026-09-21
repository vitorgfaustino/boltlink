## Unreleased - Smart Routing (Fase 3)

Notas de trabalho para a próxima release. Nenhuma tag ou versão foi publicada.

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

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
