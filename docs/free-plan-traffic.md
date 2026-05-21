# Trafego e Plano Gratuito Cloudflare

Este guia documenta medidas para reduzir desperdicio de requisicoes e uso de D1 em instancias BoltLink operadas no plano gratuito ou com foco em baixo custo.

## Limites que importam

- Workers Free possui limite diario de requisicoes ao Worker.
- Requisicoes para Static Assets sao gratuitas e ilimitadas, mas requisicoes que chegam ao script do Worker contam como uso do Worker.
- D1 Free possui limites proprios de tamanho, leituras, escritas e quantidade de bancos.

Fontes oficiais:

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Static Assets billing: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/

## O que o codigo faz

BoltLink aplica duas protecoes gratuitas dentro da aplicacao:

- rejeita probes publicos com slug invalido antes de consultar D1, por exemplo `/.env`, `/wp-login.php` e caminhos com caracteres fora do padrao de slug
- aplica rate limit em memoria para leituras publicas de redirect antes do D1, reduzindo rajadas de um mesmo IP no banco

Essas protecoes economizam D1, mas nao eliminam a requisicao do Worker. Se a requisicao chegou ao Worker, ela ainda conta como requisicao do Worker.

## Opcoes gratuitas no painel Cloudflare

### Bot Fight Mode

Bot Fight Mode e um recurso gratuito da Cloudflare para desafiar trafego identificado como bot.

Fonte oficial: https://developers.cloudflare.com/bots/get-started/free/

Como habilitar:

1. Acesse o dashboard da Cloudflare.
2. Selecione a conta e o dominio.
3. Abra `Security > Bots` ou `Security > Settings`.
4. Ative `Bot Fight Mode`.
5. Monitore `Security > Events`.

Observacao: Bot Fight Mode atua no dominio inteiro e nao permite ajuste por endpoint. Se afetar trafego legitimo, desative e revise a origem do problema.

### workers.dev e Preview URLs

Para instancias reais em dominio proprio, reduza superficies publicas extras:

1. Use um dominio proprio para o Worker.
2. No `wrangler.local.jsonc` do ambiente real, defina `workers_dev: false`.
3. Defina `preview_urls: false` para evitar URL publica de preview.
4. Faca deploy novamente pelo fluxo usado pela instancia.

Fonte oficial: https://developers.cloudflare.com/workers/wrangler/configuration/

O `wrangler.jsonc` publico pode continuar amigavel para Deploy Button e testes iniciais. A configuracao privada de producao deve ser ajustada pelo operador da instancia.

## O que nao e baseline gratuita

Cloudflare WAF Rate Limiting Rules, Bot Management avancado e regras mais granulares podem depender de plano ou produto pago.

Por isso, a baseline do BoltLink nao exige WAF pago. Se o operador tiver esses recursos, pode usa-los como camada adicional fora da aplicacao.

## Trafego dos EUA

Muitas requisicoes vindas dos EUA podem ser bots, crawlers, previews sociais, monitores ou infraestrutura de nuvem. Nao bloqueie pais por padrao apenas por aparecer como EUA.

Antes de bloquear por pais:

- verifique `Security > Events`
- confirme se nao sao previews sociais ou plataformas de ads
- prefira Bot Fight Mode e reducao de superficies `workers.dev`/preview

---

Versao 2.0.1
Criado por Vitor Faustino - vitorfaustino.com.br
