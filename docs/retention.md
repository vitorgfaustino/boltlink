# Stats Retention

## Política padrão

- Retenção de stats: 90 dias

## Estratégias suportadas

- Limpeza lazy no `recordClick()`
  - A cada 100 writes, remove stats anteriores ao cutoff
- Purga manual via API
  - `POST /api/maintenance/purge-stats`
  - Payload opcional: `{ "retentionDays": 30|60|90|180|365 }`

## Exemplo

```bash
curl -X POST http://localhost:8787/api/maintenance/purge-stats \
  -H 'Content-Type: application/json' \
  -d '{"retentionDays":90}'
```

## Observações

- Purga reduz storage
- Purga também consome writes no D1
- Ajuste retenção conforme necessidade de auditoria/custo
