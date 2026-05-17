# Ads Best Practices

## Objetivo

BoltLink é um redirecionador com contagem agregada. A atribuição detalhada deve continuar no destino.

## Recomendações

- use UTMs no `target_url`
- prefira medir campanha no analytics do destino
- não dependa de referrer completo
- valide a cadeia: URL curta, redirect final, UTMs no destino

## Referrer

Nos redirects públicos, BoltLink usa `Referrer-Policy: strict-origin`.

Isso preserva apenas a origem quando o navegador decidir enviá-la. Path e query não são encaminhados como referrer.

## Diagnóstico rápido

- perda de atribuição: valide UTMs
- incompatibilidade de domínio: revise a política da plataforma de ads
- clique inflado: revise tráfego automatizado e aplique Cloudflare WAF Rate Limiting Rules
