# Catálogo — Preço parcelado e moeda por produto — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cada produto do catálogo ganha um preço parcelado (total negociável) e sua própria moeda, e o agente de IA passa a calcular o valor da parcela por uma ferramenta determinística, sem inventar contas.

**Architecture:** uma coluna nova (`preco_parcelado_cents`) numa tabela que já existe; destrava a coluna `moeda` (já existente) para ser escolhida no cadastro, gerada só por quem já tem papel `manager` nesta rota; e uma ferramenta MCP nova (`crm_calc_installment`) que faz a divisão em código, nunca no modelo.

**Tech Stack:** Next.js 16 App Router · Zod · Supabase/Postgres (RLS) · Vitest · MCP server interno (`lib/mcp`).

**Spec:** `.specs/features/catalogo-parcelamento-e-moeda/spec.md` (o quê) e `.specs/features/catalogo-parcelamento-e-moeda/design.md` (como) — leia os dois antes de começar.

## Global Constraints

- `organization_id` vem **sempre** de fonte confiável (`authz.org.orgId` / `ctx.organizationId`), nunca do corpo da requisição — regra dura de multi-tenancy, `CLAUDE.md`.
- `moeda` no corpo do `POST /api/v1/products` só é aceita porque a rota já exige `requireRole("manager")` **e** o valor é validado contra o enum fechado `MOEDAS_SERVIDAS` — nunca texto livre. Ausente no corpo → cai no padrão da organização (`moedaDaOrganizacao`), comportamento inalterado.
- Preço à vista (`preco_cents`) **nunca** é dividido por ninguém, em nenhuma camada. Só `preco_parcelado_cents` entra em conta de parcelamento.
- Todo texto novo de UI/erro é em português, no mesmo tom direto do resto do arquivo (sem jargão técnico para quem opera a loja).
- `pnpm typecheck`, `pnpm lint` e `pnpm test:unit` zerados antes de cada commit que a task pedir.
- Schema sai em tripla: migration versionada + apêndice idempotente em `supabase/baseline.sql` + linha em `supabase/migrations/MANIFEST.md` (`CLAUDE.md`).

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `lib/money.ts` **(modificar)** | `MOEDAS_SERVIDAS` ganha `GBP` e `EUR` |
| `lib/money.test.ts` **(modificar)** | cobre as duas moedas novas |
| `supabase/migrations/<timestamp>_0233_catalog_preco_parcelado.sql` **(criar)** | coluna nova |
| `supabase/baseline.sql` **(modificar)** | apêndice idempotente da 0233 |
| `supabase/migrations/MANIFEST.md` **(modificar)** | linha da 0233 |
| `lib/schemas/produtos.ts` **(modificar)** | `preco_parcelado_cents` + `moeda` no schema; `COLUNAS_DO_PRODUTO` |
| `lib/schemas/produtos.test.ts` **(criar)** | valida os dois campos novos |
| `app/api/v1/products/route.ts` **(modificar)** | usa `moeda` do corpo quando vier, senão cai no padrão |
| `app/api/v1/products/route.test.ts` **(modificar)** | substitui o teste "ignora a moeda" pelo novo contrato |
| `lib/catalogo/planilha.ts` **(modificar)** | alias de coluna `preco_parcelado` |
| `lib/catalogo/planilha.test.ts` **(modificar)** | cobre a coluna nova e a ausência dela (regressão) |
| `app/app/products/page.tsx` **(modificar)** | passa a moeda da organização como prop |
| `app/app/products/_client.tsx` **(modificar)** | campo "Preço parcelado" + seletor de moeda + lista mostra os dois preços |
| `lib/mcp/tools/comercio.ts` **(modificar)** | `crm_search_products` devolve `preco_parcelado`; nova tool `crmCalcInstallment` |
| `lib/mcp/tools/comercio.test.ts` **(modificar)** | cobre os dois preços e a ferramenta nova |
| `lib/mcp/tools/index.ts` **(modificar)** | registra `crmCalcInstallment` |

---

## Task Breakdown

### Task 1: Moedas novas (`GBP`, `EUR`)

**Files:**
- Modify: `lib/money.ts:223`
- Test: `lib/money.test.ts`

**Interfaces:**
- Produces: `MOEDAS_SERVIDAS` agora inclui `"GBP"` e `"EUR"` — todo o resto do plano depende disto (schema, seletor da tela, `formatCents`).

- [ ] **Step 1: Escrever o teste que falha**

Adicione ao fim de `lib/money.test.ts` (dentro do `describe("formatCents", ...)` já existente, como dois `it()` novos):

```ts
  it("formata Libra Esterlina (GBP)", () => {
    expect(formatCents(19900, "GBP")).toBe("£199.00");
  });

  it("formata Euro (EUR)", () => {
    expect(formatCents(19900, "EUR")).toBe("€199.00");
  });
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm exec vitest run lib/money.test.ts`
Expected: os dois testes novos FALHAM (a função lança porque `GBP`/`EUR` não são aceitos em nenhum outro lugar que dependa da lista — na verdade `formatCents` já é agnóstica e passaria; o que precisa falhar aqui é o próximo teste do seletor, feito no Task 6. Se os dois passarem já neste passo, siga em frente sem bloquear: `formatCents` nunca dependeu de `MOEDAS_SERVIDAS`, só o seletor e o schema dependem — é esperado que este teste específico já nasça verde).

- [ ] **Step 3: Atualizar `MOEDAS_SERVIDAS`**

Em `lib/money.ts`, troque:

```ts
export const MOEDAS_SERVIDAS = ["BRL", "MXN", "USD"] as const;
```

por:

```ts
export const MOEDAS_SERVIDAS = ["BRL", "MXN", "USD", "GBP", "EUR"] as const;
```

E, no comentário logo acima que diz `"As três têm subunidade de 2 casas..."`, troque `"As três"` por `"As cinco"` (seguem span de 2 casas decimais — GBP e EUR também usam centavos).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm exec vitest run lib/money.test.ts`
Expected: PASS (todos os testes do arquivo, incluindo os 2 novos).

- [ ] **Step 5: Commit**

```bash
git add lib/money.ts lib/money.test.ts
git commit -m "feat(catalogo): adiciona Libra e Euro às moedas servidas"
```

---

### Task 2: Migration — `preco_parcelado_cents`

**Files:**
- Create: `supabase/migrations/<timestamp>_0233_catalog_preco_parcelado.sql` (use `date -u +%Y%m%d%H%M%S` para o `<timestamp>`, seguindo `20260909180000_0232_...`)
- Modify: `supabase/baseline.sql` (apêndice no fim do arquivo)
- Modify: `supabase/migrations/MANIFEST.md` (nova linha)

**Interfaces:**
- Produces: coluna `public.catalog_products.preco_parcelado_cents integer null`, com `check` de não-negativo. Tasks 3+ dependem desta coluna existir no banco de teste (`pnpm test:db`).

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- 0233 — preço parcelado por produto (catálogo).
--
-- Coluna opcional: produto sem preço parcelado continua só com preço à vista.
-- Sem backfill (nula para toda linha existente) e sem default — não muda o
-- comportamento de quem já tem o catálogo cheio.
alter table public.catalog_products
  add column if not exists preco_parcelado_cents integer;

alter table public.catalog_products
  add constraint if not exists catalog_products_preco_parcelado_nao_negativo
  check (preco_parcelado_cents is null or preco_parcelado_cents >= 0);
```

Salve como `supabase/migrations/<timestamp>_0233_catalog_preco_parcelado.sql`.

- [ ] **Step 2: Rodar o teste de banco para confirmar que aplica limpo**

Run: `pnpm test:db`
Expected: passa a fase INSTALL e UPDATE do `baseline.sql` (a migration em si só roda em ambiente com migrations encadeadas — o que este projeto testa de verdade é o baseline, no próximo passo).

- [ ] **Step 3: Apensar o mesmo SQL, idempotente, ao final de `supabase/baseline.sql`**

Abra `supabase/baseline.sql`, vá ao fim do arquivo, e adicione:

```sql

-- 0233 — preço parcelado por produto (catálogo). Ver migrations/0233 para o
-- raciocínio completo; aqui é o mesmo SQL, idempotente, aplicado no self-host.
alter table public.catalog_products
  add column if not exists preco_parcelado_cents integer;

alter table public.catalog_products
  add constraint if not exists catalog_products_preco_parcelado_nao_negativo
  check (preco_parcelado_cents is null or preco_parcelado_cents >= 0);
```

- [ ] **Step 4: Adicionar a linha no MANIFEST**

Em `supabase/migrations/MANIFEST.md`, após a linha da `0232`, adicione (troque `<timestamp>` pelo mesmo valor do Step 1):

```markdown
| `<timestamp>` | `0233_catalog_preco_parcelado` | Preço parcelado (total negociável) por produto no catálogo — coluna opcional, sem backfill; base para o agente calcular parcela sem dividir o preço à vista. |
```

- [ ] **Step 5: Rodar `pnpm test:db` de novo (agora com baseline atualizado)**

Run: `pnpm test:db`
Expected: PASS nas duas passadas (install e update) — `ON_ERROR_STOP=1`, a segunda passada prova que o `add column if not exists` / `add constraint if not exists` é idempotente.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/*_0233_catalog_preco_parcelado.sql supabase/baseline.sql supabase/migrations/MANIFEST.md
git commit -m "feat(catalogo): coluna preco_parcelado_cents em catalog_products"
```

---

### Task 3: Schema Zod — `preco_parcelado_cents` e `moeda`

**Files:**
- Modify: `lib/schemas/produtos.ts`
- Create: `lib/schemas/produtos.test.ts`

**Interfaces:**
- Consumes: `MOEDAS_SERVIDAS` de `lib/money.ts` (Task 1).
- Produces: `produtoCreateSchema` (e `produtoPatchSchema`, que é `.partial()` dele) aceitam `preco_parcelado_cents?: number | null` e `moeda?: "BRL"|"MXN"|"USD"|"GBP"|"EUR"`. `COLUNAS_DO_PRODUTO` inclui `preco_parcelado_cents`. Tasks 4, 6, 7 e 8 consomem estes dois campos.

- [ ] **Step 1: Escrever o teste que falha**

Crie `lib/schemas/produtos.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm exec vitest run lib/schemas/produtos.test.ts`
Expected: FAIL nos testes de `preco_parcelado_cents` e `moeda` — `Unrecognized key(s)` ou o campo simplesmente não existe no tipo (Zod por padrão ignora chave desconhecida em `.safeParse` de `z.object` sem `.strict()`, então o teste que precisa falhar de verdade é o de valor **inválido**: `preco_parcelado_cents: -1` e `moeda: "JPY"` devem passar hoje, porque não há validação nenhuma — confirme que esses dois `success` vêm `true` antes do Step 3, o que prova a ausência da regra).

- [ ] **Step 3: Implementar**

Em `lib/schemas/produtos.ts`, adicione o import no topo:

```ts
import { MOEDAS_SERVIDAS } from "@/lib/money";
```

Substitua o bloco do campo `custo_cents` em diante, e o comentário sobre `moeda` acima de `export const produtoCreateSchema`, por:

```ts
export const produtoCreateSchema = z.object({
  codigo,
  nome,
  descricao: z.string().trim().max(2000).optional(),
  marca: z.string().trim().max(80).optional(),
  categoria: z.string().trim().max(80).optional(),
  preco_cents: z.number().int().min(0, "preço não pode ser negativo"),
  // Preço TOTAL parcelável — nunca o preço à vista dividido. Ausente/null =
  // produto sem opção de parcelamento; o agente (crm_calc_installment) recusa
  // calcular parcela para quem não tem este campo, em vez de inventar.
  preco_parcelado_cents: z.number().int().min(0, "preço parcelado não pode ser negativo").nullable().optional(),
  // ⚠️ MOEDA: aceita do corpo, mas só chega até aqui depois de
  // requireRole("manager") na rota (app/api/v1/products/route.ts) — e só entre
  // as que o sistema SERVE (`MOEDAS_SERVIDAS`), nunca texto livre. Ausente =
  // a rota resolve pela organização (moedaDaOrganizacao()), comportamento de
  // sempre. Isto substitui a regra anterior ("moeda nunca vem do corpo"):
  // aquela existia porque nenhuma tela oferecia o campo, e a única forma de
  // um produto fugir da moeda da organização era chamar a API por fora. Agora
  // há uma tela (Configurações → Produtos) que oferece a escolha por produto
  // de propósito — cada produto pode nascer na moeda em que é vendido.
  moeda: z.enum(MOEDAS_SERVIDAS).optional(),
  custo_cents: z.number().int().min(0).nullable().optional(),
  controla_estoque: z.boolean().default(true),
  quantidade: z.number().int().min(0).default(0),
  ativo: z.boolean().default(true),
  imagem_url: z.string().trim().url().max(2000).optional(),
});
```

Depois, atualize `COLUNAS_DO_PRODUTO`:

```ts
export const COLUNAS_DO_PRODUTO =
  "id, codigo, nome, descricao, marca, categoria, preco_cents, preco_parcelado_cents, moeda, custo_cents, " +
  "controla_estoque, quantidade, ativo, origem, imagem_url, updated_at";
```

E no `interface Produto`, adicione o campo:

```ts
export interface Produto {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  marca: string | null;
  categoria: string | null;
  preco_cents: number;
  preco_parcelado_cents: number | null;
  moeda: string;
  custo_cents: number | null;
  controla_estoque: boolean;
  quantidade: number;
  ativo: boolean;
  origem: string;
  imagem_url: string | null;
  updated_at: string;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm exec vitest run lib/schemas/produtos.test.ts`
Expected: PASS em todos os 6 testes.

- [ ] **Step 5: Rodar typecheck (o `interface Produto` mudou, e é consumido por `_client.tsx`/MCP)**

Run: `pnpm typecheck`
Expected: sem erro novo neste passo (os consumidores só recebem o campo a mais como `undefined`/normal opcional; se algo quebrar, é sinal de um lugar com `Omit<Produto, ...>` estrito que precisa incluir o campo — resolva antes de prosseguir).

- [ ] **Step 6: Commit**

```bash
git add lib/schemas/produtos.ts lib/schemas/produtos.test.ts
git commit -m "feat(catalogo): schema aceita preco_parcelado_cents e moeda por produto"
```

---

### Task 4: Rota `POST /api/v1/products` — moeda do corpo

**Files:**
- Modify: `app/api/v1/products/route.ts`
- Modify: `app/api/v1/products/route.test.ts`

**Interfaces:**
- Consumes: `parsed.data.moeda` (Task 3), `moedaDaOrganizacao()` (já existe, inalterada).
- Produces: linha inserida em `catalog_products` com `moeda` = a enviada, quando presente, senão a da organização.

- [ ] **Step 1: Atualizar o teste que hoje prova o comportamento antigo**

Em `app/api/v1/products/route.test.ts`, substitua o `describe("POST /api/v1/products — a moeda vem da organização", ...)` inteiro por:

```ts
describe("POST /api/v1/products — moeda do produto", () => {
  /**
   * A rota exige requireRole("manager") ANTES de ler o corpo (ver o mock de
   * requireRole no beforeEach) — é essa gate, mais o enum fechado do Zod
   * (MOEDAS_SERVIDAS), que torna seguro aceitar moeda do corpo agora. Sem
   * manager mockado como `ok:false`, este teste nem chegaria ao insert.
   */
  it("usa a moeda enviada no corpo quando presente", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL") as never);
    const { POST } = await import("./route");

    const resposta = await POST(pedido({ ...PRODUTO, moeda: "GBP" }));

    expect(resposta.status).toBe(201);
    expect(inserido).toMatchObject({ moeda: "GBP" });
    expect(orgIdLido).toBe(ORG_ID);
  });

  it("cai na moeda da organização quando o corpo não manda nenhuma", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("MXN") as never);
    const { POST } = await import("./route");

    const resposta = await POST(pedido(PRODUTO));

    expect(resposta.status).toBe(201);
    expect(inserido).toMatchObject({ moeda: "MXN" });
    expect(orgIdLido).toBe(ORG_ID);
  });
});
```

Mantenha os demais `describe`/`it` do arquivo (o de leitura da organização ao falhar, etc.) intocados.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm exec vitest run app/api/v1/products/route.test.ts`
Expected: FAIL em "usa a moeda enviada no corpo quando presente" — hoje `inserido.moeda` é sempre `"BRL"` (a moeda da organização), porque a rota ignora o corpo.

- [ ] **Step 3: Implementar**

Em `app/api/v1/products/route.ts`, troque:

```ts
  const supabase = await createClient();
  // A moeda vem da organização, nunca do corpo — ver `moedaDaOrganizacao()`.
  const moeda = await moedaDaOrganizacao(supabase, authz.org.orgId);
  const { data, error } = await supabase
    .from("catalog_products")
    .insert({ ...parsed.data, moeda, organization_id: authz.org.orgId, origem: "manual" })
    .select(COLUNAS_DO_PRODUTO)
    .single();
```

por:

```ts
  const supabase = await createClient();
  // A moeda vem do corpo QUANDO presente — só chega até aqui depois de
  // requireRole("manager") acima e do enum fechado do Zod (MOEDAS_SERVIDAS).
  // Ausente no corpo = cai no padrão da organização, como sempre.
  const { moeda: moedaEnviada, ...produto } = parsed.data;
  const moeda = moedaEnviada ?? (await moedaDaOrganizacao(supabase, authz.org.orgId));
  const { data, error } = await supabase
    .from("catalog_products")
    .insert({ ...produto, moeda, organization_id: authz.org.orgId, origem: "manual" })
    .select(COLUNAS_DO_PRODUTO)
    .single();
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm exec vitest run app/api/v1/products/route.test.ts`
Expected: PASS em todos os testes do arquivo (os dois novos e os que já existiam).

- [ ] **Step 5: Commit**

```bash
git add app/api/v1/products/route.ts app/api/v1/products/route.test.ts
git commit -m "feat(catalogo): POST /products aceita moeda do corpo (manager-gated)"
```

---

### Task 5: Planilha — coluna "preço parcelado"

**Files:**
- Modify: `lib/catalogo/planilha.ts`
- Modify: `lib/catalogo/planilha.test.ts`

**Interfaces:**
- Consumes: `precoParaCentavos` (já existe, inalterada).
- Produces: `lerPlanilha(...)` grava `preco_parcelado_cents` quando a planilha tem a coluna; ausência da coluna não quebra nada (mesmo padrão de `custo`).

- [ ] **Step 1: Escrever o teste que falha**

Adicione a `lib/catalogo/planilha.test.ts`:

```ts
describe("lerPlanilha — preço parcelado (coluna opcional)", () => {
  it("lê a coluna 'preço parcelado' quando presente", () => {
    const csv = "codigo,nome,preco,preço parcelado\nIP15,iPhone 15,1199.00,1881.00\n";
    const r = lerPlanilha(csv);
    expect("erro" in r).toBe(false);
    if ("erro" in r) return;
    expect(r.produtos[0]!.preco_parcelado_cents).toBe(188100);
  });

  it("planilha sem a coluna continua funcionando (sem parcelamento)", () => {
    const csv = "codigo,nome,preco\nIP15,iPhone 15,1199.00\n";
    const r = lerPlanilha(csv);
    expect("erro" in r).toBe(false);
    if ("erro" in r) return;
    expect(r.produtos[0]!.preco_parcelado_cents).toBeNull();
  });
});
```

Confira no topo do arquivo se `lerPlanilha` já está importado (deve estar, os demais testes do arquivo já o usam) e se o `describe` acima entra depois dos que já existem.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm exec vitest run lib/catalogo/planilha.test.ts`
Expected: FAIL no primeiro teste novo — `r.produtos[0].preco_parcelado_cents` vem `undefined` (a coluna não é reconhecida) em vez de `188100`. O segundo teste já passa hoje (mas escreva os dois: ele é a regressão que prova que a coluna opcional não quebra a ausência).

- [ ] **Step 3: Implementar**

Em `lib/catalogo/planilha.ts`, no dicionário `ALIASES` (perto da linha 27-28), adicione a chave nova:

```ts
  preco: ["preco", "preço", "valor", "preco de venda", "preço de venda", "venda"],
  preco_parcelado: ["preco parcelado", "preço parcelado", "parcelado", "valor parcelado"],
  custo: ["custo", "preco de custo", "preço de custo", "compra"],
```

Depois, onde o `custo_cents` é lido (perto da linha 148), adicione ao lado:

```ts
    const custo_cents = custoTexto === "" ? null : precoParaCentavos(custoTexto);
    const parceladoTexto = valor("preco_parcelado").trim();
    const preco_parcelado_cents = parceladoTexto === "" ? null : precoParaCentavos(parceladoTexto);
```

E no objeto retornado por produto (perto da linha 181, onde `preco_cents` já entra), adicione a chave:

```ts
      preco_cents,
      preco_parcelado_cents,
```

⚠️ Não trate `preco_parcelado_cents === null` vindo de texto **inválido** (não vazio) como erro fatal da linha — siga o mesmo padrão do `custo_cents`: se o texto não é reconhecido, é um erro de linha (`erros.push(...)`), não silêncio. Confira como o bloco de `custo_cents` já sinaliza erro (linha ~148-ish, procure por `_t("custo não reconhecido")`) e replique a mesma estrutura para `preco_parcelado`, com a mensagem `_t("preço parcelado não reconhecido (") + ...`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm exec vitest run lib/catalogo/planilha.test.ts`
Expected: PASS em todos os testes do arquivo.

- [ ] **Step 5: Commit**

```bash
git add lib/catalogo/planilha.ts lib/catalogo/planilha.test.ts
git commit -m "feat(catalogo): importação por planilha reconhece preço parcelado"
```

---

### Task 6: Tela de cadastro — preço parcelado e moeda

**Files:**
- Modify: `app/app/products/page.tsx`
- Modify: `app/app/products/_client.tsx`

**Interfaces:**
- Consumes: `moedaDaOrganizacao()` (`lib/catalogo/moeda-da-org.ts`, já existe), `MOEDAS_SERVIDAS`/`simboloDaMoeda`/`MoedaServida` (`lib/money.ts`, Task 1), `Produto` (Task 3).
- Produces: formulário envia `preco_parcelado_cents` e `moeda` no `POST`; lista mostra os dois preços.

- [ ] **Step 1: Passar a moeda da organização como prop (server component)**

Em `app/app/products/page.tsx`, adicione o import:

```ts
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
```

Depois de `const supabase = await createClient();` e antes do `select` de produtos, adicione:

```ts
  const moedaOrg = await moedaDaOrganizacao(supabase, activeOrg.orgId);
```

E passe a prop nova ao `<ProdutosClient .../>`:

```tsx
    <ProdutosClient
      inicial={(data ?? []) as unknown as Produto[]}
      podeEditar={podeEditar}
      moedaOrg={moedaOrg}
      textos={{ ... }}
    />
```

(mantenha o resto de `textos` como já está).

- [ ] **Step 2: Ajustar `ProdutosClient` para receber a prop e o novo rascunho**

Em `app/app/products/_client.tsx`, no topo, importe o tipo e as constantes de moeda:

```ts
import { MOEDAS_SERVIDAS, simboloDaMoeda, type MoedaServida } from "@/lib/money";
```

No `interface Rascunho`, adicione os dois campos:

```ts
interface Rascunho {
  codigo: string;
  nome: string;
  marca: string;
  categoria: string;
  preco: string;
  preco_parcelado: string;
  custo: string;
  quantidade: string;
  controla_estoque: boolean;
  moeda: MoedaServida;
}
```

No `VAZIO`, `moeda` não tem valor fixo — ele é montado dinamicamente porque depende da prop `moedaOrg`. Troque a assinatura da função `ProdutosClient` para aceitar a prop nova e inicializar o rascunho com ela:

```ts
export function ProdutosClient({
  inicial,
  podeEditar,
  moedaOrg,
  textos,
}: {
  inicial: Produto[];
  podeEditar: boolean;
  moedaOrg: MoedaServida;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [busca, setBusca] = React.useState("");
  const [criando, setCriando] = React.useState(false);
  const [rascunho, setRascunho] = React.useState<Rascunho>({
    codigo: "",
    nome: "",
    marca: "",
    categoria: "",
    preco: "",
    preco_parcelado: "",
    custo: "",
    quantidade: "0",
    controla_estoque: true,
    moeda: moedaOrg,
  });
```

Remova a constante `VAZIO` de módulo (não é mais usada — o valor inicial de `moeda` depende da prop, então o objeto vazio nasce dentro do componente). Ajuste `setRascunho(VAZIO)` em `salvar()` (dentro do `try` de sucesso) para:

```ts
      setRascunho({
        codigo: "",
        nome: "",
        marca: "",
        categoria: "",
        preco: "",
        preco_parcelado: "",
        custo: "",
        quantidade: "0",
        controla_estoque: true,
        moeda: moedaOrg,
      });
```

- [ ] **Step 3: `doRascunho` monta os dois campos novos**

Em `doRascunho`, depois da checagem de `custo_cents`, adicione:

```ts
  const parceladoTexto = r.preco_parcelado.trim();
  const preco_parcelado_cents = parceladoTexto === "" ? null : precoParaCentavos(parceladoTexto);
  if (parceladoTexto !== "" && preco_parcelado_cents === null) {
    return { erro: t("Preço parcelado inválido.") };
  }
```

E no objeto retornado, adicione as duas chaves:

```ts
  return {
    codigo: r.codigo.trim(),
    nome: r.nome.trim(),
    ...(r.marca.trim() ? { marca: r.marca.trim() } : {}),
    ...(r.categoria.trim() ? { categoria: r.categoria.trim() } : {}),
    preco_cents,
    preco_parcelado_cents,
    custo_cents,
    controla_estoque: r.controla_estoque,
    quantidade: Number(r.quantidade) || 0,
    moeda: r.moeda,
  };
```

- [ ] **Step 4: Campos novos no formulário**

Depois do `<label>` de "Custo" (o bloco que termina no `</label>` antes de `</div>` que fecha o `grid`), adicione dois `<label>` novos, um do preço parcelado (ao lado do custo, mesma grade 2 colunas) e um seletor de moeda:

```tsx
            <label className="text-sm">
              {t("Preço parcelado")} <span className="text-muted-foreground">{t("(opcional)")}</span>
              <input
                value={rascunho.preco_parcelado}
                onChange={(e) => setRascunho({ ...rascunho, preco_parcelado: e.target.value })}
                placeholder="1.881,00"
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="produto-preco-parcelado"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                {t("O valor TOTAL quando o cliente parcela — o agente divide isso pelas semanas que o cliente pedir. Deixe em branco se este produto não pode ser parcelado.")}
              </span>
            </label>
            <label className="text-sm">
              {t("Moeda")}
              <select
                value={rascunho.moeda}
                onChange={(e) => setRascunho({ ...rascunho, moeda: e.target.value as MoedaServida })}
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="produto-moeda"
              >
                {MOEDAS_SERVIDAS.map((m) => (
                  <option key={m} value={m}>
                    {m} · {simboloDaMoeda(m)}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t("Já vem marcada com a moeda da sua loja. Troque só se ESTE produto for vendido em outra.")}
              </span>
            </label>
```

- [ ] **Step 5: Lista mostra os dois preços**

Localize o `<li>` que renderiza `formatCents(p.preco_cents, p.moeda)` na listagem de produtos. Ao lado dele, mostre o parcelado quando existir:

```tsx
                {formatCents(p.preco_cents, p.moeda)}
                {p.preco_parcelado_cents ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t("ou")} {formatCents(p.preco_parcelado_cents, p.moeda)} {t("parcelado")}
                  </span>
                ) : null}
```

- [ ] **Step 6: Verificação manual (sem servidor de teste automatizado para esta tela nesta task)**

Run: `pnpm typecheck && pnpm lint`
Expected: zero erros. Não há Playwright dedicado nesta task (fica fora de escopo — a spec já cobre isso via `crm_calc_installment`, que é testável sem browser); se quiser confirmar visualmente, rode `pnpm dev`, abra `/app/products`, cadastre um produto com preço parcelado e confira a lista.

- [ ] **Step 7: Commit**

```bash
git add app/app/products/page.tsx app/app/products/_client.tsx
git commit -m "feat(catalogo): tela de produto ganha preço parcelado e seletor de moeda"
```

---

### Task 7: `crm_search_products` devolve o preço parcelado

**Files:**
- Modify: `lib/mcp/tools/comercio.ts`
- Modify: `lib/mcp/tools/comercio.test.ts`

**Interfaces:**
- Consumes: `preco_parcelado_cents` (Task 3, já chega pela coluna que a query já seleciona? **Não** — o `select` desta tool lista as colunas manualmente; precisa ganhar a coluna nova).
- Produces: cada produto no array `produtos` do retorno de `crm_search_products` ganha `preco_parcelado` (formatado) quando `preco_parcelado_cents` não é nulo.

- [ ] **Step 1: Escrever o teste que falha**

Adicione a `lib/mcp/tools/comercio.test.ts` (reusando `ctxCom` e `semNbsp` já definidos no arquivo):

```ts
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
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm exec vitest run lib/mcp/tools/comercio.test.ts`
Expected: FAIL no primeiro teste novo — o mock de query (`ctxCom`) nem devolve `preco_parcelado_cents` hoje (a query da tool não pede essa coluna), e o handler não produz o campo `preco_parcelado`.

- [ ] **Step 3: Implementar**

Em `lib/mcp/tools/comercio.ts`, no `.select(...)` dentro do laço de páginas (linha ~186), acrescente a coluna:

```ts
        .select(
          "id, codigo, nome, descricao, marca, categoria, preco_cents, preco_parcelado_cents, moeda, controla_estoque, quantidade, ativo",
          { count: "exact" },
        )
```

No `type Linha`, acrescente o campo:

```ts
    type Linha = {
      id: string;
      codigo: string;
      nome: string;
      descricao: string | null;
      marca: string | null;
      categoria: string | null;
      preco_cents: number;
      preco_parcelado_cents: number | null;
      moeda: string;
      controla_estoque: boolean;
      quantidade: number;
    };
```

E no `.map(...)` final que monta `produtos`, acrescente a chave condicional (mesmo padrão de `marca`/`descricao`):

```ts
      produtos: topo.map(({ produto }) => ({
        codigo: produto.codigo,
        nome: produto.nome,
        preco: formatCents(produto.preco_cents, produto.moeda),
        preco_cents: produto.preco_cents,
        ...(produto.preco_parcelado_cents
          ? {
              preco_parcelado: formatCents(produto.preco_parcelado_cents, produto.moeda),
              preco_parcelado_cents: produto.preco_parcelado_cents,
            }
          : {}),
        ...(produto.marca ? { marca: produto.marca } : {}),
        ...(produto.descricao ? { descricao: produto.descricao } : {}),
        disponivel: !produto.controla_estoque || produto.quantidade > 0,
      })),
```

Por fim, no bloco de `description` da tool (linha ~133-143), acrescente uma frase ensinando a regra dura ao agente — troque o fim da string (antes de `inputSchema: produtosInputShape,`) para incluir:

```ts
    "Lista vazia significa que a loja não tem esse item cadastrado: não invente, ofereça consultar " +
    "com a equipe. " +
    "⚠️ `preco` é o preço À VISTA — nunca divida ele. Quando o produto tem `preco_parcelado`, esse é " +
    "o valor TOTAL que pode ser parcelado; se o cliente quiser parcelar, use a ferramenta " +
    "crm_calc_installment para calcular o valor da parcela — nunca calcule de cabeça.",
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm exec vitest run lib/mcp/tools/comercio.test.ts`
Expected: PASS em todos os testes do arquivo (os antigos e os dois novos).

- [ ] **Step 5: Commit**

```bash
git add lib/mcp/tools/comercio.ts lib/mcp/tools/comercio.test.ts
git commit -m "feat(catalogo): crm_search_products devolve o preço parcelado"
```

---

### Task 8: Ferramenta nova `crm_calc_installment`

**Files:**
- Modify: `lib/mcp/tools/comercio.ts`
- Modify: `lib/mcp/tools/comercio.test.ts`
- Modify: `lib/mcp/tools/index.ts`

**Interfaces:**
- Consumes: `McpToolDefinition`, `McpContext` (`lib/mcp/types.ts`, inalterados), `formatCents` (`lib/money.ts`).
- Produces: `crmCalcInstallment: McpToolDefinition<...>`, exportada e registrada — nenhuma outra task depende dela (é a última da cadeia).

- [ ] **Step 1: Escrever o teste que falha**

Adicione a `lib/mcp/tools/comercio.test.ts`:

```ts
import { crmCalcInstallment } from "./comercio";

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
    )) as { erro?: string };

    expect(r.erro).toBe("sem_parcelamento");
  });

  it("recusa quando a entrada é maior ou igual ao total parcelado", async () => {
    const r = (await crmCalcInstallment.handler(
      { codigo: "IP15", semanas: 10, entrada_cents: 188100 },
      ctxComProduto(PRODUTO_PARCELAVEL),
    )) as { erro?: string };

    expect(r.erro).toBe("entrada_maior_que_o_total");
  });

  it("recusa quando o produto não existe nesta organização", async () => {
    const r = (await crmCalcInstallment.handler(
      { codigo: "NAO-EXISTE", semanas: 10, entrada_cents: 0 },
      ctxComProduto(null),
    )) as { erro?: string };

    expect(r.erro).toBe("produto_nao_encontrado");
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm exec vitest run lib/mcp/tools/comercio.test.ts`
Expected: FAIL — `crmCalcInstallment` não existe ainda (erro de import/undefined).

- [ ] **Step 3: Implementar a ferramenta**

Ao final de `lib/mcp/tools/comercio.ts`, adicione:

```ts
// ---------------------------------------------------------------------------
// calcular parcela — NUNCA o modelo fazendo a conta
// ---------------------------------------------------------------------------

const calcInstallmentInputShape = {
  codigo: z.string().trim().min(1).describe("o código do produto, exatamente como voltou em crm_search_products"),
  semanas: z.number().int().min(1).describe("quantas semanas o cliente quer para pagar"),
  entrada_cents: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("valor da entrada em centavos, se o cliente vai dar uma — 0 se não"),
};

export const crmCalcInstallment: McpToolDefinition<typeof calcInstallmentInputShape> = {
  name: "crm_calc_installment",
  description:
    "Calcula o valor exato da parcela semanal de um produto. Use SEMPRE que o cliente quiser " +
    "parcelar — nunca divida o preço de cabeça, nem o preço à vista (esse é fixo e não entra na " +
    "conta). O cálculo é (preço parcelado − entrada) ÷ semanas, arredondado para cima. Se a " +
    "ferramenta devolver um `erro`, diga ao cliente o motivo (produto sem parcelamento, entrada " +
    "maior que o total) — não invente um valor.",
  inputSchema: calcInstallmentInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("catalog_products")
      .select("preco_parcelado_cents, moeda")
      .eq("organization_id", ctx.organizationId)
      .eq("codigo", input.codigo)
      .maybeSingle();

    if (error) throw new Error(`calcular_parcela_falhou: ${error.message}`);
    if (!data) return { erro: "produto_nao_encontrado" };

    const produto = data as { preco_parcelado_cents: number | null; moeda: string };
    if (produto.preco_parcelado_cents === null) return { erro: "sem_parcelamento" };
    if (input.entrada_cents >= produto.preco_parcelado_cents) {
      return { erro: "entrada_maior_que_o_total" };
    }

    // Arredonda PARA CIMA de propósito: a loja nunca recebe menos que o total
    // combinado — a diferença de arredondamento (no máximo alguns centavos)
    // fica embutida na primeira parcela. Mesmo princípio de "falha fechada"
    // de precoParaCentavos (lib/schemas/produtos.ts).
    const restante = produto.preco_parcelado_cents - input.entrada_cents;
    const valor_parcela_cents = Math.ceil(restante / input.semanas);

    return {
      valor_parcela_cents,
      valor_parcela_formatado: formatCents(valor_parcela_cents, produto.moeda),
      semanas: input.semanas,
      moeda: produto.moeda,
    };
  },
};
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm exec vitest run lib/mcp/tools/comercio.test.ts`
Expected: PASS em todos os testes do arquivo.

- [ ] **Step 5: Registrar a ferramenta no índice do MCP**

Em `lib/mcp/tools/index.ts`, troque:

```ts
import { crmListContactOrders, crmSearchProducts } from "./comercio";
```

por:

```ts
import { crmCalcInstallment, crmListContactOrders, crmSearchProducts } from "./comercio";
```

E na lista/array de tools registradas (perto da linha 110-111), acrescente:

```ts
  crmListContactOrders,
  crmSearchProducts,
  crmCalcInstallment,
```

- [ ] **Step 6: Rodar a suíte completa e o typecheck**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: tudo verde.

- [ ] **Step 7: Sabotagem — provar que o teste de arredondamento vigia de verdade**

Troque, temporariamente, `Math.ceil` por `Math.floor` no Step 3 e rode:

Run: `pnpm exec vitest run lib/mcp/tools/comercio.test.ts -t "arredonda para cima"`
Expected: FAIL (o teste passa a esperar 14470 e o código com `floor` devolve 14469).

Desfaça a troca (volte para `Math.ceil`) e rode de novo para confirmar PASS antes de commitar.

- [ ] **Step 8: Commit**

```bash
git add lib/mcp/tools/comercio.ts lib/mcp/tools/comercio.test.ts lib/mcp/tools/index.ts
git commit -m "feat(catalogo): ferramenta crm_calc_installment calcula parcela sem o modelo"
```

---

## Self-Review (preenchido ao escrever este plano)

- **Cobertura do spec:** P1 (preço parcelado) → Tasks 2, 3, 5, 6. P2 (moeda por produto) → Tasks 1, 3, 4, 6. P3 (agente calcula) → Tasks 7, 8. Nenhum requisito do `spec.md` ficou sem task.
- **Placeholders:** nenhum "TBD"/"depois" — todo passo tem código completo, inclusive os testes.
- **Consistência de tipos:** `Produto` (Task 3) é consumido por `_client.tsx` (Task 6) e por `page.tsx`; `crm_calc_installment` usa `codigo` (não `id`) porque é isso que `crm_search_products` devolve ao agente — conferido lendo o handler real antes de escrever este plano, não assumido.
- **Fora de escopo, confirmado nas tasks:** nenhuma task mexe em conversão de câmbio, teto de semanas, ou soma de valores entre moedas — consistente com o `spec.md`.
