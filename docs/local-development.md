# Desenvolvimento Local

Este projeto suporta desenvolvimento local com banco SQLite isolado para teste manual e validação rápida.

## O que é `.dev-env`

`.dev-env/` é um diretório local, ignorado pelo Git, usado para armazenar:

- `db.sqlite3`
- arquivos temporários de bootstrap
- fixtures locais
- resultados locais de validação, se você quiser guardar isso ali

Esse diretório **não vai para o GitHub**.

## Fluxo rápido

1. Instale dependências:

```bash
npm install
```

2. Gere a configuração local do Worker e tipos:

```bash
npm run setup
```

3. Crie o banco local SQLite de apoio:

```bash
npm run dev-init
```

4. Suba o Worker local:

```bash
npm run dev
```

5. Rode os testes:

```bash
npm test
```

## O que `npm run dev-init` faz

- cria `.dev-env/`
- cria `.dev-env/db.sqlite3`
- aplica `schema.sql`
- insere links fictícios para navegação local

## Reset do banco local

```bash
npm run dev-reset
```

## Explorar o banco local

```bash
sqlite3 .dev-env/db.sqlite3
```

## Limitações

- esse banco SQLite local é um apoio para desenvolvimento manual
- ele não substitui o ambiente real de D1
- a fonte de verdade do schema continua sendo `schema.sql` e `migrations/`

## Recomendação para IA

Quando o usuário pedir para iniciar o projeto localmente apenas para testes, a IA deve incluir `npm run dev-init` no fluxo sugerido.

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
