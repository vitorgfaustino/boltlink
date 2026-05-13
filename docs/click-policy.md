# Click Policy (v1.1.0)

## O que conta como clique

BoltLink contabiliza clique apenas quando `isCountableClick(request)` retorna `true`.

Regras principais:
- Método deve ser `GET`
- Bloqueia prefetch/prerender por headers `Purpose`, `Sec-Purpose`, `X-Purpose`
- Aceita `Sec-Fetch-Mode: navigate`
- Rejeita `User-Agent` vazio
- Rejeita bots/crawlers/monitores conhecidos
- Sem heurística confiável: fallback conservador para não contar

## O que NÃO conta

- Bots de busca e SEO
- Preview social (Facebook, WhatsApp, Telegram, Slack etc.)
- Monitores de uptime
- Ferramentas CLI (`curl`, `wget`) e clientes automatizados
- Prefetch/prerender do navegador

## Privacidade

Nenhum `Referer` é armazenado.
Nenhum `User-Agent` é persistido.
IP em texto puro não é salvo.

## Atualização da lista de bots

A lista está centralizada em [src/click-filter.ts](../src/click-filter.ts).
Atualize os padrões conforme surgirem novas assinaturas de tráfego automatizado.
