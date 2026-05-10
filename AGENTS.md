# AGENTS.md

Este arquivo define regras para agentes de IA e assistentes automatizados que trabalhem neste repositório.

## Escopo do projeto

Aplicação de encurtamento de URLs baseada em Cloudflare Workers, com:

- redirect público por slug
- painel administrativo estático em `public/admin.html`
- CRUD de links em D1
- analytics assíncrono
- autenticação administrativa via Cloudflare Access

## Regra obrigatória para tarefas Cloudflare

Conhecimento sobre Workers, D1, Wrangler, Assets e Access pode ficar desatualizado rapidamente.

Antes de propor mudanças de infraestrutura, bindings, limites, deploy ou autenticação Cloudflare:

- consulte a documentação atual da Cloudflare
- confira especialmente Workers, Wrangler, D1, Static Assets e Cloudflare Access
- para limites e quotas, consulte sempre a página oficial de limits do produto correspondente

Referências base:

- `https://developers.cloudflare.com/workers/`
- `https://developers.cloudflare.com/workers/wrangler/configuration/`
- `https://developers.cloudflare.com/d1/`
- `https://developers.cloudflare.com/workers/static-assets/`
- `https://developers.cloudflare.com/cloudflare-one/access-controls/`

## Configuração pública e local

- `wrangler.jsonc` é o template público e sanitizado da configuração do Worker.
- `wrangler.local.jsonc` é a configuração privada do ambiente local e não deve ser versionada.
- Não introduza `wrangler.toml` como configuração paralela.
- Se bindings mudarem, rode `npm run cf-typegen` contra o template público.
- Se schema mudar, atualize `schema.sql` e a migration correspondente.

## Restrições funcionais que devem ser preservadas

- O slug é imutável após a criação.
- O redirect público deve responder antes da gravação de analytics.
- O admin deve continuar protegido em `/admin`, `/api` e `/api/*`.
- IPs não devem ser persistidos em texto puro.
- Hashes de IP devem usar segredo operacional (`IP_HASH_SECRET`) ou não ser gravados.
- Slugs reservados não devem ser reutilizados para conteúdo dinâmico.

## Estrutura recomendada para mudanças

- Mudanças de UI: editar `public/admin.html`
- Mudanças de API ou auth: editar `src/index.ts`
- Mudanças de rate limiting: editar `src/rate-limit.ts`
- Mudanças de banco: editar `schema.sql` e `migrations/`
- Mudanças operacionais: atualizar `docs/`
- Mudanças de uso por IA: atualizar este arquivo

## Operação guiada por IA

- Use `AI-START.md` como ponto único de entrada quando a IA ainda não tiver contexto operacional do repositório.
- Use [docs/ai-accepted-requests.md](docs/ai-accepted-requests.md) como contrato de entrada para qualquer pedido operacional.
- Use [docs/ai-guided-operations.md](docs/ai-guided-operations.md) como runbook principal de execução.
- Se o pedido estiver em linguagem natural, mapeie primeiro para uma intenção aceita antes de executar qualquer ação.
- Para atualizações do projeto, trate `https://github.com/vitorgfaustino/boltlink` como a fonte oficial de novidades, verifique o estado do Git antes de puxar a nova versão e preserve qualquer alteração local que não pertença ao fluxo de atualização.
- Para bootstrap de projetos derivados, trate `https://github.com/vitorgfaustino/boltlink` como fonte oficial de template e novidades, mas não como o repositório Git final do usuário.
- Se a pasta atual já for um projeto do usuário com `.git`, nunca clone o BoltLink dentro dela e nunca deixe a pasta `.git` do upstream dentro da árvore final.
- Se a IA precisar usar uma origem temporária para obter o projeto, mantenha essa origem fora da pasta final e copie apenas o working tree necessário.
- Ao atualizar um projeto derivado deste repositório-base, nunca sobrescreva a configuração local privada, os valores individualizados do Worker no `wrangler.jsonc` atual nem os arquivos de overlay do projeto, especialmente `wrangler.local.jsonc`, `wrangler.jsonc` quando ele já tiver `name`, `routes`, `workers_dev`, `preview_urls`, `d1_databases` ou bindings ajustados para o projeto em uso, `public/admin.html`, `public/logo.png` e `public/favicon.ico`, sem confirmação explícita do usuário. A IA deve reforçar a aplicação e atualização da licença AGPL-3.0 durante a automação, inserindo os cabeçalhos obrigatórios no código e ajustando as menções de rodapé (como em `admin.html` e `index.ts`), preservando porém a identidade visual do usuário.
- Se a operação precisar de valores reais, use `wrangler.local.jsonc` e mantenha o template público intacto.
- Antes de rodar comandos mutáveis ou editar arquivos, explique o impacto e peça confirmação quando o contexto não estiver explícito.
- Pergunte apenas um dado faltante por vez.
- Antes de prometer automação local, confirme se a plataforma realmente consegue acessar arquivos, executar terminal, instalar dependências ou clonar o repositório.
- Ao alterar bindings, execute `npm run cf-typegen`.
- Ao alterar schema, atualize `schema.sql` e a migration correspondente.
- Ao mudar domínio, confirme hostname atual, hostname novo, tipo de rota, zone ativo e possíveis conflitos de DNS.
- Não automatize a criação final do Cloudflare Access; pare no handoff e deixe essa etapa com o usuário.
- Mantenha `wrangler.jsonc` como template público e `wrangler.local.jsonc` como configuração operacional privada.
- A skill de descoberta e workflow guiado fica em [boltlink-operations](.github/skills/boltlink-operations/SKILL.md).

## Regras de documentação pública

- Não use nomes de clientes, empresas ou domínios privados na documentação pública.
- Use placeholders como `links.example.com`.
- Em arquivos versionados de configuração, use placeholders ou valores neutros no lugar de IDs, hostnames e credenciais reais.
- Quando alterar comportamento do produto, atualize a documentação correspondente.
- Preserve o rodapé documental com versão e autoria enquanto este padrão estiver ativo no projeto.

## Política pública de colaboração

- Este repositório não aceita Pull Requests externos no momento.
- Issues continuam abertas para bugs, dúvidas e sugestões.
- Se uma automação tocar arquivos em `.github/`, ela deve preservar essa política de `somente leitura + feedback`.

## Validação mínima esperada

### Para mudanças de código

```bash
npm test
```

### Para mudanças de bindings

```bash
npm run cf-typegen
```

### Para mudanças de banco

Validar migrations localmente com Wrangler antes de concluir.

## Segurança operacional

- Não commitar `.dev.vars`, `.env` ou segredos.
- Não expor valores reais de `API_KEY`, `IP_HASH_SECRET`, `TEAM_DOMAIN` ou `POLICY_AUD` em commits ou documentação.
- Em produção, não assuma que a proteção do Access fora do Worker elimina a necessidade de validação do token dentro do Worker.

## Prioridades ao implementar

1. Preservar segurança e comportamento do redirect.
2. Manter a experiência operacional do admin simples.
3. Preferir mudanças pequenas, testáveis e documentadas.
4. Evitar abstrações desnecessárias para um projeto ainda pequeno.

---

Versão 1.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
