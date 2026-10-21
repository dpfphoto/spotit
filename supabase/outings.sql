-- Uscite di gruppo di SpotIt. Da eseguire una volta nell'editor SQL del progetto, dopo schema.sql.

create table if not exists public.outings (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  owner_name text not null default '' check (char_length(owner_name) <= 40),
  -- Posto: {n, a, la, lo, g, f, fb} come nei link condivisi
  place jsonb not null,
  -- Giorno e ora locali "AAAA-MM-GGTHH:MM"
  starts_at text not null check (starts_at ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  note text not null default '' check (char_length(note) <= 120),
  created_at timestamptz not null default now()
);

create table if not exists public.outing_members (
  id uuid primary key default gen_random_uuid(),
  outing_id uuid not null references public.outings on delete cascade,
  -- Vuoto per chi è stato aggiunto a mano e non è ancora entrato col link.
  -- Il numero di telefono resta solo sul telefono dell'organizzatore.
  user_id uuid references auth.users on delete set null,
  name text not null check (char_length(name) between 1 and 40),
  status text not null default 'invitato' check (status in ('invitato', 'si', 'forse', 'no')),
  created_at timestamptz not null default now(),
  unique (outing_id, user_id)
);
create index if not exists outing_members_user on public.outing_members (user_id);

alter table public.outings enable row level security;
alter table public.outing_members enable row level security;

-- Organizzatore o partecipante entrato col link
create or replace function public.in_outing(oid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from outings where id = oid and owner = auth.uid())
      or exists (select 1 from outing_members where outing_id = oid and user_id = auth.uid());
$$;

drop policy if exists "uscite visibili ai partecipanti" on public.outings;
create policy "uscite visibili ai partecipanti" on public.outings
  for select using (owner = auth.uid() or public.in_outing(id));
drop policy if exists "uscite create da me" on public.outings;
create policy "uscite create da me" on public.outings
  for insert with check (owner = auth.uid());
drop policy if exists "uscite gestite dall'organizzatore" on public.outings;
create policy "uscite gestite dall'organizzatore" on public.outings
  for update using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "uscite cancellate dall'organizzatore" on public.outings;
create policy "uscite cancellate dall'organizzatore" on public.outings
  for delete using (owner = auth.uid());

drop policy if exists "partecipanti visibili nel gruppo" on public.outing_members;
create policy "partecipanti visibili nel gruppo" on public.outing_members
  for select using (public.in_outing(outing_id));
drop policy if exists "partecipanti aggiunti dall'organizzatore" on public.outing_members;
create policy "partecipanti aggiunti dall'organizzatore" on public.outing_members
  for insert with check (exists (select 1 from public.outings o where o.id = outing_id and o.owner = auth.uid()));
drop policy if exists "risposta propria o dell'organizzatore" on public.outing_members;
create policy "risposta propria o dell'organizzatore" on public.outing_members
  for update using (user_id = auth.uid() or exists (select 1 from public.outings o where o.id = outing_id and o.owner = auth.uid()));
drop policy if exists "rimozione propria o dell'organizzatore" on public.outing_members;
create policy "rimozione propria o dell'organizzatore" on public.outing_members
  for delete using (user_id = auth.uid() or exists (select 1 from public.outings o where o.id = outing_id and o.owner = auth.uid()));

-- Anteprima per chi apre il link d'invito
create or replace function public.outing_preview(oid uuid) returns json
language sql security definer stable set search_path = public as $$
  select case when auth.uid() is null then null else (
    select json_build_object(
      'id', o.id, 'owner_name', o.owner_name, 'place', o.place, 'starts_at', o.starts_at, 'note', o.note,
      'members', coalesce((select json_agg(json_build_object('id', m.id, 'name', m.name, 'status', m.status, 'joined', m.user_id is not null) order by m.created_at)
                            from outing_members m where m.outing_id = o.id), '[]'::json))
    from outings o where o.id = oid) end;
$$;

-- Entra nel gruppo dal link: come persona già aggiunta dall'organizzatore (claim) o come nuova
create or replace function public.join_outing(oid uuid, claim uuid, display_name text, answer text) returns uuid
language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  if auth.uid() is null then raise exception 'accesso richiesto'; end if;
  if answer not in ('si', 'forse', 'no') then raise exception 'risposta non valida'; end if;
  if not exists (select 1 from outings where id = oid) then raise exception 'uscita non trovata'; end if;
  select id into mid from outing_members where outing_id = oid and user_id = auth.uid();
  if mid is not null then
    update outing_members set status = answer where id = mid;
    return mid;
  end if;
  if claim is not null then
    update outing_members set user_id = auth.uid(), status = answer
      where id = claim and outing_id = oid and user_id is null returning id into mid;
    if mid is not null then return mid; end if;
  end if;
  insert into outing_members (outing_id, user_id, name, status)
    values (oid, auth.uid(), left(coalesce(nullif(trim(display_name), ''), 'Amico'), 40), answer)
    returning id into mid;
  return mid;
end;
$$;

revoke all on function public.join_outing(uuid, uuid, text, text) from anon;
revoke all on function public.outing_preview(uuid) from anon;
