/**
 * G2-02 — seletor de papel por membro na página de team.
 *
 * Cobre: seleção dispara PATCH /api/v1/team/[user_id]; estado otimista
 * (role muda na UI antes da resposta) com rollback + toast em erro;
 * seletor ausente para não-admin (canManage=false).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/types";
import type { TeamMember } from "@/hooks/team/useTeamMembers";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { apiClient } from "@/lib/api/client";
import { toast } from "sonner";
import { TeamMembersClient } from "./TeamMembersClient";

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function members(): TeamMember[] {
  return [
    {
      user_id: ADMIN_ID,
      role: "admin",
      job_title: null,
      invited_at: null,
      accepted_at: "2026-01-01T00:00:00Z",
      revoked_at: null,
      created_at: "2026-01-01T00:00:00Z",
      email: "admin@example.com",
      full_name: "Admin",
      last_sign_in_at: null,
    },
    {
      user_id: AGENT_ID,
      role: "agent",
      job_title: null,
      invited_at: null,
      accepted_at: "2026-01-02T00:00:00Z",
      revoked_at: null,
      created_at: "2026-01-02T00:00:00Z",
      email: "agente@example.com",
      full_name: "Agente",
      last_sign_in_at: null,
    },
  ];
}

const ETAPAS = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Novo", pipeline_id: "p1", position: 1 },
  { id: "22222222-2222-4222-8222-222222222222", name: "Qualificado", pipeline_id: "p1", position: 2 },
];

function renderClient(
  props: Partial<{
    canManage: boolean;
    canManageStageAccess: boolean;
    etapas: typeof ETAPAS;
  }> = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TeamMembersClient
        currentUserId={ADMIN_ID}
        canManage={props.canManage ?? true}
        canManageStageAccess={props.canManageStageAccess ?? false}
        etapas={props.etapas ?? ETAPAS}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockResolvedValue({ data: members() });
});

describe("TeamMembersClient — seletor de papel (G2-02)", () => {
  it("não-admin não vê seletor de papel (só badge)", async () => {
    const rows = members();
    rows[1]!.interface_settings = { preset: "completa", destinos: ["/app/tasks"] };
    vi.mocked(apiClient.get).mockResolvedValue({ data: rows });
    renderClient({ canManage: false });
    expect(await screen.findByText("agente@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("agent")).toBeInTheDocument();
    expect(screen.getByText("Personalizada")).toBeInTheDocument();
  });

  it("admin seleciona novo papel → PATCH /api/v1/team/[user_id] com estado otimista", async () => {
    let resolvePatch!: (v: unknown) => void;
    vi.mocked(apiClient.patch).mockImplementation(
      () => new Promise((resolve) => (resolvePatch = resolve)),
    );

    const user = userEvent.setup();
    renderClient();

    const trigger = await screen.findByRole("combobox", { name: /Papel de Agente/i });
    expect(trigger).toHaveTextContent("agent");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "manager" }));

    // Otimista: UI já mostra o novo papel ANTES da resposta do PATCH.
    await waitFor(() => expect(trigger).toHaveTextContent("manager"));
    expect(apiClient.patch).toHaveBeenCalledWith(`/api/v1/team/${AGENT_ID}`, {
      role: "manager",
    });

    resolvePatch({ data: { user_id: AGENT_ID, role: "manager" } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Papel atualizado."));
  });

  it("erro no PATCH → rollback do papel e toast de erro", async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(
      new ApiError(
        409,
        "state_conflict",
        undefined,
        "req-1",
        "Não é possível rebaixar o último admin do tenant.",
      ),
    );

    const user = userEvent.setup();
    renderClient();

    const trigger = await screen.findByRole("combobox", { name: /Papel de Agente/i });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "viewer" }));

    // Rollback: volta ao papel original após o erro.
    await waitFor(() => expect(trigger).toHaveTextContent("agent"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("TeamMembersClient — acesso por etapa (Task 4)", () => {
  it("botão 'Acesso por etapa' não aparece quando canManageStageAccess=false", async () => {
    renderClient({ canManageStageAccess: false });
    expect(await screen.findByText("agente@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Acesso por etapa/i })).not.toBeInTheDocument();
  });

  it("gerente abre o diálogo, marca uma etapa e salva via PUT /api/v1/team/[user_id]/stage-access", async () => {
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
      if (path.endsWith("/stage-access")) return { data: { stage_ids: [] } };
      return { data: members() };
    });
    vi.mocked(apiClient.put).mockResolvedValue({
      data: { stage_ids: [ETAPAS[0]!.id] },
    });

    const user = userEvent.setup();
    renderClient({ canManageStageAccess: true });

    const botoes = await screen.findAllByRole("button", { name: /Acesso por etapa de Agente/i });
    await user.click(botoes[0]!);

    expect(await screen.findByText("Novo")).toBeInTheDocument();
    const checkbox = screen.getByRole("checkbox", { name: "Novo" });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Salvar acesso" }));

    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith(`/api/v1/team/${AGENT_ID}/stage-access`, {
        stage_ids: [ETAPAS[0]!.id],
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Acesso por etapa atualizado."),
    );
  });
});
