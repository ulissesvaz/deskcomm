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
import { PATCH } from "./route";
const user = "f2210000-0000-4000-8000-000000000001";
const org = "f2210000-0000-4000-8000-000000000002";
const ctx = { params: Promise.resolve({ user_id: user }) };
const request = (body: unknown = { job_title: "Técnico" }) =>
  new NextRequest("http://local/api/v1/team/member/job-title", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.support.mockResolvedValue(null);
  mocks.role.mockResolvedValue({ ok: true, user: { id: user }, org: { orgId: org } });
});
it("readonly nega antes de consultar/escrever", async () => {
  mocks.support.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await PATCH(request(), ctx)).status).toBe(403);
  expect(mocks.role).not.toHaveBeenCalled();
  expect(mocks.from).not.toHaveBeenCalled();
});
it("gate manager nega ao atendente", async () => {
  mocks.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await PATCH(request(), ctx)).status).toBe(403);
  expect(mocks.role).toHaveBeenCalledWith("manager", expect.anything());
  expect(mocks.from).not.toHaveBeenCalled();
});
it("cargo maior que 100 caracteres não chega ao banco", async () => {
  expect((await PATCH(request({ job_title: "x".repeat(101) }), ctx)).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
});
it("corpo com campo extra é rejeitado (strict)", async () => {
  expect((await PATCH(request({ job_title: "Técnico", role: "admin" }), ctx)).status).toBe(400);
  expect(mocks.from).not.toHaveBeenCalled();
});
it("membro fora da org não é encontrado nem auditado", async () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  mocks.from.mockReturnValue(chain);
  expect((await PATCH(request(), ctx)).status).toBe(404);
  expect(chain.eq).toHaveBeenCalledWith("organization_id", org);
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("escrita filtra org e membro ativo; emite auditoria; string vazia vira null", async () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    maybeSingle: vi
      .fn()
      .mockResolvedValueOnce({ data: { id: "m-1", role: "agent" }, error: null })
      .mockResolvedValueOnce({
        data: { id: "m-1", user_id: user, job_title: null },
        error: null,
      }),
  };
  mocks.from.mockReturnValue(chain);
  expect((await PATCH(request({ job_title: "" }), ctx)).status).toBe(200);
  expect(chain.update).toHaveBeenCalledWith({ job_title: null });
  expect(chain.eq).toHaveBeenCalledWith("organization_id", org);
  expect(chain.eq).toHaveBeenCalledWith("user_id", user);
  expect(chain.is).toHaveBeenCalledWith("revoked_at", null);
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "team.job_title_changed",
      organizationId: org,
      actorUserId: user,
    }),
  );
});
