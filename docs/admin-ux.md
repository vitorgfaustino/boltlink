# Admin UX — candidata 3.2.0

A release oficial continua 3.1.1, tag v3.1.1, congelada. Esta documentação descreve a candidata 3.2.0, ainda não publicada.

## Grupos no painel

O card mostra o caminho da raiz ao grupo atribuído: `Franquia 01 / Bio / Instagram`. Nomes repetidos em árvores diferentes continuam distinguíveis. O truncamento com ellipsis é apenas visual: o texto completo permanece no DOM, no `title` e no rótulo acessível. O `group_id` não muda.

O filtro inclui o grupo selecionado e todos os seus descendentes, em qualquer profundidade. `Franquia 01` inclui links em Bio, Instagram e Cardápio; `Bio` inclui Bio e Instagram; uma folha inclui apenas seus próprios links. “Sem grupo” continua selecionando somente `group_id` nulo, e “Todos os grupos” preserva a listagem geral de ativos.

O Admin usa `GET /api/links?group_id=<id>&include_descendants=true`. A seleção recursiva ocorre na mesma consulta administrativa, antes do `LIMIT 100`, evitando que links alheios ocupem o limite antes de filtrar. Sem a opção, a API mantém a associação direta para clientes existentes. A CTE usa `UNION` para visitar cada ID uma vez e terminar mesmo diante de ciclos legados. Não há consulta adicional nem mudança no redirect público. Paths usam a árvore de grupos já carregada.

Ao trocar rapidamente a busca ou o grupo, somente a resposta da seleção mais recente pode atualizar a lista e seu status. Sucessos ou falhas atrasados de filtros anteriores são descartados.

## UTMs na edição

`target_url` é a única fonte de verdade. Ao abrir Editar, o gerador lê `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` e `utm_term`. Alterar um campo atualiza a URL; esvaziá-lo remove completamente o parâmetro. Não existem colunas ou persistência separada para UTMs.

Editar a URL manualmente ressincroniza os campos no blur e antes de enviar o formulário. Durante digitação parcial ou inválida, o painel conserva os campos e deixa a validação existente cuidar do erro. A sincronização não dispara eventos de input em cascata.

Os helpers editam somente os tokens UTM suportados. Pathname, fragmento, parâmetros desconhecidos, parâmetros repetidos não-UTM e seu encoding permanecem intactos. A mesma implementação serve para criar e editar links.

Se um UTM suportado aparecer repetido, a hidratação usa o primeiro valor, como `URLSearchParams.get()`. Alterar o campo ou salvar normaliza esse UTM para uma única ocorrência; um primeiro valor vazio resulta na remoção do parâmetro. Parâmetros não-UTM repetidos permanecem intactos. Abrir e salvar uma URL sem duplicatas não reserializa o endereço nem muda seu encoding.

## Apresentação do painel

O Dark Mode usa superfícies neutras e discretas, com o azul reservado às ações. Cards compactos separam identidade, destino, recursos e métricas; detalhes A/B ficam sob demanda. As badges usam cores semânticas fixas para Teste A/B, Smart Routing e QR Code, enquanto grupos e tags permanecem neutros. Light e Dark compartilham a estrutura; no mobile, ações têm alvos de 44px e os recursos quebram linha.

O [README](../README.md#screenshots) apresenta nove capturas atualizadas e uma demonstração animada da interface real, com nomes, URLs e contagens fictícios. Esses dados não integram o banco nem a distribuição de produção.

## Setup inicial

Na candidata, `ROOT_REDIRECT_URL` é declarada em `wrangler.jsonc` como variável **Text**, **opcional**, **não Secret**, com valor inicial vazio. A descrição de `package.json` explica o campo. Vazio preserva a página inicial; uma URL absoluta http(s) válida usa o redirect da raiz já existente.

O [Deploy Button lê as variáveis do Wrangler](https://developers.cloudflare.com/workers/platform/deploy-buttons/#worker-environment-variables-and-secrets); descrições de bindings ficam no `package.json`. O contrato opcional usa o valor vazio, sem inventar uma chave `optional` na configuração Cloudflare. O botão do README aponta para main e só distribuirá este setup quando a candidata for publicada.

Confira [Setup](cloudflare-setup.md) e [Upgrading](upgrading.md). As variáveis do dashboard devem ser preservadas em updates (`keep_vars: true`). Configurações privadas e secrets não pertencem ao template público.

## Compatibilidade

Migrations 0000–0006 e schema D1 permanecem intactos. **MIGRATION_0007 = NOT REQUIRED**. Sem QR Code customization, Basic Auth ou Native Auth neste gate.
