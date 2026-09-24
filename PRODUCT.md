# Product

## Register

product

## Users

Operadores que gerenciam links para campanhas, QR codes, bio links e materiais. Contexto: operação diária — criar, editar, monitorar contagem agregada de acessos e manter conformidade LGPD. Não são analistas de dados; são profissionais de marketing, growth e operações que precisam de redirects estáveis e um painel que funcione sem distrações.

## Product Purpose

Self-hosted link management com privacy-by-default. O BoltLink existe para manter links públicos estáveis, independentes de plataformas terceiras, com controle total do redirect, proteção do painel e uma baseline de privacidade mais rígida que a maioria das ferramentas similares.

Sucesso é: redirect rápido e previsível, painel operacional suficiente, zero coleta desnecessária de dados.

## Split Test A/B

Um link pode dividir tráfego entre Control A (o destino principal) e Variant B (destino alternativo) por um percentual definido pelo operador. A escolha é **stateless**: cada requisição humana elegível sorteia a variante de forma independente, sem cookie de experimento, visitor ID ou fingerprint. Bots, crawlers e previews sociais recebem sempre o Control A.

O produto mede apenas **distribuição de cliques** (`Cliques A`, `Cliques B`, `Distribuição observada`, `Traffic Allocation`). Não há taxa de conversão, vencedor, significância estatística, sessões ou receita — conversão continua sendo responsabilidade de ferramentas externas como Google Ads, GA4 e Meta.

## Smart Routing

Um link pode escolher o destino por **país** e/ou **dispositivo** a partir de uma lista ordenada de regras. A primeira regra compatível vence; sem regra compatível, o visitante segue para o destino principal (fallback). O país é o metadado aproximado fornecido pela Cloudflare e o dispositivo é derivado do `User-Agent` da requisição. Ambos são usados apenas para selecionar o destino e não são armazenados por visitante.

Smart Routing é **stateless**: nenhum cookie de roteamento, visitor ID ou fingerprint é criado. A métrica continua sendo apenas `clicks_total` agregado — não há contador por regra, por país ou por dispositivo. Bots, crawlers, previews e prefetch/prerender recebem sempre o destino principal.

Smart Routing e Split Test A/B são **mutuamente exclusivos**, e links com Smart Routing ativo usam sempre redirect temporário `302` com `Cache-Control: no-store`. O recurso não transforma o produto em plataforma de analytics: não há country analytics, device analytics, conversão, UTM injection ou sticky routing.

## Destino de expiração (Unreleased / Fase 4)

Um link com expiração pode escolher o que acontece depois que expira: responder `410` (padrão) ou redirecionar para uma URL escolhida pelo operador. A decisão é do lifecycle, não do roteamento: link expirado não pede senha, não sorteia A/B, não avalia Smart Routing e não conta clique. O destino precisa ser uma URL http/https e só faz sentido junto com uma expiração — limpar a expiração remove o destino junto.

No painel, a seção "Após expirar" apresenta as duas opções em linguagem de operador (`Resposta padrão (410)` / `Redirecionar para URL`), sem nomes técnicos de coluna.

## Redirect da raiz (Unreleased / Fase 4)

A raiz do domínio (`GET /`) pode apontar para uma URL fixa configurada pela variável `ROOT_REDIRECT_URL`. É configuração de operação, não feature de link: não consulta banco, não gera métrica e não muda o comportamento de slugs desconhecidos (que continuam `404`). Sem a variável — ou com valor inválido — a landing normal é servida.

## Brand Personality

**privacy-first, preciso, confiável**

- **Privacy-first**: a decisão de arquitetura vem antes da estética. Contagem agregada sem eventos individuais, sem hash de IP, sem `Referer`, sem `User-Agent`. O produto comunica essa escolha com clareza, não como feature secundária.
- **Preciso**: slugs imutáveis, redirects previsíveis, tipografia mono para dados técnicos, labels exatas, sem metáforas ou decoração vazia.
- **Confiável**: a interface transmite estabilidade. O painel não tenta impressionar; ele funciona. O operador confia que o que está na tela é o que está no banco.

Tom: português técnico direto, sem jargão corporativo, sem entusiasmo artificial.

## Anti-references

- Dashboards de analytics coloridos e sobrecarregados (estilo Mixpanel, Amplitude, Google Analytics 4). Múltiplas cores de gráfico, cards com gradientes, métricas competindo por atenção.
- Encurtadores com estética de rede social (estilo Bitly consumer). Gradientes chamativos, ilustrações decorativas, copy de marketing.
- SaaS landing genérico. Hero metrics, gradientes modais, "trusted by" logos, seções com ícones flutuantes.

O BoltLink não é um dashboard de analytics. É um painel operacional para gerenciar links.

## Design Principles

1. **Privacy as architecture, not as label** — a ausência de tracking não é uma configuração; é a forma do produto. Cada elemento de UI que poderia sugerir coleta de dados deve ser removido ou redesignado.
2. **The redirect is the product** — o caminho crítico do redirect é prioridade máxima. O painel serve para configurar esse caminho; ele não compete com ele.
3. **Understated precision** — a interface serve a tarefa, não a si mesma. Tipografia mono para slugs e dados técnicos. Labels exatas. Nada de decoração pela decoração.
4. **Operator owns the stack** — o produto comunica independência: self-hosted em Cloudflare Workers, sem vendor lock-in de analytics, sem chamadas externas para telemetria.
5. **Common defaults, uncommon restraint** — tema escuro com acento ciano único. Um sistema de cores que não grita. Movimento com propósito, não com espetáculo.

## Accessibility & Inclusion

- **WCAG 2.1 AA** como baseline
- Suporte a `prefers-reduced-motion` já implementado (animações desativadas, transições instantâneas)
- Tema escuro como padrão (respeita `color-scheme: dark`)
- Contraste de texto ≥4.5:1 contra fundo; placeholders revisados para legibilidade
- Focus indicators visíveis (`focus-visible` com box-shadow de 4px no anel de acento)
- Labels sempre visíveis nos campos de formulário; help-tips com toggle acessível por hover/focus
- Fontes do sistema — sem carregamento externo de webfonts
