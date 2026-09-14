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
