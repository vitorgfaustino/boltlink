# Checklist de publicação — BoltLink 3.2.0

Este arquivo registra a preparação do commit definitivo. A documentação do produto está finalizada para a release pública **3.2.0**, tag **v3.2.0**; a release anterior **v3.1.1** permanece congelada. O resultado das operações posteriores ao commit é registrado no relatório operacional externo à release, sem avançar main depois da tag.

## Preparação concluída

- [x] Autorização explícita do proprietário para commit, integração em main, push, tag e GitHub Release estável.
- [x] Preflight aprovado: checkout correto e limpo, descendente da base oficial, sem avanço concorrente, tag/release alvo ausentes.
- [x] Ausência de deploy automático no repositório oficial confirmada expressamente pelo proprietário. Consulta GitHub Apps com 403 é não bloqueante; nenhum workflow de deploy identificado.
- [x] Documentação final reconciliada: README sem estado transitório, Changelog datado, Release Notes finais e guias atuais na 3.2.0; histórico preservado.
- [x] Deploy Button aponta para main do repositório oficial; setup com ROOT_REDIRECT_URL como Text opcional. Screenshots e GIF aprovados preservados.
- [x] Versão 3.2.0, migrations 0000–0006 e schema preservados. **MIGRATION_0007 = NOT REQUIRED**. Sem bump adicional.

## Validação e operações posteriores

- [x] Validação final aprovada: npm test (1237 testes), npm ls --depth=0 --offline e git diff --check; npx --no-install tsc --noEmit apresenta somente o TS7016 histórico de qrcode. Conferidos 38 links/referências relativos e dez assets de showcase preservados.
- [ ] Criar commit definitivo e registrar o SHA no relatório externo; integrar main por fast-forward, sem reset, squash ou reescrita.
- [ ] Reconfirmar main remota, tag/release ausentes e ausência de evidência contrária à confirmação do proprietário antes do primeiro push.
- [ ] Publicar somente main, confirmar main == origin/main e aguardar CI aprovado antes da tag.
- [ ] Criar tag anotada v3.2.0 no SHA definitivo, publicar sem sobrescrever tags e aguardar CI da tag aprovado antes da Release.
- [ ] Publicar GitHub Release estável/latest, título BoltLink v3.2.0, notas finais e nenhum anexo adicional.
- [ ] Verificar refs, Release ID/URL, latest, CI, README renderizado, screenshots, GIF, Deploy Button e tags históricas; registrar evidência final fora da release congelada.

Caixas abertas registram operações posteriores à preparação deste arquivo; o relatório externo documenta sua execução e verificação. Publicação é source distribution. Deploy, configuração Cloudflare e migrations D1 remotas permanecem proibidos neste escopo.

P3 aceitos: TS7016 histórico de qrcode; `public/tela-links.webp`, `public/tela-home.webp` e `public/tela-link-protegido.webp` preservados para limpeza futura; `LANDING_DARK_ALIGNMENT = DEFERRED` e `PRIMARY_HOVER_GLOW = DEFERRED`.
