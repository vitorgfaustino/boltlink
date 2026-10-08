# Publicação futura — BoltLink 3.2.1

A candidata local **3.2.1 não está publicada**. Este documento prepara o próximo gate e não autoriza suas operações. A release atual pública permanece na tag `v3.2.0`. GitHub source distribution e operações Cloudflare por instalação são escopos separados.

| Passo | Verificação / ação | Estado neste gate |
| --- | --- | --- |
| 1 | Confirmar Gate 10.2 e ausência de P0/P1/P2 | Relatório local |
| 2 | Conferir package, lockfile e versão da aplicação em 3.2.1 | Preparado localmente |
| 3 | Conferir suíte completa, dependências, TypeScript e diff check | Evidências do relatório |
| 4 | Auditar delta contra BASE_SHA 84ecacf1822f41c2fcc240d464dc4a0b43447d7a; migrations/schema sem delta | Evidências locais |
| 5 | Conferir template sem UUID e simulações do Deploy Button | Somente local; primeiro deploy remoto não comprovado |
| 6 | Revisar CHANGELOG/RELEASE_NOTES e reconciliar metadata pública no futuro gate autorizado | Candidata preparada |
| 7 | Confirmar SHA final e árvore limpa | Commit local do Gate 10.2 |
| 8 | Obter autorização explícita do proprietário com destino/escopo concreto | **Não concedida** |
| 9 | Integrar seguramente na main, preservando histórico e invariante de release | **Não executar neste gate** |
| 10 | Push autorizado de main | **Não executar neste gate** |
| 11 | Verificar CI da main, inclusive tag histórica v2.2.1 | Pendente GitHub |
| 12 | Criar tag v3.2.1 no SHA autorizado | **Não executar neste gate** |
| 13 | Verificar CI da tag | Pendente GitHub |
| 14 | Criar GitHub Release e conferir latest/metadados | **Não executar neste gate** |
| 15 | Auditar publicamente source commit/main/tag/Release/CI e documentação | Pendente publicação |

Não executar passos 8–15 no Gate 10.2. Antes de publicação futura, a redação corrente de candidata e os scanners de identidade precisam ser reconciliados com o novo estado autorizado; não antecipar que a 3.2.1 já é Latest. A alteração do workflow de testes busca histórico/tags com `fetch-depth: 0`, somente `contents: read`, sem persistir credenciais, sem job de deploy. Sua execução real no GitHub continua pendente.

Para cada instalação existente, aplica-se separadamente o [upgrade seguro](upgrading.md#upgrade-seguro--candidata-321): baseline confiável, comparação obrigatória, preflight, testes, diff e autorização antes de push/auto-deploy. Publicar uma release source distribution não atualiza Worker ou D1 de clientes nem autoriza migrations remotas.
