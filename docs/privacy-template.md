# Template de Política de Privacidade

Este arquivo é um modelo genérico para quem implantar o BoltLink.

Ele não substitui assessoria jurídica e não representa a política de privacidade do autor do software.

Quem publicar o sistema deve adaptar este texto aos dados reais do próprio ambiente, aos subprocessadores efetivamente usados e à base legal aplicável ao caso concreto.

---

# Política de Privacidade

Última atualização: `[preencher data]`

## 1. Quem somos

Este serviço é operado por:

- Nome do operador/controlador: `[preencher]`
- CNPJ/CPF, se aplicável: `[preencher]`
- E-mail de contato: `[preencher]`
- Canal para assuntos de privacidade: `[preencher]`

## 2. Escopo

Esta Política de Privacidade descreve como tratamos dados pessoais relacionados ao uso deste serviço de gerenciamento e redirecionamento de links.

## 3. Dados tratados pelo sistema

No estado padrão do BoltLink v2.0.0, o produto foi configurado para minimizar coleta e persistência de dados.

O sistema pode persistir:

- slug do link
- URL de destino
- contador agregado de cliques (`clicks_total`)
- datas operacionais do link
- tags e grupos definidos pelo operador
- hash de senha do link, quando houver proteção por senha

O sistema não persiste, por padrão:

- IP em texto puro
- hash de IP
- país por clique
- `Referer`
- `User-Agent`
- eventos individuais por clique

## 4. Finalidades do tratamento

Os dados são tratados para:

- operar o redirecionamento de links
- administrar links, grupos, expiração e configurações relacionadas
- manter contagem agregada de cliques
- proteger o painel administrativo e a API

## 5. Base legal

As bases legais aplicáveis dependem da forma como este serviço é utilizado pelo operador.

O operador deve identificar e informar aqui a base legal adequada para cada finalidade efetivamente praticada.

## 6. Compartilhamento

Este serviço pode depender de provedores de infraestrutura e segurança, como a Cloudflare, conforme a configuração adotada pelo operador.

Liste aqui os subprocessadores e provedores efetivamente utilizados:

- `[preencher]`

## 7. Retenção

No estado padrão do BoltLink v2.0.0, não existe tabela de eventos de clique.

Ainda assim, o operador deve definir e documentar:

- por quanto tempo manterá links e grupos
- por quanto tempo manterá logs externos eventualmente ativados

## 8. Direitos do titular

O titular pode solicitar, quando aplicável:

- confirmação do tratamento
- acesso
- correção
- anonimização, bloqueio ou eliminação
- informações sobre compartilhamento
- revogação de consentimento, quando essa for a base legal utilizada

Canal para exercício de direitos:

- `[preencher]`

## 9. Segurança

O serviço utiliza controles técnicos e organizacionais compatíveis com sua operação, incluindo autenticação administrativa e minimização de dados no estado padrão do produto.

## 10. Observações importantes sobre este software

Este sistema utiliza o software livre BoltLink, distribuído sob AGPL-3.0.

O autor original do software não é o operador deste serviço e não participa automaticamente do tratamento de dados realizado por quem implanta ou utiliza esta instância.

Toda responsabilidade pela operação concreta deste ambiente, pela configuração de provedores, pela base legal e pelo conteúdo inserido no sistema é do operador identificado nesta política.

---

Versão 2.0.0
Criado por Vitor Faustino - vitorfaustino.com.br
