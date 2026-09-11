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
