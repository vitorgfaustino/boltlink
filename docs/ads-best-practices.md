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

BoltLink não troca essa origem pelo domínio curto nem tenta reconstruí-la. O site de origem, navegador ou app podem suprimir o header por sua própria política de privacidade.

## Diagnóstico rápido

- perda de atribuição: valide UTMs
- incompatibilidade de domínio: revise a política da plataforma de ads
- clique inflado: revise tráfego automatizado, habilite Bot Fight Mode quando fizer sentido e consulte `docs/free-plan-traffic.md`

---

Release atual publicada: 3.1.1 · Tag: v3.1.1
Criado por Vitor Faustino - vitorfaustino.com.br
