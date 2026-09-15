import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  role: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

import { GET, PUT } from "./route";

const user = "f2210000-0000-4000-8000-000000000001";
const org = "f2210000-0000-4000-8000-000000000002";
const stageA = "f2210000-0000-4000-8000-0000000000a1";
const stageB = "f2210000-0000-4000-8000-0000000000a2";
const stageForaDaOrg = "f2210000-0000-4000-8000-0000000000ff";
const ctx = { params: Promise.resolve({ user_id: user }) };

/**
 * Query builder de mentira: cada método encadeável devolve o próprio chain,
 * e o chain é THENABLE — resolve consumindo a fila de resultados na ordem em
 * que a rota chama (seja `.maybeSingle()` explícito, seja `await` direto no
 * fim da cadeia de `.eq()`/`.in()`/`.insert()`/`.delete()`, como a rota faz).
 */
function makeChain(resultados: Array<{ data: unknown; error: unknown }>) {
  const fila = [...resultados];
  const inseridos: unknown[] = [];
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    not: vi.fn(() => chain),
    in: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    insert: vi.fn((linhas: unknown[]) => {
      inseridos.push(...linhas);
      return chain;
    }),
    maybeSingle: vi.fn(async () => fila.shift() ?? { data: null, error: null }),
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      Promise.resolve(fila.shift() ?? { data: null, error: null }).then(resolve, reject);
    },
  };
  return { chain, inseridos };
}

const putRequest = (body: unknown) =>
  new NextRequest("http://local/api/v1/team/member/stage-access", {
    method: "PUT",
    body: JSON.stringify(body),
  });
const getRequest = () =>
  new NextRequest("http://local/api/v1/team/member/stage-access", { method: "GET" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.support.mockResolvedValue(null);
  mocks.role.mockResolvedValue({
    ok: true,
    user: { id: user, idioma: "pt-BR" },
    org: { orgId: org },
  });
});

it("GET devolve os stage_ids que a query de user_stage_access retornar", async () => {
  const { chain } = makeChain([
    { data: { user_id: user }, error: null }, // membroAtivo
    { data: [{ stage_id: stageA }, { stage_id: stageB }], error: null }, // select stage_id
  ]);
  mocks.from.mockReturnValue(chain);

  const res = await GET(getRequest(), ctx);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.stage_ids).toEqual([stageA, stageB]);
});

it("GET nega antes de consultar quando readonly/support bloqueia", async () => {
  mocks.support.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await GET(getRequest(), ctx)).status).toBe(403);
  expect(mocks.role).not.toHaveBeenCalled();
  expect(mocks.from).not.toHaveBeenCalled();
});

it("PUT com um stage_id que não pertence à organização -> 422, sem chamar delete/insert", async () => {
  const { chain } = makeChain([
    { data: { user_id: user }, error: null }, // membroAtivo
    { data: [{ id: stageA }], error: null }, // crm_stages válidas — falta stageForaDaOrg
  ]);
  mocks.from.mockReturnValue(chain);

  const res = await PUT(putRequest({ stage_ids: [stageA, stageForaDaOrg] }), ctx);
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.details).toEqual({ stage_id: stageForaDaOrg });
  expect(chain.delete).not.toHaveBeenCalled();
  expect(chain.insert).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});

it("PUT com stage_ids: [] apaga tudo, não insere nada, e audita sucesso", async () => {
  const { chain } = makeChain([
    { data: { user_id: user }, error: null }, // membroAtivo
    { data: null, error: null }, // delete().eq().eq()
  ]);
  mocks.from.mockReturnValue(chain);

  const res = await PUT(putRequest({ stage_ids: [] }), ctx);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.stage_ids).toEqual([]);
  expect(chain.delete).toHaveBeenCalledTimes(1);
  expect(chain.insert).not.toHaveBeenCalled();
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "team.stage_access_updated",
      organizationId: org,
      actorUserId: user,
      resourceId: user,
      metadata: { user_id: user, stage_ids: [] },
    }),
  );
});

it("PUT com stage_ids válidos substitui o conjunto e audita", async () => {
  const { chain, inseridos } = makeChain([
    { data: { user_id: user }, error: null }, // membroAtivo
    { data: [{ id: stageA }, { id: stageB }], error: null }, // crm_stages válidas
    { data: null, error: null }, // delete
    { data: null, error: null }, // insert
  ]);
  mocks.from.mockReturnValue(chain);

  const res = await PUT(putRequest({ stage_ids: [stageA, stageB] }), ctx);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.stage_ids).toEqual([stageA, stageB]);
  expect(chain.delete).toHaveBeenCalledTimes(1);
  expect(inseridos).toEqual([
    { organization_id: org, user_id: user, stage_id: stageA, granted_by: user },
    { organization_id: org, user_id: user, stage_id: stageB, granted_by: user },
  ]);
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "team.stage_access_updated" }),
  );
});

it("PUT com membro inexistente/revogado na org -> 404, sem tocar em user_stage_access", async () => {
  const { chain } = makeChain([{ data: null, error: null }]); // membroAtivo: não encontrado
  mocks.from.mockReturnValue(chain);

  const res = await PUT(putRequest({ stage_ids: [stageA] }), ctx);
  expect(res.status).toBe(404);
  expect(chain.delete).not.toHaveBeenCalled();
  expect(chain.insert).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});

it("PUT com corpo inválido (Zod) -> 422, sem tocar no banco", async () => {
  mocks.from.mockReturnValue(makeChain([]).chain);
  const res = await PUT(putRequest({ stage_ids: "não é array" }), ctx);
  expect(res.status).toBe(422);
  expect(mocks.from).not.toHaveBeenCalled();
});

it("PUT com user_id inválido -> 400, sem consultar o banco", async () => {
  const ctxInvalido = { params: Promise.resolve({ user_id: "not-a-uuid" }) };
  const res = await PUT(putRequest({ stage_ids: [] }), ctxInvalido);
  expect(res.status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
});

it("gate manager nega antes de tocar no banco", async () => {
  mocks.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await PUT(putRequest({ stage_ids: [] }), ctx)).status).toBe(403);
  expect(mocks.role).toHaveBeenCalledWith("manager", expect.anything());
  expect(mocks.from).not.toHaveBeenCalled();
});
