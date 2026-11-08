-- Medagliette NFC (v69, 2026-11-08): sulla medaglietta del cane c'è il link wespot.me/#t=<codice>.
-- Chi la legge col telefono vede nome, foto e messaggio scritti dal padrone (senza account)
-- e, solo se lo sceglie, manda al padrone la propria posizione e un messaggio.
-- La posizione del padrone non c'è da nessuna parte. Da eseguire una volta nell'editor SQL del progetto.

create table if not exists public.pet_tags (
  id text primary key check (id ~ '^[A-Za-z0-9]{7}$'),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null default '' check (length(name) <= 40),
  message text not null default '' check (length(message) <= 500),
  phone text not null default '' check (phone ~ '^\+?[0-9]{0,15}$'),
  photo text not null default '' check (length(photo) <= 400000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.pet_tags enable row level security;
drop policy if exists "medagliette proprie" on public.pet_tags;
create policy "medagliette proprie" on public.pet_tags
  for all using (owner = auth.uid()) with check (owner = auth.uid());
grant select, insert, update, delete on public.pet_tags to authenticated;

-- Segnalazioni di chi ha letto la medaglietta: le vede (e le cancella) solo il padrone
create table if not exists public.tag_sightings (
  id uuid primary key default gen_random_uuid(),
  tag_id text not null references public.pet_tags on delete cascade,
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  acc real,
  note text not null default '' check (length(note) <= 300),
  phone text not null default '' check (phone ~ '^\+?[0-9]{0,15}$'),
  notified boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists tag_sightings_tag on public.tag_sightings (tag_id, created_at desc);
alter table public.tag_sightings enable row level security;
drop policy if exists "segnalazioni delle mie medagliette" on public.tag_sightings;
create policy "segnalazioni delle mie medagliette" on public.tag_sightings
  for select using (exists (select 1 from pet_tags t where t.id = tag_id and t.owner = auth.uid()));
drop policy if exists "cancello le segnalazioni delle mie medagliette" on public.tag_sightings;
create policy "cancello le segnalazioni delle mie medagliette" on public.tag_sightings
  for delete using (exists (select 1 from pet_tags t where t.id = tag_id and t.owner = auth.uid()));
revoke insert, update on public.tag_sightings from anon, authenticated;
grant select, delete on public.tag_sightings to authenticated;

-- Pagina di chi trova il cane: solo quello che il padrone ha scritto (niente elenco di tutte le medagliette)
create or replace function public.get_tag(code text)
returns jsonb
language sql security definer stable set search_path = public as $$
  select jsonb_build_object('name', name, 'message', message, 'phone', phone, 'photo', photo)
  from pet_tags where id = code
$$;

-- "Invia la mia posizione al padrone": posizione e messaggio facoltativi, al massimo 5 invii ogni 10 minuti
create or replace function public.report_tag(code text, p_lat double precision, p_lng double precision,
  p_acc real, p_note text, p_phone text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare sid uuid;
declare ph text := left(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), 16);
begin
  if not exists (select 1 from pet_tags where id = code) then raise exception 'medaglietta non trovata'; end if;
  if (p_lat is null) <> (p_lng is null) then raise exception 'posizione non valida'; end if;
  if (select count(*) from tag_sightings where tag_id = code and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'troppi invii, riprova tra qualche minuto';
  end if;
  if ph !~ '^\+?[0-9]{0,15}$' then ph := ''; end if;
  insert into tag_sightings (tag_id, lat, lng, acc, note, phone)
    values (code, p_lat, p_lng, p_acc, left(trim(coalesce(p_note, '')), 300), ph)
    returning id into sid;
  -- tengo le ultime 50 segnalazioni per medaglietta
  delete from tag_sightings where tag_id = code and id not in
    (select id from tag_sightings where tag_id = code order by created_at desc limit 50);
  return sid;
end $$;

revoke all on function public.get_tag(text) from public;
revoke all on function public.report_tag(text, double precision, double precision, real, text, text) from public;
grant execute on function public.get_tag(text) to anon, authenticated;
grant execute on function public.report_tag(text, double precision, double precision, real, text, text) to anon, authenticated;
