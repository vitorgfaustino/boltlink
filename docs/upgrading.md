# Upgrading

## Upgrade para a versão atual

Esta release nao introduz migration nova nem bindings novos para instalacoes ja alinhadas com a baseline LGPD da linha `2.0.0`.

## PASSWORD_SESSION_SECRET e links protegidos por senha

Esta versão passa a exigir `PASSWORD_SESSION_SECRET` para todo o recurso de links protegidos por senha. `API_KEY` deixou de ser fallback de sessão.

- Instalações sem links protegidos por senha: nenhuma ação necessária.
- Instalações com links protegidos por senha: configure `PASSWORD_SESSION_SECRET` como secret do Worker **antes** do upgrade/deploy desta versão.
- `API_KEY` não é mais utilizado para assinar sessões de links protegidos por senha.
- Links protegidos legados sem `PASSWORD_SESSION_SECRET` falham fechados com HTTP 503, tanto no `GET` quanto no `POST`, sem redirect e sem cookie de sessão.
- HTTP 503 significa configuração pendente no servidor; não é senha incorreta nem link inexistente.
- Não existe fallback inseguro: sem o secret, o recurso fica indisponível em vez de degradar.

Fluxo normal:

1. Atualize o codigo:

```bash
git pull --ff-only
npm install
npm run wrangler:init
npm test
```

## Upgrade legado para v2.0.0

Esta versão é breaking change de produto e schema.

Ela remove:

- `stats`
- `IP_HASH_SECRET`
- `last_clicked_at`
- `notes`
- endpoint `/api/links/:slug/stats`
- endpoint `/api/maintenance/purge-stats`

## Passo a passo

1. Atualize o código:

```bash
git pull --ff-only
npm install
```

2. Recrie ou sincronize o config local:

```bash
npm run wrangler:init
```

3. Aplique migrations localmente:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --local
```

4. Se o deploy for manual e já houver ambiente remoto:

```bash
npm run wrangler -- d1 migrations apply <nome-do-banco-ou-binding-real> --remote -c wrangler.local.jsonc
```

5. Valide:

```bash
npm test
```

## GitHub auto-deploy e one-click

Se você atualiza pelo GitHub ou pelo botão:

- o código novo consegue reconciliar schema legado em runtime
- ainda assim, a migration continua sendo o caminho recomendado

## Impacto funcional

- a contagem continua existindo em `clicks_total`
- o referrer público passa a ser apenas `strict-origin`
- métricas detalhadas deixam de existir por padrão

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
