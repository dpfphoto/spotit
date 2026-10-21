-- Archivio online di SpotIt (Supabase). Da eseguire una volta nell'editor SQL del progetto.

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null default '' check (char_length(name) <= 40),
  created_at timestamptz not null default now()
);

create table if not exists public.places (
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  id text not null check (char_length(id) <= 40),
  name text not null check (char_length(name) between 1 and 80),
  address text not null default '' check (char_length(address) <= 160),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  verdict text not null check (verdict in ('tornarci', 'andarci', 'consigliato', 'sconsigliato', 'nonandarci')),
  note text not null default '' check (char_length(note) <= 280),
  from_name text not null default '' check (char_length(from_name) <= 40),
  gid text not null default '',
  gphoto text not null default '',
  gphoto_by text not null default '',
  created_at bigint not null,
  updated_at bigint not null,
  deleted boolean not null default false,
  primary key (user_id, id)
);

alter table public.profiles enable row level security;
alter table public.places enable row level security;

-- Ognuno vede e modifica solo i propri dati (gli amici arriveranno dopo)
drop policy if exists "profilo proprio" on public.profiles;
create policy "profilo proprio" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "posti propri" on public.places;
create policy "posti propri" on public.places
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Foto dei posti: cartella privata per utente (foto/<user_id>/...)
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
  on conflict (id) do nothing;

drop policy if exists "foto proprie" on storage.objects;
create policy "foto proprie" on storage.objects
  for all using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
