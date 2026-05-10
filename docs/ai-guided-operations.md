# Operação Guiada por IA

Este documento define o fluxo canônico para qualquer IA que ajude a colocar o BoltLink em operação.
Ele é vendor-neutral: pode ser usado por Copilot, por outro chat dentro do editor ou por automações futuras.

## Objetivo

Guiar o usuário da primeira execução até o deploy final com o mínimo de atrito, sem adivinhar dados e sem ultrapassar os pontos que exigem ação manual na Cloudflare.

## Regras canônicas

- Se a IA estiver começando sem contexto do repositório, leia primeiro [AI-START.md](../AI-START.md).
- Comece pelo catálogo de pedidos aceitos em [docs/ai-accepted-requests.md](ai-accepted-requests.md).
- Se a solicitação não estiver no catálogo, peça que o usuário reformule usando um item existente.
- Leia primeiro [package.json](../package.json), [wrangler.jsonc](../wrangler.jsonc), [docs/cloudflare-setup.md](cloudflare-setup.md), [docs/admin-auth.md](admin-auth.md) e [src/index.ts](../src/index.ts).
- Antes de prometer automação local, confirme se a plataforma consegue acessar arquivos, executar comandos e obter o conteúdo do repositório quando ele ainda não existir na raiz final do projeto.
- Se existir, leia também [wrangler.local.jsonc](../wrangler.local.jsonc) e trate-o como a configuração real do ambiente local.
- Pergunte apenas um dado faltante por vez.
- Antes de rodar qualquer comando mutável ou editar arquivo, explique o que vai mudar e peça confirmação.
- Antes de atualizar um clone já existente, verifique o estado do Git; se houver mudanças locais fora de `wrangler.local.jsonc`, pare e peça confirmação antes de puxar a nova versão.
- Mantenha [wrangler.jsonc](../wrangler.jsonc) como template público sanitizado e [wrangler.local.jsonc](../wrangler.local.jsonc) como configuração privada fora do Git.
- Em projetos derivados já em uso, preserve também os valores individualizados do [wrangler.jsonc](../wrangler.jsonc), especialmente `name`, `routes`, `workers_dev`, `preview_urls`, `d1_databases` e bindings já conectados ao Worker atual, a menos que o usuário peça substituição explícita.
- Quando o projeto estiver em deploy automático por GitHub ou botão da Cloudflare, trate `TEAM_DOMAIN` e `POLICY_AUD` do painel do Worker como fonte de verdade. Quando o deploy for manual local com `npm run deploy`, o `wrangler.local.jsonc` pode publicar esses valores.
- Se o pedido envolver o botão `Deploy to Cloudflare Workers`, trate [wrangler.jsonc](../wrangler.jsonc) como a configuração pública de deploy e deixe os passos de Cloudflare Access como handoff manual pós-deploy.
- Nunca crie clone aninhado do BoltLink dentro da pasta final do usuário.
- Nunca deixe a pasta `.git` do repositório oficial dentro da árvore final de um projeto derivado.
- Trate arquivos de branding e overlays visuais do projeto atual como propriedade do usuário por padrão; não substitua `public/admin.html`, `public/logo.png` ou `public/favicon.ico` sem confirmação explícita.
- Nunca assuma que o remoto do repositório oficial será o remoto final de push do usuário.
- Depois de alterar bindings, rode `npm run cf-typegen`.
- Se alterar schema, atualize [schema.sql](../schema.sql) e a migration correspondente.
- Não tente automatizar a criação final do Cloudflare Access; pare no checklist e entregue o handoff ao usuário.
- Não persista IP em texto puro.
- Não altere o slug depois da criação.
- O redirect público deve continuar respondendo antes da gravação de analytics.

## Protocolo padrão

1. Confirme se a IA tem capacidade real de operar no ambiente atual.
2. Classifique a intenção do usuário.
3. Identifique a raiz operacional correta e verifique se ela já possui `.git` ou arquivos existentes.
4. Colete apenas os campos obrigatórios que estiverem faltando.
5. Leia o estado atual do repositório ou da pasta final escolhida.
6. Execute comandos automatizáveis e edite arquivos quando necessário.
7. Valide que não houve criação de clone aninhado nem herança indevida de `.git`.
8. Faça pausas explícitas nos checkpoints manuais da Cloudflare.
9. Valide o resultado.
10. Encerre com um resumo curto do que foi feito e do que ainda depende do usuário.

## Decidir método de deploy

Antes de qualquer deploy, atualização ou configuração de variáveis, a IA deve sempre perguntar ao usuário:

> **"Como você publica o projeto?"**

### Opções de método

1. **GitHub auto-deploy** — o Worker na Cloudflare está conectado ao repositório GitHub e faz deploy automático a cada push.
2. **Deploy local com Wrangler** — você publica manualmente da sua máquina com `npm run deploy`.
3. **Ambos** — usa GitHub para deploys normais, mas às vezes publica localmente para testes.
4. **Ainda não sei / primeira vez** — ainda não publicou o projeto.

### Como detectar se o usuário não souber

- **GitHub auto-deploy**: o repositório tem `.git` com um remoto configurado; o Worker na Cloudflare mostra conexão com GitHub.
- **Deploy local**: existe `wrangler.local.jsonc` com `database_id` real ou outros valores de produção.
- **Ambos**: ambos os sinais estão presentes.

### Regras por método

| Método | TEAM_DOMAIN e POLICY_AUD | keep_vars | vars no local config |
|--------|--------------------------|-----------|----------------------|
| GitHub auto-deploy | **Apenas no painel do Worker** na Cloudflare | `true` no template público | **Remover** do `wrangler.local.jsonc` |
| Deploy local | Podem estar no painel OU no `wrangler.local.jsonc` | `true` no local | Somente com valores reais; nunca vazio |

### Regra de ouro

> **Nunca deixe `vars` com valores vazios em nenhuma configuração.** Strings vazias (`""`) sobrescrevem os valores do painel do Worker durante o deploy.

### Checklist antes de deploy

1. Verificar se `wrangler.jsonc` tem `keep_vars: true`.
2. Verificar se `wrangler.local.jsonc` (se existir) NÃO tem `vars.TEAM_DOMAIN` ou `vars.POLICY_AUD` vazios.
3. Se o método for GitHub auto-deploy, remover `vars` completamente do `wrangler.local.jsonc`.
4. Se o método for deploy local, `vars` só pode existir se tiver valores reais preenchidos.

## Intenções suportadas

As intenções abaixo são a camada operacional principal. O catálogo completo de frases aceitas, perguntas obrigatórias e exemplos de entrada vive em [docs/ai-accepted-requests.md](ai-accepted-requests.md).

### Iniciar o projeto

Use quando o usuário quiser sair do zero ou retomar o bootstrap do ambiente local e da Cloudflare.

Fluxo típico:

1. Identificar a raiz final do projeto e verificar se a pasta atual já possui `.git` próprio do usuário.
2. Se a pasta atual já for o projeto do usuário, não clonar o BoltLink dentro dela; obter apenas o conteúdo do template sem a pasta `.git` do upstream.
3. Se a pasta atual estiver vazia e ela já for a raiz final, obter o conteúdo diretamente nela, sem criar subpasta `boltlink`.
4. Se a pasta final ainda não existir, criar a pasta final escolhida pelo usuário e obter o conteúdo nela.
5. Validar que o resultado final não criou `nested repo`, não trouxe `.git` herdado e não apontou `origin` automaticamente para o upstream oficial como remoto final de push do usuário.
6. Confirmar se o usuário quer começar em `workers.dev` ou em domínio próprio.
7. Confirmar se o Wrangler já está autenticado.
8. Confirmar se o arquivo `wrangler.local.jsonc` já existe.
9. Instalar dependências, criar o config local se necessário, gerar tipos, criar ou reaproveitar o D1, aplicar migrations e validar localmente.
10. Parar antes de qualquer etapa manual de Access ou domínio que exija navegação no dashboard.

Se o usuário optar pelo botão `Deploy to Cloudflare Workers`, a IA pode pular a criação manual inicial do D1 e orientar o deploy com o `wrangler.jsonc` público. Nesse caso, a IA deve deixar explícito que:

- o D1 pode ser provisionado automaticamente no deploy;
- o schema base é inicializado automaticamente na primeira operação que toca o banco;
- o Access para `/admin`, `/admin.html`, `/api` e `/api/*` continua sendo etapa manual.

### Aquisição segura do projeto

Antes de qualquer `npm install`, a IA deve passar por esta árvore de decisão:

1. A pasta atual já tem `.git`?
2. A pasta atual já é a raiz final desejada pelo usuário?
3. Os arquivos do BoltLink já estão presentes nessa raiz?

Com base nisso:

- se a resposta for “sim” para `.git` e para raiz final, a IA não pode clonar o upstream dentro dessa pasta;
- se a raiz final já existe e está vazia, a IA deve obter o conteúdo diretamente nela;
- se a raiz final ainda não existe, a IA deve criá-la explicitamente antes de obter o conteúdo.

Mecanismos aceitáveis incluem cópia apenas do working tree, snapshot sem metadados Git ou uso de diretório temporário fora da árvore final seguido de cópia apenas dos arquivos necessários.

Antes de prosseguir, a IA deve validar:

- que não existe subpasta `boltlink/` criada indevidamente dentro da raiz final;
- que não existe `.git` do upstream na árvore final;
- que os arquivos esperados do projeto estão posicionados na raiz correta.

### Continuar configuração

Use quando o usuário já começou o setup e quer voltar de um ponto específico.

Fluxo típico:

1. Descobrir em qual etapa o processo parou.
2. Identificar arquivos já alterados e comandos já executados.
3. Retomar apenas o próximo passo necessário.
4. Validar antes de avançar para o próximo checkpoint.

### Atualizar o projeto

Use quando o usuário quiser buscar a versão mais recente do repositório e manter os dados locais seguros.

Fluxo típico:

1. Confirmar que o remoto consultado é o repositório oficial `https://github.com/vitorgfaustino/boltlink`.
2. Verificar o estado do Git com `git status --short`.
3. Confirmar se há mudanças locais que precisam ser preservadas, especialmente fora de `wrangler.local.jsonc`, do `wrangler.jsonc` individualizado do projeto atual e dos overlays visuais.
4. Preservar explicitamente os arquivos locais e visuais que pertencem ao projeto em uso, especialmente `wrangler.local.jsonc`, os valores reais já definidos em `wrangler.jsonc` como `name`, `routes`, `workers_dev`, `preview_urls`, `d1_databases` e bindings do Worker atual, `public/admin.html`, `public/logo.png` e `public/favicon.ico`, a menos que o usuário peça substituição.
5. Se o trabalho estiver limpo, executar `git fetch origin` e depois `git pull --ff-only` para trazer apenas a nova versão sem merge inesperado.
6. Se houver divergência em arquivos de overlay ou configuração local, parar e pedir confirmação antes de aplicar a atualização.
7. Rodar `npm install` para atualizar dependências.
8. Rodar `npm run wrangler:init` para garantir que a cópia local continue existindo sem tocar no template público.
9. Rodar `npm run cf-typegen` se houver chance de mudança de bindings.
10. Rodar `npm test` e, se houver migrations novas, aplicá-las no ambiente local e orientar o remoto quando necessário.
11. Reiniciar `npm run dev` se o projeto estiver ativo.

### Checklist pós-atualização

Depois de cada sincronização, confirme sempre estes pontos antes de considerar o update concluído:

1. `wrangler.local.jsonc` continua preservado como configuração local privada e `wrangler.jsonc` manteve os valores individualizados do projeto.
2. `src/index.ts` continua com as regras de auth, rotas e segurança do projeto em uso.
3. `public/admin.html`, `public/logo.png` e `public/favicon.ico` não foram sobrescritos sem confirmação explícita.
4. Se houve alteração de binding, `npm run cf-typegen` foi executado.
5. `npm test` passou após a atualização.
6. A árvore do projeto não ganhou clone aninhado nem `.git` herdado do upstream.
7. O endpoint público e o acesso do admin continuam coerentes com o comportamento esperado.

### Auditar estado operacional

Use quando o usuário quiser saber o que está pronto, o que falta e o que está inconsistente.

Fluxo típico:

1. Ler a configuração atual.
2. Comparar comandos, bindings, docs e autenticação.
3. Listar pendências em ordem de execução.
4. Sugerir o próximo pedido aceito, se existir.

### D1 e migrations

Use para criar banco novo, reaproveitar banco existente ou aplicar migrations local e remotamente.

Fluxo típico:

1. Confirmar nome do banco e binding desejado.
2. Criar o banco com `npm run wrangler -- d1 create` quando necessário.
3. Atualizar `wrangler.local.jsonc` se o comando não fizer isso automaticamente.
4. Rodar `npm run cf-typegen`.
5. Aplicar migrations localmente e depois remotamente, se o deploy já for produção.

### Domínio

Use para publicar no `workers.dev`, adicionar custom domain ou trocar o hostname público.

Fluxo típico:

1. Confirmar hostname atual, hostname novo e tipo de rota desejada.
2. Confirmar se o zone está ativo na Cloudflare.
3. Confirmar se há CNAME ou registro conflitante.
4. Atualizar `wrangler.local.jsonc` com `route` ou `routes[].custom_domain` conforme o caso.
5. Validar o endpoint antes de trocar o Access do admin, se houver.

### Cloudflare Access

Use para preparar o handoff de autenticação do admin e da API.

Fluxo típico:

1. Confirmar o hostname administrativo.
2. Confirmar `TEAM_DOMAIN` e `POLICY_AUD`.
3. Explicar como criar a aplicação Access e a política `Allow`.
4. Parar antes da criação final da aplicação, porque essa etapa é responsabilidade do usuário.
5. Validar o login depois que o usuário concluir o dashboard.

## Checklist de conclusão

A operação pode ser considerada concluída quando:

- `wrangler.jsonc` está coerente como template público e `wrangler.local.jsonc` contém os valores reais do ambiente escolhido.
- `npm run cf-typegen` já foi executado após qualquer mudança de binding.
- `npm test` passa, quando houver alteração de código ou configuração relevante.
- O endpoint público responde corretamente.
- O acesso do admin foi validado ou o usuário recebeu o handoff manual para concluir o Access.
- A árvore final do projeto não contém clone aninhado do upstream nem `.git` herdado do repositório oficial.

## Handoff seguro

Quando chegar em uma etapa manual, a IA deve sempre informar:

- qual tela ou seção do dashboard o usuário precisa abrir;
- qual valor precisa copiar ou confirmar;
- qual resultado esperado indica que a etapa terminou;
- qual é o próximo passo assim que o usuário voltar ao chat.

---

Versão 1.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
