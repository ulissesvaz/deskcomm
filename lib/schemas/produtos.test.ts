import { describe, expect, it } from "vitest";

import { produtoCreateSchema } from "./produtos";

const BASE = { codigo: "IP15", nome: "iPhone 15", preco_cents: 549900 };

describe("produtoCreateSchema — preço parcelado", () => {
  it("aceita produto sem preço parcelado", () => {
    const r = produtoCreateSchema.safeParse(BASE);
    expect(r.success).toBe(true);
  });

  it("aceita preço parcelado nulo", () => {
    const r = produtoCreateSchema.safeParse({ ...BASE, preco_parcelado_cents: null });
    expect(r.success).toBe(true);
  });

  it("aceita preço parcelado válido", () => {
    const r = produtoCreateSchema.safeParse({ ...BASE, preco_parcelado_cents: 188100 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.preco_parcelado_cents).toBe(188100);
  });

  it("recusa preço parcelado negativo", () => {
    const r = produtoCreateSchema.safeParse({ ...BASE, preco_parcelado_cents: -1 });
    expect(r.success).toBe(false);
  });
});

describe("produtoCreateSchema — moeda por produto", () => {
  it("aceita produto sem moeda (cai no padrão da organização, fora deste schema)", () => {
    const r = produtoCreateSchema.safeParse(BASE);
    expect(r.success).toBe(true);
  });

  it("aceita uma moeda servida", () => {
    const r = produtoCreateSchema.safeParse({ ...BASE, moeda: "GBP" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.moeda).toBe("GBP");
  });

  it("recusa moeda fora da lista servida", () => {
    const r = produtoCreateSchema.safeParse({ ...BASE, moeda: "JPY" });
    expect(r.success).toBe(false);
  });
});
