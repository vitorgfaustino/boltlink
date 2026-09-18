# Password-Protected Links

## Como funciona

Quando `password_hash` está configurado para um slug:
- `GET /:slug` retorna gate HTML de senha
- `POST /:slug` valida senha e redireciona em caso de sucesso

## Segurança

- Senha é armazenada como hash com salt
- Sessão curta via cookie `HttpOnly` (`Max-Age=300`) assinado com HMAC SHA-256
- `PASSWORD_SESSION_SECRET` não é obrigatório para o produto inteiro, mas é obrigatório para o recurso de links protegidos por senha
- `PASSWORD_SESSION_SECRET` deve ser tratado como `Secret`, nao como `Text` em `vars`
- sem `PASSWORD_SESSION_SECRET`, API e admin recusam criar ou atualizar um link para adicionar senha
- links protegidos legados sem `PASSWORD_SESSION_SECRET` falham fechados com HTTP 503 (sem redirect e sem cookie de sessão); 503 indica configuração pendente no servidor, não senha incorreta nem link inexistente
- `API_KEY` não é fallback de `PASSWORD_SESSION_SECRET`; as responsabilidades dos secrets são separadas
- Rate limit de tentativa por slug com chave derivada de IP apenas em memória (5/min)
- Geracao recomendada:

```bash
openssl rand -hex 32
```

## Fluxo

1. Criar ou editar link com `password`
2. Compartilhar URL curta normalmente
3. Usuário informa senha na página de gate
4. Redirect para destino

## Limitação atual

Sessões são curtas e assinadas localmente. O rate limit é apenas em memória do isolate e não substitui uma camada de borda. Não há persistência de tentativas, IPs ou hashes estáveis de IP.

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
