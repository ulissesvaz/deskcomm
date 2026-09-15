import { z } from "zod";

/** O PUT substitui o conjunto INTEIRO de etapas concedidas — mais simples de UI
 * do que add/remove individual, e o volume por pessoa é sempre pequeno. */
export const stageAccessSetSchema = z
  .object({
    stage_ids: z.array(z.string().uuid()).max(50),
  })
  .strict();
export type StageAccessSet = z.infer<typeof stageAccessSetSchema>;
