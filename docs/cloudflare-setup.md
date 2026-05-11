# Setup na Cloudflare

Este guia descreve o fluxo recomendado para colocar o projeto em funcionamento na Cloudflare usando Workers, D1, Assets e Access.

Se você estiver conduzindo a operação por chat ou IA, comece por [AI-START.md](../AI-START.md). Depois use [docs/ai-guided-operations.md](ai-guided-operations.md) e [docs/ai-accepted-requests.md](ai-accepted-requests.md) como contrato do fluxo guiado.

O fluxo seguro usa `wrangler.jsonc` como template público e `wrangler.local.jsonc` como configuração privada ignorada pelo Git. O comando `npm run wrangler:init` cria essa base local para você.

## Fluxo A: Deploy to Cloudflare Workers

Se você quiser a experiência mais próxima de “one-click”, use o botão de deploy do GitHub presente no `README.md`.

Nesse fluxo:

- o `wrangler.jsonc` público é a fonte de verdade do deploy
- o Worker sobe em `workers.dev` por padrão
- o D1 pode ser provisionado automaticamente pela Cloudflare porque o template público não fixa um `database_id`
- o schema base é criado automaticamente na primeira operação que usa o banco
- `public/admin.html` e os demais assets são publicados junto com o Worker

Depois do botão, ainda restam etapas manuais:

1. Validar a URL em `workers.dev`.
2. Configurar Cloudflare Zero Trust Access para `/admin`, `/admin.html`, `/api` e `/api/*`.
3. Preencher `TEAM_DOMAIN` e `POLICY_AUD` no ambiente implantado.
4. Opcionalmente publicar o secret `API_KEY` para automações internas.
5. Opcionalmente publicar o secret `IP_HASH_SECRET` para analytics com hash HMAC de IP.
6. Opcionalmente configurar domínio próprio.

Se `TEAM_DOMAIN` ou `POLICY_AUD` aparecerem no painel como "este valor é um segredo criptografado" e não der para editar o conteúdo diretamente, o valor foi criado no tipo errado. Recrie o campo como `Texto`, informe o valor real e faça um novo deploy. No fluxo one-click, essas variáveis devem ficar como texto no Worker, não como secret.

O botão não cria a aplicação final do Access nem define as políticas `Allow`. Esse handoff continua manual.

Nos Workers Builds, o projeto deve usar o `wrangler.jsonc` público durante o `deploy`, porque o ambiente de build injeta `WORKERS_CI=1` e não carrega `wrangler.local.jsonc`.

Nesse modo automático, `TEAM_DOMAIN` e `POLICY_AUD` devem ser tratados como valores do Worker no painel da Cloudflare. Os deploys automáticos preservam esses valores já configurados.

## Fluxo B: CLI manual ou guiado por IA local

## Pré-requisitos

- Conta Cloudflare ativa
- Domínio ativo dentro da Cloudflare se você quiser publicar em hostname próprio
- Node.js 20 ou superior
- Dependências instaladas com `npm install`
- Wrangler autenticado com `npx wrangler login`

## 1. Revise a configuração base do Worker

Abra `wrangler.jsonc` apenas para conferir o template público. Os valores reais devem ficar em `wrangler.local.jsonc`.

Rode primeiro:

```bash
npm run setup
```

Se você preferir fazer em duas etapas, use `npm run wrangler:init` e depois `npm run cf-typegen`.

Importante: fora dos Workers Builds, `npm run deploy` continua exigindo `wrangler.local.jsonc`. Se você quiser testar manualmente o template público por troubleshooting, rode o deploy com `--config wrangler.jsonc` de forma explícita.

Depois ajuste, no mínimo, o arquivo local:

- `name`: nome público do Worker
- `compatibility_date`: mantenha uma data atual e validada
- `workers_dev` ou `routes`: escolha entre deploy padrão em `workers.dev` ou custom domain
- `d1_databases`: binding e identificador do banco
- `assets.directory`: diretório de arquivos públicos
- `vars.TEAM_DOMAIN` e `vars.POLICY_AUD`: preencha no arquivo local quando você quiser publicar manualmente com `npm run deploy`; `TEAM_DOMAIN` deve usar HTTPS

Se você adotar ambientes nomeados mais tarde, lembre que bindings e `vars` não são herdados automaticamente entre ambientes do Wrangler. Repita explicitamente os blocos necessários em cada ambiente operacional.

No estado público deste repositório:

- `workers_dev` vem habilitado por padrão para facilitar o primeiro deploy
- o bloco `routes` está comentado como exemplo
- o D1 público fica sem `database_id` fixo para permitir provisionamento automático no fluxo one-click

Observação importante: a documentação atual da Cloudflare recomenda `wrangler.jsonc` como formato preferido para novos projetos. Neste repositório, ele funciona como template público; os valores reais do fluxo manual local ficam em `wrangler.local.jsonc`, que é o arquivo privado usado pela operação local.

Resumo simples:

- deploy automático por GitHub ou botão da Cloudflare: o código vem do repositório e `TEAM_DOMAIN` e `POLICY_AUD` ficam no painel do Worker
- deploy manual local: o código e as `vars` podem ser publicados a partir do `wrangler.local.jsonc`

## 2. Crie o banco D1, se quiser o fluxo manual explícito

Crie o banco com o Wrangler:

```bash
npm run wrangler -- d1 create <nome-do-banco> --binding db_boltlink --update-config
```

Este comando cria o banco, atualiza a configuração local e já devolve o binding e o UUID que o projeto precisa. Se você preferir revisar manualmente a saída, copie o bloco retornado e confirme a seção `d1_databases` em `wrangler.local.jsonc` antes de seguir.

Se você não executar esse passo e fizer `deploy` com um config sem `database_id`, a Cloudflare poderá provisionar o D1 automaticamente no deploy. Ainda assim, o fluxo explícito acima continua sendo o caminho mais previsível para operação local e troubleshooting.

Campos importantes:

- `binding`: nome usado no código, por exemplo `db_boltlink`
- `database_name`: nome legível do banco
- `database_id`: identificador único do banco

## 3. Gere os tipos do Worker

Sempre que bindings mudarem, gere novamente os tipos:

```bash
npm run cf-typegen
```

Isso atualiza `worker-configuration.d.ts` e mantém o código tipado de acordo com os bindings reais.

## 4. Aplique as migrations localmente, se quiser inicializar o banco antes do primeiro uso

Antes de desenvolver, inicialize o banco local do Wrangler:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco> --local
```

Esse passo é o caminho explícito recomendado quando você quiser inicializar o banco local antes do primeiro uso.

No fluxo one-click ou em bancos novos, o Worker também consegue criar o schema base automaticamente na primeira operação que usa o D1.

## 5. Rode o projeto localmente

```bash
npm run dev
```

O Wrangler iniciará um ambiente local. O painel administrativo ficará disponível em `/admin`.

## 6. Valide o comportamento local

- Abra `/admin`
- Crie um link curto
- Pesquise pelo slug
- Edite a URL de destino
- Teste o redirect acessando `/:slug`
- Rode os testes:

```bash
npm test
```

## 7. Escolha a forma de publicação

### Opção A: publicar rapidamente em workers.dev

Sem alterar rotas, você já pode fazer deploy para o subdomínio padrão da sua conta Cloudflare.

Isso é o caminho mais simples para validar o projeto pela primeira vez.

### Opção B: usar custom domain

Se você pretende usar custom domain em vez de `workers.dev`, garanta que:

- o domínio esteja ativo na Cloudflare
- o hostname final esteja definido em `routes`
- o deploy seja feito a partir do mesmo projeto Wrangler que contém essa rota

Exemplo conceitual de hostname público para documentação:

- `links.example.com`

## 8. Publique os assets estáticos

Este projeto usa `assets.directory` com binding `ASSETS`. Na prática:

- `public/admin.html` é empacotado junto com o Worker
- o deploy envia código e assets em uma única operação
- o Worker pode servir diretamente o asset do admin via `env.ASSETS.fetch()`
- os caminhos administrativos passam por `run_worker_first`, para que `/admin`, `/admin.html`, `/api` e `/api/*` continuem protegidos e controlados pelo Worker antes de qualquer asset ser servido

## 9. Aplique as migrations no banco remoto quando quiser um fluxo explícito ou quando existirem mudanças futuras de schema

O banco local e o remoto são diferentes. Antes do deploy de produção, rode:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco> --remote
```

Para a versão atual do projeto, o schema base também pode nascer automaticamente na primeira operação que toca o D1. Ainda assim, aplicar migrations remotamente continua sendo o caminho explícito recomendado quando você quiser controle operacional maior ou quando o projeto evoluir com migrations adicionais.

## 10. Faça o deploy

```bash
npm run deploy
```

Depois do deploy:

- valide a rota pública
- valide `/health`
- valide `/admin`
- valide `/admin.html` para confirmar que não está exposto sem autenticação
- valide criação, edição e exclusão de links

Se você publicou primeiro em `workers.dev`, use esse endpoint para validar o fluxo antes de configurar um domínio próprio.

## 11. Configure autenticação do admin

Para proteger `/admin`, `/admin.html`, `/api` e `/api/*`, configure o Cloudflare Access. O fluxo completo está em `docs/admin-auth.md`, mas o resumo é:

1. Criar uma aplicação Access do tipo self-hosted.
2. Associar o hostname administrativo.
3. Definir políticas Allow para os usuários autorizados.
4. Copiar o `AUD` da aplicação.
5. Se você opera com deploy manual local, preencher `TEAM_DOMAIN` e `POLICY_AUD` no arquivo `wrangler.local.jsonc`.
6. Se você publicou pelo botão ou por Git integration, preencher `TEAM_DOMAIN` e `POLICY_AUD` diretamente no painel do Worker.
7. Opcionalmente configurar `API_KEY` para automações de backoffice.

Enquanto isso não estiver configurado, o comportamento esperado fora do localhost é `401` em `/admin`, `/api` e `/api/*`.

O mesmo raciocínio vale para `/admin.html`, que também deve continuar fechado fora do ambiente local até que o Access esteja configurado.

## 12. Configure segredos

Para automação por bearer token na API de gestão:

```bash
npx wrangler secret put API_KEY
```

Use esse secret apenas para `/api` e `/api/*`, nunca para substituir o login humano no `/admin`.

Para gravar hashes de IP com HMAC-SHA-256 nos analytics:

```bash
npx wrangler secret put IP_HASH_SECRET
```

Sem `IP_HASH_SECRET`, o Worker continua contando cliques, mas grava `ip_hash` como `NULL`.

Se você separar `staging` e `production`, publique `API_KEY` e `IP_HASH_SECRET` diferentes em cada ambiente e mantenha o equivalente local em arquivos específicos como `.dev.vars.staging` e `.dev.vars.production`.

Para desenvolvimento local, copie o arquivo de exemplo e ajuste os valores:

```bash
cp .dev.vars.example .dev.vars
```

Nunca versione `.dev.vars`, `.env` ou qualquer valor sensível.

## 13. Observabilidade e operação

O projeto já está com `observability.enabled` ativo em `wrangler.jsonc`. Recomenda-se também:

- acompanhar erros do Worker após deploy
- monitorar falhas de autenticação do admin
- revisar growth do D1 com o aumento do volume de `stats`

## Problemas comuns

### `no such table`

Causa comum: banco remoto novo ainda sem schema inicializado.
Correção: faça a primeira operação que usa o D1 para deixar o bootstrap automático criar o schema base, ou rode o comando de migration com `--remote` se quiser inicialização explícita.

### Admin abre localmente, mas falha em produção

Causa comum: `TEAM_DOMAIN` e `POLICY_AUD` incorretos, ausentes no lugar certo, ou política Access ausente.
Correção: revisar a aplicação Access e confirmar onde esses valores estão sendo mantidos: painel do Worker no fluxo automático, ou `wrangler.local.jsonc` no fluxo manual local.

### `Missing wrangler.local.jsonc` ao rodar `npm run deploy`

Causa comum: deploy local executado sem inicializar a configuração privada.
Correção: rode `npm run wrangler:init` para o fluxo local normal, ou use `npm run wrangler -- deploy --config wrangler.jsonc` se a intenção for testar explicitamente o template público.

### Alterei bindings e os tipos ficaram inconsistentes

Causa comum: tipos não regenerados.  
Correção: rode `npm run cf-typegen`.

## Recomendações para o release público

- Criar ambientes Wrangler nomeados para separar produção e homologação.
- Substituir quaisquer hostnames específicos por placeholders antes de publicar o repositório.
- Expandir o CI para incluir validação de documentação e migrations.
- Revisar `wrangler.jsonc` antes de abrir o código publicamente.

---

Versão 1.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
