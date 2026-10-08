# Checklist de publicação — BoltLink 3.2.1

Este arquivo registra a preparação autorizada do commit definitivo. A documentação do produto está finalizada para a release pública **3.2.1**, tag **v3.2.1**; a release anterior **v3.2.0** permanece congelada. Os resultados de push, CI, tag e GitHub Release são registrados no relatório operacional externo à release, sem avançar main depois da tag.

## Integridade local

- [x] Freeze do Gate 10.3 e ancestralidade dos Gates 10.1–10.3 preservados; árvore inicialmente limpa.
- [x] Documentação corrente promovida para 3.2.1; Changelog datado em America/Sao_Paulo e Release Notes definitivas.
- [x] Histórico dos Gates 10.1–10.3, changelogs anteriores, screenshots, GIF, imagens e Deploy Button preservados.
- [x] Package, lockfile e APP_VERSION em 3.2.1; nenhuma mudança funcional no Admin/runtime.
- [x] Migrations 0000–0006 e schema preservados. **MIGRATION_0007 = NOT_REQUIRED**.
- [x] Scripts operacionais congelados: preflight D1, seleção de config/ambiente, merge por binding e upgrade:check obrigatório.
- [x] Autorização expressa do proprietário para GitHub source distribution; sem produção Cloudflare associada ao repositório oficial, conforme confirmação do proprietário.
- [ ] Registrar no relatório externo suíte completa, dependências offline, TypeScript e diff check; somente TS7016 histórico de qrcode é aceito.
- [ ] Registrar SHA definitivo e árvore limpa após o único commit documental de publicação.

## Sequência autorizada e dependente de evidência

1. Revalidar origin/main na base, tag v3.2.0 preservada e ausência de tag/Release v3.2.1; avanço concorrente bloqueia.
2. Integrar por fast-forward na main, preservar histórico e fazer push sem force.
3. Aguardar CI da main no SHA definitivo; falha ou skips históricos interrompem antes da tag.
4. Criar tag anotada v3.2.1, mensagem `BoltLink v3.2.1`, no mesmo SHA; conferir objeto anotado e commit separadamente, e publicar sem sobrescrever tags.
5. Aguardar CI da tag no mesmo SHA. Falha interrompe antes da Release; não mover ou excluir a tag.
6. Criar GitHub Release com título `BoltLink v3.2.1`, notas definitivas, draft false, prerelease false e latest true; sem assets extras.
7. Auditar main/origin/main/tag/Release/CI, metadados públicos, README, links relativos, screenshots, GIF e Deploy Button apontando para o repositório oficial e main.
8. Verificar preservação de v3.2.0 e das Releases/tags históricas e entregar o relatório final.

Se ocorrer falha após escrita remota, registrar publicação parcial e solicitar orientação, sem rollback destrutivo. Não executar `npm run deploy` como validação.

## Separação operacional

GitHub Release é source distribution. Não há deploy Cloudflare, migration D1 remota, alteração de Worker/Pages/DNS/Access/secrets ou atualização automática de clientes neste fluxo. Cada instalação precisa seguir o [upgrade seguro](upgrading.md#upgrade-seguro--321), preservar sua identidade e autorizar suas próprias operações.

UUID válido não comprova associação ao banco correto; IDs perdidos exigem recuperação individual. O primeiro Deploy Button remoto desta versão não foi validado durante a preparação. O workflow de testes usa histórico/tags completos, `contents: read` e `persist-credentials: false`, sem job de deploy.

## Baselines preservados

```text
BASE_SHA = 84ecacf1822f41c2fcc240d464dc4a0b43447d7a
FREEZE_SHA = 4588f219870c2754724568fad6cc21075d08e1b5
VERSION = 3.2.1
CURRENT_TAG = v3.2.1
PREVIOUS_VERSION = 3.2.0
```

Release atual publicada: 3.2.1 · Tag: v3.2.1 · Release anterior: 3.2.0
