-- 0235 — forward-fix de public.user_stage_access.granted_by (achado S2.4 da
-- revisão final de branch de acesso-por-etapa-do-funil).
--
-- A 0234 criou `granted_by uuid not null references auth.users(id)` sem
-- `on delete` — logo `NO ACTION`. `.specs/features/acesso-por-etapa-do-funil/
-- design.md:84` prometia "on delete cascade nas três FKs: apagar a
-- organização, o usuário ou a etapa limpa a concessão sozinha", mas a coluna
-- ficou fora disso. Consequência real: apagar de `auth.users` um gerente que
-- já concedeu QUALQUER etapa levanta violação de FK e bloqueia a exclusão da
-- conta dele — mesmo numa organização diferente, anos depois.
--
-- O conserto não é `cascade` (apagaria a concessão inteira quando o AUTOR sai
-- da empresa, mesmo que o BENEFICIÁRIO — user_id, que segue cascade — continue
-- lá): é `set null`, porque a concessão não deveria depender de quem a deu
-- ainda existir. Isso exige a coluna nullable, então:
--
--   1. `drop not null` — idempotente por natureza: reaplicar numa coluna já
--      nullable não é erro no Postgres.
--   2. Descobrir e derrubar a FK antiga pelo CATÁLOGO, não por nome fixo — a
--      0234 criou `references auth.users(id)` sem nomear a constraint, e o
--      nome que o Postgres gera por convenção
--      (`user_stage_access_granted_by_fkey`) não é garantia contratual em todo
--      clone. A busca casa por conrelid + contype='f' + confrelid=auth.users +
--      a ÚNICA coluna da FK sendo `granted_by` — distingue da FK de `user_id`,
--      que também aponta pra auth.users mas é outra coluna.
--   3. Recriar com `on delete set null` e nome fixo. Reaplicar este arquivo
--      dropa-e-recria a mesma FK (idempotente por resultado, não por
--      no-op — o mesmo idioma de `drop policy if exists` + `create policy`
--      já usado no resto do baseline).
--
-- Nunca edite a 20260914161936_0234_acesso_por_etapa.sql — ela já está
-- mesclada. Isto é uma forward-fix nova, com seu próprio apêndice no
-- baseline.sql.

do $$
declare
  v_constraint text;
begin
  select c.conname into v_constraint
    from pg_constraint c
   where c.conrelid = 'public.user_stage_access'::regclass
     and c.contype = 'f'
     and c.confrelid = 'auth.users'::regclass
     and array_length(c.conkey, 1) = 1
     and c.conkey[1] = (
       select attnum from pg_attribute
        where attrelid = c.conrelid and attname = 'granted_by'
     );

  if v_constraint is not null then
    execute format('alter table public.user_stage_access drop constraint %I', v_constraint);
  end if;
end
$$;

alter table public.user_stage_access alter column granted_by drop not null;

alter table public.user_stage_access
  add constraint user_stage_access_granted_by_fkey
  foreign key (granted_by) references auth.users(id) on delete set null;
