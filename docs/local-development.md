# Desenvolvimento Local

> Escopo: release publicada = **v2.2.1** (tag real, migrations até `0003`; sem `npm run dev-prepare`). Este documento descreve as **bases locais**: o baseline da Fase 2 (`0004`, Split Test A/B), o estado Unreleased / Fase 3 (`0005`, Smart Routing), a working tree Unreleased / Fase 4 (`0006`, destino de expiração) e a working tree Unreleased / Fase 5 (hierarquia de grupos, **sem migration nova**).

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

## Fluxo rápido (Unreleased / Fase 3)

Vale para as bases locais; no baseline da Fase 2 a cadeia para na `0004`, no estado Unreleased / Fase 3 (HEAD congelado `548f179`) ela vai até a `0005` e na working tree da Fase 4 ela vai até a `0006`.

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

`npm run dev-prepare` lê o banco configurado em `wrangler.jsonc`/`wrangler.local.jsonc` e aplica a cadeia de migrations em `.wrangler/state/v3/d1`: `0000` a `0004` no baseline da Fase 2, `0000` a `0005` no estado Unreleased / Fase 3, e `0000` a `0006` na working tree da Fase 4 e também na da Fase 5 (a Fase 5 não adiciona migration: a hierarquia de grupos usa `link_groups.parent_id`, criado pela `0002`). Sem isso o Worker responde `503 Database schema is not initialized`.

O script `dev-prepare` **não existe** no checkout da tag `v2.2.1`, que termina na `0003`; lá o comando é `npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local`.

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
- aplica a cadeia de migrations (`migrations/0000` a `0006` nesta working tree da Fase 4) nesse arquivo
- insere links fictícios para navegação local

Para o Worker, o comando correto nas bases locais é `npm run dev-prepare`. `npm run dev-init` também existe na tag `v2.2.1`, mas lá a cadeia disponível termina na `0003`.

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

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
