"use client";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useStageAccess, useSetStageAccess } from "@/hooks/team/useStageAccess";
import type { TeamMember } from "@/hooks/team/useTeamMembers";

interface Etapa {
  id: string;
  name: string;
  pipeline_id: string;
  position: number;
}

export function MemberStageAccessDialog({
  member,
  etapas,
  onClose,
}: {
  member: TeamMember;
  etapas: Etapa[];
  onClose: () => void;
}) {
  const t = useT();
  const { data, isLoading } = useStageAccess(member.user_id);
  const save = useSetStageAccess(member.user_id);
  const [selecionadas, setSelecionadas] = useState<string[] | null>(null);
  const atuais = selecionadas ?? data?.data.stage_ids ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("Acesso por etapa de")} {member.full_name ?? member.email ?? t("membro")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Marque as etapas do funil que esta pessoa deve enxergar automaticamente no Inbox e no Kanban — sem precisar que ninguém atribua nada a ela. Sem nenhuma marcada, nada muda para ela.",
            )}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
        ) : (
          <div className="space-y-2">
            {etapas.map((e) => (
              <label key={e.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={atuais.includes(e.id)}
                  disabled={save.isPending}
                  onChange={(ev) => {
                    const marcado = ev.target.checked;
                    setSelecionadas(
                      marcado ? [...atuais, e.id] : atuais.filter((id) => id !== e.id),
                    );
                  }}
                />
                {e.name}
              </label>
            ))}
          </div>
        )}
        <Button disabled={isLoading || save.isPending} onClick={() => save.mutate(atuais, { onSuccess: onClose })}>
          {save.isPending ? t("Salvando…") : t("Salvar acesso")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
