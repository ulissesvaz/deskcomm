import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * `user_stage_access` NÃO VAZA ENTRE ORGANIZAÇÕES — arquivo próprio, e não uma
 * linha em `rls-isolation.test.ts`.
 *
 * ═══ Por que um arquivo próprio ═══
 *
 * `rls-isolation.test.ts` semeia um usuário `agent` por organização e prova
 * duas coisas por tabela: zero linhas do vizinho, e mais de zero linhas
 * próprias (controle positivo). A policy de `user_stage_access`
 * (`supabase/migrations/20260914161936_0234_acesso_por_etapa.sql`) é `for all
 * using (fn_is_platform_admin() or (org in fn_user_org_ids() and
 * fn_role_at_least(org,'manager')))` — MESMA condição para SELECT, INSERT,
 * UPDATE e DELETE. Um `agent` não passa `fn_role_at_least(org,'manager')`
 * (nível 2 < 3, `baseline.sql:664-678`), então o controle positivo do molde
 * genérico falharia por ACERTO se a tabela entrasse em `TABLES` com o usuário
 * `agent` que aquele arquivo semeia — exatamente o defeito que o cabeçalho de
 * `rls-isolation.test.ts` descreve para `webhook_lead_captures`, e a razão
 * pela qual aquela tabela também vive num arquivo à parte
 * (`historico-de-captacao-rls.test.ts`) em vez de em `TABLES`.
 *
 * Este arquivo é a entrada de `user_stage_access` em `PROVA_PROPRIA`
 * (`rls-completude-varredura.test.ts`), no MESMO molde de
 * `historico-de-captacao-rls.test.ts`: dois tenants reais, `set role
 * authenticated` + `request.jwt.claims`, contagem cross-org nos dois sentidos.
 *
 * Conectar como `postgres` mediria NADA (rolbypassrls = t).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`saída inesperada do psql: ${out}`);
  }
  return Number(last);
}

// UUIDs próprios (namespace e7a9a000 — exclusivo deste arquivo) para não
// disputar linhas com nenhum outro invariante que rode na mesma base.
const ORG_A = "e7a9a000-0000-4000-8000-00000000000a";
const ORG_B = "e7a9a000-0000-4000-8000-00000000000b";
const MANAGER_A = "e7a9a000-1111-4000-8000-00000000000a";
const AGENT_A = "e7a9a000-1111-4000-8000-00000000000c";
const MANAGER_B = "e7a9a000-1111-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${MANAGER_A}', 'etapa-mgr-a@invariant.test'),
      ('${AGENT_A}',   'etapa-agent-a@invariant.test'),
      ('${MANAGER_B}', 'etapa-mgr-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'etapa-inv-a', 'Etapa Invariant A', 'Etapa A'),
      ('${ORG_B}', 'etapa-inv-b', 'Etapa Invariant B', 'Etapa B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${MANAGER_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    -- Uma concessão por organização, sobre a etapa default que
    -- trg_seed_default_pipeline_for_org já criou ao inserir a org
    -- (baseline.sql:684-718, dispara em AFTER INSERT em organizations).
    insert into public.user_stage_access (organization_id, user_id, stage_id, granted_by)
    select v.org, v.mgr,
           (select id from public.crm_stages where organization_id = v.org order by position limit 1),
           v.mgr
      from (values ('${ORG_A}'::uuid, '${MANAGER_A}'::uuid), ('${ORG_B}'::uuid, '${MANAGER_B}'::uuid)) as v(org, mgr)
     where not exists (
       select 1 from public.user_stage_access u where u.organization_id = v.org and u.user_id = v.mgr
     );
  `);
});

describe("user_stage_access — isolamento cross-tenant e gate de papel", () => {
  it("o manager da org A lê a concessão da PRÓPRIA org (controle positivo)", () => {
    const propria = countAs(
      MANAGER_A,
      `select count(*) from public.user_stage_access where organization_id = '${ORG_A}';`,
    );
    expect(propria).toBeGreaterThan(0);
  });

  it("o manager da org A lê ZERO concessões da org B", () => {
    const vizinha = countAs(
      MANAGER_A,
      `select count(*) from public.user_stage_access where organization_id = '${ORG_B}';`,
    );
    expect(vizinha).toBe(0);
  });

  it("o manager da org A não alcança nenhuma linha da tabela inteira além das suas", () => {
    // Sem filtro de organização — é assim que um cliente do PostgREST pediria
    // a tabela toda. O total visível tem que ser exatamente o das próprias.
    const total = countAs(MANAGER_A, `select count(*) from public.user_stage_access;`);
    const propria = countAs(
      MANAGER_A,
      `select count(*) from public.user_stage_access where organization_id = '${ORG_A}';`,
    );
    expect(total).toBe(propria);
  });

  it("o manager da org B lê as dele (controle positivo do outro lado)", () => {
    const propria = countAs(
      MANAGER_B,
      `select count(*) from public.user_stage_access where organization_id = '${ORG_B}';`,
    );
    expect(propria).toBeGreaterThan(0);
  });

  it("o AGENT da própria org não lê a concessão — a policy exige manager, não agent", () => {
    // É o que distingue esta tabela do molde genérico de rls-isolation.test.ts:
    // lá o `agent` semeado basta para o controle positivo; aqui a mesma
    // condição de USING vale para SELECT, e um agent não é manager.
    const doAgent = countAs(
      AGENT_A,
      `select count(*) from public.user_stage_access where organization_id = '${ORG_A}';`,
    );
    expect(doAgent).toBe(0);
  });
});
