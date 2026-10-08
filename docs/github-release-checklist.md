# GitHub Release Checklist

## Release 3.2.0 — publicação e verificação

- confirmar versão `3.2.0` em package.json e nas duas entradas do lockfile; `APP_VERSION` deriva do package
- manter `v3.1.1`, `v3.1.0` e `v3.0.0` congeladas; publicar `v3.2.0` somente após validação local e autorização explícita
- confirmar scripts `db:migrations:apply` pelo binding `db_boltlink` e `deploy` com migrations antes do Worker e encadeamento `&&`
- confirmar wrapper e `migrations_dir: "migrations"`; arquivos `0000`–`0006` inalterados; **MIGRATION_0007 = NOT REQUIRED**
- validar encadeamento com mock e routing do wrapper em Workers Builds (`WORKERS_CI=1`) sem config privado
- rodar `npm test`, `npm ls --depth=0 --offline`, `git diff --check`, syntax checks dos scripts e `npx --no-install tsc --noEmit`; somente o TS7016 histórico de `qrcode` é aceito
- não executar `npm run deploy` para validar o gate: agora ele aplica migrations remotas
- a GitHub Release continua source distribution; publicar tag/release não toca D1 de clientes; cada instalação executa seu próprio `npm run deploy`
- manter Deploy command = `npm run deploy` no Deploy Button/Workers Builds da instalação; comandos diretos não passam pelo apply

## Checklist geral

- confirmar que `README.md`, `AI-START.md`, `docs/cloudflare-setup.md`, `docs/privacy.md` e `docs/upgrading.md` refletem a versão atual
- confirmar que `docs/privacy-template.md` está presente e coerente com a baseline LGPD
- confirmar que nenhum valor real de `API_KEY`, `PASSWORD_SESSION_SECRET`, `TEAM_DOMAIN`, `POLICY_AUD`, `database_id` ou domínio privado aparece em arquivos versionados
- confirmar que o template público não menciona mais `IP_HASH_SECRET`
- confirmar que `stats`, `last_clicked_at` e `notes` não aparecem mais como recursos ativos do produto
- rodar `npm test`
- validar `wrangler.jsonc` com `observability.enabled = false` e `upload_source_maps = false`
- revisar `CHANGELOG.md` e `RELEASE_NOTES.md`

---

Release atual publicada: 3.2.0 · Tag: v3.2.0
Criado por Vitor Faustino - vitorfaustino.com.br

Na publicação, promover main por fast-forward, criar tag anotada v3.2.0 e GitHub Release sem prerelease/draft/assets adicionais. Verificar main/tag, latest, CI e preservação das tags históricas. Operações Cloudflare continuam fora da publicação do repositório.
