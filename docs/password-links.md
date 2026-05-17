# Password-Protected Links

## Como funciona

Quando `password_hash` está configurado para um slug:
- `GET /:slug` retorna gate HTML de senha
- `POST /:slug` valida senha e redireciona em caso de sucesso

## Segurança

- Senha é armazenada como hash com salt
- Sessão curta via cookie `HttpOnly` (`Max-Age=300`) assinado com HMAC SHA-256
- `PASSWORD_SESSION_SECRET` é recomendado em produção; sem ele, o Worker usa `API_KEY` ou fallback aleatório em memória
- Rate limit de tentativa por slug com chave derivada de IP apenas em memória (5/min)

## Fluxo

1. Criar ou editar link com `password`
2. Compartilhar URL curta normalmente
3. Usuário informa senha na página de gate
4. Redirect para destino

## Limitação atual

Sessão do gate é assinada localmente para duração curta. O fallback aleatório em memória é adequado para desenvolvimento, mas pode invalidar sessões quando o isolate reinicia. Em produção, configure `PASSWORD_SESSION_SECRET`.

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
