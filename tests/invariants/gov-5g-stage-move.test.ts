import { beforeAll, describe, expect, it } from "vitest";

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
