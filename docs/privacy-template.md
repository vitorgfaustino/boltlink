# Template de Politica de Privacidade

Este arquivo e um modelo generico para quem implantar o BoltLink.

Ele nao substitui assessoria juridica e nao representa a politica de privacidade do autor do software.

Quem publicar o sistema deve adaptar este texto aos dados reais do proprio ambiente, aos subprocessadores efetivamente usados e a base legal aplicavel ao caso concreto.

---

# Politica de Privacidade

Ultima atualizacao: `[preencher data]`

## 1. Quem somos

Este servico e operado por:

- Nome do operador/controlador: `[preencher]`
- CNPJ/CPF, se aplicavel: `[preencher]`
- E-mail de contato: `[preencher]`
- Canal para assuntos de privacidade: `[preencher]`

## 2. Escopo

Esta Politica de Privacidade descreve como tratamos dados pessoais relacionados ao uso deste servico de gerenciamento e redirecionamento de links.

## 3. Dados tratados pelo sistema

No estado padrao do BoltLink v2.0.0, o produto foi configurado para minimizar coleta e persistencia de dados.

O sistema pode persistir:

- slug do link
- URL de destino
- contador agregado de cliques (`clicks_total`)
- datas operacionais do link
- tags e grupos definidos pelo operador
- hash de senha do link, quando houver protecao por senha

O sistema nao persiste, por padrao:

- IP em texto puro
- hash de IP
- pais por clique
- `Referer`
- `User-Agent`
- eventos individuais por clique

## 4. Finalidades do tratamento

Os dados sao tratados para:

- operar o redirecionamento de links
- administrar links, grupos, expiracao e configuracoes relacionadas
- manter contagem agregada de cliques
- proteger o painel administrativo e a API

## 5. Base legal

As bases legais aplicaveis dependem da forma como este servico e utilizado pelo operador.

O operador deve identificar e informar aqui a base legal adequada para cada finalidade efetivamente praticada.

## 6. Compartilhamento

Este servico pode depender de provedores de infraestrutura e seguranca, como a Cloudflare, conforme a configuracao adotada pelo operador.

Liste aqui os subprocessadores e provedores efetivamente utilizados:

- `[preencher]`

## 7. Retencao

No estado padrao do BoltLink v2.0.0, nao existe tabela de eventos de clique.

Ainda assim, o operador deve definir e documentar:

- por quanto tempo mantera links e grupos
- por quanto tempo mantera logs externos eventualmente ativados

## 8. Direitos do titular

O titular pode solicitar, quando aplicavel:

- confirmacao do tratamento
- acesso
- correcao
- anonimização, bloqueio ou eliminacao
- informacoes sobre compartilhamento
- revogacao de consentimento, quando essa for a base legal utilizada

Canal para exercicio de direitos:

- `[preencher]`

## 9. Seguranca

O servico utiliza controles tecnicos e organizacionais compativeis com sua operacao, incluindo autenticacao administrativa e minimizacao de dados no estado padrao do produto.

## 10. Observacoes importantes sobre este software

Este sistema utiliza o software livre BoltLink, distribuido sob AGPL-3.0.

O autor original do software nao e o operador deste servico e nao participa automaticamente do tratamento de dados realizado por quem implanta ou utiliza esta instancia.

Toda responsabilidade pela operacao concreta deste ambiente, pela configuracao de provedores, pela base legal e pelo conteudo inserido no sistema e do operador identificado nesta politica.
