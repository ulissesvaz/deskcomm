import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { jobTitleSchema } from "@/lib/schemas/team";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";

/**
 * PATCH /api/v1/team/[user_id]/job-title — cargo (rótulo visual, texto
 * livre) de um membro. NÃO é `role`: não muda permissão nem o que a pessoa vê,
 * só identificação (ex.: "Técnico", "Consultora de Vendas"). Manager+, mesma
 * régua de `team.role_changed` — mais permissivo que a interface (`admin`)
 * porque não há superfície de risco nenhuma num campo de texto decorativo.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ user_id: string }> }) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user_id } = await ctx.params;
  const parsed = jobTitleSchema.strict().safeParse(await req.json().catch(() => null));
  if (!z.string().uuid().safeParse(user_id).success || !parsed.success)
    return fail("validation_error", "Confira o cargo informado.", 400, { requestId });
  const db = await createClient();
  const { data: member, error: readError } = await db
    .from("user_organizations")
    .select("id, role")
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", user_id)
    .is("revoked_at", null)
    .not("accepted_at", "is", null)
    .maybeSingle();
  if (readError) return fail("internal_error", "Não foi possível ler o membro.", 500, { requestId });
  if (!member) return fail("not_found", "Membro ativo não encontrado.", 404, { requestId });
  const { data, error } = await db
    .from("user_organizations")
    .update({ job_title: parsed.data.job_title })
    .eq("organization_id", authz.org.orgId)
    .eq("user_id", user_id)
    .is("revoked_at", null)
    .not("accepted_at", "is", null)
    .select("id, user_id, job_title")
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível salvar o cargo.", 500, { requestId });
  if (!data)
    return fail("conflict", "O vínculo mudou. Atualize e tente novamente.", 409, { requestId });
  void audit({
    action: "team.job_title_changed",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "membership",
    resourceId: data.id,
    requestId,
    metadata: { user_id, job_title: parsed.data.job_title },
  });
  return ok(data, { requestId });
}
