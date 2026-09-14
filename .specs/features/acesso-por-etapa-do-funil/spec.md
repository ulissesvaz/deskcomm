# Acesso por etapa do funil (papel "técnico")

**Slug:** `acesso-por-etapa-do-funil`
**Status:** Draft (aguardando aprovação)
**Data:** 2026-09-14
**Base escrita (CONFIRMADO):** `supabase/baseline.sql` (`fn_can_view_conversation`, `fn_can_view_lead`, policies `conversations_select`/`crm_leads_select`/`crm_leads_update`), `app/api/v1/leads/[id]/move/route.ts`, `lib/auth/types.ts`, `app/app/settings/atendimento/_form.tsx`

---

## Problem Statement

Hoje o CRM só distingue pessoas por **papel de permissão** (`viewer < agent < manager < admin`) e por **atribuição manual** (quem está "assigned" numa conversa/lead). Não existe nenhum jeito de dizer "esta pessoa só deve enxergar conversas e cards cujo negócio esteja numa etapa X do funil" — e essa exata lacuna já estava documentada como decisão adiada nos PRDs (`docs/prd/00-prd-master.md:161`: *"Permissão por pipeline (`user_pipeline_access`) — adicionar quando cliente real pedir"*).

O dono de uma assistência técnica (Luzara Electronics) quer dois tipos de atendimento na mesma equipe: **atendente** (cuida do primeiro contato, orçamento, venda) e **técnico** (só deve ver o WhatsApp e o card do Kanban quando o aparelho já está "Em conserto" ou "Aguardando peça" — nunca antes disso, e nunca depois que ele mesmo mover o card pra fora dessas etapas).

Investigação prévia (nesta mesma conversa) já eliminou dois caminhos: criar um **papel novo** no banco (~15 comparações de papel espalhadas no código tratariam o valor desconhecido de formas inconsistentes) e usar **atribuição manual/automação** (o pedido confirmado foi acesso automático pela etapa, não por atribuição).

## Goals

- [ ] Um administrador/gerente pode, por pessoa, marcar **quais etapas de um funil** ela enxerga — nenhuma etapa marcada = comportamento de hoje, sem mudança.
- [ ] Assim que um lead entra numa etapa marcada para essa pessoa, ela **já vê** a conversa de WhatsApp (Inbox) e o card (Kanban) daquele contato — sem precisar que ninguém atribua nada a ela.
- [ ] A pessoa consegue **mover o card** para fora das etapas dela (ex.: terminou o conserto, manda pra "Pronto pra retirada") — e, assim que o card sai, ela deixa de enxergar aquela conversa/card, exatamente como hoje acontece quando alguém perde a atribuição.
- [ ] Continua sendo o mesmo papel de permissão (`agent`) por trás — a pessoa não vira um "papel" novo no sistema, só ganha uma permissão extra.
- [ ] Quem já usa o CRM sem configurar isso **não percebe nenhuma mudança** (nenhuma etapa marcada para ninguém = todas as regras de hoje continuam idênticas).

## Out of Scope

| Item | Motivo |
| --- | --- |
| Papel novo "técnico" no enum de papéis do banco | Investigado e descartado nesta conversa — risco alto, ~15 comparações de papel no código tratam valor desconhecido de forma inconsistente. A pessoa continua com papel `agent`. |
| Conversão automática / negociação de câmbio, times de vendas por moeda etc. | Não relacionado a esta feature. |
| Timeline de atividades do lead (`crm_lead_activities`) seguir a mesma regra de etapa | Essa tabela tem sua própria policy, que replica `fn_can_view_lead` por outro caminho (chamada direta, não por `exists` que atravessaria a RLS de `crm_leads`). Estender pra lá é mudança à parte; nesta v1 quem só tem acesso por etapa não vê a timeline do lead, só a conversa e o card do Kanban. |
| Múltiplos funis com etapas de funis diferentes na mesma permissão | Confirmado nesta conversa: a loja usa um funil só. O desenho permite mais de uma etapa, mas todas dentro do(s) funil(is) que existir(em) — não há UI especial "por funil" nesta v1. |
| Limitar quantas etapas uma pessoa pode ter marcadas | Sem limite — é uma lista igual a "convidar pra equipe". |

---

## User Stories

### P1: Conceder acesso por etapa ⭐ MVP

**User Story:** Como gerente/admin, quero marcar quais etapas do funil uma pessoa da equipe enxerga, so that o técnico veja só o que é do trabalho dele, sem eu precisar atribuir conversa por conversa.

**Acceptance Criteria:**

1. WHEN um admin/gerente abre a tela de um membro da equipe THEN o sistema SHALL mostrar a lista de etapas do(s) funil(is) da organização, cada uma com uma marcação de "esta pessoa vê esta etapa".
2. WHEN o admin/gerente marca uma ou mais etapas e salva THEN o sistema SHALL gravar essas concessões, sem exigir papel diferente de `agent` para a pessoa.
3. WHEN nenhuma etapa está marcada para uma pessoa THEN o comportamento de visibilidade dela SHALL ser idêntico ao de hoje (sem regressão).
4. WHEN um `agent` tenta conceder acesso por etapa a si mesmo ou a outra pessoa (rota de escrita) THEN o sistema SHALL recusar — só `manager`/`admin` concede.

**Independent Test:** Como admin, marcar a etapa "Em conserto" para o usuário X (papel `agent`); conferir no banco que a concessão foi gravada com o `organization_id` certo.

---

### P2: Visibilidade automática pela etapa

**User Story:** Como técnico, quero que a conversa e o card apareçam pra mim assim que o negócio entrar em "Em conserto", so that eu não dependa de ninguém me atribuir nada.

**Acceptance Criteria:**

1. WHEN um lead está numa etapa concedida a um usuário THEN esse usuário SHALL conseguir ver, no Inbox, a conversa de WhatsApp do contato desse lead (mesmo sem estar "assigned" a ela).
2. WHEN um lead está numa etapa concedida a um usuário THEN esse usuário SHALL conseguir ver o card desse lead no Kanban.
3. WHEN o lead muda de etapa para uma que NÃO está concedida a esse usuário THEN ele SHALL deixar de ver a conversa e o card (a menos que outra regra de hoje — dono, papel `manager`/`admin`, `visibility_mode` da organização — já desse acesso).
4. WHEN um contato tem mais de um lead (em funis ou momentos diferentes) THEN o acesso concedido SHALL valer se **qualquer um** dos leads desse contato estiver numa etapa concedida ao usuário — não é preciso escolher "qual lead conta".
5. WHEN o usuário não tem NENHUMA etapa concedida THEN o comportamento SHALL ser exatamente o de hoje (regressão zero — ver Global Constraint sobre isso no plano).

**Independent Test:** Criar lead num contato, mover pra "Em conserto"; usuário sem concessão nenhuma não vê a conversa desse contato no Inbox; conceder a etapa a ele; sem ele sair/entrar de novo (só recarregar), a conversa aparece. Mover o lead pra outra etapa não concedida; a conversa some da lista dele.

---

### P3: Mover o card sem travar

**User Story:** Como técnico, quero mover o card pra fora da minha etapa quando termino o serviço, so that o atendente saiba que já pode chamar o cliente pra retirar — mesmo que eu deixe de ver aquele card depois.

**Acceptance Criteria:**

1. WHEN um usuário só tem acesso a um lead **por causa da etapa concedida** (não é dono, não é manager) THEN ele SHALL conseguir mover esse lead para QUALQUER etapa do mesmo funil pela tela do Kanban (a mesma ação de arrastar o card que já existe hoje).
2. WHEN essa movimentação acontece THEN o sistema SHALL registrar a atividade e o audit log exatamente como já registra hoje para qualquer movimentação de card (sem caminho especial visível pra quem usa).
3. WHEN a etapa de destino não está mais entre as concedidas ao usuário THEN, na PRÓXIMA leitura, esse card/conversa SHALL desaparecer da visão dele — sem erro na hora de mover (essa é exatamente a trava técnica identificada nesta conversa: um jeito ingênuo de implementar isso bloquearia a movimentação por causa de uma regra de segurança do Postgres que compara o estado antigo com o novo; o design técnico (ver `design.md`) descreve como isso é evitado).

**Independent Test:** Conceder só a etapa "Em conserto" a um usuário `agent` que não é dono do lead. Ele move o card de "Em conserto" para "Pronto pra retirada" pelo Kanban — a movimentação SHALL ter sucesso (não pode dar erro de permissão). Ao recarregar a tela, o card SHALL ter sumido da visão dele.

---

## Notas de decisão (desta conversa)

- Confirmado: acesso automático pela etapa, não por atribuição manual (ver histórico da conversa).
- Confirmado: um funil só hoje, mas o técnico pode precisar de mais de uma etapa concedida ("Em conserto" + "Aguardando peça").
- Confirmado: o próprio técnico move o card ao terminar — por isso P3 existe e precisa de tratamento técnico específico (ver `design.md`).
