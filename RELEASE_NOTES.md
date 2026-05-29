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

Versão 2.1.0
Criado por Vitor Faustino - vitorfaustino.com.br
