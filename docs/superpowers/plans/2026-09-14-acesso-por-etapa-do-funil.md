# Acesso por etapa do funil — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** um manager/admin pode conceder a um membro da equipe (papel `agent`) visibilidade automática de conversas/cards cujo lead esteja numa etapa concedida — sem criar papel novo — e essa pessoa consegue mover o card pra fora da etapa concedida sem a RLS travar a ação.

**Architecture:** uma tabela nova (`user_stage_access`) + duas policies de SELECT existentes ganham um `OR` (via funções novas, sem tocar `fn_can_view_conversation`/`fn_can_view_lead`) + uma função `security definer` nova que decide a autorização de mover um lead em código (não em RLS declarativa), porque só ela consegue comparar a etapa ANTES e DEPOIS do movimento.

**Tech Stack:** Next.js 16 App Router · Zod · Supabase/Postgres (RLS + `security definer`) · Vitest (`tests/invariants/**` via `pnpm test:db`) · TanStack Query.

**Spec:** `.specs/features/acesso-por-etapa-do-funil/spec.md` (o quê) e `.specs/features/acesso-por-etapa-do-funil/design.md` (como, incluindo o raciocínio completo de por que a escrita não pode ser um `OR` simples na policy) — leia os dois antes de começar.

## Global Constraints

- `organization_id` vem **sempre** de fonte confiável (`authz.org.orgId` / `ctx.organizationId` / JWT via `auth.uid()` dentro do Postgres) — nunca do corpo da requisição.
- As funções **existentes** `fn_can_view_conversation(uuid,uuid)` e `fn_can_view_lead(uuid,uuid)` **não mudam de assinatura nem de corpo** — são chamadas em 8+ lugares fora das policies de SELECT (triggers, outras RLS, resolução de canal) que este plano não deve tocar. O acesso por etapa entra como `OR` **só** nas policies `conversations_select` e `crm_leads_select`, usando funções NOVAS.
- **Nunca** `create policy if not exists` nem `add constraint if not exists` — nenhum dos dois é sintaxe válida em Postgres (confirmado nesta mesma sessão, ao corrigir esse exato erro numa feature anterior). O padrão idempotente deste repo pra redefinir uma policy é `drop policy if exists "X" on T; create policy "X" on T ...`.
- Toda `security definer` nova em `public` nasce exposta a `anon`/`PUBLIC` — termina com `revoke all on function ... from public, anon; grant execute on function ... to authenticated, service_role;` (as duas origens, `CLAUDE.md` doutrina de migrations item 9). Isso é vigiado por `tests/invariants/hardening-definer-varredura.test.ts`, que este plano NÃO precisa modificar, só não pode reprovar.
- Schema sai em tripla: migration versionada + apêndice idempotente em `supabase/baseline.sql` + linha em `supabase/migrations/MANIFEST.md`.
- `pnpm typecheck`, `pnpm lint` e `pnpm test:unit` zerados antes de cada commit que a task pedir. `pnpm test:db` (Docker) não roda nesta máquina de desenvolvimento — ver nota na Task 1 e na Task 5/6.
- Convite/conceder acesso por etapa é `manager`+ (mesma régua de `crm_leads_update`/`crm_leads_delete`), **não** admin-only — mais permissivo que o botão de trocar Role nesta mesma tela (que é admin-only) e isso é intencional, não inconsistência a "corrigir".

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/<timestamp>_0234_acesso_por_etapa.sql` **(criar)** + `baseline.sql` + `MANIFEST.md` | Tabela `user_stage_access`, 3 funções (`fn_has_stage_access`, `fn_has_stage_access_via_contact`, `fn_mover_lead_com_permissao_de_etapa`), policies `conversations_select`/`crm_leads_select` redefinidas |
| `lib/schemas/stage-access.ts` **(criar)** | Zod do corpo do `PUT` da rota de concessão |
| `app/api/v1/team/[user_id]/stage-access/route.ts` **(criar)** | `GET` (etapas concedidas hoje) e `PUT` (substitui o conjunto) |
| `app/api/v1/team/[user_id]/stage-access/route.test.ts` **(criar)** | Unit da rota nova (mocks) |
| `lib/audit/actions.ts` **(modificar)** | `"team.stage_access_updated"` |
| `app/api/v1/leads/[id]/move/route.ts` **(modificar)** | Troca `.from("crm_leads").update(...)` pela chamada `supabase.rpc("fn_mover_lead_com_permissao_de_etapa", ...)` |
| `app/app/team/page.tsx` **(modificar)** | Busca o(s) pipeline(s) + etapas da org (Server Component) e passa como prop |
| `app/app/team/_components/TeamMembersClient.tsx` **(modificar)** | Botão "Acesso por etapa" por linha (gate: `canManageStageAccess`, prop nova = `isManager`) |
| `hooks/team/useStageAccess.ts` **(criar)** | `useStageAccess(userId)` (query) + `useSetStageAccess()` (mutation) |
| `components/team/MemberStageAccessDialog.tsx` **(criar)** | Diálogo com checkboxes das etapas, espelha `MemberInterfaceDialog.tsx` |
| `tests/invariants/gov-5f-stage-access.test.ts` **(criar)** | Invariante de LEITURA: concessão dá acesso a conversa/lead; sem concessão, zero mudança |
| `tests/invariants/gov-5g-stage-move.test.ts` **(criar)** | Invariante de ESCRITA: a função de mover funciona pra quem só tem acesso por etapa, inclusive saindo da etapa concedida; recusa pra quem não tem nenhum acesso |

---

## Task Breakdown

### Task 1: Migration — tabela, funções e policies

**Files:**
- Create: `supabase/migrations/<timestamp>_0234_acesso_por_etapa.sql` (use `date -u +%Y%m%d%H%M%S`, seguindo 0233)
- Modify: `supabase/baseline.sql` (apêndice no fim do arquivo)
- Modify: `supabase/migrations/MANIFEST.md`

**Interfaces:**
- Produces: tabela `public.user_stage_access(id, organization_id, user_id, stage_id, granted_by, created_at)`, funções `public.fn_has_stage_access(uuid,uuid) returns boolean`, `public.fn_has_stage_access_via_contact(uuid,uuid) returns boolean`, `public.fn_mover_lead_com_permissao_de_etapa(uuid,uuid,numeric,timestamptz) returns public.crm_leads`. Tasks 2, 3, 5 e 6 dependem de todas as quatro existirem no banco de teste.

**IMPORTANTE — ambiente:** esta máquina não tem Docker/psql. Você NÃO roda `pnpm test:db` aqui — o controller verifica esta migration numa máquina com Docker depois do seu report. Escreva o SQL com o MÁXIMO de cuidado, comparando cada `create or replace function`/`create policy` com os exemplos REAIS já existentes no arquivo (linhas citadas abaixo) — é a única defesa disponível sem poder rodar.

- [ ] **Step 1: Escrever a migration**

```sql
-- 0234 — acesso por etapa do funil (papel "técnico", sem criar papel novo).
--
-- Uma pessoa (papel `agent`) pode ganhar visibilidade automática de qualquer
-- conversa/lead cujo negócio esteja numa etapa concedida a ela — sem precisar
-- ser dona/atribuída. Ver .specs/features/acesso-por-etapa-do-funil/design.md
-- para o raciocínio completo de por que a escrita (mover o card) precisa de
-- uma função própria em vez de entrar como OR na policy crm_leads_update.

create table if not exists public.user_stage_access (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  stage_id uuid not null references public.crm_stages(id) on delete cascade,
  granted_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (user_id, stage_id)
);

create index if not exists user_stage_access_org_stage_idx
  on public.user_stage_access (organization_id, stage_id);
create index if not exists user_stage_access_user_idx
  on public.user_stage_access (user_id);

alter table public.user_stage_access enable row level security;

drop policy if exists "user_stage_access_all" on public.user_stage_access;
create policy "user_stage_access_all" on public.user_stage_access
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  );

create or replace function public.fn_has_stage_access(p_org uuid, p_stage_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_stage_access a
    where a.organization_id = p_org
      and a.stage_id = p_stage_id
      and a.user_id = auth.uid()
  );
$$;
revoke all on function public.fn_has_stage_access(uuid, uuid) from public, anon;
grant execute on function public.fn_has_stage_access(uuid, uuid) to authenticated, service_role;

create or replace function public.fn_has_stage_access_via_contact(p_org uuid, p_contact_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.crm_leads l
      join public.user_stage_access a
        on a.stage_id = l.stage_id and a.organization_id = l.organization_id
     where l.organization_id = p_org
       and l.contact_id = p_contact_id
       and a.user_id = auth.uid()
  );
$$;
revoke all on function public.fn_has_stage_access_via_contact(uuid, uuid) from public, anon;
grant execute on function public.fn_has_stage_access_via_contact(uuid, uuid) to authenticated, service_role;

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select using (
    public.fn_can_view_conversation(organization_id, assigned_to_user_id)
    or public.fn_has_stage_access_via_contact(organization_id, contact_id)
  );

drop policy if exists "crm_leads_select" on public.crm_leads;
create policy "crm_leads_select" on public.crm_leads
  for select using (
    public.fn_can_view_lead(organization_id, owner_user_id)
    or public.fn_has_stage_access(organization_id, stage_id)
  );

create or replace function public.fn_mover_lead_com_permissao_de_etapa(
  p_lead_id uuid,
  p_stage_id uuid,
  p_position_in_stage numeric,
  p_expected_updated_at timestamptz
) returns public.crm_leads
language plpgsql security definer
set search_path = public
as $$
declare
  v_lead public.crm_leads;
  v_new_stage public.crm_stages;
  v_pode boolean;
begin
  select * into v_lead from public.crm_leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead_nao_encontrado' using errcode = 'P0002';
  end if;

  if v_lead.organization_id not in (select public.fn_user_org_ids()) then
    raise exception 'sem_acesso_a_organizacao' using errcode = '42501';
  end if;
  if not public.fn_role_at_least(v_lead.organization_id, 'agent') then
    raise exception 'papel_insuficiente' using errcode = '42501';
  end if;

  v_pode := public.fn_role_at_least(v_lead.organization_id, 'manager')
    or public.fn_can_view_lead(v_lead.organization_id, v_lead.owner_user_id)
    or public.fn_has_stage_access(v_lead.organization_id, v_lead.stage_id);
  if not v_pode then
    raise exception 'sem_permissao_para_mover_este_lead' using errcode = '42501';
  end if;

  select * into v_new_stage from public.crm_stages where id = p_stage_id;
  if not found then
    raise exception 'etapa_nao_encontrada' using errcode = 'P0002';
  end if;
  if v_new_stage.pipeline_id <> v_lead.pipeline_id then
    raise exception 'pipeline_immutable_use_clone' using errcode = '22023';
  end if;

  update public.crm_leads
     set stage_id = p_stage_id,
         position_in_stage = p_position_in_stage,
         updated_at = now()
   where id = p_lead_id
     and updated_at = p_expected_updated_at
  returning * into v_lead;

  if not found then
    raise exception 'lead_stage_changed_concurrent' using errcode = '55P02';
  end if;

  return v_lead;
end;
$$;

revoke all on function public.fn_mover_lead_com_permissao_de_etapa(uuid, uuid, numeric, timestamptz) from public, anon;
grant execute on function public.fn_mover_lead_com_permissao_de_etapa(uuid, uuid, numeric, timestamptz) to authenticated, service_role;
```

Salve como `supabase/migrations/<timestamp>_0234_acesso_por_etapa.sql`.

- [ ] **Step 2: Verificação manual cuidadosa (sem `pnpm test:db` — Docker ausente)**

Compare, linha por linha, cada pedaço novo com um exemplo REAL já existente no arquivo, procurando por eles com `grep -n`:
- O padrão `drop policy if exists "X" ...; create policy "X" ...` já existe (procure por `drop policy if exists "conversations_agent_write"` perto da linha 5555 do `baseline.sql` atual).
- O padrão de função `security definer` com `revoke ... from public, anon; grant ... to authenticated, service_role;` já existe em `fn_can_view_conversation` (linhas 5544-5547 do `baseline.sql` atual) — confirme que sua sintaxe é idêntica nesse ponto.
- `errcode` em `raise exception ... using errcode = 'P0002'` — confirme que `P0002` já é usado em algum outro lugar do arquivo (`grep -n "errcode = 'P0002'" supabase/baseline.sql`) como prova de que é um SQLSTATE que este projeto já trata, não um valor inventado.

Se qualquer uma dessas comparações não bater, PARE e reporte BLOCKED/NEEDS_CONTEXT em vez de adivinhar — SQL errado só é descoberto quando o controller rodar contra um Postgres de verdade depois, e quanto mais cedo você desconfiar de si mesmo, mais barato o conserto.

- [ ] **Step 3: Apensar o mesmo SQL, idempotente, ao final de `supabase/baseline.sql`**

Copie o bloco inteiro do Step 1 para o fim de `supabase/baseline.sql`, com um comentário de cabeçalho:

```sql

-- 0234 — acesso por etapa do funil. Ver migrations/0234 para o raciocínio
-- completo; aqui é o mesmo SQL, idempotente, aplicado no self-host.
```

seguido do bloco idêntico ao Step 1.

- [ ] **Step 4: Adicionar a linha no MANIFEST**

Em `supabase/migrations/MANIFEST.md`, após a última linha, adicione (troque `<timestamp>` pelo mesmo valor do Step 1):

```markdown
| `<timestamp>` | `0234_acesso_por_etapa` | Tabela `user_stage_access` + concessão de visibilidade de Inbox/Kanban por etapa do funil, sem criar papel novo; função `security definer` dedicada para mover um lead pra fora da etapa concedida sem a RLS travar a ação. |
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/*_0234_acesso_por_etapa.sql supabase/baseline.sql supabase/migrations/MANIFEST.md
git commit -m "feat(equipe): tabela e funções de acesso por etapa do funil"
```

Reporte DONE_WITH_CONCERNS (não DONE) citando explicitamente: "SQL não verificado contra Postgres real nesta máquina — controller verifica com `pnpm test:db` numa máquina com Docker antes de aprovar esta task."

---

### Task 2: Rota de concessão (`GET`/`PUT /api/v1/team/:user_id/stage-access`)

**Files:**
- Create: `lib/schemas/stage-access.ts`
- Create: `app/api/v1/team/[user_id]/stage-access/route.ts`
- Create: `app/api/v1/team/[user_id]/stage-access/route.test.ts`
- Modify: `lib/audit/actions.ts`

**Interfaces:**
- Consumes: `user_stage_access` (Task 1), `requireRole` (`lib/auth/require-role.ts`, já existe), padrão de rota de `app/api/v1/team/[user_id]/interface/route.ts` (já existe, leia antes de escrever a sua).
- Produces: `GET` devolve `{ data: { stage_ids: string[] } }`; `PUT` aceita `{ stage_ids: string[] }` e devolve o mesmo formato após substituir o conjunto. Task 4 (UI) consome esta rota via `hooks/team/useStageAccess.ts`.

- [ ] **Step 1: Escrever o schema Zod**

`lib/schemas/stage-access.ts`:

```ts
import { z } from "zod";

/** O PUT substitui o conjunto INTEIRO de etapas concedidas — mais simples de UI
 * do que add/remove individual, e o volume por pessoa é sempre pequeno. */
export const stageAccessSetSchema = z
  .object({
    stage_ids: z.array(z.string().uuid()).max(50),
  })
  .strict();
export type StageAccessSet = z.infer<typeof stageAccessSetSchema>;
```

- [ ] **Step 2: Escrever a rota**

Leia primeiro `app/api/v1/team/[user_id]/interface/route.ts` inteiro (já existe no repo) — sua rota segue a MESMA estrutura: `requireSupportWrite`, `requireRole`, valida `user_id` é uuid, confere que o membro é ativo (`revoked_at is null`, `accepted_at not null`) na MESMA organização antes de tocar em qualquer coisa.

`app/api/v1/team/[user_id]/stage-access/route.ts`:

```ts
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { stageAccessSetSchema } from "@/lib/schemas/stage-access";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

async function membroAtivo(
  db: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  userId: string,
) {
  const { data, error } = await db
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user_id } = await ctx.params;
  if (!z.string().uuid().safeParse(user_id).success) {
    return fail("validation_failed", t("Membro inválido."), 400, { requestId });
  }

  const db = await createClient();
  let ativo: boolean;
  try {
    ativo = await membroAtivo(db, authz.org.orgId, user_id);
  } catch {
    return fail("internal_error", "Erro ao ler o membro.", 500, { requestId });
  }
  if (!ativo) return fail("not_found", t("Membro ativo não encontrado."), 404, { requestId });

  const { data, error } = await db
    .from("user_stage_access")
    .select("stage_id")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", user_id);
  if (error) return fail("internal_error", "Erro ao listar o acesso.", 500, { requestId });

  return ok({ stage_ids: (data ?? []).map((r) => (r as { stage_id: string }).stage_id) }, { requestId });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user_id } = await ctx.params;
  if (!z.string().uuid().safeParse(user_id).success) {
    return fail("validation_failed", t("Membro inválido."), 400, { requestId });
  }

  const parsed = stageAccessSetSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const db = await createClient();
  let ativo: boolean;
  try {
    ativo = await membroAtivo(db, authz.org.orgId, user_id);
  } catch {
    return fail("internal_error", "Erro ao ler o membro.", 500, { requestId });
  }
  if (!ativo) return fail("not_found", t("Membro ativo não encontrado."), 404, { requestId });

  // Cada stage_id precisa pertencer a um pipeline DESTA organização — nunca
  // aceitar de outra org, mesmo que o uuid exista no banco (multi-tenancy:
  // organization_id nunca vem do body, o servidor confere na fonte).
  if (parsed.data.stage_ids.length > 0) {
    const { data: validas, error: stageErr } = await db
      .from("crm_stages")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .in("id", parsed.data.stage_ids);
    if (stageErr) return fail("internal_error", "Erro ao validar etapas.", 500, { requestId });
    const validasSet = new Set((validas ?? []).map((s) => (s as { id: string }).id));
    const invalida = parsed.data.stage_ids.find((id) => !validasSet.has(id));
    if (invalida) {
      return fail("validation_failed", t("Etapa não pertence a esta organização."), 422, {
        requestId,
        details: { stage_id: invalida },
      });
    }
  }

  const { error: delErr } = await db
    .from("user_stage_access")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", user_id);
  if (delErr) return fail("internal_error", "Erro ao atualizar o acesso.", 500, { requestId });

  if (parsed.data.stage_ids.length > 0) {
    const { error: insErr } = await db.from("user_stage_access").insert(
      parsed.data.stage_ids.map((stage_id) => ({
        organization_id: authz.org.orgId,
        user_id,
        stage_id,
        granted_by: authz.user.id,
      })),
    );
    if (insErr) return fail("internal_error", "Erro ao salvar o acesso.", 500, { requestId });
  }

  await audit({
    action: "team.stage_access_updated",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "membership",
    resourceId: user_id,
    requestId,
    metadata: { user_id, stage_ids: parsed.data.stage_ids },
  });

  return ok({ stage_ids: parsed.data.stage_ids }, { requestId });
}
```

- [ ] **Step 3: Registrar a ação de auditoria**

Em `lib/audit/actions.ts`, logo após a linha `"team.role_changed",`, adicione:

```ts
  "team.stage_access_updated",
```

- [ ] **Step 4: Escrever os testes (TDD retroativo aceitável aqui: a rota é nova e mecânica — escreva teste + implementação juntos, mas RODE o teste antes de considerar pronto)**

`app/api/v1/team/[user_id]/stage-access/route.test.ts` — mock o `requireRole` e o `createClient`, no mesmo estilo de `app/api/v1/products/route.test.ts` (leia esse arquivo para o padrão de mock de query builder encadeado). Casos mínimos:
- `GET` devolve os `stage_ids` que a query de `user_stage_access` retornar.
- `PUT` com um `stage_id` que não pertence à organização → 422, sem chamar delete/insert.
- `PUT` com `stage_ids: []` → apaga tudo, não insere nada, sucesso.
- `PUT` com membro inexistente/revogado na org → 404, sem tocar em `user_stage_access`.

- [ ] **Step 5: Rodar e confirmar**

Run: `pnpm exec vitest run app/api/v1/team/[user_id]/stage-access/route.test.ts`
Expected: todos os casos passando.

Run: `pnpm typecheck`
Expected: limpo.

- [ ] **Step 6: Commit**

```bash
git add lib/schemas/stage-access.ts app/api/v1/team/[user_id]/stage-access/ lib/audit/actions.ts
git commit -m "feat(equipe): rota de concessão de acesso por etapa do funil"
```

---

### Task 3: `leads/[id]/move` passa a chamar a função nova

**Files:**
- Modify: `app/api/v1/leads/[id]/move/route.ts`
- Create: `app/api/v1/leads/[id]/move/route.test.ts` (não existe hoje — você está criando a primeira cobertura desta rota)

**Interfaces:**
- Consumes: `fn_mover_lead_com_permissao_de_etapa` (Task 1).
- Produces: a rota continua devolvendo o mesmo formato de resposta (`ok(finalLead, ...)`) — só a origem do UPDATE muda.

- [ ] **Step 1: Ler a rota atual por inteiro**

`app/api/v1/leads/[id]/move/route.ts` já existe — leia as ~208 linhas atuais antes de editar. Você vai trocar SÓ o bloco do UPDATE (hoje entre o comentário `// OCC update (Pattern B / Spec 09 §7.2).` e o `if (!updated) { ... }` de concorrência), mantendo TUDO em volta (`emitLeadActivity`, `emit_event`, `audit`, a busca de `fromStage`) exatamente como está.

- [ ] **Step 2: Escrever o teste ANTES de mudar a rota (TDD real — este arquivo não existe ainda)**

`app/api/v1/leads/[id]/move/route.test.ts` — mock `requireRole` (ok) e `createClient` retornando um client cujo `.rpc("fn_mover_lead_com_permissao_de_etapa", ...)` você controla por teste, e cujo `.from("crm_leads").select(...)`/`.from("crm_stages").select(...)` (as duas leituras que já existem antes do UPDATE) continuam mockadas como hoje. Casos:

```ts
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: vi.fn(() => "motivo"),
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";
const STAGE_ID = "44444444-4444-4444-8444-444444444444";

function pedido(corpo: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD_ID}/move`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

const LEAD_ATUAL = {
  id: LEAD_ID,
  organization_id: ORG_ID,
  pipeline_id: "p1",
  stage_id: "stage-antiga",
  contact_id: "c1",
  updated_at: "2026-01-01T00:00:00.000Z",
  status: "open",
};

function supabaseCom(rpcResultado: { data?: unknown; error?: { message: string } | null }) {
  return {
    from: (tabela: string) => {
      if (tabela === "crm_leads") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: LEAD_ATUAL, error: null }) }),
          }),
        };
      }
      if (tabela === "crm_stages") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: STAGE_ID, pipeline_id: "p1", name: "Nova etapa" },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
    rpc: (nome: string, _args: unknown) => {
      if (nome !== "fn_mover_lead_com_permissao_de_etapa") throw new Error(`rpc inesperada: ${nome}`);
      return Promise.resolve(rpcResultado);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
});

describe("POST /api/v1/leads/[id]/move — chama a função de mover, não o UPDATE direto", () => {
  it("sucesso: devolve o lead atualizado que a função retornou", async () => {
    const leadNovo = { ...LEAD_ATUAL, stage_id: STAGE_ID, updated_at: "2026-01-02T00:00:00.000Z" };
    vi.mocked(createClient).mockResolvedValue(
      supabaseCom({ data: leadNovo, error: null }) as never,
    );
    const { POST } = await import("./route");

    const resposta = await POST(
      pedido({ stage_id: STAGE_ID, position_in_stage: 1000, expected_updated_at: LEAD_ATUAL.updated_at }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(resposta.status).toBe(200);
  });

  it("sem permissão (função recusa) → 403, sem UPDATE direto tentado", async () => {
    vi.mocked(createClient).mockResolvedValue(
      supabaseCom({
        data: null,
        error: { message: "sem_permissao_para_mover_este_lead" },
      }) as never,
    );
    const { POST } = await import("./route");

    const resposta = await POST(
      pedido({ stage_id: STAGE_ID, position_in_stage: 1000, expected_updated_at: LEAD_ATUAL.updated_at }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(resposta.status).toBe(403);
  });

  it("concorrência (função recusa por updated_at divergente) → 409", async () => {
    vi.mocked(createClient).mockResolvedValue(
      supabaseCom({
        data: null,
        error: { message: "lead_stage_changed_concurrent" },
      }) as never,
    );
    const { POST } = await import("./route");

    const resposta = await POST(
      pedido({ stage_id: STAGE_ID, position_in_stage: 1000, expected_updated_at: LEAD_ATUAL.updated_at }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(resposta.status).toBe(409);
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `pnpm exec vitest run "app/api/v1/leads/[id]/move/route.test.ts"`
Expected: FAIL — a rota ainda chama `.from("crm_leads").update(...)` diretamente, não `.rpc(...)`, então o mock de `rpc` nunca é exercitado e os testes não batem com o comportamento real.

- [ ] **Step 4: Implementar a troca na rota**

Em `app/api/v1/leads/[id]/move/route.ts`, substitua o bloco:

```ts
  // OCC update (Pattern B / Spec 09 §7.2).
  const { data: updated, error: updErr } = await supabase
    .from("crm_leads")
    .update({
      stage_id: input.stage_id,
      position_in_stage: input.position_in_stage,
      updated_at: new Date().toISOString(),
    })
    .eq("id", leadId)
    .eq("updated_at", input.expected_updated_at)
    .select("id")
    .maybeSingle();

  if (updErr) {
    return fail("internal_error", updErr.message, 500, { requestId });
  }

  if (!updated) {
    // Concurrent edit. Re-fetch current to surface the latest updated_at.
    const { data: current } = await supabase
      .from("crm_leads")
      .select("updated_at")
      .eq("id", leadId)
      .maybeSingle();
    return fail(
      "lead_stage_changed_concurrent",
      t("Lead foi modificado por outro usuário. Recarregue e tente novamente."),
      409,
      {
        details: { current_updated_at: current?.updated_at ?? null },
        requestId,
      },
    );
  }

  // Re-SELECT so trigger-driven status/closed_at changes are reflected.
  const { data: fresh } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  const finalLead = fresh ?? lead;
```

por:

```ts
  // A autorização de MOVER (dono/manager OU acesso por etapa concedida na
  // etapa ANTIGA) e o UPDATE em si acontecem dentro de uma função
  // security definer — RLS declarativa (USING/WITH CHECK) não dá pra usar
  // aqui porque o WITH CHECK avaliaria a etapa NOVA, e quem só tem acesso por
  // etapa concedida vai justamente SAIR dela nesta ação. Ver
  // .specs/features/acesso-por-etapa-do-funil/design.md.
  const { data: movido, error: moveErr } = await supabase.rpc(
    "fn_mover_lead_com_permissao_de_etapa",
    {
      p_lead_id: leadId,
      p_stage_id: input.stage_id,
      p_position_in_stage: input.position_in_stage,
      p_expected_updated_at: input.expected_updated_at,
    },
  );

  if (moveErr) {
    if (moveErr.message.includes("lead_stage_changed_concurrent")) {
      const { data: current } = await supabase
        .from("crm_leads")
        .select("updated_at")
        .eq("id", leadId)
        .maybeSingle();
      return fail(
        "lead_stage_changed_concurrent",
        t("Lead foi modificado por outro usuário. Recarregue e tente novamente."),
        409,
        { details: { current_updated_at: current?.updated_at ?? null }, requestId },
      );
    }
    if (moveErr.message.includes("sem_permissao_para_mover_este_lead")) {
      return fail("forbidden_stage_move", t("Você não tem acesso para mover este lead."), 403, {
        requestId,
      });
    }
    if (moveErr.message.includes("pipeline_immutable_use_clone")) {
      return fail(
        "pipeline_immutable_use_clone",
        t("Move cross-pipeline não é permitido. Clone o lead para o pipeline alvo."),
        422,
        { requestId },
      );
    }
    if (moveErr.message.includes("lead_nao_encontrado") || moveErr.message.includes("etapa_nao_encontrada")) {
      return fail("not_found", t("Lead ou etapa não encontrado."), 404, { requestId });
    }
    return fail("internal_error", moveErr.message, 500, { requestId });
  }

  const finalLead = movido as typeof lead;
```

Note que os dois blocos de validação ANTERIORES ao UPDATE (buscar `lead` por `.from("crm_leads").select("*")` e buscar `stage` por `.from("crm_stages").select(...)`) **continuam existindo** — eles ainda servem pra rota montar `fromStage`/nomear a mensagem de atividade e pra dar um 404 cedo e amigável antes de gastar uma chamada RPC; a função nova é só quem decide e executa o UPDATE em si, com a autorização certa.

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `pnpm exec vitest run "app/api/v1/leads/[id]/move/route.test.ts"`
Expected: PASS nos 3 casos.

Run: `pnpm typecheck`
Expected: limpo — preste atenção especial ao tipo de retorno de `supabase.rpc(...)` vs o `finalLead` usado mais abaixo por `emitLeadActivity`/`emit_event`/`audit` (eles esperam campos como `.organization_id`, `.stage_id` etc. — confirme que `movido` tem esse shape via cast ou via tipagem do `.rpc<...>()` genérico do supabase-js).

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/leads/\[id\]/move/route.ts "app/api/v1/leads/[id]/move/route.test.ts"
git commit -m "feat(leads): move usa função com permissão por etapa em vez de UPDATE direto"
```

---

### Task 4: Tela — botão "Acesso por etapa" em Equipe

**Files:**
- Modify: `app/app/team/page.tsx`
- Create: `hooks/team/useStageAccess.ts`
- Create: `components/team/MemberStageAccessDialog.tsx`
- Modify: `app/app/team/_components/TeamMembersClient.tsx`

**Interfaces:**
- Consumes: rota da Task 2, padrão de `MemberInterfaceDialog.tsx`/`useChangeRole.ts` (já existem, leia antes de escrever).
- Produces: nenhuma outra task depende desta (é a ponta visível).

- [ ] **Step 1: `page.tsx` busca as etapas do(s) pipeline(s) da org**

Em `app/app/team/page.tsx`, depois de resolver `activeOrg`, adicione (import de `createClient` de `@/lib/supabase/server` — confira se já não está importado; se estiver, reuse):

```ts
import { createClient } from "@/lib/supabase/server";
```

e, dentro do componente, após `const isManager = ...`:

```ts
  const supabase = await createClient();
  const { data: etapasData } = activeOrg
    ? await supabase
        .from("crm_stages")
        .select("id, name, pipeline_id, position")
        .eq("organization_id", activeOrg.orgId)
        .order("pipeline_id")
        .order("position")
    : { data: null };
  const etapas = (etapasData ?? []) as Array<{
    id: string;
    name: string;
    pipeline_id: string;
    position: number;
  }>;
```

Passe `etapas` e `canManageStageAccess={isManager}` para `<TeamMembersClient .../>`:

```tsx
        <TeamMembersClient
          currentUserId={user.id}
          canManage={isAdmin}
          canManageStageAccess={isManager}
          etapas={etapas}
        />
```

- [ ] **Step 2: Hook de dados**

`hooks/team/useStageAccess.ts` (espelha `useTeamMembers.ts` + `useChangeRole.ts`):

```ts
"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

export function useStageAccess(userId: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["team", "stage-access", userId],
    queryFn: async () =>
      apiClient.get<{ data: { stage_ids: string[] } }>(`/api/v1/team/${userId}/stage-access`),
    enabled: opts?.enabled ?? true,
  });
}

export function useSetStageAccess(userId: string) {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (stageIds: string[]) =>
      apiClient.put<{ data: { stage_ids: string[] } }>(`/api/v1/team/${userId}/stage-access`, {
        stage_ids: stageIds,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["team", "stage-access", userId] });
      toast.success(t("Acesso por etapa atualizado."));
    },
    onError: showApiError,
  });
}
```

`apiClient.put` já existe em `lib/api/client.ts:221` — confirmado, use como está acima.

- [ ] **Step 3: O diálogo**

`components/team/MemberStageAccessDialog.tsx` (espelha `MemberInterfaceDialog.tsx` — leia esse arquivo primeiro):

```tsx
"use client";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useStageAccess, useSetStageAccess } from "@/hooks/team/useStageAccess";
import type { TeamMember } from "@/hooks/team/useTeamMembers";

interface Etapa {
  id: string;
  name: string;
  pipeline_id: string;
  position: number;
}

export function MemberStageAccessDialog({
  member,
  etapas,
  onClose,
}: {
  member: TeamMember;
  etapas: Etapa[];
  onClose: () => void;
}) {
  const t = useT();
  const { data, isLoading } = useStageAccess(member.user_id);
  const save = useSetStageAccess(member.user_id);
  const [selecionadas, setSelecionadas] = useState<string[] | null>(null);
  const atuais = selecionadas ?? data?.data.stage_ids ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("Acesso por etapa de")} {member.full_name ?? member.email ?? t("membro")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Marque as etapas do funil que esta pessoa deve enxergar automaticamente no Inbox e no Kanban — sem precisar que ninguém atribua nada a ela. Sem nenhuma marcada, nada muda para ela.",
            )}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
        ) : (
          <div className="space-y-2">
            {etapas.map((e) => (
              <label key={e.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={atuais.includes(e.id)}
                  disabled={save.isPending}
                  onChange={(ev) => {
                    const marcado = ev.target.checked;
                    setSelecionadas(
                      marcado ? [...atuais, e.id] : atuais.filter((id) => id !== e.id),
                    );
                  }}
                />
                {e.name}
              </label>
            ))}
          </div>
        )}
        <Button disabled={isLoading || save.isPending} onClick={() => save.mutate(atuais, { onSuccess: onClose })}>
          {save.isPending ? t("Salvando…") : t("Salvar acesso")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
```

`components/ui/checkbox.tsx` não existe neste repo (confirmado) — por isso o código acima já usa `<input type="checkbox">` puro, no mesmo estilo que `app/app/products/_client.tsx:369-373` usa para "Controlar estoque deste produto". Não instale/gere um componente shadcn novo para isto.

- [ ] **Step 4: Wire no `TeamMembersClient.tsx`**

Adicione a prop nova na interface e assinatura do componente:

```ts
interface Props {
  currentUserId: string;
  canManage: boolean;
  canManageStageAccess: boolean;
  etapas: Array<{ id: string; name: string; pipeline_id: string; position: number }>;
}

export function TeamMembersClient({ currentUserId, canManage, canManageStageAccess, etapas }: Props) {
```

Adicione o estado do diálogo junto aos outros (`interfaceMember`, `revokeDialog`):

```ts
  const [stageAccessMember, setStageAccessMember] = useState<TeamMember | null>(null);
```

Na célula de "Interface" (ou numa coluna nova ao lado — decisão sua, mas NÃO remova nenhuma coluna existente), adicione, condicionado a `canManageStageAccess`:

```tsx
{canManageStageAccess ? (
  <Button
    variant="outline"
    size="sm"
    aria-label={`${t("Acesso por etapa de")} ${m.full_name ?? m.email ?? m.user_id}`}
    onClick={() => setStageAccessMember(m)}
  >
    {t("Acesso por etapa")}
  </Button>
) : null}
```

E, junto aos outros diálogos renderizados no fim do componente:

```tsx
{stageAccessMember && (
  <MemberStageAccessDialog
    key={stageAccessMember.user_id}
    member={stageAccessMember}
    etapas={etapas}
    onClose={() => setStageAccessMember(null)}
  />
)}
```

Não esqueça o import: `import { MemberStageAccessDialog } from "@/components/team/MemberStageAccessDialog";`.

- [ ] **Step 5: Verificação**

Run: `pnpm typecheck && pnpm lint`
Expected: zero erros.

Este passo não tem teste automatizado dedicado (é UI de configuração, mesmo padrão de escopo do `MemberInterfaceDialog` original, que também não tem). Se quiser confirmar visualmente: `pnpm dev`, abrir `/app/team`, clicar em "Acesso por etapa" de um membro.

- [ ] **Step 6: Commit**

```bash
git add app/app/team/page.tsx app/app/team/_components/TeamMembersClient.tsx hooks/team/useStageAccess.ts components/team/MemberStageAccessDialog.tsx
git commit -m "feat(equipe): tela de acesso por etapa do funil por membro"
```

---

### Task 5: Invariante de LEITURA (`pnpm test:db`)

**Files:**
- Create: `tests/invariants/gov-5f-stage-access.test.ts`

**Interfaces:**
- Consumes: `tests/invariants/gov-helpers.ts` (já existe — `GOV_ORG`, `GOV_AGENT_A`, `GOV_AGENT_B`, `GOV_PIPELINE`, `GOV_STAGE`, `seedGov`, `sql`, `countAs`), a migration da Task 1 já aplicada no banco de teste.

**IMPORTANTE — ambiente:** `pnpm test:db` precisa de Docker. Esta máquina não tem. Escreva o arquivo com cuidado espelhando EXATAMENTE `tests/invariants/gov-5c-lead-scope.test.ts` (leia o arquivo inteiro antes de escrever o seu) e reporte DONE_WITH_CONCERNS — o controller roda `pnpm test:db` de verdade numa máquina com Docker antes de aprovar.

- [ ] **Step 1: Ler `gov-5c-lead-scope.test.ts` por inteiro** para o padrão exato de seed/fixtures/asserts (namespace de IDs próprio, comentário de cabeçalho explicando o eixo).

- [ ] **Step 2: Escrever o arquivo**

`tests/invariants/gov-5f-stage-access.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_ORG, GOV_PIPELINE, GOV_SESSION, countAs, seedGov, sql } from "./gov-helpers";

/**
 * Eixo 5f — acesso por etapa do funil (feature "acesso-por-etapa-do-funil").
 * Prova que uma concessão em `user_stage_access` dá visibilidade de LEITURA a
 * conversas e leads de um contato cujo lead esteja na etapa concedida — SEM
 * o usuário ser dono nem estar atribuído — e que sem concessão nenhuma o
 * comportamento de hoje (gov-5/gov-5c) não muda nem um pouco.
 *
 * Fixtures locais (namespace a5f… — exclusivo deste arquivo).
 */

const STAGE_TECNICO = "a5f01111-0000-4000-8000-000000000001"; // etapa concedida a GOV_AGENT_A
const STAGE_OUTRA = "a5f01111-0000-4000-8000-000000000002"; // etapa NÃO concedida
const CONTACT_1 = "a5f01111-0000-4000-8000-000000000003";
const CONTACT_2 = "a5f01111-0000-4000-8000-000000000004"; // tem 2 leads (AC4 do P2)
const LEAD_NA_ETAPA = "a5f01111-0000-4000-8000-000000000005"; // stage = STAGE_TECNICO, owner = GOV_AGENT_B (não é dono de A)
const LEAD_FORA_DA_ETAPA = "a5f01111-0000-4000-8000-000000000006"; // stage = STAGE_OUTRA, owner = GOV_AGENT_B
const LEAD_CONTATO2_A = "a5f01111-0000-4000-8000-000000000007"; // stage = STAGE_OUTRA (fora)
const LEAD_CONTATO2_B = "a5f01111-0000-4000-8000-000000000008"; // stage = STAGE_TECNICO (dentro) — AC4
const CONVERSA_1 = "a5f01111-0000-4000-8000-000000000009"; // contact_id = CONTACT_1, ninguém atribuído
const CONVERSA_2 = "a5f01111-0000-4000-8000-00000000000a"; // contact_id = CONTACT_2, ninguém atribuído

beforeAll(() => {
  seedGov(); // GOV_ORG (visibility_mode default 'own_and_unassigned') + agents A/B + pipeline/stage
  sql(`
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values
        ('${STAGE_TECNICO}', '${GOV_ORG}', '${GOV_PIPELINE}', 'Em conserto', 'em-conserto-a5f', 2000),
        ('${STAGE_OUTRA}',   '${GOV_ORG}', '${GOV_PIPELINE}', 'Outra etapa', 'outra-a5f', 3000)
      on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, display_name)
      values
        ('${CONTACT_1}', '${GOV_ORG}', 'Contato A5F 1'),
        ('${CONTACT_2}', '${GOV_ORG}', 'Contato A5F 2')
      on conflict (id) do nothing;

    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, contact_id)
      values
        ('${LEAD_NA_ETAPA}',      '${GOV_ORG}', '${GOV_PIPELINE}', '${STAGE_TECNICO}', 'Lead na etapa técnico', '${GOV_AGENT_B}', '${CONTACT_1}'),
        ('${LEAD_FORA_DA_ETAPA}', '${GOV_ORG}', '${GOV_PIPELINE}', '${STAGE_OUTRA}',   'Lead fora da etapa',    '${GOV_AGENT_B}', null),
        ('${LEAD_CONTATO2_A}',    '${GOV_ORG}', '${GOV_PIPELINE}', '${STAGE_OUTRA}',   'Contato 2, lead fora',  '${GOV_AGENT_B}', '${CONTACT_2}'),
        ('${LEAD_CONTATO2_B}',    '${GOV_ORG}', '${GOV_PIPELINE}', '${STAGE_TECNICO}', 'Contato 2, lead dentro', '${GOV_AGENT_B}', '${CONTACT_2}')
      on conflict (id) do nothing;

    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values
        ('${CONVERSA_1}', '${GOV_ORG}', '${CONTACT_1}', '${GOV_SESSION}', 'open'),
        ('${CONVERSA_2}', '${GOV_ORG}', '${CONTACT_2}', '${GOV_SESSION}', 'open')
      on conflict (id) do nothing;
  `);
});

describe("eixo 5f — leitura por acesso concedido de etapa (sem concessão nenhuma)", () => {
  it("agent A NÃO vê o lead na etapa-alvo antes de qualquer concessão (controle negativo)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.crm_leads where id = '${LEAD_NA_ETAPA}';`),
    ).toBe(0);
  });

  it("agent A NÃO vê a conversa do contato 1 antes de qualquer concessão (controle negativo)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.conversations where id = '${CONVERSA_1}';`),
    ).toBe(0);
  });
});

describe("eixo 5f — leitura após conceder a etapa 'Em conserto' ao agent A", () => {
  beforeAll(() => {
    sql(`
      insert into public.user_stage_access (organization_id, user_id, stage_id, granted_by)
        values ('${GOV_ORG}', '${GOV_AGENT_A}', '${STAGE_TECNICO}', '${GOV_AGENT_B}')
        on conflict (user_id, stage_id) do nothing;
    `);
  });

  it("agent A passa a ver o lead que está na etapa concedida (P2 AC1)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.crm_leads where id = '${LEAD_NA_ETAPA}';`),
    ).toBe(1);
  });

  it("agent A continua SEM ver o lead que está fora da etapa concedida (P2 AC3, regressão)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.crm_leads where id = '${LEAD_FORA_DA_ETAPA}';`),
    ).toBe(0);
  });

  it("agent A vê a conversa do contato cujo lead está na etapa concedida (P2 AC1, via contact_id)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.conversations where id = '${CONVERSA_1}';`),
    ).toBe(1);
  });

  it("contato com 2 leads: basta UM estar na etapa concedida para a conversa aparecer (P2 AC4)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.conversations where id = '${CONVERSA_2}';`),
    ).toBe(1);
  });

  it("agent B (sem concessão nenhuma) nunca ganha acesso por causa da concessão de A", () => {
    expect(
      countAs(GOV_AGENT_B, `select count(*) from public.crm_leads where id = '${LEAD_NA_ETAPA}';`),
    ).toBe(1); // B é o DONO — isso já era true antes desta feature (fn_can_view_lead), controle de que nada quebrou
  });
});
```

Os nomes de coluna acima (`contacts.display_name`, `conversations.channel_session_id` reaproveitando `GOV_SESSION` de `seedGov()`, sem coluna `external_id` — ela não existe em `conversations`) já foram conferidos contra o schema real em `supabase/baseline.sql:1324-1398` e contra `seedGov()` em `gov-helpers.ts` ao escrever este plano — não invente colunas novas nem troque por outras sem reconferir o `CREATE TABLE` real primeiro.

- [ ] **Step 2: Reportar DONE_WITH_CONCERNS**

Não rode `pnpm test:db` (sem Docker). Reporte explicitamente: "arquivo escrito e comparado manualmente com gov-5c e com o schema real de contacts/conversations; controller roda `pnpm test:db` numa máquina com Docker."

- [ ] **Step 3: Commit**

```bash
git add tests/invariants/gov-5f-stage-access.test.ts
git commit -m "test(invariants): eixo 5f — leitura por acesso concedido de etapa"
```

---

### Task 6: Invariante de ESCRITA — mover o lead (`pnpm test:db`)

**Files:**
- Create: `tests/invariants/gov-5g-stage-move.test.ts`

**Interfaces:**
- Consumes: `fn_mover_lead_com_permissao_de_etapa` (Task 1), `gov-helpers.ts`.

**IMPORTANTE — mesmo ambiente da Task 5: sem Docker aqui.** Reporte DONE_WITH_CONCERNS; controller roda de verdade.

- [ ] **Step 1: Escrever um helper local para chamar a função e capturar o erro**

`writeCountAs` (de `gov-helpers.ts`) serve para DML direto, não para chamar uma função e inspecionar SEU erro específico. Dentro do arquivo novo, escreva:

```ts
function moverComo(
  userId: string,
  leadId: string,
  novaEtapa: string,
  expectedUpdatedAt: string,
): { ok: true } | { ok: false; erro: string } {
  try {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      select public.fn_mover_lead_com_permissao_de_etapa(
        '${leadId}'::uuid, '${novaEtapa}'::uuid, 9999, '${expectedUpdatedAt}'::timestamptz
      );
    `);
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const match = /ERROR:\s+([a-z_]+)/.exec(stderr);
    return { ok: false, erro: match?.[1] ?? stderr };
  }
}
```

- [ ] **Step 2: Escrever o arquivo de teste**

`tests/invariants/gov-5g-stage-move.test.ts`:

```ts
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_ORG, GOV_PIPELINE, sql, seedGov } from "./gov-helpers";

/**
 * Eixo 5g — mover um lead usando SÓ acesso por etapa concedida (não dono, não
 * manager). Prova o motivo de existir `fn_mover_lead_com_permissao_de_etapa`
 * em vez de um OR na policy `crm_leads_update`: o técnico precisa conseguir
 * mover o card PRA FORA da etapa concedida a ele, o que uma policy
 * USING/WITH CHECK simétrica bloquearia (ver design.md).
 */

const STAGE_A = "a5g01111-0000-4000-8000-000000000001"; // concedida ao agent A
const STAGE_B = "a5g01111-0000-4000-8000-000000000002"; // NÃO concedida a ninguém
const LEAD = "a5g01111-0000-4000-8000-000000000003"; // owner = GOV_AGENT_B (não é A), stage inicial = STAGE_A

function moverComo(
  userId: string,
  leadId: string,
  novaEtapa: string,
  expectedUpdatedAt: string,
): { ok: true } | { ok: false; erro: string } {
  try {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      select public.fn_mover_lead_com_permissao_de_etapa(
        '${leadId}'::uuid, '${novaEtapa}'::uuid, 9999, '${expectedUpdatedAt}'::timestamptz
      );
    `);
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const match = /ERROR:\s+([a-z_]+)/.exec(stderr);
    return { ok: false, erro: match?.[1] ?? stderr };
  }
}

function updatedAtDoLead(): string {
  return sql(`select updated_at::text from public.crm_leads where id = '${LEAD}';`);
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values
        ('${STAGE_A}', '${GOV_ORG}', '${GOV_PIPELINE}', 'Em conserto 5g', 'em-conserto-5g', 4000),
        ('${STAGE_B}', '${GOV_ORG}', '${GOV_PIPELINE}', 'Pronto 5g', 'pronto-5g', 5000)
      on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id)
      values ('${LEAD}', '${GOV_ORG}', '${GOV_PIPELINE}', '${STAGE_A}', 'Lead 5g', '${GOV_AGENT_B}')
      on conflict (id) do nothing;
    insert into public.user_stage_access (organization_id, user_id, stage_id, granted_by)
      values ('${GOV_ORG}', '${GOV_AGENT_A}', '${STAGE_A}', '${GOV_AGENT_B}')
      on conflict (user_id, stage_id) do nothing;
  `);
});

describe("eixo 5g — mover lead só com acesso por etapa (P3)", () => {
  it("agent A NÃO consegue mover um lead que nunca esteve numa etapa concedida a ele (controle negativo)", () => {
    // Cria um segundo lead, fora de qualquer concessão de A, dono = B.
    sql(`
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id)
        values ('a5g01111-0000-4000-8000-000000000099', '${GOV_ORG}', '${GOV_PIPELINE}', '${STAGE_B}', 'Fora', '${GOV_AGENT_B}')
        on conflict (id) do nothing;
    `);
    const updatedAt = sql(
      `select updated_at::text from public.crm_leads where id = 'a5g01111-0000-4000-8000-000000000099';`,
    );
    const r = moverComo(GOV_AGENT_A, "a5g01111-0000-4000-8000-000000000099", STAGE_A, updatedAt);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toContain("sem_permissao_para_mover_este_lead");
  });

  it("agent A CONSEGUE mover o lead pra FORA da etapa concedida a ele (P3 AC1 — o motivo desta função existir)", () => {
    const updatedAt = updatedAtDoLead();
    const r = moverComo(GOV_AGENT_A, LEAD, STAGE_B, updatedAt);
    expect(r.ok).toBe(true);

    const etapaFinal = sql(`select stage_id from public.crm_leads where id = '${LEAD}';`);
    expect(etapaFinal).toBe(STAGE_B);
  });

  it("depois de mover pra fora, agent A deixa de ver o lead (fecha o ciclo com o eixo 5f)", () => {
    const conta = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', false);
      select count(*) from public.crm_leads where id = '${LEAD}';
    `);
    expect(conta.trim().split("\n").pop()).toBe("0");
  });
});
```

- [ ] **Step 3: Sabotagem (prova de que a função importa)**

Depois de confirmar (mentalmente, comparando o SQL) que o teste do Step 2 exercitaria a linha `or public.fn_has_stage_access(v_lead.organization_id, v_lead.stage_id)` dentro de `fn_mover_lead_com_permissao_de_etapa`, documente no seu report: se essa linha fosse removida, o segundo `it` (mover pra fora da etapa) passaria a receber `sem_permissao_para_mover_este_lead` (porque `GOV_AGENT_A` não é dono nem manager) — ou seja, o teste ESPECIFICAMENTE prova essa linha, não é decoração. Você não precisa rodar a sabotagem de verdade nesta máquina (sem Docker); documente o raciocínio no report para o controller confirmar quando rodar `pnpm test:db`.

- [ ] **Step 4: Commit**

```bash
git add tests/invariants/gov-5g-stage-move.test.ts
git commit -m "test(invariants): eixo 5g — mover lead com acesso só por etapa"
```

---

## Self-Review (preenchido ao escrever este plano)

- **Cobertura do spec:** P1 (conceder) → Task 2 + Task 4. P2 (visibilidade automática) → Task 1 + Task 5. P3 (mover sem travar) → Task 1 (função) + Task 3 (rota) + Task 6 (prova). Nenhum requisito do `spec.md` ficou sem task.
- **Placeholders:** nenhum "TBD"/"depois" — todo passo tem código completo, inclusive os testes de invariante (que a maioria dos planos anteriores não chegava a escrever por extenso).
- **Consistência entre tasks:** a Task 3 depende do NOME exato da função e dos NOMES dos erros (`sem_permissao_para_mover_este_lead`, `lead_stage_changed_concurrent`, `pipeline_immutable_use_clone`, `lead_nao_encontrado`, `etapa_nao_encontrada`) — conferidos como idênticos entre a Task 1 (onde nascem) e a Task 3 (onde são mapeados) e a Task 6 (onde são testados).
- **Risco sinalizado explicitamente:** Tasks 1, 5 e 6 não podem ser verificadas de verdade nesta máquina (sem Docker) — todas terminam em DONE_WITH_CONCERNS por design, não por acidente, e o controller sabe que precisa rodar `pnpm test:db` de verdade (numa VPS com Docker, como já foi feito na feature anterior) antes de aprovar essas três.
- **Fora de escopo, confirmado nas tasks:** nenhuma task cria um papel novo no banco, nenhuma toca em `crm_lead_activities`, nenhuma muda a assinatura de `fn_can_view_conversation`/`fn_can_view_lead` — consistente com o `spec.md` e o `design.md`.
