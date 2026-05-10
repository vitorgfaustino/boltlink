# Catálogo de Pedidos Aceitos pela IA

Este documento é o contrato de entrada da operação guiada por IA.
Se um pedido não estiver listado aqui, a IA deve pedir reformulação ou mapear para a intenção mais próxima.

## Regras de uso

- Se a IA estiver chegando do zero, use `AI-START.md` como porta de entrada antes de mapear a solicitação.
- Aceite linguagem natural em português e inglês.
- Não invente valores que o usuário não forneceu.
- Faça no máximo uma pergunta de cada vez quando faltar contexto.
- Se a solicitação envolver domínio, banco ou Access, confirme os campos obrigatórios antes de agir.
- Se a solicitação envolver arquivo sensível, explique o impacto antes de editar.
- O template público fica em `wrangler.jsonc`; os valores reais devem ficar em `wrangler.local.jsonc`, que não entra no Git.
- Branding e overlays visuais do projeto atual devem ser preservados por padrão; a IA só pode substituir `public/admin.html`, `public/logo.png` e `public/favicon.ico` quando o usuário pedir explicitamente.
- Antes de prometer obtenção do projeto, instalação de Git ou execução local, confirme que a plataforma suporta essas ações.
- Se a pasta atual já for o projeto do usuário, a IA não pode criar um clone aninhado do BoltLink dentro dela nem copiar a pasta `.git` do repositório oficial para a árvore final.

## Catálogo

| Chave | Frases aceitas | O que a IA deve pedir | O que pode automatizar | Onde parar |
| --- | --- | --- | --- | --- |
| `iniciar_projeto` | `Iniciar o Projeto`, `start the project`, `colocar o projeto em operação`, `iniciar setup` | Se a pasta atual já é a raiz final do projeto, se ela já possui `.git` do usuário, se o usuário quer começar em `workers.dev` ou domínio próprio, nome do banco D1, e se o Wrangler já está autenticado | Obter o conteúdo do projeto na raiz correta sem herdar `.git` do upstream, instalar dependências, gerar tipos, criar D1, aplicar migrations locais, preparar deploy inicial, validar testes | Antes da criação final do Access e antes de qualquer mudança de domínio que dependa do dashboard |
| `continuar_configuracao` | `Continuar configuração do projeto`, `retomar setup`, `o que falta?`, `resume setup` | Em qual etapa o processo parou e qual foi o último comando executado | Ler o estado atual, retomar o próximo passo, corrigir arquivos de configuração | Quando houver um checkpoint manual pendente |
| `atualizar_projeto` | `Atualizar o projeto`, `update the project`, `pull latest version`, `buscar nova versão` | Se o repositório está limpo ou se existem mudanças locais que precisam ser preservadas; se o usuário quer atualizar só o código ou também dependências e tipos | Verificar o estado do Git, fazer `git pull --ff-only` quando seguro, instalar dependências, criar ou preservar `wrangler.local.jsonc`, regenerar tipos, executar o checklist pós-atualização e orientar migrations | Antes de sobrescrever qualquer mudança local não versionada ou antes de avançar se houver conflitos |
| `auditar_estado_operacional` | `Auditar estado operacional`, `check status`, `what is missing?`, `verificar operação` | Se o foco é deploy, domínio, D1 ou Access; se não disser, usar o repositório inteiro | Ler arquivos principais, comparar com o estado operacional esperado, listar pendências | Não há parada especial; é um pedido de leitura e diagnóstico |
| `configurar_d1` | `Criar banco D1 chamado X`, `configurar banco`, `create the D1 database`, `criar D1` | Nome do banco, binding desejado, se o banco já existe, se quer atualizar `wrangler.local.jsonc` automaticamente | Executar `wrangler d1 create`, atualizar config local, gerar tipos | Antes de alterar migrations remotas ou tocar em produção |
| `aplicar_migrations` | `Aplicar migrations`, `rodar migrations`, `apply database migrations` | Nome do banco e se o alvo é `local`, `remote` ou ambos | Rodar `wrangler d1 migrations apply` no alvo indicado | Se houver erro de schema ou se o usuário precisar confirmar a origem do banco |
| `publicar_workers_dev` | `Publicar no workers.dev`, `deploy inicial`, `subir no workers.dev` | Se o usuário quer manter `workers_dev` habilitado e se já executou testes | Rodar deploy padrão e validar endpoint público | Se o deploy exigir custom domain ou alterações de Access |
| `publicar_com_deploy_button` | `Deploy to Cloudflare Workers`, `publicar com o botão da Cloudflare`, `usar o botão de deploy`, `one-click deploy` | Se o usuário quer usar o `workers.dev` padrão ou planeja trocar para domínio próprio depois; se já sabe que o Access do admin será configurado manualmente após o deploy | Orientar o uso do botão, revisar `wrangler.jsonc`, revisar placeholders públicos e preparar checklist de pós-deploy | Antes da criação final do Access, da configuração do domínio próprio e de qualquer secret opcional |
| `configurar_dominio_customizado` | `Configurar domínio`, `usar domínio próprio`, `add custom domain`, `publicar em links.example.com` | Hostname alvo, zone da Cloudflare, se é root ou subdomínio, se quer manter `workers.dev` como fallback | Atualizar `wrangler.local.jsonc`, preparar checklist de DNS/rota, validar o endpoint | Antes de qualquer passo manual no dashboard ou de mudanças em Access |
| `mudar_dominio` | `Mudar domínio para links.example.com`, `trocar domínio`, `change domain`, `switch hostname` | Hostname atual, hostname novo, se será `custom_domain` ou `route`, se existe CNAME conflitante, se o Access também vai mudar | Atualizar `wrangler.local.jsonc`, orientar a troca e preparar validação | Antes da alteração do dashboard e antes de remover o hostname anterior |
| `preparar_access` | `Preparar Access`, `proteger admin`, `setup Cloudflare Access`, `configure access` | Hostname do admin, `TEAM_DOMAIN`, `POLICY_AUD`, e se a aplicação Access já existe | Orientar leitura, validar variáveis e preparar checklist | Sempre antes da criação final da aplicação Access |
| `validar_deploy` | `Validar deploy`, `check production`, `validar publicação`, `verificar produção` | Qual endpoint deve ser testado, se o foco é público ou admin | Testar saúde, redirect, admin e API, conforme o caso | Se faltar credencial ou acesso ao dashboard |

## Perguntas obrigatórias para troca de domínio

Quando o usuário pedir para mudar domínio, a IA deve perguntar, nesta ordem e sem pular etapas:

1. Qual é o hostname atual?
2. Qual é o hostname final desejado?
3. O destino será `workers.dev`, `route` ou `custom domain`?
4. O zone correspondente já existe e está ativo na Cloudflare?
5. Existe algum CNAME ou outro registro DNS que precise sair do caminho?
6. O admin vai continuar no mesmo hostname ou também vai mudar?
7. O usuário quer manter `workers.dev` como fallback durante a transição?
8. O Access já está configurado para o hostname novo, ou isso ainda será feito depois?

Se faltar qualquer uma dessas respostas, a IA deve perguntar apenas a próxima que estiver faltando.

## Exemplos de roteamento

- `Iniciar o Projeto` -> usar `iniciar_projeto`.
- `Atualizar o Projeto` -> usar `atualizar_projeto`.
- `Mudar domínio para links.example.com` -> usar `mudar_dominio`.
- `Configurar o D1 primeiro` -> usar `configurar_d1`.
- `Preciso saber o que falta para publicar` -> usar `auditar_estado_operacional`.
- `Quero preparar o Access, mas ainda não criar` -> usar `preparar_access`.
- `Quero publicar com o botão da Cloudflare` -> usar `publicar_com_deploy_button`.

### Notas para `atualizar_projeto`

- O repositório oficial `https://github.com/vitorgfaustino/boltlink` é a fonte de novidades e segurança.
- Ao atualizar projetos derivados, preserve os arquivos locais e visuais do projeto em uso, especialmente `wrangler.local.jsonc`, `public/admin.html`, `public/logo.png` e `public/favicon.ico`, salvo confirmação do usuário para substituí-los.
- Se houver dúvida sobre qual repositório é o alvo, a IA deve ler `AI-START.md` e confirmar o `git remote` antes de puxar mudanças.

### Notas para `iniciar_projeto`

- O repositório oficial `https://github.com/vitorgfaustino/boltlink` é a fonte de template e novidades, mas não deve assumir automaticamente o papel de repositório Git final do usuário.
- Se a pasta atual já tiver `.git`, a IA deve tratá-la como a raiz do projeto do usuário e não pode clonar o BoltLink dentro dela.
- Se a IA precisar usar uma origem temporária para obter o projeto, essa origem deve ficar fora da árvore final do usuário e a cópia final deve excluir a pasta `.git` do upstream.
- O resultado esperado para `iniciar_projeto` é conteúdo do BoltLink na raiz operacional correta, sem subpasta `boltlink/` indevida e sem `.git` herdado.

### Notas para `publicar_com_deploy_button`

- O `wrangler.jsonc` público deve continuar sanitizado e compatível com deploy automático em `workers.dev`.
- O botão não executa a criação final do Cloudflare Access nem publica secrets opcionais como `API_KEY` ou `IP_HASH_SECRET`.
- O deploy pode provisionar o D1 automaticamente, e o schema base pode ser criado na primeira operação que usa o banco.
- O handoff obrigatório depois do botão é configurar Access para `/admin`, `/admin.html`, `/api` e `/api/*`, revisar `TEAM_DOMAIN` e `POLICY_AUD`, opcionalmente publicar `IP_HASH_SECRET`, e opcionalmente trocar para domínio próprio.

## Critério de rejeição

A IA deve recusar ou reformular quando:

- o pedido tentar mudar slug já criado;
- o pedido pedir a criação automática do Access sem participação do usuário;
- o pedido tentar substituir a fonte de verdade do Wrangler por outro arquivo paralelo;
- o pedido exigir um valor sensível que o usuário ainda não informou;
- o pedido estiver fora do escopo operacional do projeto.

---

Versão 1.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
