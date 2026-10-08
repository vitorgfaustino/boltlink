# Checklist de publicação posterior — BoltLink 3.2.0

**Estado atual: candidata local, não publicada. Autorização de publicação não concedida.** Este checklist não autoriza sua execução. A release oficial continua 3.1.1, tag v3.1.1. Publicação do repositório é source distribution; não opera instalações Cloudflare.

- [ ] Obter aprovação explícita do usuário para publicar a 3.2.0, incluindo integração em main, push, tag e GitHub Release.
- [ ] Conferir branch, HEAD aprovado e árvore de trabalho; preservar alterações alheias e as tags históricas v3.1.1, v3.1.0 e v3.0.0.
- [ ] Reconciliar README, AGENTS, AI-START, PRODUCT, CHANGELOG, RELEASE_NOTES e docs com o estado de publicação acordado. Converter os oito resumos de candidata, finalizar a data do Changelog e distinguir 3.2.0 atual, 3.1.1 anterior e baselines históricos. Revisar também DESIGN.md, textos de versão em public e guias que citam `/version`; não alterar blocos históricos como se fossem a versão corrente.
- [ ] Atualizar os textos do Deploy Button: após integração, main distribuirá 3.2.0 e o setup terá ROOT_REDIRECT_URL como Text opcional. Preservar variáveis do dashboard, configuração privada e secrets.
- [ ] Executar testes finais após essa atualização: npm test (pelo menos 1234 aprovados), npm ls --depth=0 --offline, npx --no-install tsc --noEmit e git diff --check. Aceitar somente o TS7016 histórico documentado do qrcode, sem erro novo. Conferir novamente links, screenshots e GIF.
- [ ] Confirmar versão 3.2.0, migrations 0000–0006 e schema preservados; MIGRATION_0007 = NOT REQUIRED. Não fazer bump adicional nem adicionar migration para esta publicação.
- [ ] Criar o commit definitivo, registrar o SHA e integrar a candidata em main com revisão do diff completo e método aprovado, sem reset destrutivo ou perda de trabalho.
- [ ] Enviar somente os refs autorizados e confirmar main == origin/main com leitura remota atual. Se surgir divergência, parar e reconciliar antes da tag.
- [ ] Criar v3.2.0 no commit definitivo correto, enviar a tag autorizada e confirmar que ela resolve para o mesmo commit de main/origin/main. Nunca mover tags históricas.
- [ ] Publicar GitHub Release com título e notas finais da 3.2.0, status definitivo e latest conforme aprovado. Não anexar screenshots, GIF, logs ou bundles desnecessários: os assets já estão no source.
- [ ] Verificar CI de main e da tag, URLs da release, Deploy Button e assets no GitHub; confirmar ausência de anexos desnecessários e coerência documental após a publicação.
- [ ] Registrar a evidência final de source distribution. Deploy Cloudflare, migrations D1 remotas, Access e smoke de uma instalação somente mediante solicitação e autorização separadas para essa instalação.

Limpezas futuras não bloqueantes: preservar por enquanto `public/tela-links.webp`, `public/tela-home.webp` e `public/tela-link-protegido.webp`; avaliar remoção em escopo próprio. `LANDING_DARK_ALIGNMENT = DEFERRED` e `PRIMARY_HOVER_GLOW = DEFERRED` permanecem fora desta publicação.
