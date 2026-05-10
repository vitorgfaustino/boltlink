---
name: boltlink-operations
description: Guide BoltLink setup, update, deployment, domain changes, and Cloudflare handoff from natural-language prompts such as "Iniciar o Projeto", "Atualizar o Projeto", "mudar domínio", "configurar D1", "publicar na Cloudflare", or "validar deploy".
argument-hint: "[pedido operacional em linguagem natural]"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion
---

<objective>
Transforma pedidos operacionais em um fluxo guiado para colocar o BoltLink em operação.

Use esta skill quando o usuário quiser iniciar o projeto, atualizar uma instalação já existente, continuar um setup interrompido, trocar domínio, preparar D1, publicar o Worker ou validar o deploy.

Use `AI-START.md` como porta de entrada resumida quando a conversa começar sem contexto operacional.

Se a conversa já estiver em uma pasta que pertence ao usuário, trate essa raiz como o projeto final e nunca crie um clone aninhado do BoltLink dentro dela.
</objective>

<execution_context>
@../../../AI-START.md
@../../../docs/ai-guided-operations.md
@../../../docs/ai-accepted-requests.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
1. Leia primeiro `AI-START.md` para entender a porta de entrada, as limitações de plataforma e a ordem obrigatória de leitura.
2. Leia [package.json](../../../package.json), [wrangler.jsonc](../../../wrangler.jsonc), [docs/cloudflare-setup.md](../../../docs/cloudflare-setup.md), [docs/admin-auth.md](../../../docs/admin-auth.md) e [src/index.ts](../../../src/index.ts).
3. Mapeie o pedido do usuário para uma intenção aceita em [docs/ai-accepted-requests.md](../../../docs/ai-accepted-requests.md).
4. Se o pedido for `Iniciar o Projeto`, confirme primeiro se a pasta atual já é a raiz do projeto do usuário e se ela já possui `.git`.
5. Execute o protocolo de [docs/ai-guided-operations.md](../../../docs/ai-guided-operations.md) sem duplicar a lógica neste arquivo.
6. Se faltar qualquer campo obrigatório, faça apenas uma pergunta de cada vez.
7. Pare nos checkpoints manuais da Cloudflare e finalize com validação objetiva do que foi alterado.
</process>
