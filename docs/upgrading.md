# Upgrading

## Escopo das três bases e da Fase 4 (Unreleased / Fase 4)

Os documentos abaixo descrevem quatro estados de código diferentes. Confirme em qual você está antes de seguir um procedimento:

| Base | Como identificar | Migrations | Recursos de produto |
| --- | --- | --- | --- |
| Publicada | tag `v2.2.1` (`git rev-parse v2.2.1` → `8b3895e`) | `0000` a `0003` | links, grupos, tags, QR code, senha, agenda/expiração |
| Fase 2 local | baseline local `23353a1`, não publicado | `0000` a `0004` | base publicada + Split Test A/B |
| Fase 3 congelada | HEAD `548f179`, Unreleased | `0000` a `0005` | Fase 2 + Smart Routing |
| Fase 4 (working tree) | working tree atual sobre `548f179` | `0000` a `0006` | Fase 3 + destino de expiração + `ROOT_REDIRECT_URL` |

Nenhum bump de versão acompanha estas correções: a tag publicada continua sendo `v2.2.1` e termina na `0003`.

## Upgrade para a versão publicada (v2.2.1)

Não há bindings novos. A release publicada termina na migration `0003_lgpd_minimization.sql`; um checkout da tag `v2.2.1` não possui os recursos das bases locais. Instalações alinhadas com a `0003` não precisam de migration nova. Aplique as migrations pendentes antes de publicar o Worker.

Os recursos do baseline local da Fase 2 e do estado Unreleased / Fase 3 estão descritos em seções próprias abaixo; nenhum dos dois faz parte da release publicada.

## Split Test A/B e migration 0004 (Phase 2 local, não publicado)

> Escopo: **baseline local da Fase 2** (`0004`). A tag publicada `v2.2.1` não contém esta migration nem o Split Test A/B.

O Split Test A/B adiciona a migration `0004_ab_testing.sql`. Ela é a fonte autoritativa das colunas A/B.

- O runtime não executa `schema.sql`, não cria/altera colunas, não aplica migrations implicitamente e não reconstrói tabelas; banco não preparado falha fechado com `503 Database schema is not initialized`.
- Em banco pré-0004, links normais continuam com redirect, lifecycle, senha e `clicks_total`; configurar A/B pela API retorna `400` pedindo a migration.
- Aplique a `0004` pelo fluxo normal de migrations antes de usar A/B em produção.
- Ordem recomendada: aplicar migrations → publicar/reiniciar o Worker → validar. Um isolate iniciado antes da migration revalida o schema e passa a usar fencing no request seguinte; o restart não é obrigatório para correção.
- Reaplicar migrations é seguro: o Wrangler responde `No migrations to apply!` quando já estão aplicadas.
- Instalações limpas do baseline local da Fase 2 aplicam a cadeia de migrations (`0000` a `0004`); `schema.sql` é apenas o baseline da `0000` para ferramentas manuais.
- Colunas legadas extras (`last_clicked_at`, `notes`, `stats`) podem permanecer após o upgrade; o runtime as ignora.

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

## Smart Routing e migration 0005 (Unreleased / Fase 3)

> Escopo: release publicada/baseline = **v2.2.1**. O procedimento abaixo está preparado para a **próxima release (Unreleased / Fase 3)**. Um checkout da tag `v2.2.1` não contém a migration `0005`.

O Smart Routing adiciona a migration `0005_smart_routing.sql`, fonte autoritativa da coluna `links.smart_routing_rules` (JSON em linha). Instalações limpas nesta branch de desenvolvimento aplicam a cadeia `0000` a `0005`.

- Em banco pré-0005, links normais continuam funcionando e a API retorna `400` explicando a migration ao tentar configurar Smart Routing; `GET /api/capabilities` reporta `smartRouting: false`.
- Aplique a `0005` pelo fluxo normal antes de configurar Smart Routing em produção.
- Ordem recomendada: backup → aplicar migrations (`0004` e `0005` quando aplicável) → publicar/atualizar o Worker → validar `GET /api/capabilities` → validar um redirect normal → configurar Smart Routing no Admin.
- O deploy não aplica migrations automaticamente; a aplicação é uma etapa operacional explícita.
- Um isolate iniciado antes da migration revalida a capability no request seguinte; o restart não é obrigatório.
- Smart Routing e Split Test A/B são mutuamente exclusivos e links com Smart Routing usam sempre `302` com `Cache-Control: no-store`.
- Links configurados antes do upgrade permanecem com `smart_routing_rules = NULL` (desativado) até serem configurados no Admin.

## Destino de expiração e migration 0006 (Unreleased / Fase 4)

> Escopo: **working tree da Fase 4** (sobre o HEAD congelado da Fase 3 `548f179`). A tag publicada `v2.2.1` não contém esta migration nem o destino de expiração.

O destino de expiração adiciona a migration `0006_expired_redirect.sql`, fonte autoritativa da coluna `links.expired_redirect_url` (TEXT, nullable). A mudança é additive: sem default, sem reescrita de dados e sem rebuild de tabela; linhas existentes permanecem `NULL`, o que preserva o comportamento anterior (link expirado responde `410`). Instalações limpas nesta working tree aplicam a cadeia `0000` a `0006`.

- Em banco pré-0006, links normais continuam funcionando integralmente; tentar configurar `expiredRedirectUrl` retorna `400` pedindo a migration, `GET /api/capabilities` reporta `expiredRedirect: false` e o Admin oculta a seção "Após expirar".
- Aplique a `0006` pelo fluxo normal **antes** de tentar configurar destino de expiração em produção.
- Ordem recomendada: backup → aplicar migrations pendentes (`0006`) → publicar/atualizar o Worker → validar `GET /api/capabilities` (`expiredRedirect: true`) → validar um redirect normal → configurar destinos no Admin quando desejado.
- Não há downtime obrigatório: a coluna é nullable e additive.
- Rollback benigno: banco em `0006` com código da Fase 3 ignora a coluna extra; nenhum dado é perdido e nenhum comportamento muda.
- O deploy não aplica migrations automaticamente; a aplicação é uma etapa operacional explícita, e o runtime nunca cria a coluna durante requests.

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

A Fase 4 também introduz a variável opcional `ROOT_REDIRECT_URL` (redirect da raiz), que não depende de migration nem de bindings novos: veja `README.md` e `docs/cloudflare-setup.md`.

## PASSWORD_SESSION_SECRET e links protegidos por senha

Esta versão passa a exigir `PASSWORD_SESSION_SECRET` para todo o recurso de links protegidos por senha. `API_KEY` deixou de ser fallback de sessão.

- Instalações sem links protegidos por senha: nenhuma ação necessária.
- Instalações com links protegidos por senha: configure `PASSWORD_SESSION_SECRET` como secret do Worker **antes** do upgrade/deploy desta versão.
- `API_KEY` não é mais utilizado para assinar sessões de links protegidos por senha.
- Links protegidos legados sem `PASSWORD_SESSION_SECRET` falham fechados com HTTP 503, tanto no `GET` quanto no `POST`, sem redirect e sem cookie de sessão.
- HTTP 503 significa configuração pendente no servidor; não é senha incorreta nem link inexistente.
- Não existe fallback inseguro: sem o secret, o recurso fica indisponível em vez de degradar.

Fluxo normal:

1. Atualize o codigo:

```bash
git pull --ff-only
npm install
npm run wrangler:init
npm test
```

## Upgrade legado para v2.0.0

Esta versão é breaking change de produto e schema.

Ela remove:

- `stats`
- `IP_HASH_SECRET`
- `last_clicked_at`
- `notes`
- endpoint `/api/links/:slug/stats`
- endpoint `/api/maintenance/purge-stats`

## Passo a passo

1. Atualize o código:

```bash
git pull --ff-only
npm install
```

2. Recrie ou sincronize o config local:

```bash
npm run wrangler:init
```

3. Aplique migrations localmente:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

4. Se o deploy for manual e já houver ambiente remoto:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

5. Valide:

```bash
npm test
```

## GitHub auto-deploy e one-click

Se você atualiza pelo GitHub ou pelo botão:

- o runtime não executa reconciliação de schema: colunas legadas extras são ignoradas, mas continuam no banco até uma migration explícita
- a migration continua sendo o caminho suportado

## Impacto funcional

- a contagem continua existindo em `clicks_total`
- o referrer público passa a ser apenas `strict-origin`
- métricas detalhadas deixam de existir por padrão

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
