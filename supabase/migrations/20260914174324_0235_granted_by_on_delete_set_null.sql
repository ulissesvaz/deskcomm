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
--   2. `drop constraint if exists` + `add constraint` pelo NOME — a forma
--      canônica que o resto deste apêndice já usa para constraint (o Postgres
--      não tem `add constraint if not exists`). O nome é determinístico: a
--      0234 criou a FK sem nomeá-la explicitamente
--      (`references auth.users(id)`, dentro de um `create table` novo, sem
--      nenhuma constraint homônima possível antes dela), e a convenção do
--      Postgres para uma FK de coluna única sem nome explícito é
--      `<tabela>_<coluna>_fkey` — logo `user_stage_access_granted_by_fkey`
--      em QUALQUER clone que tenha aplicado a 0234, sem exceção.
--   3. Recriar com `on delete set null`. Reaplicar este arquivo
--      dropa-e-recria a mesma FK (idempotente por resultado, não por
--      no-op — o mesmo idioma de `drop policy if exists` + `create policy`
--      já usado no resto do baseline).
--
-- Nunca edite a 20260914161936_0234_acesso_por_etapa.sql — ela já está
-- mesclada. Isto é uma forward-fix nova, com seu próprio apêndice no
-- baseline.sql.

alter table public.user_stage_access alter column granted_by drop not null;

alter table public.user_stage_access drop constraint if exists user_stage_access_granted_by_fkey;
alter table public.user_stage_access
  add constraint user_stage_access_granted_by_fkey
  foreign key (granted_by) references auth.users(id) on delete set null;
