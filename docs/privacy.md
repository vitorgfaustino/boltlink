# Privacy (BoltLink v2.0.0)

## Princípio

Redirecionar, contar de forma agregada e evitar coleta desnecessária.

## O que o produto persiste

- `links.slug`
- `links.target_url`
- `links.clicks_total`
- `links.created_at`
- `links.updated_at`
- campos operacionais do link: `redirect_type`, `expires_at`, `go_live_at`, `tags`, `has_qrcode`, `group_id`, `password_hash`, `disabled_at`, `version`
- nomes de grupos em `link_groups`

## O que o produto não persiste

- IP em texto puro
- hash de IP
- país
- `Referer`
- `User-Agent`
- eventos por clique
- `last_clicked_at`
- notas internas livres
- cookies de rastreamento

## Contagem

Cada clique elegível incrementa apenas `links.clicks_total`.

O redirecionamento continua respondendo antes da atualização do contador.

## Referrer

Nos redirects públicos, BoltLink envia `Referrer-Policy: strict-origin`.

Isso permite ao destino receber apenas a origem do tráfego quando o navegador decidir enviá-la, sem path nem query string.

Admin, API, home, gate de senha e respostas não redirect usam `Referrer-Policy: no-referrer`.

## Senhas e rate limit

- links protegidos armazenam apenas `password_hash`
- tentativas de senha usam chave derivada de IP apenas em memória do isolate
- a recomendação operacional para abuso público continua sendo Cloudflare WAF Rate Limiting Rules

## Responsabilidades

O projeto é distribuído sob AGPL-3.0 e com disclaimer, mas quem implanta e opera o sistema continua responsável por:

- definir a finalidade e a base legal do tratamento
- decidir quais URLs, slugs, tags e grupos conterão dados
- configurar a conta Cloudflare, logs e retenções externas
- atender pedidos de titulares e exigências regulatórias do próprio uso

O autor original do software não se torna controlador, operador ou encarregado apenas por distribuir o código-fonte.

Para apoiar quem publicar uma instância do produto, o repositório inclui um modelo genérico em `docs/privacy-template.md`, que deve ser adaptado pelo operador antes do uso público.

A instância pública padrão também expõe uma página em `/privacidade`, servida por `public/privacidade.html`, para que a política aplicável ao ambiente publicado fique acessível fora do repositório.

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
