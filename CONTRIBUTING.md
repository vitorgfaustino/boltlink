# Contribuindo

Obrigado pelo interesse neste projeto.

Este repositório está em modo de colaboração `somente leitura + feedback`.

Isso significa:

- Issues são bem-vindas para bugs, dúvidas e sugestões.
- Pull Requests externos não são aceitos no momento.
- PRs enviados por terceiros podem ser fechados automaticamente ou permanecer sem revisão.

O objetivo dessa política é preservar a visão autoral do projeto, manter a evolução técnica centralizada e evitar divergência de direção em um repositório que também funciona como portfólio.

## Como ajudar de forma útil

Se você quiser colaborar, use Issues.

Os melhores relatos costumam incluir:

- um título claro e direto
- contexto do problema
- passos para reproduzir
- comportamento esperado
- comportamento atual
- ambiente utilizado, como navegador, sistema operacional e modo local ou deploy
- logs, prints ou trechos de resposta relevantes

Nunca inclua segredos, tokens, `API_KEY`, valores reais de `TEAM_DOMAIN`, `POLICY_AUD` ou qualquer credencial em uma Issue.

## O que acontece com Pull Requests

PRs externos não fazem parte do fluxo oficial deste repositório.

Na prática:

- Pull Requests de terceiros podem ser fechados automaticamente.
- Mudanças de código enviadas via PR não são a via recomendada de contribuição.
- Se a sua ideia for útil, abra uma Issue descrevendo a proposta e o motivo.

Se você quiser adaptar o projeto para seu próprio uso, a recomendação é trabalhar no seu fork localmente e manter sua própria linha de evolução.

## O que pode virar Issue

- bug reproduzível
- dúvida de uso ou configuração
- sugestão de melhoria
- problema de documentação
- problema de experiência do admin

## Antes de abrir uma Issue

- verifique se o problema já não foi relatado
- confirme se você removeu dados sensíveis do texto
- revise a documentação em `README.md` e `docs/`

## Contexto técnico para relatar problemas

- O slug é imutável após a criação.
- O redirect não deve esperar a gravação de analytics.
- `wrangler.jsonc` é o template público da configuração.
- `wrangler.local.jsonc` é a configuração privada e não deve ser versionada.
- O admin depende de Cloudflare Access quando configurado para produção.

## Setup local

```bash
npm install
npm run wrangler:init
npm run cf-typegen
npm run wrangler -- d1 migrations apply <nome-do-banco> --local
npm run dev
npm test
```

## Resumo da política deste repositório

- Código: sem aceitação de PRs externos no momento
- Feedback: Issues abertas e incentivadas
- Segurança: nunca publicar segredos
- Uso próprio: faça no seu fork, respeitando a licença

---

Versão 1.0.0
Criado por Vitor Faustino - vitorfaustino.com.br