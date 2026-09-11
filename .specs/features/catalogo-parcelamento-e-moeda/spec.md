# Catálogo — Preço parcelado e moeda por produto

**Slug:** `catalogo-parcelamento-e-moeda`
**Status:** Draft (aguardando aprovação)
**Data:** 2026-09-11
**Base escrita (CONFIRMADO):** `lib/schemas/produtos.ts`, `app/api/v1/products/route.ts`, `app/app/products/_client.tsx`, `lib/catalogo/planilha.ts`, `lib/mcp/tools/comercio.ts`, `lib/catalogo/moeda-da-org.ts`, `lib/money.ts`, `app/app/settings/tenant/_form.tsx`

---

## Problem Statement

O catálogo hoje só guarda **um preço** por produto (`preco_cents`) e a **moeda é sempre a da organização inteira** (`moedaDaOrganizacao()`), travada em Configurações → Organização, com apenas três opções (`BRL`, `MXN`, `USD`).

O dono da loja (UF Premium Solutions / Luzara Electronics, operando no Reino Unido) vende em mais de uma moeda dependendo do produto/cliente (Libra, Euro, Real) e vende parte do catálogo **parcelado em semanas**, com um valor total diferente do preço à vista (ex.: à vista £1.199, parcelado £1.881 — a diferença já embute a margem do parcelamento). O número de semanas e o valor de entrada são **negociados na conversa**, não fixos por produto.

Sem isso, o agente de IA só consegue falar um preço fixo, na moeda única da loja, e não sabe calcular parcela nenhuma.

## Goals

- [ ] Cada produto pode ter um **preço parcelado** (total), além do preço à vista — campo opcional (produto sem ele não é parcelável).
- [ ] Cada produto escolhe sua **própria moeda** no cadastro (Libra, Euro, Real, ou as já existentes), com a moeda da organização como sugestão inicial pré-marcada.
- [ ] O agente de IA, ao falar de um produto, usa **o preço à vista sem dividir nunca**, e usa o **preço parcelado como base negociável**: quando o cliente pedir para parcelar, o agente pergunta quantas semanas e se haverá entrada, e calcula `(preço parcelado − entrada) ÷ semanas` — sempre na moeda daquele produto.
- [ ] A importação por planilha reconhece uma coluna opcional de preço parcelado.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Conversão de câmbio ao vivo (cotação do dia, conversão automática entre moedas) | Pedido explicitamente descartado nesta conversa — cada produto já nasce na moeda certa, sem precisar converter nada. |
| Limite técnico de número máximo de semanas por produto | Confirmado que é negociação livre, sem teto do sistema. Quem já existe para isso (opt-in, por organização) é a *promise table* (`lib/agent-engine/guardrails/promise/table.ts`, campo `maxInstallments`) — fora do escopo desta feature, não muda. |
| Somar/reportar valores do catálogo entre moedas diferentes (dashboards, totais) | Nada hoje soma `catalog_products.preco_cents` entre produtos; não introduzir essa necessidade aqui. |
| Regras de valor mínimo de parcela ou de entrada | Não pedido; o cálculo é livre. |
| Mudar a moeda-padrão da organização em si | Continua existindo como está; só ganha novas opções na lista (Libra, Euro). |

---

## User Stories

### P1: Preço parcelado por produto ⭐ MVP

**User Story:** As a manager, quero cadastrar um preço parcelado (total) além do preço à vista, so that o agente saiba negociar parcelamento sem eu ter que calcular nada.

**Acceptance Criteria:**

1. WHEN o manager cadastra um produto sem preencher "Preço parcelado" THEN o sistema SHALL salvar o produto normalmente, sem parcelamento disponível.
2. WHEN o manager preenche "Preço parcelado" com um valor no formato `1.881,00` THEN o sistema SHALL salvar `preco_parcelado_cents` correspondente, usando o mesmo parser já usado no preço à vista (`precoParaCentavos`).
3. WHEN o manager preenche "Preço parcelado" com um valor não reconhecido THEN o sistema SHALL recusar o salvamento e apontar o campo, sem gravar nada.
4. WHEN a planilha de importação traz uma coluna "parcelado" ou "preço parcelado" THEN o sistema SHALL gravar `preco_parcelado_cents` daquela linha; WHEN a coluna não existir THEN a importação SHALL continuar funcionando como hoje (coluna opcional).
5. WHEN a tela lista os produtos THEN o sistema SHALL mostrar os dois preços quando o parcelado existir.

**Independent Test:** Cadastrar produto com preço à vista `1.199,00` e parcelado `1.881,00`; ver os dois valores na lista; reabrir a ferramenta do agente (`crm_search_products` ou equivalente em `comercio.ts`) e confirmar que os dois campos voltam certos.

---

### P2: Moeda por produto

**User Story:** As a manager, quero escolher a moeda de cada produto no cadastro, so that um produto vendido em Libra não apareça em Real só porque é a moeda padrão da loja.

**Acceptance Criteria:**

1. WHEN o manager abre o formulário de novo produto THEN o sistema SHALL mostrar um seletor de moeda, pré-selecionado com a moeda da organização.
2. WHEN o manager troca a moeda do produto para uma diferente da organização e salva THEN o sistema SHALL gravar essa moeda na linha do produto (`catalog_products.moeda`), sem alterar a moeda da organização nem de outros produtos.
3. WHEN a lista de moedas é mostrada (nesta tela e em Configurações → Organização) THEN o sistema SHALL incluir Libra Esterlina (`GBP`) e Euro (`EUR`), além das já existentes (`BRL`, `MXN`, `USD`).
4. WHEN a planilha de importação não traz coluna de moeda THEN o sistema SHALL continuar usando a moeda da organização como hoje (comportamento não regride).

**Independent Test:** Cadastrar produto A em GBP e produto B em EUR na mesma organização; consultar os dois pela ferramenta do agente; cada um SHALL voltar com sua própria moeda e formatação (`£`, `€`).

---

### P3: O agente calcula parcela na conversa

**User Story:** As a lead/cliente conversando no WhatsApp, quero perguntar "dá pra parcelar em 15 semanas?" e receber o valor certo da parcela, so that eu decida a compra sem falar com um humano.

**Acceptance Criteria:**

1. WHEN o cliente pergunta o preço de um produto sem mencionar parcelamento THEN o agente SHALL responder o preço à vista daquele produto, na moeda do produto.
2. WHEN o cliente pede para parcelar e informa quantas semanas (com ou sem entrada) THEN o agente SHALL calcular `(preco_parcelado_cents − entrada) ÷ semanas` e informar o valor da parcela, na moeda do produto — nunca dividindo o preço à vista.
3. WHEN o produto não tem `preco_parcelado_cents` cadastrado THEN o agente SHALL dizer que este produto não tem opção de parcelamento, sem inventar um valor.
4. WHEN a organização tiver uma *promise table* ativa com `maxInstallments` configurado E o cliente pedir mais parcelas que o teto THEN o guardrail existente (`before-send.ts`) SHALL continuar vetando a mensagem, sem mudança de comportamento.

**Independent Test:** Conversa simulada pedindo "15 semanas, entrada de 100" num produto com parcelado £1.881 → resposta deve conter `(1881,00 − 100,00) / 15 = £118,73`/semana (arredondamento a definir no design). Segundo teste: mesmo pedido num produto sem `preco_parcelado_cents` → agente recusa calcular e diz que não há parcelamento para aquele item.

---

## Notas de decisão (desta conversa)

- Preço à vista nunca é dividido; só o preço parcelado entra na conta do agente.
- Não existe teto de semanas do sistema — é negociação. O único teto possível já existe (promise table, opcional, por organização) e não muda aqui.
- Moeda é **por produto**, escolhida no cadastro, com a moeda da organização como valor sugerido — não há conversão entre moedas.
