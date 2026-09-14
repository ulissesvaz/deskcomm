import type { SupabaseClient } from "@supabase/supabase-js";

import { MOEDA_PADRAO } from "@/lib/money";

/**
 * A moeda que a organização declarou — a fonte de `catalog_products.moeda`.
 *
 * ─── Por que uma função, e não `select` inline nas rotas ───────────────────
 *
 * São DOIS caminhos de escrita no catálogo, e eles precisam responder igual: o
 * cadastro de um produto (`POST /api/v1/products`) e o import por planilha,
 * que grava em lote. Duas leituras inline divergem no dia em que uma ganhar
 * fallback e a outra não — e a divergência apareceria como um catálogo com
 * duas moedas dentro da mesma organização, que é justamente o que a coluna
 * existe para impedir.
 *
 * ─── Por que o fallback é 'BRL', e não um erro ─────────────────────────────
 *
 * Se a linha da organização não vier (RLS negando, linha removida no meio da
 * requisição), 'BRL' é o MESMO valor que o `default` da coluna gravaria se
 * ninguém mandasse nada — ou seja, o comportamento de antes desta feature.
 * Derrubar o cadastro do produto porque a leitura de um campo de configuração
 * falhou seria trocar um rótulo errado por um formulário que não salva.
 *
 * ⚠️ O papel desta função é agora ser o **fallback** quando nenhuma moeda por
 * produto foi escolhida. A rota `POST /api/v1/products` aceitava moeda do corpo
 * (Task 3: Zod passou a declarar o campo; Task 4: rota a respeita se enviada
 * por manager, senão chama esta função). Segurança garantida pelo gate
 * `requireRole("manager")` e pelo enum fechado do Zod, a mesma razão que
 * torna seguro o `organization_id` vir de fonte confiável (CLAUDE.md
 * multi-tenancy). A função em si continua sendo apenas fallback, nunca
 * aceitando entrada diretamente do cliente — a validação mora na rota.
 */
export async function moedaDaOrganizacao(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("organizations")
    .select("currency")
    .eq("id", orgId)
    .maybeSingle();

  const declarada = (data as { currency?: string | null } | null)?.currency;
  if (declarada) return declarada;

  // Cai no padrão sem derrubar o cadastro (doutrina acima), mas o silêncio
  // tem que deixar RASTRO: sem isto, uma organização em MXN com a leitura
  // falhando grava cada produto novo em BRL sem que ninguém perceba até o
  // cliente reclamar do preço errado — o mesmo defeito que esta feature existe
  // para consertar, só que calado em vez de gritado.
  const motivo = error?.message ?? "linha da organização não veio (RLS ou removida)";
  console.error("[moeda-da-org] caiu no padrão", { orgId, motivo });
  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.captureMessage(`[moeda-da-org] caiu no padrão: ${motivo}`, {
        level: "warning",
        tags: { subsystem: "catalogo" },
        extra: { organization_id: orgId },
      });
    })
    .catch(() => {
      /* sem Sentry configurado: o console.error acima é o que resta */
    });

  return MOEDA_PADRAO;
}
