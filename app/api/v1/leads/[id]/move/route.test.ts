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
// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria
// (mesmo padrão de app/api/v1/leads/[id]/lose/route.test.ts).
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
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
      if (nome === "fn_mover_lead_com_permissao_de_etapa") return Promise.resolve(rpcResultado);
      // emit_event: fire-and-forget pós-move, já existente na rota antes desta
      // task e fora do escopo do teste de autorização/OCC.
      if (nome === "emit_event") return Promise.resolve({ data: "evt-1", error: null });
      throw new Error(`rpc inesperada: ${nome}`);
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
