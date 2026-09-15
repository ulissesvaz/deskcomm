-- 0236 — cargo (job_title) por membro da equipe.
--
-- Rótulo de identificação visual, texto livre, opcional. NÃO é papel de
-- permissão (`role`, que continua sendo os 4 valores de sempre) — é só o que
-- aparece do lado do nome pra dizer "esta pessoa é técnico" / "consultora de
-- vendas" etc. Mora em `user_organizations` porque é por ORGANIZAÇÃO, igual
-- `role` e `interface_settings`: a mesma pessoa pode ter cargos diferentes em
-- tenants diferentes da mesma instalação.
--
-- Sem CHECK de vocabulário de propósito: é texto livre, cada organização
-- escreve o que quiser.
alter table public.user_organizations
  add column if not exists job_title text;
