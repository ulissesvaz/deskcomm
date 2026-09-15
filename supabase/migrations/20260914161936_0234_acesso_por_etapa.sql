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
