"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { TeamMember } from "@/hooks/team/useTeamMembers";

/**
 * Cargo (rótulo visual, texto livre) de um membro — NÃO é `role`: não muda
 * permissão nem o que a pessoa vê, só identificação (ex.: "Técnico",
 * "Consultora de Vendas"). Mesmo padrão de `MemberInterfaceDialog`.
 */
export function MemberJobTitleDialog({
  member,
  onClose,
}: {
  member: TeamMember;
  onClose: () => void;
}) {
  const t = useT();
  const [jobTitle, setJobTitle] = useState(member.job_title ?? "");
  const qc = useQueryClient();
  const router = useRouter();
  const save = useMutation({
    mutationFn: () =>
      apiClient.patch(`/api/v1/team/${member.user_id}/job-title`, { job_title: jobTitle }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["team"] });
      router.refresh();
      toast.success(t("Cargo atualizado."));
      onClose();
    },
    onError: showApiError,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("Cargo de")} {member.full_name ?? member.email ?? t("membro")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Só identificação visual — aparece do lado do nome na Equipe, no Perfil, no Inbox e no Kanban. Não muda permissão nem o que esta pessoa vê.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="job_title">{t("Cargo")}</Label>
          <Input
            id="job_title"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            maxLength={100}
            placeholder={t("Ex.: Técnico, Consultora de Vendas…")}
            disabled={save.isPending}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            {t("Cancelar")}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t("Salvando…") : t("Salvar cargo")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
