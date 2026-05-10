# Autenticação do Admin

Este projeto protege o painel administrativo e a API de gestão com Cloudflare Access, validando o token dentro do próprio Worker.

## Rotas protegidas

As rotas abaixo passam pelo middleware de autenticação:

- `/admin`
- `/admin.html`
- `/api`
- `/admin/*`
- `/api/*`

Se você usar o botão `Deploy to Cloudflare Workers`, o comportamento esperado logo após o deploy é o painel administrativo continuar indisponível fora do localhost até que o Cloudflare Access seja configurado manualmente.

## Como a autenticação funciona hoje

O Worker aceita três cenários:

1. Desenvolvimento local em `localhost`, `127.0.0.1` ou `[::1]`
2. Sessão válida do Cloudflare Access
3. `Authorization: Bearer <API_KEY>` para automação opcional em `/api` e `/api/*`

O acesso aberto sem credenciais existe apenas em `localhost`, `127.0.0.1` e `[::1]`. Fora do ambiente local, ausência ou erro de configuração do Access faz `/admin`, `/api` e `/api/*` falharem com `401`. O único bypass opcional por bearer token existe para automações de API.

## O que o Worker valida

Quando o Access está configurado, o Worker:

- lê o token preferencialmente do header `Cf-Access-Jwt-Assertion`
- aceita também `cf-access-token`
- por compatibilidade, aceita `CF_Authorization` no cookie
- busca as chaves públicas em `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
- valida `issuer` com `TEAM_DOMAIN`
- valida `audience` com `POLICY_AUD`

O `TEAM_DOMAIN` deve ser uma URL HTTPS válida. O Worker não fixa o sufixo do domínio no código para evitar acoplamento desnecessário caso a Cloudflare altere formatos de host no futuro.

Esse desenho segue a recomendação atual da documentação da Cloudflare para validação programática de JWT do Access em Workers.

## Passo a passo no Cloudflare Access

### 1. Configurar sua Equipe

Antes de criar qualquer aplicativo, confirme que a sua equipe do Zero Trust já está criada e acessível:

1. Vá em `Zero Trust > Configurações`.
2. Verifique o nome da equipe e a URL base da instância.
3. Use essa URL base depois como valor de `TEAM_DOMAIN` no `wrangler.local.jsonc`.

### 2. Adicionar o provedor de identidade

Antes de publicar a aplicação, conecte pelo menos um provedor de identidade:

1. Vá em `Zero Trust > Integrações > Provedores de Identidade`.
2. Adicione o provedor desejado, por exemplo `One-time PIN` (método mais simples, você recebe um código único por e-mail para acessar).
3. Se preferir, escolha outro provedor compatível com o seu fluxo de acesso (Vai exigir configuração adicional que não será abordada aqui).
4. Conclua a configuração e confirme que o provedor está disponível para uso em políticas.

### 3. Criar a aplicação

No painel da Cloudflare:

1. Vá em `Zero Trust`.
2. Acesse `Controles de Acesso -> Aplicativos`.
3. Clique em `Criar novo aplicativo`.
4. Escolha `Auto-Hospedado e Privado`

#### 3.1. Definir os destinos

Na seção `Destinos`, informe o hostname público do projeto, por exemplo `links.example.com` ou apenas `example.com`.

#### 3.2. Restringir os caminhos protegidos

Adicione apenas os caminhos administrativos e de API que devem exigir autenticação:

- `/admin`
- `/api`
- `/admin/*`
- `/api/*`

Não use `links.example.com/*`, porque isso protegeria também os redirects públicos e bloquearia o acesso aos slugs.

Se você quiser ser estrito com o asset do painel, inclua também `/admin.html` nesse escopo protegido.

#### 3.3. Salvar a aplicação

Revise os dados e salve a aplicação antes de criar as políticas.

#### 3.4. Criar as políticas

Adicione ao menos uma política `Permitir` com os usuários ou grupos autorizados.

Na tela atual, isso fica na área `Políticas de Access`, com os campos principais em um painel lateral à direita:

1. Clique em `Permitir` para criar a política.
2. Defina um `Nome da política` claro, como `allow-admin`.
3. Em `Ação`, mantenha `Permitir`.
4. Em `Regras de política`, use um seletor que identifique quem pode entrar, por exemplo:

- e-mails específicos (Utilizado no metodo `One-time PIN` para acesso por e-mail. Adicione o e-mail do usuário autorizado, por exemplo `user@example.com`)
- domínio de e-mail corporativo
- grupos do provedor de identidade
- contas de login já existentes, como GitHub ou Google Workspace

5. Ajuste a `Duração da sessão da política` conforme sua necessidade (Tempo que a sessão permanece ativa antes de exigir novo login).
6. Salve a política.

Como padrão, aplicações Access são deny-by-default. Sem policy `Allow`, ninguém entra.

### 5. Ajustar sessão e login

Na seção `Autenticação`, configure apenas o que for realmente necessário:

- identity providers desejados
- duração da sessão
- MFA, se necessário
- comportamento de login automático, se quiser experiência mais direta

Se você estiver começando agora, mantenha os padrões até validar a proteção básica do aplicativo.

### 6. Obter o AUD Tag

Depois de salvar a aplicação:

1. Abra a aplicação criada.
2. Procure `Configurações adicionais` ou `Additional settings`.
3. Copie o Token em `Tag de AUD`.

Se o painel mostrar a configuração dentro de `Detalhes`, use esse bloco como referência visual para localizar o AUD.

## Configuração no Worker

Defina os valores abaixo no arquivo `wrangler.local.jsonc`, não no template público:

- `TEAM_DOMAIN`: pegue em `Zero Trust > Configurações` e copie a URL base da sua instância, por exemplo `https://<seu-time>.cloudflareaccess.com`
- `POLICY_AUD`: valor do `AUD` copiado da aplicação

> Importante: `wrangler.local.jsonc` é um arquivo local e não é enviado para o GitHub. Se você apagar a pasta local ou perder o arquivo, o `git pull` não irá restaurá-lo.
>
> Por isso, salve os dados de conexão do Cloudflare (como `TEAM_DOMAIN`, `POLICY_AUD` e `database_id`) em um local seguro, separado do repositório.
>
> Os segredos criados com `npx wrangler secret put API_KEY` permanecem no Cloudflare e não são perdidos ao apagar a pasta local, mas as configurações do `wrangler.local.jsonc` precisam ser recriadas se for apagado.

Se você ainda não criou o arquivo local, rode `npm run wrangler:init` e edite apenas a cópia privada.

## API_KEY opcional

Para chamadas programáticas à API de gestão, o projeto aceita um bearer token simples:

```bash
npx wrangler secret put API_KEY
```

Depois disso, clientes autorizados podem chamar a API com:

```http
Authorization: Bearer <API_KEY>
```

Use esse modo apenas para automações internas. Esse token libera apenas `/api` e `/api/*`; não libera o HTML do `/admin`. Para acesso humano ao painel, prefira sempre Cloudflare Access.

Se você operar múltiplos ambientes, mantenha uma `API_KEY` diferente em cada um. Na Cloudflare, publique um secret distinto por ambiente. Em desenvolvimento local, use arquivos como `.dev.vars.staging` e `.dev.vars.production` quando precisar simular esses cenários.

## Desenvolvimento local

Copie o arquivo de exemplo:

```bash
cp .dev.vars.example .dev.vars
```

Você pode testar com valores vazios para desenvolvimento aberto, ou preencher os campos para simular o comportamento autenticado.

Em produção, valores vazios não mantêm o admin aberto publicamente. O comportamento esperado fora do localhost é falhar fechado até que o Access esteja configurado.

## Checklist de produção

- `TEAM_DOMAIN` configurado
- `POLICY_AUD` configurado
- `API_KEY` configurado apenas se realmente necessário
- aplicação Access criada para o hostname correto
- políticas `Allow` revisadas
- `/admin` bloqueado para usuários não autorizados
- `/admin.html` bloqueado para usuários não autorizados
- `/admin` continua retornando `401` quando apenas `API_KEY` é enviada
- `/api` continua retornando `401` sem Access ou `API_KEY` válido
- `/api/links` retornando `401` ou `403` sem credenciais válidas

## Recomendações de endurecimento

- Não dependa apenas do cookie `CF_Authorization`; prefira o header do Access.
- Não reutilize a mesma `API_KEY` entre ambientes.
- Não documente ou publique valores reais de `TEAM_DOMAIN`, `POLICY_AUD`, `API_KEY` ou `IP_HASH_SECRET` em exemplos públicos.
- Mantenha auditoria das políticas Access fora do código, mas documentada operacionalmente.

---

Versão 1.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
