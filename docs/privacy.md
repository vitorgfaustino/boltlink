# Privacy (BoltLink 3.0.0)

## Release publicada — 3.1.1

A **3.1.1 está publicada**, identificada pela tag **v3.1.1**; é a release atual e latest do repositório. A release anterior **v3.1.0** permanece congelada. Este patch operacional aplica migrations D1 pendentes antes do Worker no fluxo padrão de deploy e amplia o guia Cloudflare Access. **MIGRATION_0007 = NOT REQUIRED**; migrations `0000`–`0006`, sem mudança funcional no produto.

Publicar tag/release é **source distribution** e não opera Cloudflare de clientes. Cada instalação executa o próprio `npm run deploy`, que aplica apenas migrations pendentes antes do Worker, e configura seu próprio Access. O guia completo está em [Cloudflare Access](admin-auth.md).

## Recursos preservados desde a 3.1.0

A **3.1.0**, agora release anterior congelada na tag **v3.1.0**, introduziu os recursos abaixo. A tag histórica **v3.0.0** também permanece congelada. A 3.1.0 adiciona Lixeira, restauração validada, exclusão definitiva com reutilização de slug e limpeza administrativa explícita com preview e retenção de 90 dias. Não há Cron automático. O export passa a conter somente links ativos; tombstones ficam fora do documento e dos limites de links, enquanto ativos inválidos continuam fail-closed. Import v1 legado com `disabled: true` continua aceito. **MIGRATION_0007 = NOT REQUIRED**; migrations permanecem `0000`–`0006`.

Contrato completo e operação no Admin: [Lixeira e recuperação](trash-recovery.md). Os procedimentos correntes abaixo seguem a release `3.1.1`. Publicar código no Git/GitHub não atualiza instalações: deploy, D1 remoto e Access exigem autorização própria por instalação.


> Escopo: release atual = **`3.1.1`** (publicada; os recursos de roteamento abaixo têm origem nas Fases 2–5 do desenvolvimento e foram publicados juntos na `3.0.0`). A release histórica `v2.2.1` não contém Split Test A/B, Smart Routing, destino de expiração, `ROOT_REDIRECT_URL`, portabilidade nem o diálogo de QR Code.

## Princípio

Redirecionar, contar de forma agregada e evitar coleta desnecessária.

## O que o produto persiste

- `links.slug`
- `links.target_url`
- `links.clicks_total`
- `links.created_at`
- `links.updated_at`
- campos operacionais do link: `redirect_type`, `expires_at`, `go_live_at`, `tags`, `has_qrcode`, `group_id`, `password_hash`, `disabled_at`, `version`
- nomes de grupos em `link_groups`

### Split Test A/B (release 3.0.0, migration 0004)

> Escopo: release `3.0.0` (migration `0004`, introduzida originalmente na Fase 2 e publicada desde a `3.0.0`). A tag anterior `v2.2.1` não tem Split Test A/B.

- quando o Split Test A/B está ativo, o link passa a persistir também `ab_target_url`, `ab_weight_b`, `ab_enabled`, `ab_started_at`, a geração/epóque do experimento e os contadores agregados `ab_clicks_a` e `ab_clicks_b`

## O que o produto não persiste

- IP em texto puro
- hash de IP
- país por visitante
- dispositivo derivado por visitante
- `Referer`
- `User-Agent`
- eventos por clique
- `last_clicked_at`
- notas internas livres
- cookies de rastreamento
- cookie de experimento A/B
- registro de qual variante (A ou B) um visitante recebeu
- visitor ID, fingerprint ou qualquer identidade estável de visitante

## Contagem

Cada clique elegível incrementa apenas `links.clicks_total`.

O redirecionamento continua respondendo antes da atualização do contador.

O operador pode zerar manualmente `links.clicks_total` de um link ativo pelo admin. Isso remove apenas a métrica agregada daquele link; não existe histórico de eventos individuais para apagar.

Excluir um link marca `disabled_at`, impede novo redirect e reserva o slug enquanto a linha existir. Na 3.1.0, restauração preserva configuração e métricas; exclusão definitiva ou purge manual remove fisicamente o registro e libera o slug. Retenção de 90 dias define elegibilidade; não existe limpeza automática. A Lixeira não entra no export ativo.

### Contagem no Split Test A/B (release 3.0.0)

> Escopo: release `3.0.0` (migration `0004`, origem Fase 2). A tag anterior `v2.2.1` não tem Split Test A/B.

Stateless A/B testing distributes each eligible request independently without building visitor profiles. Em links com Split Test A/B, a variante é sorteada por requisição e apenas os contadores agregados (`ab_clicks_a`, `ab_clicks_b`) são persistidos.

## Smart Routing (release 3.0.0, migration 0005)

> Escopo: release `3.0.0` (migration `0005`, introduzida originalmente na Fase 3 e publicada desde a `3.0.0`). A tag anterior `v2.2.1` não processa Smart Routing.

- quando configurado, o link persiste apenas as regras administrativas em `smart_routing_rules` (país, dispositivo e destino); nenhum dado de visitante é armazenado.
- a seleção de destino usa, de forma transitória e apenas em memória durante o request, o país aproximado fornecido pela Cloudflare (`request.cf.country`) e o `User-Agent` para derivar o tipo de dispositivo. Esses valores não são persistidos por visitante e não produzem analytics de país ou dispositivo.
- não existe cookie de roteamento, visitor ID, fingerprint nem registro da regra selecionada por visita.
- quando o link usa essa feature, apenas `clicks_total` é incrementado; não há contador por regra.

## Destino de expiração e redirect da raiz (release 3.0.0)

> Escopo: release `3.0.0` (migration `0006` e `ROOT_REDIRECT_URL`, introduzidos originalmente na Fase 4 e publicados desde a `3.0.0`). A tag anterior `v2.2.1` não contém estes recursos.

- `links.expired_redirect_url` é configuração administrativa (a URL de destino usada depois que o link expira), no mesmo plano de `target_url`: não é dado de visitante.
- requests de link expirado não gravam nada: zero escritas, zero métrica, sem classificação bot/humano e sem avaliação de país/dispositivo.
- `ROOT_REDIRECT_URL` é variável de ambiente de configuração operacional, não um secret e não um dado pessoal. O redirect da raiz não consulta D1 e não gera métrica.
- A release `3.0.0` não adiciona nenhuma persistência nova de visitante: sem IP, sem `User-Agent`, sem país, sem dispositivo, sem visitor ID, sem eventos de referrer e sem clickstream.
- A minimização de dados e a privacidade por arquitetura apoiam a adequação LGPD do operador, mas não a substituem: quem implanta e opera a instância continua sendo o controlador dos tratamentos que realizar.

## Portabilidade de configuração (release 3.0.0)

> Escopo: release `3.0.0` (introduzida originalmente na Fase 5 e publicada desde a `3.0.0`). A tag anterior `v2.2.1` não possui `GET /api/export` nem as rotas de importação.

- O export contém apenas **configuração administrativa**: destino, tipo de redirect, tags, grupo, lifecycle, existência de senha e configuração de A/B e de Smart Routing. É a mesma informação que o operador vê e digita no painel; nenhum dado individual entra no documento.
- Explicitamente ausentes do JSON: IP, hash de IP, `User-Agent`, país, dispositivo derivado, visitor ID, eventos de referrer, clickstream e qualquer métrica por visitante.
- `password_hash` **não** é exportado: a consulta nem seleciona a coluna e o documento traz apenas `passwordProtected: true/false`. A importação exige uma **nova** senha para cada link protegido, enviada no corpo do `apply`, usada só para gerar o hash e nunca devolvida, registrada ou guardada no navegador.
- O import grava apenas **configuração administrativa** (as mesmas linhas que o operador digitaria no painel): não cria visitor data, não cria métrica, não cria histórico de importações e não registra auditoria de quem importou. Como toda rota administrativa, ele usa upload apenas do arquivo escolhido pelo operador na própria instalação — nenhum documento é enviado a serviço externo.
- Métricas agregadas também ficam de fora (`clicks_total` e contadores A/B): o export é configuração, não histórico. Backup completo do D1 continua sendo o caminho para recuperar estado operacional.
- Por ser leitura administrativa autenticada, o export compartilha o boundary de `/api` (Cloudflare Access, `requireAdmin` ou chave de API) e o mesmo rate limit; nenhuma autenticação paralela foi criada.
- O export é somente leitura: não grava nada no banco e não cria tabela de auditoria nem histórico de exportações. Guardar o arquivo gerado é responsabilidade do operador, como qualquer material administrativo baixado do painel.

## QR Code (release 3.0.0)

> Escopo: release `3.0.0`. Os endpoints `GET/POST /api/links/:slug/qrcode` e a coluna `has_qrcode` existem desde a base publicada; o diálogo de preview e os downloads no painel foram introduzidos na Fase 5 e publicados desde a `3.0.0`.

- O QR codifica apenas a short URL pública do link; nenhum dado de visitante entra na geração, no preview ou no download.
- `has_qrcode` é memória operacional de que um QR foi obtido — escrita pelo `POST` que acompanha um download (PNG ou SVG) —, não telemetria: não conta clique, não identifica visitante e não cria histórico.
- Nenhuma imagem de QR é persistida; o QR é derivável da short URL a qualquer momento.
- A portabilidade de configuração não transporta `has_qrcode` nem imagem de QR: nada de QR entra no export e nada de QR é importado.

## Referrer

Nos redirects públicos, BoltLink envia `Referrer-Policy: strict-origin`.

Isso permite ao destino receber apenas a origem do tráfego quando o navegador decidir enviá-la, sem path nem query string.

O BoltLink não substitui essa origem pelo domínio curto, não adiciona parâmetros artificiais e não tenta contornar decisões do cliente. O site de origem, o navegador ou o app podem usar `no-referrer` ou suprimir o header.

Admin, API, home, gate de senha e respostas não redirect usam `Referrer-Policy: no-referrer`.

## Senhas e rate limit

- links protegidos armazenam apenas `password_hash`
- tentativas de senha usam chave derivada de IP apenas em memória do isolate
- redirects públicos usam rate limit em memória antes da leitura D1
- para abuso público no plano gratuito, consulte `docs/free-plan-traffic.md`

## Responsabilidades

O projeto é distribuído sob AGPL-3.0 e com disclaimer, mas quem implanta e opera o sistema continua responsável por:

- definir a finalidade e a base legal do tratamento
- decidir quais URLs, slugs, tags e grupos conterão dados
- configurar a conta Cloudflare, logs e retenções externas
- atender pedidos de titulares e exigências regulatórias do próprio uso

O autor original do software não se torna controlador, operador ou encarregado apenas por distribuir o código-fonte.

Para apoiar quem publicar uma instância do produto, o repositório inclui um modelo genérico em `docs/privacy-template.md`, que deve ser adaptado pelo operador antes do uso público.

A instância pública padrão também expõe uma página em `/privacidade`, servida por `public/privacidade.html`, para que a política aplicável ao ambiente publicado fique acessível fora do repositório.

---

Release atual publicada: 3.1.1 · Tag: v3.1.1
Criado por Vitor Faustino - vitorfaustino.com.br
