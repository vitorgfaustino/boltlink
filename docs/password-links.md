# Password-Protected Links

## Como funciona

Quando `password_hash` está configurado para um slug:
- `GET /:slug` retorna gate HTML de senha
- `POST /:slug` valida senha e redireciona em caso de sucesso

## Segurança

- Senha é armazenada como hash com salt
- Sessão curta via cookie `HttpOnly` (`Max-Age=300`)
- Rate limit de tentativa por slug+IP (5/min)

## Fluxo

1. Criar ou editar link com `password`
2. Compartilhar URL curta normalmente
3. Usuário informa senha na página de gate
4. Redirect para destino

## Limitação atual

Sessão do gate é assinada localmente para duração curta. Em cenários de alta criticidade, use também proteção externa via Cloudflare Access.
