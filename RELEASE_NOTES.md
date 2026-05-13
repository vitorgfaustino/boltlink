# Release Notes

Esta página destaca os principais focos da versão mais recente. O detalhamento de cada mudança está disponível no [CHANGELOG.md](CHANGELOG.md).

## 1.1.0 - 2026-05-13

O **BoltLink 1.1.0** amplia a base 1.0.0 com foco em três frentes: qualidade de analytics, gestão avançada de links e experiência operacional no admin.

Esta release adiciona controles mais completos para campanhas (ativação, expiração, tipo de redirect, tags, grupos, QR, duplicação), melhora a confiabilidade dos dados de cliques com filtro anti-bot e refina a UX do painel para uso diário em produção.

**Destaques da 1.1.0:**
- **Analytics mais confiável**: filtro de cliques reais bloqueando bots, crawlers, prefetch/prerender e tráfego automatizado.
- **Gestão avançada de links**: suporte a `301/302`, `Ativa em`, `Expira em`, tags, notas, grupos, QR por link e duplicação com slug sugerido.
- **Links com senha**: gate de acesso com hash+salt, sessão curta e controle de tentativa.
- **Admin UX revisado**: layout com seções colapsáveis, help text em todos os campos, preview UTM sem overflow e contador regressivo de exclusão com desfazer.
- **Privacidade preservada**: sem persistência de IP em texto puro, sem `Referer` e sem `User-Agent` em banco.
- **Evolução de schema e upgrade guiado**: novas migrations (`0001`, `0002`) e documentação dedicada para atualização segura.

**Validação desta release:**
- 69 testes automatizados aprovados (filtro de clique, referrer policy, recursos avançados, integração Worker).
- Fluxo admin validado localmente em layout responsivo e operações principais.
- Revisão de segurança local concluída para manter fora do Git qualquer artefato de ambiente (`.dev-env/`, `.dev.vars*`, `wrangler.local.jsonc`).

## 1.0.0 - 2026-05-10

O **BoltLink 1.0.0** marca a consolidação oficial do projeto sob a nova licença GNU Affero General Public License v3.0 (AGPL-3.0).

Esta versão consolida todo o histórico do encurtador de URLs serverless em uma base unificada, trazendo desde as configurações de Zero Trust, rate limiting e analytics até a interface administrativa responsiva, garantindo proteção máxima de autoria e exigindo que qualquer uso do sistema em rede (SaaS) tenha seu código-fonte compartilhado.

**Destaques desta consolidação:**
- **Licenciamento Estrito**: Adoção integral da licença AGPL-3.0.
- **Proteção Integral**: Aplicação de cabeçalhos de licença e Disclaimer de isenção total de responsabilidade em todo o código e no README.
- **Histórico Unificado**: Todo o desenvolvimento prévio (versões antigas) foi unificado na versão base 1.0.0, garantindo uma linha do tempo limpa no repositório.
- **Segurança Pronta para Produção**: Autenticação nativa com Cloudflare Access, rate limiting e HMAC-SHA-256 para IPs já vêm embutidos.
