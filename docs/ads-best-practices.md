# Ads Best Practices (BoltLink)

## Objetivo

BoltLink é um redirecionador. Analytics de campanha deve continuar no destino (GA4, Meta, etc.).

## Recomendações

- Use UTMs no `target_url` ao criar o link
- Prefira domínio de destino para campanhas com políticas estritas de `destination mismatch`
- Evite trocar destino de slug ativo no meio da campanha sem rastreio de versão
- Para campanhas críticas, valide a cadeia completa:
  1. URL curta
  2. Redirect final
  3. Presença de UTMs

## Referrer

Para redirects públicos, BoltLink usa `Referrer-Policy: strict-origin-when-cross-origin`.
Isso permite enviar origem (não URL completa) quando aplicável.

## Diagnóstico rápido

- Queda de atribuição: validar UTMs no destino
- Divergência de domínio: revisar política da plataforma de ads
- Clique inflado: verificar origem de tráfego automatizado
