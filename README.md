# BoltLink

**Links estáveis para campanhas, QR Codes e materiais — com controle do destino e privacidade por padrão.**

BoltLink é um gerenciador de links que você instala na sua própria conta Cloudflare. Crie uma URL curta, organize seus links e atualize o destino quando precisar: o endereço compartilhado continua o mesmo. O painel reúne criação, edição e contagem agregada de cliques em um só lugar.

**Checkout: 3.2.0 candidata, não publicada · Release oficial: 3.1.1, tag v3.1.1 · AGPL-3.0**

## Por que usar o BoltLink

- **Mantenha seus materiais válidos.** Troque o destino de um link sem substituir o QR Code impresso, a bio ou a URL divulgada.
- **Organize a operação.** Separe clientes, unidades e campanhas em grupos e subgrupos, com caminhos completos e filtros que incluem os descendentes.
- **Tenha controle da instalação.** Worker, banco e configuração ficam na sua conta Cloudflare; o painel é protegido com Cloudflare Access.
- **Meça sem rastrear pessoas.** Veja contagens agregadas de cliques, sem persistir IP, país, dispositivo ou histórico individual de visitas.

## Principais recursos

| Recurso | O que você pode fazer |
| --- | --- |
| Gerenciamento de links | Criar, editar destinos, duplicar e organizar com tags |
| QR Codes | Visualizar e baixar PNG ou SVG do link curto |
| Grupos e hierarquia | Ver o caminho completo e filtrar um grupo com todos os subgrupos |
| UTMs | Montar parâmetros de campanha e editar os valores já presentes na URL |
| Split Test A/B | Distribuir cliques entre dois destinos, com contadores agregados |
| Smart Routing | Escolher destinos por país ou dispositivo, sem guardar esses dados |
| Proteção por senha | Restringir o acesso a links selecionados |
| Agendamento e expiração | Definir ativação, expiração e um destino após expirar |
| Lixeira | Restaurar links ou excluir definitivamente com confirmação |
| Import/Export | Transferir a configuração lógica entre instalações |
| Estatísticas agregadas | Acompanhar cliques totais e distribuição A/B, sem analytics por visitante |
| Light/Dark theme | Escolher o tema do painel |
| Privacidade por padrão | Operar sem perfis de visitantes nem rastreamento individual |

Smart Routing e Split Test A/B são opções alternativas por link. A contagem A/B mede cliques, sem calcular conversões ou declarar um vencedor. A portabilidade de configuração não substitui backup do banco.

## Casos de uso

Use para links da bio, QR Codes em cardápios e materiais impressos, campanhas com UTMs, documentos compartilhados ou gestão de links de várias franquias. Grupos como `Franquia 01 / Bio / Instagram` deixam o contexto visível sem mudar os endereços públicos.

## Screenshots

As imagens abaixo são capturas históricas do projeto (as telas com versão visível mostram v2.1.0). Ilustram os fluxos de links, página inicial e senha, mas não representam o layout da candidata 3.2.0. Serão revisadas após o redesign visual.

![Painel administrativo do BoltLink](public/tela-links.webp)

![Página inicial do BoltLink](public/tela-home.webp)

![Link protegido por senha](public/tela-link-protegido.webp)

## Deploy rápido

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vitorgfaustino/boltlink)

O botão prepara a instalação automaticamente na sua conta. Configure o Cloudflare Access para proteger o painel e a API seguindo o [guia de instalação](docs/cloudflare-setup.md) e o [guia de autenticação](docs/admin-auth.md).

**O botão aponta para `main`, que distribui a release publicada 3.1.1.** As melhorias da candidata 3.2.0 ainda estão no checkout candidato e não são distribuídas pelo botão. Na candidata, `ROOT_REDIRECT_URL` aparece no setup como **Text opcional**: deixe vazio para manter a página inicial, ou informe a URL para a qual deseja redirecionar a raiz `/`.

## Instalação e configuração

- [Setup na Cloudflare](docs/cloudflare-setup.md): instalação pelo botão, Wrangler ou operação guiada por IA.
- [Cloudflare Access](docs/admin-auth.md): proteção administrativa e variáveis da instalação.
- [Atualização e migrations](docs/upgrading.md): upgrade de instalações existentes e backups.
- [Referência técnica](docs/technical-reference.md): comandos, configurações, compatibilidade histórica e matriz de variáveis/secrets.

## Documentação

- [Admin UX da candidata 3.2.0](docs/admin-ux.md): filtro hierárquico, badges e edição de UTMs.
- [Lixeira e recuperação](docs/trash-recovery.md).
- [Senhas em links](docs/password-links.md).
- [Privacidade](docs/privacy.md) e [política de cliques](docs/click-policy.md).
- [Capacidade e tráfego no plano gratuito](docs/free-plan-traffic.md).
- [Notas de versão](RELEASE_NOTES.md) e [Changelog](CHANGELOG.md).

## Arquitetura e desenvolvimento

BoltLink usa Cloudflare Workers, Hono, D1 e um painel estático. O redirect público e a configuração administrativa têm responsabilidades distintas; o projeto conserva apenas métricas agregadas.

Consulte a [arquitetura](docs/architecture.md), o [desenvolvimento local](docs/local-development.md) e o [ponto de entrada para IA](AI-START.md).

## Estado das versões

A **3.1.1 está publicada**, identificada pela tag **v3.1.1** e congelada. A release anterior **v3.1.0** permanece congelada. O checkout desta branch é a **3.2.0 candidata**, ainda sem tag, release ou deploy neste gate. Publicar código não atualiza instalações self-hosted.

## Licença

[AGPL-3.0](LICENSE). Criado por Vitor Faustino — [vitorfaustino.com.br](https://vitorfaustino.com.br).
