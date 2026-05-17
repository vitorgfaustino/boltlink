# BoltLink

BoltLink é um gerenciador de links com Cloudflare Workers, Hono, D1 e painel administrativo estático.

**Versão 2.0.0 - AGPL-3.0**

Ele funciona como encurtador de URLs, mas o objetivo real do projeto é maior: manter links públicos estáveis, simples de operar e independentes de plataformas terceiras, com controle do redirect, proteção do painel e uma baseline de privacidade mais rígida do que a maioria das ferramentas desse tipo.

Esta versão muda o produto para uma baseline LGPD mais rígida:

- sem `stats`
- sem `IP_HASH_SECRET`
- sem `last_clicked_at`
- sem `notes`
- contagem apenas agregada em `clicks_total`
- `Referrer-Policy: strict-origin` nos redirects públicos
- `Referrer-Policy: no-referrer` no admin, API e demais respostas

## O que é o BoltLink

Na prática, o BoltLink existe para resolver cenários como:

- link da bio que precisa continuar estável
- QR Code impresso que não pode quebrar
- URL curta para campanhas, materiais, vídeos e documentos
- gestão própria de links sem depender de serviços externos para redirect e painel

O foco do sistema é manter o caminho crítico do redirect enxuto e previsível, enquanto o painel administrativo continua suficiente para operação real do dia a dia.

## O que diferencia este projeto

- **Controle do stack**: o redirect, o painel e o banco ficam no mesmo projeto, em Cloudflare Workers + D1.
- **Privacidade por padrão**: a linha `2.0.0` remove analytics detalhado por evento e mantém apenas contagem agregada.
- **Admin protegido**: o painel continua pensado para operar com Cloudflare Access.
- **Produto pequeno, mas operacional**: slug imutável, QR code, grupos, tags, expiração, ativação e links com senha já fazem parte do fluxo.
- **Distribuição aberta com AGPL**: quem adaptar e operar em rede precisa manter o código derivado sob a mesma licença.

## Telas

<p align="center">
  <img src="public/tela-home.webp" alt="Tela inicial do BoltLink" width="100%" />
</p>

<p align="center">
  <img src="public/tela-links.webp" alt="Painel administrativo do BoltLink" width="100%" />
</p>

<p align="center">
  <img src="public/tela-link-protegido.webp" alt="Tela de link protegido por senha" width="100%" />
</p>

## Deploy na Cloudflare

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vitorgfaustino/boltlink)

O botão continua funcional com o `wrangler.jsonc` público.

## Três formas de usar

### 1. Wrangler local

```bash
npm install
npm run setup
npm run dev
npm test
```

Se quiser criar o D1 explicitamente:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config
```

Se quiser criar o D1 já com jurisdição:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config --jurisdiction=eu
```

Para desenvolvimento manual com banco SQLite local de apoio:

```bash
npm run dev-init
```

Esse fluxo cria `.dev-env/db.sqlite3` localmente. O diretório `.dev-env/` é ignorado pelo Git e não vai para o GitHub.

### 2. Operação guiada por IA

Comece por `AI-START.md`.

Pedidos úteis:

- `Iniciar o Projeto`
- `Atualizar o Projeto`
- `Aplicar migrations`
- `Auditar estado operacional`

### 3. One-click / GitHub auto-deploy

Depois do deploy:

1. validar `workers.dev`
2. configurar Access para `/admin`, `/admin.html`, `/api` e `/api/*`
3. preencher `TEAM_DOMAIN` e `POLICY_AUD`
4. opcionalmente configurar `API_KEY` e `PASSWORD_SESSION_SECRET`
5. opcionalmente trocar para domínio próprio

Se voce nao usa links protegidos por senha, pode deixar `PASSWORD_SESSION_SECRET` sem configurar.
Se voce usa GitHub auto-deploy ou o botao de deploy da Cloudflare, configure `PASSWORD_SESSION_SECRET` no painel da Cloudflare como `Secret`.
Se voce publica com Wrangler local, use `.dev.vars` para desenvolvimento e `wrangler secret put PASSWORD_SESSION_SECRET` para o Worker implantado.

## Página pública de privacidade

A instância publicada agora inclui uma página pública em `/privacidade`, servida a partir de `public/privacidade.html`.

Esse arquivo é um ponto de partida e deve ser adaptado pelo operador antes do uso público real.

## O que o projeto faz

- cria links curtos com slug customizado ou automático
- mantém slug imutável
- protege links opcionais com senha
- permite grupos, tags, QR code, ativação e expiração
- conta cliques de forma agregada sem eventos detalhados

## Upgrade para v2.0.0

```bash
git pull --ff-only
npm install
npm run wrangler:init
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm test
```

Se houver ambiente remoto operado por CLI:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

O upgrade aplica a migration `0003_lgpd_minimization.sql`, que remove `stats` e reconstrói `links` sem `last_clicked_at` e sem `notes`.

## Configuração segura

- `wrangler.jsonc` é o template público
- `wrangler.local.jsonc` é a configuração privada local
- `observability` fica desligado por padrão
- `upload_source_maps` fica desligado por padrão
- `API_KEY` continua opcional para automações internas
- `PASSWORD_SESSION_SECRET` é recomendado em produção para assinar sessões curtas de links protegidos por senha
- `TEAM_DOMAIN` e `POLICY_AUD` são valores de texto
- `API_KEY` e `PASSWORD_SESSION_SECRET` devem ser tratados como `Secret`
- `wrangler.local.jsonc` só afeta deploys locais via Wrangler; GitHub auto-deploy e o Deploy Button usam o template público e os valores definidos no painel

## Referências

- `docs/cloudflare-setup.md`
- `docs/admin-auth.md`
- `docs/privacy.md`
- `docs/privacy-template.md`
- `docs/architecture.md`
- `docs/upgrading.md`
- `docs/local-development.md`
- `AGENTS.md`

## Licença

Este projeto é distribuído sob **AGPL-3.0**.

O software é fornecido "como está". Quem implanta e opera o sistema continua responsável pelo uso, pela base legal, pelas configurações da conta Cloudflare e por qualquer dado inserido no ambiente operacional.

Para ajudar quem redistribuir ou implantar o projeto, o repositório inclui um modelo genérico em `docs/privacy-template.md`. Esse texto é apenas um template operacional e não substitui revisão jurídica do operador.
