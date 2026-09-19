# BoltLink

BoltLink é um gerenciador de links com Cloudflare Workers, Hono, D1 e painel administrativo estático.

**Versão 2.2.1 - AGPL-3.0**

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
- **Privacidade por padrão**: a linha `2.0.x` mantém analytics detalhado por evento fora do produto e conserva apenas contagem agregada.
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
npm run dev-prepare
npm run dev
npm test
```

`npm run dev-prepare` aplica a cadeia de migrations no D1 local que o `wrangler dev` usa (`.wrangler/state/v3/d1`).

Se quiser criar o D1 explicitamente:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config
```

Se quiser criar o D1 já com jurisdição:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config --jurisdiction=eu
```

Antes de subir o Worker, aplique as migrations no D1 local que o `wrangler dev` usa (o runtime não cria schema):

```bash
npm run dev-prepare
```

O comando lê o banco configurado em `wrangler.jsonc`/`wrangler.local.jsonc` e aplica `migrations/0000` a `0004` em `.wrangler/state/v3/d1`. Equivalente explícito: `npm run wrangler -- d1 migrations apply boltlink-db --local`.

Com o banco sem schema, a API e os redirects respondem `503 Database schema is not initialized`; aplique as migrations e o mesmo isolate volta a funcionar sem restart.

Para inspecionar dados manualmente com um SQLite auxiliar:

```bash
npm run dev-init
```

Esse comando cria `.dev-env/db.sqlite3` (migrations + seed) apenas para exploração local com `sqlite3`. Ele **não** é o D1 usado pelo Worker; para o Worker, use `npm run dev-prepare`. O diretório `.dev-env/` é ignorado pelo Git e não vai para o GitHub.

### 2. Operação guiada por IA

Comece por `AI-START.md`.

Pedidos úteis:

- `Iniciar o Projeto`
- `Atualizar o Projeto`
- `Aplicar migrations`
- `Auditar estado operacional`

### 3. One-click / GitHub auto-deploy

Depois do deploy:

1. aplicar as migrations no D1 (`npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc`); sem isso a API e os redirects respondem `503 Database schema is not initialized`
2. validar `workers.dev`
3. configurar Access para `/admin`, `/admin.html`, `/api` e `/api/*`
4. preencher `TEAM_DOMAIN` e `POLICY_AUD`
5. opcionalmente configurar `API_KEY`; configurar `PASSWORD_SESSION_SECRET` se a instância usar links protegidos por senha
6. opcionalmente trocar para domínio próprio

Se você utiliza o recurso de links protegidos por senha, **deve obrigatoriamente** configurar o `PASSWORD_SESSION_SECRET`. Se não for configurado, a criação e o acesso aos links com senha falharão.
Se você usa GitHub auto-deploy ou o botão de deploy da Cloudflare, configure `PASSWORD_SESSION_SECRET` no painel da Cloudflare como `Secret`.
Se você publica com Wrangler local, use `.dev.vars` para desenvolvimento e `wrangler secret put PASSWORD_SESSION_SECRET` para o Worker implantado.

Comandos simples para gerar secrets:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

Sugestao pratica:

- use um dos comandos acima para gerar `PASSWORD_SESSION_SECRET`
- use outro valor aleatorio independente para `API_KEY`

## Página pública de privacidade

A instância publicada agora inclui uma página pública em `/privacidade`, servida a partir de `public/privacidade.html`.

Esse arquivo é um ponto de partida e deve ser adaptado pelo operador antes do uso público real.

## O que o projeto faz

- cria links curtos com slug customizado ou automático
- mantém slug imutável
- protege links opcionais com senha
- permite grupos, tags, QR code, ativação e expiração
- permite Split Test A/B com distribuição stateless e apenas contadores agregados
- conta cliques de forma agregada sem eventos detalhados
- permite zerar a estatística agregada de um link ativo
- inclui orientações para reduzir tráfego desnecessário no plano gratuito da Cloudflare

## Upgrade para v2.2.1

```bash
git pull --ff-only
npm install
npm run wrangler:init
npm test
```

Se a instância ainda estiver em uma linha anterior à baseline LGPD da `2.0.0`, aplique também:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

Para instalações já alinhadas com `2.0.0`, o upgrade base não exige migration nova nem bindings novos.

O Split Test A/B adiciona a migration `0004_ab_testing.sql`, que é a fonte autoritativa das colunas A/B. O runtime **não** cria nem altera colunas: uma instalação existente precisa aplicar a `0004` para habilitar A/B e uma instalação nova precisa aplicar a cadeia completa de migrations. O `schema.sql` é apenas o baseline da `0000` para ferramentas manuais e não é executado pelo runtime.

Procedimento recomendado:

1. backup conforme o procedimento da instância;
2. aplicar as migrations (`npm run wrangler -- d1 migrations apply ...`);
3. atualizar/publicar o Worker;
4. validar o painel (o Admin mostra A/B somente quando a capability está disponível).

Sem a migration, links normais continuam criando, editando, duplicando e redirecionando normalmente; apenas o Split Test A/B fica indisponível.

## Split Test A/B

Um link pode dividir tráfego entre Control A (destino principal) e Variant B (destino alternativo). A escolha é feita por requisição, sem cookie, sem visitor ID e sem fingerprint; qualquer automação reconhecida (bots, crawlers, previews, prefetch/prerender) recebe sempre o Control A.

Links com A/B ativo usam sempre redirect temporário `302` com `Cache-Control: no-store`; `301` é incompatível com A/B. Mudanças de configuração avançam a geração do experimento, então métricas atrasadas não contaminam o novo teste, e `reset-clicks` funciona como corte explícito das métricas.

O produto expõe apenas distribuição de cliques (`Cliques A`, `Cliques B`, `Distribuição observada`, `Traffic Allocation`). Conversão continua sendo medida por ferramentas externas.

## Tráfego e estatísticas

BoltLink não mantém eventos individuais de clique.

- `clicks_total` é apenas um número agregado na linha do link
- zerar estatísticas redefine esse número para `0`
- excluir um link faz exclusão lógica com `disabled_at`, preservando o slug como já usado
- não há ganho relevante de espaço no D1 ao zerar ou apagar estatística, porque não existe tabela de eventos

Para reduzir tráfego automatizado sem depender de WAF pago, consulte `docs/free-plan-traffic.md`.

## Configuração segura

- `wrangler.jsonc` é o template público
- `wrangler.local.jsonc` é a configuração privada local
- `observability` fica desligado por padrão
- `upload_source_maps` fica desligado por padrão
- `API_KEY` continua opcional para automações internas
- links protegidos por senha só podem ser criados quando `PASSWORD_SESSION_SECRET` estiver configurado para assinar suas sessões curtas
- `TEAM_DOMAIN` e `POLICY_AUD` são valores de texto
- `API_KEY` e `PASSWORD_SESSION_SECRET` devem ser tratados como `Secret`
- `wrangler.local.jsonc` só afeta deploys locais via Wrangler; GitHub auto-deploy e o Deploy Button usam o template público e os valores definidos no painel

## Capacidade no Cloudflare Free

Projetado para dezenas de milhares de acessos públicos por dia no Cloudflare Free. Um alvo operacional conservador é cerca de **75.000 requisições públicas/dia** sob os limites atuais, deixando margem para previews sociais, crawlers, tráfego de admin/API e outros overheads. Isso não é uma garantia de 75.000 cliques: requisições públicas e cliques contabilizados são métricas diferentes. Veja `docs/free-plan-traffic.md`.

## Referências

- `docs/cloudflare-setup.md`
- `docs/admin-auth.md`
- `docs/privacy.md`
- `docs/privacy-template.md`
- `docs/architecture.md`
- `docs/free-plan-traffic.md`
- `docs/upgrading.md`
- `docs/local-development.md`
- `AGENTS.md`

## Licença

Este projeto é distribuído sob **AGPL-3.0**.

O software é fornecido "como está". Quem implanta e opera o sistema continua responsável pelo uso, pela base legal, pelas configurações da conta Cloudflare e por qualquer dado inserido no ambiente operacional.

Para ajudar quem redistribuir ou implantar o projeto, o repositório inclui um modelo genérico em `docs/privacy-template.md`. Esse texto é apenas um template operacional e não substitui revisão jurídica do operador.
