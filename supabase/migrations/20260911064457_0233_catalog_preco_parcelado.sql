-- 0233 — preço parcelado por produto (catálogo).
--
-- Coluna opcional: produto sem preço parcelado continua só com preço à vista.
-- Sem backfill (nula para toda linha existente) e sem default — não muda o
-- comportamento de quem já tem o catálogo cheio.
alter table public.catalog_products
  add column if not exists preco_parcelado_cents integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'catalog_products_preco_parcelado_nao_negativo') then
    alter table public.catalog_products
      add constraint catalog_products_preco_parcelado_nao_negativo
      check (preco_parcelado_cents is null or preco_parcelado_cents >= 0);
  end if;
end $$;
