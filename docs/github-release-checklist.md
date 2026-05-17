# GitHub Release Checklist

- confirmar que `README.md`, `AI-START.md`, `docs/cloudflare-setup.md`, `docs/privacy.md` e `docs/upgrading.md` refletem a v2.0.0
- confirmar que `docs/privacy-template.md` está presente e coerente com a baseline LGPD
- confirmar que nenhum valor real de `API_KEY`, `PASSWORD_SESSION_SECRET`, `TEAM_DOMAIN`, `POLICY_AUD`, `database_id` ou domínio privado aparece em arquivos versionados
- confirmar que o template público não menciona mais `IP_HASH_SECRET`
- confirmar que `stats`, `last_clicked_at` e `notes` não aparecem mais como recursos ativos do produto
- rodar `npm test`
- validar `wrangler.jsonc` com `observability.enabled = false` e `upload_source_maps = false`
- revisar `CHANGELOG.md` e `RELEASE_NOTES.md`

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
