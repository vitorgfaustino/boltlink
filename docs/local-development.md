# Desenvolvimento Local

## Release publicada — 3.2.1

A **3.2.1 está publicada**, identificada pela tag **v3.2.1**; é a release atual e latest do repositório. A release anterior **v3.2.0** permanece congelada. Esta versão de manutenção acrescenta preflight D1, seleção consistente da configuração Wrangler, merge por identidade de binding e comparação obrigatória das configurações no upgrade. Mantém os recursos de links e o Admin refinado da 3.2.0. **MIGRATION_0007 = NOT REQUIRED**; migrations `0000`–`0006` e schema preservados. Nenhum secret obrigatório novo ou atualização automática de instalações.

> Escopo: release atual = **`3.2.1`** (tag `v3.2.1`, migrations `0000` a `0006`, com `npm run dev-prepare`). Este documento descreve o desenvolvimento local da release atual; os checkpoints de desenvolvimento (Fase 2 = `0004`/Split Test A/B, Fase 3 = `0005`/Smart Routing, Fase 4 = `0006`/destino de expiração, Fase 5 = hierarquia de grupos, portabilidade e QR Code sem migration nova) são **origem histórica** desses recursos, publicados juntos na `3.0.0` — não são estados ativos.

Este projeto suporta desenvolvimento local com banco SQLite isolado para teste manual e validação rápida.

## Dois bancos locais diferentes

- **D1 local do Worker** (`.wrangler/state/v3/d1`): é o banco que `npm run dev` usa de verdade. Recebe schema por migrations.
- **SQLite auxiliar** (`.dev-env/db.sqlite3`): artefato separado, ignorado pelo Git, usado apenas para inspeção/experimentação com `sqlite3`. O Worker **não** usa esse arquivo.

## O que é `.dev-env`

`.dev-env/` é um diretório local, ignorado pelo Git, usado para armazenar:

- `db.sqlite3` (SQLite auxiliar)
- fixtures locais
- resultados locais de validação, se você quiser guardar isso ali

Esse diretório **não vai para o GitHub**.

## Fluxo rápido (release atual v3.2.1)

1. Instale dependências:

```bash
npm install
```

2. Gere a configuração local do Worker e tipos:

```bash
npm run setup
```

3. Aplique as migrations no D1 local usado pelo Worker:

```bash
npm run dev-prepare
```

`npm run dev-prepare` faz parte da release `3.0.0` e lê o banco configurado em `wrangler.jsonc`/`wrangler.local.jsonc`, aplicando a cadeia completa de migrations em `.wrangler/state/v3/d1`: `0000` a `0006` — o que habilita o Split Test A/B (`0004`), o Smart Routing (`0005`), o destino de expiração (`0006`) e os recursos sem migration nova da Fase 5 (hierarquia de grupos via `link_groups.parent_id`, criado pela `0002`; portabilidade de configuração, que lê colunas existentes; e QR Code, que usa os endpoints e a coluna `has_qrcode` existentes desde a base publicada). Sem isso o Worker responde `503 Database schema is not initialized`.

Os checkpoints históricos de desenvolvimento aplicavam cadeias mais curtas no mesmo script: a Fase 2 (`23353a1`) parava na `0004`, a Fase 3 (`548f179`) na `0005` e a Fase 4 (`cdb9f83`) na `0006` — todas essas fases são origem dos recursos publicados na `3.0.0`.

### Referência histórica: checkout da release histórica (v2.2.1)

No checkout histórico da tag `v2.2.1`, que termina na `0003_lgpd_minimization.sql`, o script de preparação local do D1 não existe; lá a cadeia é aplicada manualmente:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

4. (Opcional) Crie o SQLite auxiliar para inspeção manual:

```bash
npm run dev-init
```

5. Suba o Worker local:

```bash
npm run dev
```

6. Rode os testes:

```bash
npm test
```

## O que `npm run dev-init` faz

- cria `.dev-env/`
- cria `.dev-env/db.sqlite3` (auxiliar, não usado pelo Worker)
- aplica a cadeia de migrations (`migrations/0000` a `0006` na release atual `3.2.1`) nesse arquivo
- insere links fictícios para navegação local

Para o Worker, o comando correto na release atual é `npm run dev-prepare`. `npm run dev-init` também existe na tag `v2.2.1`, mas lá a cadeia disponível termina na `0003`.

## Reset do banco auxiliar

```bash
npm run dev-reset
```

## Explorar o banco auxiliar

```bash
sqlite3 .dev-env/db.sqlite3
```

## Limitações

- o SQLite auxiliar é um apoio para desenvolvimento manual
- ele não substitui o D1 local do Worker nem o ambiente real de D1
- a fonte de verdade do schema são as migrations; `schema.sql` é apenas o baseline da `0000` para ferramentas manuais e não é executado pelo runtime

## Recomendação para IA

Quando o usuário pedir para iniciar o projeto localmente, a IA deve incluir `npm run dev-prepare` **antes** de `npm run dev`. `npm run dev-init` é opcional e prepara apenas o SQLite auxiliar.

---

Release atual publicada: 3.2.1 · Tag: v3.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
