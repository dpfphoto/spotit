-- Link corti per i posti condivisi (2026-10-24): il posto consigliato si salva qui
-- e su WhatsApp va solo wespot.me/#p=<codice>. I vecchi link lunghi (#s=...) continuano a funzionare.
-- Dentro c'è solo quello che c'era già nel link lungo (nome, indirizzo, punto, giudizio, nota, nome di chi consiglia solo se l'ha permesso).
-- Da eseguire una volta nell'editor SQL del progetto.

create table if not exists public.shares (
  id text primary key check (id ~ '^[A-Za-z0-9]{6,12}$'),
  data jsonb not null check (length(data::text) <= 2000),
  created_at timestamptz not null default now()
);
alter table public.shares enable row level security;
-- Nessun accesso diretto alla tabella: si passa solo dalle due funzioni qui sotto (niente elenco di tutti i link)

create or replace function public.create_share(sid text, d jsonb)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into shares (id, data) values (sid, d);
  return true;
exception when unique_violation then
  -- stesso codice già usato: va bene solo se è lo stesso posto
  return exists (select 1 from shares where id = sid and data = d);
end $$;

create or replace function public.get_share(sid text)
returns jsonb
language sql security definer stable set search_path = public as $$
  select data from shares where id = sid
$$;

revoke all on function public.create_share(text, jsonb) from public;
revoke all on function public.get_share(text) from public;
grant execute on function public.create_share(text, jsonb) to anon, authenticated;
grant execute on function public.get_share(text) to anon, authenticated;
