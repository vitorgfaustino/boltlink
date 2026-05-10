# AI-START

Este arquivo é o ponto único de entrada para qualquer IA que vá ajudar a colocar o BoltLink em operação.

Use este repositório oficial:

- `https://github.com/vitorgfaustino/boltlink`

## Objetivo

Permitir que uma IA:

- obtenha o conteúdo do projeto na raiz correta quando a plataforma suportar isso, sem herdar o `.git` do repositório oficial para dentro do projeto derivado do usuário;
- instale dependências e execute o setup inicial quando tiver acesso real a terminal;
- conduza o pedido `Iniciar o Projeto` sem exigir que o usuário entenda Git, Wrangler ou Cloudflare logo no começo;
- pare nos checkpoints manuais que dependem do dashboard da Cloudflare.

## Regra principal

Antes de prometer qualquer automação, a IA deve verificar se ela realmente consegue:

- acessar arquivos locais;
- executar comandos no terminal;
- instalar dependências;
- instalar Git, se ele não existir no sistema;
- obter o conteúdo do repositório oficial sem deixar um `.git` herdado dentro do projeto final do usuário.

Se a plataforma não permitir isso, a IA deve dizer explicitamente essa limitação e continuar apenas como guia passo a passo.

## Ordem obrigatória de leitura

Antes de agir, leia nesta ordem:

1. `AGENTS.md`
2. `docs/ai-accepted-requests.md`
3. `docs/ai-guided-operations.md`

Leia também quando necessário:

- `docs/cloudflare-setup.md`
- `docs/admin-auth.md`
- `README.md`

## Regra crítica para aquisição do projeto

O repositório oficial `https://github.com/vitorgfaustino/boltlink` é a fonte de template, novidades e segurança, mas não deve se tornar automaticamente o repositório Git final do usuário.

Antes de obter o projeto, a IA deve identificar em qual cenário está trabalhando:

1. Se a pasta atual já possui `.git`, trate essa pasta como o repositório do usuário e não clone o BoltLink dentro dela.
2. Se a pasta atual está vazia e ela já é a raiz final desejada, obtenha o conteúdo diretamente nela, sem criar uma subpasta `boltlink`.
3. Se a pasta final ainda não existe, crie a pasta final escolhida pelo usuário e obtenha o conteúdo nela.

Em qualquer cenário, o resultado obrigatório é:

- arquivos do BoltLink na raiz operacional correta;
- nenhum `.git` do repositório oficial dentro da árvore final do projeto derivado;
- nenhum clone aninhado como `meu-projeto/boltlink/.git`;
- nenhum `origin` do repositório oficial assumido como remoto final de push do usuário.

Se a IA precisar usar uma origem temporária para copiar o projeto, essa origem deve ficar fora da pasta final do usuário. Depois, a IA deve mover ou copiar apenas o conteúdo necessário, nunca a pasta `.git` do upstream.

## Prompt universal recomendado

Se a plataforma permitir colar uma instrução inicial grande, use este texto como ponto de partida:

```text
Você está operando o projeto BoltLink a partir do repositório oficial https://github.com/vitorgfaustino/boltlink.

Leia primeiro AI-START.md, depois AGENTS.md, docs/ai-accepted-requests.md e docs/ai-guided-operations.md.

Antes de prometer automação, confirme se você realmente consegue acessar arquivos, usar terminal, instalar dependências, instalar Git se necessário e obter o conteúdo do repositório oficial sem herdar a pasta `.git` do upstream.

Antes de obter o projeto, descubra se a pasta atual já é a raiz do projeto do usuário. Se ela já tiver `.git`, não clone o BoltLink dentro dela e não crie uma subpasta `boltlink`. Traga apenas o conteúdo do template para a raiz correta, sem herdar a pasta `.git` do repositório oficial.

Se conseguir operar localmente, siga o fluxo aceito para o pedido "Iniciar o Projeto" e faça apenas uma pergunta por vez quando faltar contexto.

Se não conseguir operar localmente, diga essa limitação de forma explícita e continue como guia passo a passo, sem inventar resultados.

Preserve wrangler.jsonc como template público, mas em projetos derivados não sobrescreva valores já individualizados como `name`, `routes`, `workers_dev`, `preview_urls` ou bindings do Worker atual; use wrangler.local.jsonc como configuração privada local, trate `TEAM_DOMAIN` e `POLICY_AUD` do painel do Worker como fonte de verdade quando o projeto usar deploy automático por GitHub ou botão da Cloudflare, e pare nos checkpoints manuais da Cloudflare.
```

## Compatibilidade prática

Este arquivo foi pensado para funcionar bem em agentes como:

- GitHub Copilot Chat
- Claude Code
- Codex e agentes equivalentes com acesso a terminal

Se a ferramenta não conseguir ler arquivos do repositório automaticamente, entregue o conteúdo deste arquivo diretamente no prompt inicial.

## Como a IA deve começar

1. Confirmar se está trabalhando no repositório oficial `https://github.com/vitorgfaustino/boltlink`.
2. Verificar se a pasta atual já é a raiz final do projeto do usuário e se ela já possui `.git`.
3. Verificar se os arquivos do projeto já foram obtidos nessa raiz.
4. Se o conteúdo ainda não existir, obter apenas os arquivos do projeto na raiz correta, sem criar clone aninhado nem copiar a pasta `.git` do repositório oficial para dentro do projeto derivado.
5. Mapear o pedido do usuário para uma intenção aceita em `docs/ai-accepted-requests.md`.
6. Se o pedido for uma primeira instalação, usar a intenção `Iniciar o Projeto`.
7. Se o pedido for `Atualizar o Projeto`, buscar novidades no repositório oficial acima e preservar os arquivos de overlay do projeto atual e as configurações individualizadas do Worker, em especial `wrangler.local.jsonc`, os valores reais já definidos em `wrangler.jsonc` como `name`, `routes`, `workers_dev`, `preview_urls` e bindings, `public/admin.html`, `public/logo.png` e `public/favicon.ico`. Ao atualizar, garanta a integridade da licença AGPL-3.0 inserindo as menções obrigatórias e os headers em todo o código-fonte (arquivos .ts, .html, .sql) e atualizando rodapés, sem apagar os overlays visuais do usuário.
8. Antes de aplicar qualquer atualização, comparar o estado local com o remoto e pedir confirmação se houver divergência em arquivos que não fazem parte do template público puro, especialmente branding, overlays visuais e identidade operacional do Worker atual.
9. Fazer apenas uma pergunta por vez quando faltar contexto obrigatório.
10. Seguir o protocolo de execução em `docs/ai-guided-operations.md`.

## Primeira resposta esperada da IA

Na primeira resposta, a IA deve deixar claro:

- se ela consegue ou não operar no ambiente local;
- se a pasta atual já é a raiz final do projeto e se ela já possui `.git` próprio;
- se o conteúdo do BoltLink já existe ou ainda precisa ser obtido com segurança;
- qual intenção aceita ela identificou para o pedido do usuário;
- qual é a próxima ação concreta ou a próxima pergunta única necessária.

## Pedidos de entrada recomendados

Exemplos de pedidos que a IA deve reconhecer:

- `Iniciar o Projeto`
- `Continuar configuração do projeto`
- `Atualizar o Projeto`
- `Auditar estado operacional`
- `Configurar D1`
- `Preparar Access`
- `Validar deploy`
- `Publicar com o botão da Cloudflare`

## Regras operacionais importantes

- Não invente valores que o usuário não forneceu.
- Peça confirmação antes de comandos mutáveis quando o contexto não estiver explícito.
- Preserve `wrangler.jsonc` como template público sanitizado no repositório oficial, mas em projetos derivados preserve também os valores individualizados já definidos para o Worker atual, especialmente `name`, `routes`, `workers_dev`, `preview_urls` e bindings reais.
- Use `wrangler.local.jsonc` como configuração local privada quando ele existir.
- Nunca trate o Git como backup de arquivos locais privados.
- Nunca crie um clone aninhado do BoltLink dentro da pasta final do projeto do usuário.
- Nunca deixe a pasta `.git` do repositório oficial dentro da árvore final de um projeto derivado.
- Nunca assuma que o remoto `origin` do repositório oficial será o remoto de push final do usuário.
- Se o pedido for usar o botão `Deploy to Cloudflare Workers`, trate `wrangler.jsonc` como a configuração pública de deploy e explique que Cloudflare Access para `/admin`, `/admin.html` e `/api/*` continua sendo etapa manual de pós-deploy.
- Não automatize a criação final do Cloudflare Access; faça o handoff e valide depois.
- Trate `public/admin.html`, `public/logo.png`, `public/favicon.ico` e qualquer ajuste visual já existente como branding do usuário por padrão; nunca substitua esses arquivos sem confirmação explícita.

## Arquivos locais que não vão para o Git

Os arquivos locais privados não são restaurados por `git pull`.

Em especial:

- `wrangler.local.jsonc`
- `.wrangler/`
- `.dev.vars` quando existir localmente

Se esses arquivos forem apagados, a IA deve explicar que será necessário recriar a configuração local e preencher novamente os valores operacionais.

Os segredos enviados para a Cloudflare com `npx wrangler secret put ...` continuam na Cloudflare, mas não substituem o conteúdo de `wrangler.local.jsonc`.

## Resultado esperado

Ao seguir este arquivo, a IA deve conseguir:

- descobrir o fluxo correto sem duplicar a documentação existente;
- usar `docs/ai-accepted-requests.md` como contrato de entrada;
- usar `docs/ai-guided-operations.md` como runbook canônico;
- usar `AGENTS.md` como guardrail do repositório.
- obter o conteúdo do projeto na raiz correta sem criar `nested repo` nem herdar o `.git` do upstream.

---

Versão 1.0.0
Criado por Vitor Faustino - vitorfaustino.com.br