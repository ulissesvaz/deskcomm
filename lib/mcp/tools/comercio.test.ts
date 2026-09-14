import { describe, expect, it } from "vitest";

import { crmCalcInstallment, crmSearchProducts } from "./comercio";
import type { McpContext } from "../types";

/** Só o formato do campo que este arquivo mede — não o contrato inteiro. */
interface RespostaBusca {
  produtos: Array<{ preco: string }>;
}

/**
 * O PREÇO QUE O AGENTE COTA AO CLIENTE — NA CONVENÇÃO DA MOEDA DA LOJA.
 *
 * `precoLegivel()` era uma SEXTA cópia de formatador de dinheiro, não
 * declarada no comentário de `lib/money.ts` que lista as cinco conhecidas — e
 * a mais grave das seis: é o texto que `crm_search_products` devolve ao
 * agente, que é quem fala com o cliente por WhatsApp. A pantalla de Produtos
 * já mostrava `$249.90` para uma loja em MXN; o agente, com `precoLegivel`,
 * continuava dizendo `MXN 249,90` — o mesmo defeito que a migration 0208
 * documenta ter corrigido, sobrevivendo no único canal que fala com o
 * cliente de verdade.
 */

function ctxCom(produtos: Array<Record<string, unknown>>): McpContext {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    range: async () => ({ data: produtos, error: null, count: produtos.length }),
  };
  return {
    organizationId: "22222222-2222-4222-8222-222222222222",
    role: "agent",
    actor: { type: "ai_agent", id: "run-1", agent_id: "agent-1" },
    apiTokenId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: () => query } as any,
  } as McpContext;
}


/** O `Intl` emite NBSP (U+00A0) ou narrow NBSP (U+202F) entre símbolo e número. */
const semNbsp = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");

const PRODUTO_MXN = {
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "IP15",
  nome: "iPhone 15",
  descricao: null,
  marca: null,
  categoria: null,
  preco_cents: 24990,
  moeda: "MXN",
  controla_estoque: false,
  quantidade: 0,
  ativo: true,
};

describe("crm_search_products — preço na convenção da moeda", () => {
  it("cota o preço em MXN como um comerciante mexicano lê, não em pt-BR", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([PRODUTO_MXN]),
    )) as RespostaBusca;

    expect(resultado.produtos).toHaveLength(1);
    // Ponto decimal e cifrão — não `MXN 249,90`, que era o que precoLegivel()
    // devolvia (vírgula decimal brasileira com o código colado na frente).
    expect(resultado.produtos[0]!.preco).toBe("$249.90");
    expect(resultado.produtos[0]!.preco).not.toContain("MXN 249,90");
  });

  it("continua certo em BRL — a troca não pode mudar o que já funcionava", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([{ ...PRODUTO_MXN, moeda: "BRL" }]),
    )) as RespostaBusca;

    expect(semNbsp(resultado.produtos[0]!.preco)).toBe("R$ 249,90");
  });
});

describe("crm_search_products — preço parcelado", () => {
  it("devolve o preço parcelado formatado quando o produto tem um", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([{ ...PRODUTO_MXN, moeda: "GBP", preco_cents: 119900, preco_parcelado_cents: 188100 }]),
    )) as { produtos: Array<{ preco: string; preco_parcelado?: string }> };

    expect(resultado.produtos[0]!.preco).toBe("£1,199.00");
    expect(resultado.produtos[0]!.preco_parcelado).toBe("£1,881.00");
  });

  it("não inclui preco_parcelado quando o produto não tem", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([PRODUTO_MXN]),
    )) as { produtos: Array<{ preco_parcelado?: string }> };

    expect(resultado.produtos[0]!.preco_parcelado).toBeUndefined();
  });
});

/** Mock de uma única linha de catalog_products, buscada por (organization_id, codigo). */
function ctxComProduto(produto: Record<string, unknown> | null): McpContext {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: produto, error: null }),
  };
  return {
    organizationId: "22222222-2222-4222-8222-222222222222",
    role: "agent",
    actor: { type: "ai_agent", id: "run-1", agent_id: "agent-1" },
    apiTokenId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: () => query } as any,
  } as McpContext;
}

describe("crm_calc_installment", () => {
  const PRODUTO_PARCELAVEL = {
    codigo: "IP15",
    preco_parcelado_cents: 188100,
    moeda: "GBP",
  };

  it("calcula a parcela sem entrada, arredondando para cima", async () => {
    const r = (await crmCalcInstallment.handler(
      { codigo: "IP15", semanas: 15, entrada_cents: 0 },
      ctxComProduto(PRODUTO_PARCELAVEL),
    )) as { valor_parcela_cents: number; valor_parcela_formatado: string };

    // 188100 / 15 = 12540.0 exato
    expect(r.valor_parcela_cents).toBe(12540);
    expect(r.valor_parcela_formatado).toBe("£125.40");
  });

  it("arredonda para cima quando a divisão não fecha redondo", async () => {
    const r = (await crmCalcInstallment.handler(
      { codigo: "IP15", semanas: 13, entrada_cents: 0 },
      ctxComProduto(PRODUTO_PARCELAVEL),
    )) as { valor_parcela_cents: number };

    // 188100 / 13 = 14469.23... -> arredonda para 14470
    expect(r.valor_parcela_cents).toBe(14470);
  });

  it("desconta a entrada antes de dividir", async () => {
    const r = (await crmCalcInstallment.handler(
      { codigo: "IP15", semanas: 15, entrada_cents: 10000 },
      ctxComProduto(PRODUTO_PARCELAVEL),
    )) as { valor_parcela_cents: number };

    // (188100 - 10000) / 15 = 11873.33... -> arredonda para 11874
    expect(r.valor_parcela_cents).toBe(11874);
  });

  it("recusa quando o produto não tem preço parcelado", async () => {
    const r = (await crmCalcInstallment.handler(
      { codigo: "SEM-PARC", semanas: 10, entrada_cents: 0 },
      ctxComProduto({ codigo: "SEM-PARC", preco_parcelado_cents: null, moeda: "GBP" }),
    )) as { erro?: string; mensagem?: string };

    expect(r.erro).toBe("sem_parcelamento");
    expect(r.mensagem).toBe(
      "este produto não tem preço parcelado cadastrado — informe que não há opção de " +
        "parcelamento, não invente um valor.",
    );
  });

  /**
   * ⚠️ O CASO DA REVISÃO FINAL. `preco_parcelado_cents: 0` é tratado como "sem
   * parcelamento" em `crm_search_products` e na lista de produtos (os dois com
   * checagem falsy) — mas aqui a checagem era `=== null`, então um produto com
   * `0` caía direto no cálculo e, com a entrada padrão 0, `0 >= 0` disparava
   * "entrada_maior_que_o_total": dizia ao cliente que a entrada (zero) dele era
   * maior que o total (também zero). Este teste prova que os três lugares
   * concordam agora.
   */
  it("recusa como sem_parcelamento quando preco_parcelado_cents é 0, sem tentar dividir", async () => {
    const r = (await crmCalcInstallment.handler(
      { codigo: "ZERO", semanas: 10, entrada_cents: 0 },
      ctxComProduto({ codigo: "ZERO", preco_parcelado_cents: 0, moeda: "GBP" }),
    )) as { erro?: string; mensagem?: string };

    expect(r.erro).toBe("sem_parcelamento");
    expect(r.mensagem).toBeDefined();
  });

  it("recusa quando a entrada é maior ou igual ao total parcelado", async () => {
    const r = (await crmCalcInstallment.handler(
      { codigo: "IP15", semanas: 10, entrada_cents: 188100 },
      ctxComProduto(PRODUTO_PARCELAVEL),
    )) as { erro?: string; mensagem?: string };

    expect(r.erro).toBe("entrada_maior_que_o_total");
    expect(r.mensagem).toBe(
      "a entrada informada é maior ou igual ao valor total parcelado — confirme o valor da " +
        "entrada com o cliente.",
    );
  });

  it("recusa quando o produto não existe nesta organização", async () => {
    const r = (await crmCalcInstallment.handler(
      { codigo: "NAO-EXISTE", semanas: 10, entrada_cents: 0 },
      ctxComProduto(null),
    )) as { erro?: string };

    expect(r.erro).toBe("produto_nao_encontrado");
  });
});
