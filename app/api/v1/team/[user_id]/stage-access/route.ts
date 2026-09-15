import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { stageAccessSetSchema } from "@/lib/schemas/stage-access";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

async function membroAtivo(
  db: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  userId: string,
) {
  const { data, error } = await db
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user_id } = await ctx.params;
  if (!z.string().uuid().safeParse(user_id).success) {
    return fail("validation_failed", t("Membro inválido."), 400, { requestId });
  }

  const db = await createClient();
  let ativo: boolean;
  try {
    ativo = await membroAtivo(db, authz.org.orgId, user_id);
  } catch {
    return fail("internal_error", t("Erro ao ler o membro."), 500, { requestId });
  }
  if (!ativo) return fail("not_found", t("Membro ativo não encontrado."), 404, { requestId });

  const { data, error } = await db
    .from("user_stage_access")
    .select("stage_id")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", user_id);
  if (error) return fail("internal_error", t("Erro ao listar o acesso."), 500, { requestId });

  return ok({ stage_ids: (data ?? []).map((r) => (r as { stage_id: string }).stage_id) }, { requestId });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user_id } = await ctx.params;
  if (!z.string().uuid().safeParse(user_id).success) {
    return fail("validation_failed", t("Membro inválido."), 400, { requestId });
  }

  const parsed = stageAccessSetSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const db = await createClient();
  let ativo: boolean;
  try {
    ativo = await membroAtivo(db, authz.org.orgId, user_id);
  } catch {
    return fail("internal_error", t("Erro ao ler o membro."), 500, { requestId });
  }
  if (!ativo) return fail("not_found", t("Membro ativo não encontrado."), 404, { requestId });

  // Cada stage_id precisa pertencer a um pipeline DESTA organização — nunca
  // aceitar de outra org, mesmo que o uuid exista no banco (multi-tenancy:
  // organization_id nunca vem do body, o servidor confere na fonte).
  if (parsed.data.stage_ids.length > 0) {
    const { data: validas, error: stageErr } = await db
      .from("crm_stages")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .in("id", parsed.data.stage_ids);
    if (stageErr) return fail("internal_error", t("Erro ao validar etapas."), 500, { requestId });
    const validasSet = new Set((validas ?? []).map((s) => (s as { id: string }).id));
    const invalida = parsed.data.stage_ids.find((id) => !validasSet.has(id));
    if (invalida) {
      return fail("validation_failed", t("Etapa não pertence a esta organização."), 422, {
        requestId,
        details: { stage_id: invalida },
      });
    }
  }

  const { error: delErr } = await db
    .from("user_stage_access")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", user_id);
  if (delErr) return fail("internal_error", t("Erro ao atualizar o acesso."), 500, { requestId });

  if (parsed.data.stage_ids.length > 0) {
    const { error: insErr } = await db.from("user_stage_access").insert(
      parsed.data.stage_ids.map((stage_id) => ({
        organization_id: authz.org.orgId,
        user_id,
        stage_id,
        granted_by: authz.user.id,
      })),
    );
    if (insErr) return fail("internal_error", t("Erro ao salvar o acesso."), 500, { requestId });
  }

  await audit({
    action: "team.stage_access_updated",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "membership",
    resourceId: user_id,
    requestId,
    metadata: { user_id, stage_ids: parsed.data.stage_ids },
  });

  return ok({ stage_ids: parsed.data.stage_ids }, { requestId });
}
