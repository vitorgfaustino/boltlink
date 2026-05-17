# AI-START

Este arquivo é a entrada única para qualquer IA operar o BoltLink v2.0.0 com segurança.

O objetivo dele é permitir que a IA:

- inicie um projeto novo corretamente
- atualize uma instalação existente sem quebrar overlays e configuração local
- entenda quando deve parar e entregar handoff manual ao usuário
- saiba como tratar deploy local, GitHub auto-deploy e one-click

Se a IA recebeu apenas este arquivo, ela deve conseguir orientar ou executar o fluxo operacional sem inventar dados sensíveis nem pular checkpoints importantes.

## Leitura obrigatória

Leia nesta ordem antes de agir:

1. `AGENTS.md`
2. `docs/ai-accepted-requests.md`
3. `docs/ai-guided-operations.md`
4. `docs/cloudflare-setup.md`
5. `docs/admin-auth.md`
6. `docs/privacy.md`

## Estado atual do produto

BoltLink v2.0.0 é um gerenciador de links com:

- redirect público por slug
- painel administrativo estático
- D1 para links, grupos e contador agregado
- Cloudflare Access para `/admin`, `/admin.html`, `/api` e `/api/*`
- contagem apenas agregada em `links.clicks_total`
- política pública em `/privacidade`

O produto não mantém:

- `stats`
- `IP_HASH_SECRET`
- `last_clicked_at`
- `notes`
- IP persistido
- hash estável de IP
- país por clique
- `Referer` persistido
- `User-Agent` persistido

## Regras fixas

- `wrangler.jsonc` é o template público
- `wrangler.local.jsonc` é a configuração privada local
- não criar `wrangler.toml`
- não automatizar a criação final do Cloudflare Access
- não sobrescrever branding e overlays do usuário sem confirmação
- não reintroduzir `stats`, `IP_HASH_SECRET`, `last_clicked_at` ou `notes`
- o slug continua imutável
- o redirect público continua respondendo antes da contagem
- redirects públicos usam `Referrer-Policy: strict-origin`
- admin, API, home, gate de senha e respostas não redirect usam `Referrer-Policy: no-referrer`

## Como interpretar pedidos

Use apenas intenções compatíveis com `docs/ai-accepted-requests.md`.

As principais são:

- `Iniciar o Projeto`
- `Continuar configuração do projeto`
- `Atualizar o Projeto`
- `Aplicar migrations`
- `Auditar estado operacional`
- `Publicar no workers.dev`
- `Publicar com o botão da Cloudflare`
- `Preparar Access`

Se o pedido vier em linguagem natural, primeiro mapeie para uma dessas intenções antes de executar qualquer ação.

## Pergunta obrigatória antes de publicação ou atualização

A IA deve sempre perguntar ou descobrir:

`Como você publica o projeto?`

Métodos aceitos:

1. `GitHub auto-deploy`
2. `Deploy local com Wrangler`
3. `Ambos`
4. `Primeira publicação`

Essa resposta muda:

- onde `TEAM_DOMAIN` e `POLICY_AUD` vivem
- se a migration remota será executada por CLI ou só orientada
- se a atualização depende de `git pull` local ou de push para o GitHub

## Árvore de decisão para iniciar um projeto

Antes de qualquer `npm install`, a IA deve descobrir:

1. a pasta atual já é a raiz final do projeto?
2. a pasta atual já possui `.git` do usuário?
3. os arquivos do BoltLink já estão presentes nessa raiz?

Regras:

- se a pasta atual já for a raiz final do usuário com `.git`, nunca criar clone aninhado
- se a IA precisar obter o projeto do upstream, usar origem temporária fora da árvore final
- nunca deixar `.git` do upstream dentro do projeto final do usuário
- se a pasta final já estiver preenchida, ler antes de sobrescrever qualquer coisa

Fluxo para `Iniciar o Projeto`:

1. confirmar a raiz final
2. verificar se já existe `.git`
3. obter o conteúdo do projeto sem clone aninhado
4. rodar `npm install`
5. rodar `npm run setup`
6. se o usuário quiser banco explícito, criar D1 com `npm run wrangler -- d1 create ... --update-config`
7. aplicar migrations locais
8. rodar `npm test`
9. parar antes da criação final do Access

Se o pedido for iniciar o projeto apenas localmente para testes manuais, a IA deve incluir:

```bash
npm run dev-init
```

Esse comando cria `.dev-env/db.sqlite3` localmente para navegação e experimentação. O diretório `.dev-env/` é ignorado pelo Git e não deve ser tratado como artefato versionado.

## Fluxo para atualizar instalações existentes

Esse fluxo precisa cobrir tanto instalações novas quanto legadas.

Quando o pedido for `Atualizar o Projeto`, a IA deve:

1. rodar `git status --short`
2. identificar mudanças locais que precisam ser preservadas
3. preservar explicitamente:
   - `wrangler.local.jsonc`
   - `public/admin.html`
   - `public/logo.png`
   - `public/favicon.ico`
   - valores individualizados do `wrangler.jsonc`, se o projeto derivado já os tiver alterado
4. verificar como o projeto publica
5. se estiver seguro, rodar `git pull --ff-only`
6. rodar `npm install`
7. rodar `npm run wrangler:init`
8. aplicar migrations locais
9. se o deploy remoto for operado por CLI, aplicar migrations remotas com `-c wrangler.local.jsonc`
10. rodar `npm test`

## Upgrade específico para legados anteriores à v2.0.0

Projetos antigos podem ainda conter:

- tabela `stats`
- colunas `last_clicked_at` e `notes`
- documentação ou config anterior à baseline LGPD

Nesses casos:

- a migration relevante é `migrations/0003_lgpd_minimization.sql`
- o código atual também reconcilia schema legado em runtime
- mesmo assim, a migration continua sendo o caminho recomendado

Comandos:

Migration local:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

Migration remota:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

## Diferença entre os três modos de operação

### 1. Wrangler local

Usado quando o operador publica manualmente da própria máquina.

Fluxo mínimo:

```bash
npm install
npm run setup
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run dev
npm test
```

### 2. AI-guided setup

A IA deve:

- mapear o pedido para uma intenção aceita
- perguntar só o dado faltante seguinte
- explicar qualquer comando mutável antes de rodar
- parar nos checkpoints manuais da Cloudflare

### 3. One-click / GitHub auto-deploy

O botão e o auto-deploy continuam usando `wrangler.jsonc`.

Depois do deploy:

1. validar `workers.dev`
2. configurar Access para `/admin`, `/admin.html`, `/api` e `/api/*`
3. preencher `TEAM_DOMAIN` e `POLICY_AUD`
4. opcionalmente configurar `API_KEY` e `PASSWORD_SESSION_SECRET`
5. opcionalmente trocar para domínio próprio

Não existe mais etapa de publicar `IP_HASH_SECRET`.

Regras para esses valores:

- se o projeto usa GitHub auto-deploy ou o Deploy Button, `wrangler.local.jsonc` nao deve fornecer `TEAM_DOMAIN`, `POLICY_AUD`, `API_KEY` ou `PASSWORD_SESSION_SECRET`
- nesses fluxos, `TEAM_DOMAIN` e `POLICY_AUD` vivem como texto no dashboard e `API_KEY`/`PASSWORD_SESSION_SECRET` vivem como secrets no dashboard
- se o projeto publica com Wrangler local, `TEAM_DOMAIN` e `POLICY_AUD` podem existir em `wrangler.local.jsonc`
- em deploy local, `API_KEY` e `PASSWORD_SESSION_SECRET` devem viver em `.dev.vars` para desenvolvimento ou em secrets do Worker para o ambiente implantado
- `PASSWORD_SESSION_SECRET` nao e obrigatorio quando a instancia nao usa links protegidos por senha

## Checkpoints manuais obrigatórios

A IA deve parar e entregar handoff quando a tarefa depender de:

- criação final do Cloudflare Access
- policy `Allow` do Access
- revisão de DNS/rota no dashboard
- decisão jurídica sobre o conteúdo final da política de privacidade da instância

## Arquivos que a IA deve tratar como canônicos

- `AGENTS.md`
- `AI-START.md`
- `docs/ai-accepted-requests.md`
- `docs/ai-guided-operations.md`
- `docs/cloudflare-setup.md`
- `docs/admin-auth.md`
- `docs/privacy.md`
- `schema.sql`
- `migrations/`
- `wrangler.jsonc`

## Comandos de referência

Setup local:

```bash
npm install
npm run setup
```

Setup local com banco SQLite de apoio:

```bash
npm install
npm run setup
npm run dev-init
npm run dev
```

Criar D1 com update do config local:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config
```

Criar D1 com jurisdição:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config --jurisdiction=eu
```

Migration local:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

Migration remota:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

Validação:

```bash
npm test
```

## Resultado esperado

Se a IA seguir este arquivo corretamente, ela deve conseguir:

- iniciar projetos novos sem clone aninhado
- atualizar projetos legados preservando overlays e configs locais
- aplicar migrations corretas da linha `2.0.0`
- respeitar o modelo de publicação do usuário
- parar nos checkpoints manuais corretos

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
