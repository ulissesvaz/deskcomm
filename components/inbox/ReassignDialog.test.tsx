/**
 * G3-01 — seletor de destino no modal "Transferir conversa" mostra o CARGO
 * (job_title) de cada membro, não o papel de permissão (role).
 *
 * Bug real: o modal usava `ROLE_LABEL[m.role]` (Atendente/Gestor/Admin) como
 * legenda, ignorando `job_title` — o mesmo campo que o resto do produto
 * (Kanban, Inbox, Equipe, Perfil) já exibe. Quem definia um cargo ("Consultora
 * Executiva") nunca via esse rótulo aqui, só "Atendente". Sem cargo definido,
 * cai no papel como fallback (nunca fica em branco).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const CURRENT_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LUZIA_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SEM_CARGO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: CURRENT_USER_ID } }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({
      data: [
        {
          user_id: LUZIA_ID,
          role: "agent",
          full_name: "Luzia Vaz",
          job_title: "Consultora Executiva",
        },
        {
          user_id: SEM_CARGO_ID,
          role: "agent",
          full_name: "Sem Cargo",
          job_title: null,
        },
      ],
    })),
    post: vi.fn(),
  },
}));

import { ReassignDialog } from "./ReassignDialog";

function renderDialog() {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <ReassignDialog conversationId="conv-1" open={true} onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("ReassignDialog — legenda do seletor de destino", () => {
  it("mostra o cargo (job_title) em vez do papel quando o membro tem cargo definido", async () => {
    renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("combobox", { name: /transferir para/i }));

    const opcaoLuzia = await screen.findByRole("option", { name: /Luzia Vaz/ });
    expect(within(opcaoLuzia).getByText(/Consultora Executiva/)).toBeInTheDocument();
    expect(within(opcaoLuzia).queryByText(/Atendente/)).not.toBeInTheDocument();
  });

  it("recai no papel de permissão quando o membro não tem cargo definido", async () => {
    renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("combobox", { name: /transferir para/i }));

    const opcaoSemCargo = await screen.findByRole("option", { name: /Sem Cargo/ });
    expect(within(opcaoSemCargo).getByText(/Atendente/)).toBeInTheDocument();
  });
});
