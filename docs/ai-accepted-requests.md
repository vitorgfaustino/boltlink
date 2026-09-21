# Catálogo de Pedidos Aceitos pela IA

## Regras de uso

- leia `AI-START.md` primeiro
- não invente valores do usuário
- faça uma pergunta por vez quando faltar contexto
- preserve `wrangler.local.jsonc` e overlays do projeto
- não reintroduza coleta detalhada de analytics

## Catálogo

| Chave | Frases aceitas | O que pode automatizar | Onde parar |
| --- | --- | --- | --- |
| `iniciar_projeto` | `Iniciar o Projeto`, `start the project` | setup local, geração do config privado, D1 local, testes | antes da criação final do Access |
| `continuar_configuracao` | `Continuar configuração do projeto`, `retomar setup` | retomar próximo passo e corrigir config | em qualquer checkpoint manual |
| `atualizar_projeto` | `Atualizar o Projeto`, `pull latest version` | atualizar código, dependências, `wrangler.local.jsonc`, migrations e testes | antes de sobrescrever mudanças locais |
| `aplicar_migrations` | `Aplicar migrations`, `rodar migrations` | aplicar migrations local e/ou remoto | se o banco alvo estiver indefinido |
| `auditar_estado_operacional` | `Auditar estado operacional`, `check status` | revisar config, docs e pendências | não há parada especial |
| `publicar_workers_dev` | `Publicar no workers.dev`, `deploy inicial` | deploy padrão e validação pública | antes de Access |
| `publicar_com_deploy_button` | `Deploy to Cloudflare Workers`, `usar o botão de deploy` | revisar template público e preparar pós-deploy | antes da criação final do Access |
| `configurar_dominio_customizado` | `Configurar domínio`, `usar domínio próprio` | revisar `wrangler.local.jsonc`, DNS e checklist | antes do dashboard |
| `preparar_access` | `Preparar Access`, `proteger admin` | orientar Access e validar variáveis | sempre antes da criação final |

## Notas da linha atual

- não existe mais `IP_HASH_SECRET`
- a release publicada `v2.2.1` (tag real) termina na `0003_lgpd_minimization.sql`; a `0004` pertence ao baseline local da Fase 2 e a `0005` ao estado Unreleased / Fase 3
- o endpoint `/api/links/:slug/stats` não faz mais parte do produto
- o endpoint `/api/maintenance/purge-stats` não faz mais parte do produto
- para pedido de teste local/manual nas bases locais (Fase 2 e Fase 3), a IA deve aplicar migrations no D1 local do Worker com `npm run dev-prepare` antes de `npm run dev`; no checkout da tag `v2.2.1` esse script não existe e o comando é `npm run wrangler -- d1 migrations apply ... --local`
- `npm run dev-init` é opcional em qualquer base e cria apenas o SQLite auxiliar `.dev-env/db.sqlite3`

---

Versão 2.2.1
Criado por Vitor Faustino - vitorfaustino.com.br
