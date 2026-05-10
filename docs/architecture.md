# Arquitetura do Projeto

## Visão geral

Este projeto é um encurtador de URLs orientado a edge. O Worker atende tanto o fluxo público de redirect quanto o fluxo administrativo protegido.

O objetivo do desenho atual é manter o caminho crítico de redirect simples, previsível e barato, enquanto o painel administrativo continua prático para operação manual.

## Componentes principais

- Landing page pública em `/`
- Endpoint técnico `GET /health`
- Worker HTTP em `src/index.ts`
- Banco D1 com tabelas `links` e `stats`
- Bootstrap idempotente do schema base do D1 na primeira operação que usa o banco
- Asset estático `public/admin.html`
- Binding `ASSETS` para servir o painel administrativo
- Middleware de autenticação para `/admin`, `/admin.html`, `/api` e `/api/*`

## Fluxo público de redirect

1. A requisição chega em `/:slug`.
2. O Worker recusa slugs reservados.
3. O Worker consulta `links` filtrando apenas registros ativos.
4. Se houver correspondência, responde com `302` para `target_url`.
5. Em paralelo, grava um evento em `stats` e incrementa `clicks_total` com `ctx.waitUntil()`.

Esse desenho evita que o redirect dependa da escrita de analytics e reduz latência percebida pelo usuário final.

## Fluxo administrativo

1. O usuário acessa `/admin`.
2. O middleware `requireAdmin` valida se a requisição é local, se o Access está configurado ou se há credenciais válidas.
3. O painel carregado em `admin.html` chama `/api/links`.
4. O Worker lista, cria, edita e exclui links no D1.

O asset administrativo também pode ser requisitado por `/admin.html`, mas esse caminho continua passando pelo Worker antes de servir o asset para evitar exposição direta do HTML do painel.

As rotas administrativas cobertas hoje são:

- `GET /api/links`
- `POST /api/links`
- `PATCH /api/links/:slug`
- `PUT /api/links/:slug`
- `DELETE /api/links/:slug`
- `GET /api/links/:slug/stats`

## Modelo de dados

### Tabela `links`

- `slug`: identificador público do link curto
- `target_url`: URL de destino atual
- `clicks_total`: contador agregado de cliques
- `last_clicked_at`: último clique conhecido
- `disabled_at`: exclusão lógica
- `version`: controle simples de evolução do registro

### Tabela `stats`

- `link_id`: referência opcional ao link
- `slug_snapshot`: slug observado no momento do clique
- `clicked_at`: timestamp do evento
- `ip_hash`: HMAC-SHA-256 do IP quando `IP_HASH_SECRET` está configurado; caso contrário, `NULL`
- `country`: contexto geográfico auxiliar e opcional do clique

## Bootstrap do banco

No fluxo atual, o schema base do D1 pode ser criado automaticamente na primeira operação que toca o banco. Isso existe para suportar o fluxo `Deploy to Cloudflare Workers`, no qual o deploy publica o Worker e o D1, mas não executa migrations automaticamente.

Esse bootstrap é idempotente e cobre o schema inicial do projeto. Para evolução futura do banco, `schema.sql` e `migrations/` continuam sendo as fontes de referência para mudanças estruturais planejadas.

## Decisões de produto que devem ser preservadas

- O slug pode ser definido na criação, mas não pode ser alterado depois.
- A exclusão é lógica, via `disabled_at`, para preservar histórico.
- O painel foca em operação rápida: busca, edição de destino, cópia do link e exclusão.
- O redirect é a prioridade do sistema; métricas são secundárias e assíncronas.
- O projeto evita persistir dados pessoais brutos além do necessário para observabilidade operacional.

## Segurança

- O admin é protegido por Cloudflare Access quando `TEAM_DOMAIN` e `POLICY_AUD` estão configurados.
- Existe fallback opcional por `Authorization: Bearer <API_KEY>` apenas para automação em `/api` e `/api/*`.
- Em ambiente local, o middleware permite acesso sem bloquear o fluxo de desenvolvimento.
- Em produção, admin e API falham fechados fora de `localhost` até que Access ou `API_KEY` válido esteja configurado.
- O Worker roda antes de servir assets administrativos críticos, evitando que `/admin.html` seja exposto diretamente sem passar pela camada de autenticação.
- `TEAM_DOMAIN` deve ser HTTPS; o Worker valida o protocolo sem fixar um sufixo de domínio específico.
- Respostas sensíveis em HTTPS incluem `Strict-Transport-Security`.

## Rate Limiting

Os endpoints `/api` e `/api/*` possuem rate limiting in-memory com as seguintes características:

- Janela fixa de 60 segundos
- Limite de 30 requisições por janela, por IP
- Implementado em `src/rate-limit.ts`
- Constantes editáveis no topo do arquivo (`API_RATE_LIMIT`, `API_RATE_WINDOW_MS`)
- Não requer migration de banco

O redirect público (`/:slug`) não possui rate limiting no Worker para preservar a latência do caminho crítico. A proteção contra abuso de redirect é delegada à camada de rede da Cloudflare (DDoS protection gratuita).

### Alterar os limites

Edite as constantes em `src/rate-limit.ts` e faça o deploy:

```typescript
const API_RATE_LIMIT = 30;        // requisições por janela
const API_RATE_WINDOW_MS = 60000; // duração da janela em ms
```

Não é necessário alterar schema, migrations ou bindings.

### Evolução futura

Se o projeto crescer para múltiplos operadores simultâneos em múltiplas regiões, o rate limiting in-memory pode ser insuficiente (não compartilhado entre isolates). Nesse caso, a migração recomendada é para **Cloudflare Rate Limiting Rules (WAF)**, não D1, por oferecer consistência global com zero latência de aplicação.

## Estrutura recomendada para evolução futura

- Separar ambientes `staging` e `production`.
- Expandir testes para autenticação e analytics.
- Expandir o CI para documentação, testes e validação de migrations.
- Documentar decisões arquiteturais maiores em arquivos dedicados quando o projeto crescer.

---

Versão 1.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
