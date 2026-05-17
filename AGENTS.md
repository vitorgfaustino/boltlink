# AGENTS.md

Este arquivo define regras para agentes de IA e assistentes automatizados que trabalhem neste repositório.

## Escopo do projeto

Aplicação de gerenciamento e redirecionamento de links baseada em Cloudflare Workers, com:

- redirect público por slug
- painel administrativo estático em `public/admin.html`
- CRUD de links em D1
- contagem agregada em `links.clicks_total`
- autenticação administrativa via Cloudflare Access

## Regra obrigatória para tarefas Cloudflare

Conhecimento sobre Workers, D1, Wrangler, Assets, Access, Observability e WAF pode ficar desatualizado rapidamente.

Antes de propor mudanças de infraestrutura, bindings, limites, deploy, logging, rate limit ou autenticação Cloudflare:

- consulte a documentação atual da Cloudflare
- confira especialmente Workers, Wrangler, D1, Static Assets, Cloudflare Access e WAF Rate Limiting Rules
- para limites e quotas, consulte a página oficial do produto correspondente

## Configuração pública e local

- `wrangler.jsonc` é o template público e sanitizado
- `wrangler.local.jsonc` é a configuração privada local e não deve ser versionada
- não introduza `wrangler.toml`
- se bindings mudarem, rode `npm run cf-typegen`
- se schema mudar, atualize `schema.sql` e a migration correspondente

## Restrições funcionais que devem ser preservadas

- o slug é imutável após a criação
- o redirect público deve responder antes da contagem
- o admin deve continuar protegido em `/admin`, `/api` e `/api/*`
- IPs não devem ser persistidos
- hashes estáveis de IP não devem existir no produto
- slugs reservados não devem ser reutilizados
- redirects públicos usam `Referrer-Policy: strict-origin`
- admin, API, home, gate de senha e respostas não redirect usam `Referrer-Policy: no-referrer`

## Estrutura recomendada para mudanças

- UI: `public/admin.html`
- API ou auth: `src/index.ts`
- rate limiting: `src/rate-limit.ts`
- banco: `schema.sql` e `migrations/`
- operação: `docs/`
- regras para IA: este arquivo e `AI-START.md`

## Operação guiada por IA

- use `AI-START.md` como ponto de entrada
- use `docs/ai-accepted-requests.md` como contrato de entrada
- use `docs/ai-guided-operations.md` como runbook principal
- mapeie linguagem natural para uma intenção aceita antes de executar ações
- para atualizações, trate `https://github.com/vitorgfaustino/boltlink` como fonte oficial
- preserve `wrangler.local.jsonc`, `public/admin.html`, `public/logo.png` e `public/favicon.ico` em projetos derivados
- não automatize a criação final do Cloudflare Access

## Regras de documentação pública

- não use nomes de clientes, empresas ou domínios privados
- use placeholders como `links.example.com`
- em arquivos versionados de configuração, use placeholders em vez de IDs, hostnames e credenciais reais
- quando alterar comportamento do produto, atualize a documentação correspondente

## Validação mínima

Para mudanças de código:

```bash
npm test
```

Para mudanças de bindings:

```bash
npm run cf-typegen
```

Para mudanças de banco:

- validar migrations localmente com Wrangler

## Segurança operacional

- não commitar `.dev.vars`, `.env` ou segredos
- não expor valores reais de `API_KEY`, `TEAM_DOMAIN` ou `POLICY_AUD`
- não assumir que a proteção do Access fora do Worker elimina a validação do token dentro do Worker

## Prioridades ao implementar

1. preservar segurança e comportamento do redirect
2. manter o admin simples
3. preferir mudanças pequenas, testáveis e documentadas
4. evitar qualquer coleta ou persistência que aumente desnecessariamente a superfície LGPD

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
