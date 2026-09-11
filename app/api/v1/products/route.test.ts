import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** O que a rota mandou para o `insert` — é sobre isto que as asserções falam. */
let inserido: Record<string, unknown> | null = null;
/** O org id que o `.eq()` de `organizations` recebeu — o alvo do hallazgo 4. */
let orgIdLido: string | null = null;

/**
 * Supabase de mentira com as DUAS tabelas que a rota toca: lê a moeda em
 * `organizations` e grava em `catalog_products`.
 */
function supabaseCom(moedaDaOrg: string | null) {
  return {
    from: (tabela: string) => {
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: (_coluna: string, valor: string) => {
              orgIdLido = valor;
              return {
                maybeSingle: async () => ({
                  data: moedaDaOrg === null ? null : { currency: moedaDaOrg },
                  error: null,
                }),
              };
            },
          }),
        };
      }
      return {
        insert: (linha: Record<string, unknown>) => {
          inserido = linha;
          return {
            select: () => ({
              single: async () => ({ data: { id: "p1", ...linha }, error: null }),
            }),
          };
        },
      };
    },
  };
}

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/products", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

const PRODUTO = { codigo: "IP15", nome: "iPhone 15", preco_cents: 549900 };

beforeEach(() => {
  vi.clearAllMocks();
  inserido = null;
  orgIdLido = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID },
    org: { orgId: ORG_ID },
  } as never);
});

describe("POST /api/v1/products — moeda do produto", () => {
  /**
   * A rota exige requireRole("manager") ANTES de ler o corpo (ver o mock de
   * requireRole no beforeEach) — é essa gate, mais o enum fechado do Zod
   * (MOEDAS_SERVIDAS), que torna seguro aceitar moeda do corpo agora. Sem
   * manager mockado como `ok:false`, este teste nem chegaria ao insert.
   */
  it("usa a moeda enviada no corpo quando presente", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL") as never);
    const { POST } = await import("./route");

    const resposta = await POST(pedido({ ...PRODUTO, moeda: "GBP" }));

    expect(resposta.status).toBe(201);
    expect(inserido).toMatchObject({ moeda: "GBP" });
    expect(orgIdLido).toBe(ORG_ID);
  });

  it("cai na moeda da organização quando o corpo não manda nenhuma", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("MXN") as never);
    const { POST } = await import("./route");

    const resposta = await POST(pedido(PRODUTO));

    expect(resposta.status).toBe(201);
    expect(inserido).toMatchObject({ moeda: "MXN" });
    expect(orgIdLido).toBe(ORG_ID);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
