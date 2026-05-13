# Upgrade 1.0.0 -> 1.1.0

## Pré-requisitos

- Backup lógico do D1 (opcional, recomendado)
- Ambiente local funcional (`npm test`)

## Passos

1. Atualizar código para v1.1.0
2. Instalar dependências
3. Aplicar migrations
4. Executar testes
5. Deploy

## Comandos sugeridos

```bash
npm install
npm test
npx wrangler d1 migrations apply db_boltlink --local
npx wrangler d1 migrations apply db_boltlink --remote
npm run deploy
```

## Migrations

- `0001_link_management.sql`
- `0002_advanced_features.sql`

## Validação pós-upgrade

- Redirect 301/302 por link
- Go-live e expiração
- QR flag (`has_qrcode`)
- Filtro por tag/QR no admin
- Links com senha exibem gate antes do redirect
