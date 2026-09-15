"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

export function useStageAccess(userId: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["team", "stage-access", userId],
    queryFn: async () =>
      apiClient.get<{ data: { stage_ids: string[] } }>(`/api/v1/team/${userId}/stage-access`),
    enabled: opts?.enabled ?? true,
  });
}

export function useSetStageAccess(userId: string) {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (stageIds: string[]) =>
      apiClient.put<{ data: { stage_ids: string[] } }>(`/api/v1/team/${userId}/stage-access`, {
        stage_ids: stageIds,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["team", "stage-access", userId] });
      toast.success(t("Acesso por etapa atualizado."));
    },
    onError: showApiError,
  });
}
