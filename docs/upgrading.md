# Upgrading

## Upgrade para v2.0.0

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

- o código novo consegue reconciliar schema legado em runtime
- ainda assim, a migration continua sendo o caminho recomendado

## Impacto funcional

- a contagem continua existindo em `clicks_total`
- o referrer público passa a ser apenas `strict-origin`
- métricas detalhadas deixam de existir por padrão
