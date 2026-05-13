# Privacy (BoltLink v1.1.0)

## Princípio

Capturar, encaminhar e esquecer.

## Coletado

- `clicked_at`
- `country` (quando disponível)
- `ip_hash` (HMAC-SHA-256 apenas quando `IP_HASH_SECRET` está configurado)

## Não coletado

- IP em texto puro
- `Referer`
- `User-Agent` persistido
- UTMs em tabela separada
- Cookies de rastreamento

## Referrer transparente

Nos redirects públicos, BoltLink permite envio de referrer para o destino via política HTTP adequada.
BoltLink não persiste esse dado.

## Retenção

Padrão operacional: 90 dias para `stats` com limpeza lazy e endpoint manual de purge.
