# Cloudflare Access — instalação e autenticação do Admin

> Escopo: release atual publicada **3.2.0** (`v3.2.0`); release anterior **3.1.1** (`v3.1.1`), congelada. A autenticação do produto permanece Cloudflare Access.

Este é o guia principal para configurar o login de uma instalação nova do BoltLink. A configuração é manual, na conta Cloudflare do operador. Publicar uma GitHub Release não cria Access, não configura variáveis e não atualiza instalações.

## 1. Preparar a instalação e delimitar a proteção

Tenha o Worker implantado pelo fluxo `npm run deploy`, o D1 preparado e o hostname que você realmente usa no navegador. Os exemplos usam `links.example.com` e `administrador@example.com`; substitua-os pelos seus próprios valores.

O BoltLink autoriza estas superfícies administrativas:

| Rota | Finalidade |
| --- | --- |
| `/admin` | entrada do painel |
| `/admin/*` | caminhos abaixo do painel, incluindo `/admin/` |
| `/admin.html` | acesso direto ao HTML do painel |
| `/api` | raiz administrativa da API |
| `/api/*` | endpoints administrativos, incluindo `/api/links` |

Links curtos públicos, como `GET /promocao`, e `GET /` devem continuar acessíveis sem login Access. `/health` e `/version` também são públicos no contrato atual. Uma senha configurada no próprio link continua sendo um recurso independente do Access administrativo.

Use **UMA ÚNICA aplicação Access / UM AUD** para todas as rotas da tabela: o Worker valida um único `POLICY_AUD`. Aplicações independentes para Admin e API normalmente produzem AUDs diferentes e não correspondem a esse contrato.

Para Workers, use proteção por **hostname/path**. Não escolha proteção do Worker inteiro ou de todos os Workers da conta: essas opções também colocariam os redirects públicos atrás do login. A Cloudflare distingue essas formas de proteção em [Access para Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-a-specific-hostname-custom-domain-or-path).

## 2. Criar a organização Zero Trust

1. No Cloudflare Dashboard, abra **Zero Trust**.
2. Se a organização ainda não existe, escolha um **Team Name**, por exemplo `sua-equipe`.
3. Selecione o plano apropriado; para um pequeno operador, confira primeiro o **Zero Trust Free**.
4. Complete o onboarding solicitado. A documentação consultada informa que dados de pagamento são pedidos também no Free, sem cobrança por essa adesão ao plano gratuito. Condições comerciais podem mudar: confira o plano apresentado antes de concluir.

O Team Name é o identificador da organização; ele forma a parte personalizável do Team Domain. Não é o hostname do BoltLink. Fonte: [onboarding Zero Trust](https://developers.cloudflare.com/cloudflare-one/setup/).

## 3. Criar uma aplicação e adicionar os paths

O caminho documentado atualmente é **Zero Trust → Access controls → Applications → Create new application → Self-hosted and private → Add public hostname**.

Dê um nome identificável à aplicação, por exemplo `BoltLink Admin`. Selecione o domínio ativo da sua conta e o subdomínio da instalação. O guia de aplicação pública exige domínio na Cloudflare, com configuração full ou partial/CNAME. Para uma instalação em `workers.dev`, a documentação de Workers também suporta hostname-based Access: use o hostname completo do seu Worker como destino público, mantendo os paths abaixo. Fonte: [criação de aplicação self-hosted pública](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

Repita **Add public hostname** dentro da **mesma aplicação**, com o mesmo hostname e um Path para cada entrada abaixo. A coluna central mostra o destino completo que deve resultar da seleção de hostname e Path; não coloque `https://` no campo de hostname.

| Rota protegida | Destino público ilustrativo | Path |
| --- | --- | --- |
| `/admin` | `links.example.com/admin` | `admin` |
| `/admin/*` | `links.example.com/admin/*` | `admin/*` |
| `/admin.html` | `links.example.com/admin.html` | `admin.html` |
| `/api` | `links.example.com/api` | `api` |
| `/api/*` | `links.example.com/api/*` | `api/*` |

A Cloudflare suporta vários destinos em uma aplicação self-hosted. Todos devem aparecer na mesma aplicação, que terá um único Application Audience (AUD) Tag. Se houver outro hostname usado para o Admin, acrescente seus paths nessa mesma aplicação. Referências: [aplicações com múltiplos domínios](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/#multi-domain-applications) e [destinos públicos da aplicação](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/get/).

O wildcard `admin/*` cobre caminhos abaixo de `/admin/`, mas não o pai `/admin`; por isso ambos estão listados. O mesmo vale para `api/*` e `/api`. Paths mais específicos podem prevalecer sobre regras de um caminho pai: revise aplicações sobrepostas. **Não deixe Path vazio e não cadastre `/` ou `/*` como proteção global**; isso protegeria também os links curtos públicos. Evite `admin*`, que amplia desnecessariamente o prefixo. Fonte: [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

## 4. Autorizar o operador com uma policy Allow

Em **Access policies**, vincule ou crie uma policy com este exemplo mínimo:

| Campo | Valor ilustrativo |
| --- | --- |
| Action | `Allow` |
| Rule type | `Include` |
| Selector | `Emails` |
| Value | `administrador@example.com` |

Use o email real do operador autorizado. Aplicações Access são **deny-by-default**: o usuário precisa corresponder a uma policy Allow. Não use `Everyone` como padrão. Fonte: [Access policies e selectors](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

Selecione um método de login disponível para essa aplicação. One-time PIN, Google ou Microsoft/Entra são opções; nenhum IdP específico é requisito do BoltLink. Usar One-time PIN como método de login não substitui a regra que limita os emails autorizados. Conclua a criação em **Create** e revise os cinco destinos na aplicação.

Se ajustar cookies em Additional settings, mantenha **Cookie Path Attribute** desligado para este fluxo no mesmo hostname: limitar o cookie a `/admin` pode impedir seu envio a `/api`. Fonte: [cookies do Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/#cookie-settings).

## 5. Obter TEAM_DOMAIN e POLICY_AUD

### TEAM_DOMAIN

Em **Zero Trust → Settings**, encontre **Team name and domain**. O **Team Name** é, por exemplo, `sua-equipe`; o **Team Domain** é `sua-equipe.cloudflareaccess.com`. Fonte: [Team Domain / Team Name](https://developers.cloudflare.com/cloudflare-one/faq/getting-started-faq/#what-is-a-team-domainteam-name).

No BoltLink, use a origem HTTPS completa, sem caminho de aplicação:

```text
TEAM_DOMAIN = https://sua-equipe.cloudflareaccess.com
Type = Text
```

Use o domínio da sua organização, não `https://links.example.com`. O BoltLink exige uma origem HTTPS válida para a validação do Access. `TEAM_DOMAIN` é configuração pública, **não Secret**.

### POLICY_AUD

Abra **Zero Trust → Access controls → Applications → aplicação BoltLink → Configure → Additional settings → Application Audience (AUD) Tag**. Copie exatamente o valor para `POLICY_AUD`, sem aspas ou espaços adicionados.

Esse AUD identifica a **aplicação**, não uma senha nem uma policy Allow individual. É variável **Text, não Secret**. Apagar e recriar a aplicação pode mudar o AUD; nesse caso atualize `POLICY_AUD` no Worker. Fonte: [obter o AUD e validar JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag).

O Worker verifica a assinatura do JWT com as chaves públicas da organização, `issuer` com `TEAM_DOMAIN` e `audience` com `POLICY_AUD`. Prefere `Cf-Access-Jwt-Assertion`; aceita `cf-access-token` e o cookie `CF_Authorization` por compatibilidade. Fazer login na Cloudflare não dispensa a validação dentro do Worker.

## 6. Inserir as variáveis no Worker

Para Deploy Button / GitHub Workers Builds, configure **variáveis de runtime**, não variáveis do build:

**Cloudflare Dashboard → Workers & Pages → Overview → seu Worker → Settings → Variables and Secrets → Add**.

Selecione Type, Variable name e Value. Adicione as variáveis abaixo e conclua em **Deploy**, como documentado pela Cloudflare, para disponibilizar os valores ao Worker. Este é um passo operacional da sua instalação. Fonte: [variáveis no dashboard](https://developers.cloudflare.com/workers/configuration/environment-variables/#add-environment-variables-via-the-dashboard).

| Variable name | Type | Valor / uso |
| --- | --- | --- |
| `TEAM_DOMAIN` | `Text` | `https://sua-equipe.cloudflareaccess.com` |
| `POLICY_AUD` | `Text` | Application Audience (AUD) Tag da única aplicação |
| `API_KEY` | `Secret` | opcional para automações API; não faz login no Admin |
| `PASSWORD_SESSION_SECRET` | `Secret` | necessário somente quando a instalação cria/usa/serve links com senha |
| `ROOT_REDIRECT_URL` | `Text` | opcional para redirect de `GET /` |
| `APP_TIMEZONE` | `Text` | normalmente `America/Sao_Paulo` no template atual |

Não copie valores reais para arquivos públicos ou para o Git. Em Workers Builds/Deploy Button, o dashboard é a origem das variáveis operacionais; `wrangler.local.jsonc` não deve sobrescrevê-las. No deploy local via Wrangler, TEAM_DOMAIN/POLICY_AUD podem estar na configuração privada; secrets continuam em Cloudflare Secrets e, no desenvolvimento, em `.dev.vars`. Preserve secrets já existentes ao atualizar.

Salvar TEAM_DOMAIN/POLICY_AUD **não cria Access**. Criar Access **não preenche automaticamente essas variáveis do BoltLink**. Os dois lados precisam coincidir. O template usa `keep_vars=true` para preservar variáveis do dashboard; valores explicitamente definidos no config ainda podem sobrescrever a variável correspondente. Fonte: [Wrangler / source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth).

## 7. Relação com o deploy e as migrations

Na 3.2.0, o fluxo padrão é:

```text
Deploy Button → D1 provisionado → npm run deploy
  → npm run db:migrations:apply
  → migrations pendentes pelo binding db_boltlink
  → somente após sucesso: deploy do Worker
  → configurar Access e variáveis → validar a instalação
```

No Workers Builds, mantenha **Settings → Build → Deploy command = `npm run deploy`**. O script aplica somente pendentes; um D1 já preparado não reaplica migrations concluídas. A tag histórica **v3.1.0** não tinha migrations automáticas no deploy.

O comando `npm run wrangler -- d1 migrations apply db_boltlink --remote` continua disponível para manutenção autorizada. Não é etapa adicional obrigatória de uma instalação nova no fluxo padrão 3.2.0. O runtime não aplica migrations durante requests. Veja [setup Cloudflare](cloudflare-setup.md) e [upgrade](upgrading.md).

## 8. Validar a instalação

Faça os checks abaixo no seu ambiente depois da configuração, com uma sessão sem login prévio para os passos públicos e o desafio Access. Este guia não afirma que qualquer instalação tenha sido testada remotamente pela publicação da release.

1. Abra um link ativo existente, por exemplo `https://links.example.com/promocao`: deve redirecionar sem tela Access. Escolha um link sem senha para testar especificamente o redirect público.
2. Abra `https://links.example.com/`: deve servir a landing ou o redirect da raiz configurado, sem exigir login Access.
3. Abra `/admin`, `/admin.html` e `/admin/`: sem sessão, devem solicitar autenticação Access. Autentique com o email permitido e confirme que o Admin abre.
4. Após autenticar, confirme que o painel carrega `/api/links`. Pode conferir a chamada na aba Network do navegador; deve devolver os dados, não uma página de login ou HTTP 401.
5. Em sessão sem login, confirme que `/api` e `/api/links` também estão sob Access. A raiz `/api` pode não ter endpoint próprio após autenticação; aqui o objetivo é testar a proteção.
6. Abra `/health` sem login: deve continuar público e retornar a resposta de saúde. Isso não substitui a checagem da API/D1.
7. Abra `/version` sem login: deve devolver JSON com `version: "3.2.0"` e o timezone configurado. Confira o hostname correto.

## 9. Troubleshooting

| Sintoma | Verificação e ação |
| --- | --- |
| Admin retorna 401 mesmo depois do login | Confira TEAM_DOMAIN HTTPS, POLICY_AUD copiado integralmente e o AUD da aplicação que realmente cobre esse hostname/path. Depois de corrigir valores, abra uma nova sessão e valide de novo. |
| Cloudflare autentica, mas o Worker rejeita | A autenticação no IdP e a validação do JWT são etapas distintas. Compare a aplicação Access, seu AUD e Team Domain com POLICY_AUD/TEAM_DOMAIN do Worker; confira se não há outra aplicação sobreposta. |
| Redirect público pede login | A proteção está ampla demais. Revise Path vazio, `/`, `/*`, aplicações sobrepostas e proteção do Worker inteiro/da conta; limite os destinos às rotas administrativas. |
| `/admin` abre, mas `/api` falha | Confirme `/api` e `/api/*` na MESMA aplicação Access e sob o mesmo AUD; confira Cookie Path Attribute e a sessão do browser. |
| Aplicação Access apagada e recriada | Copie novamente o Application Audience (AUD) Tag e atualize POLICY_AUD no Worker. |
| `503 Database schema is not initialized` | Confira o log do build e Deploy command. `npx wrangler deploy` ignora o encadeamento do package: troque por `npm run deploy` para aplicar migrations pendentes antes do Worker. Se o apply falhou, corrija a causa no D1 alvo antes de repetir o deploy autorizado. |

O bypass local em `localhost`, `127.0.0.1` e `[::1]` serve apenas para desenvolvimento. `Authorization: Bearer <API_KEY>` é aceito pelo Worker somente em `/api` e `/api/*`; não substitui as policies do Access na borda e não autoriza o HTML do Admin. Não use esse mecanismo para evitar corrigir a aplicação Access.

## Referências e responsabilidade

Instruções de UI e condições de onboarding conferidas na documentação oficial em **7 de outubro de 2026**. Os links próximos de cada etapa são as fontes; nomes de telas e condições podem evoluir. O operador é responsável pelas policies, IdP, sessões, MFA externo e configurações da própria instalação.

Release atual publicada: 3.2.0 · Tag: v3.2.0 · Release anterior: 3.1.1
Criado por Vitor Faustino - vitorfaustino.com.br
