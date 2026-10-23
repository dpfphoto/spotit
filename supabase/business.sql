-- Locali iscritti (2026-10-23): il titolare di un locale si iscrive dall'app ("Il tuo locale") e riceve un avviso
-- quando qualcuno salva il suo locale come Tornarci o Andarci. Sempre anonimo: il titolare vede solo quanti,
-- mai chi. Le email partono solo a chi si è iscritto e ha dato il consenso, all'indirizzo del suo account.
-- Da eseguire una volta nell'editor SQL del progetto, dopo one-vote.sql. Poi va ripubblicata la funzione notify-outing.

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  gid text not null check (char_length(gid) between 1 and 300),
  name text not null check (char_length(name) between 1 and 80),
  address text not null default '' check (char_length(address) <= 160),
  email text not null default '',
  notify_email boolean not null default true,
  consent_at timestamptz not null default now(),
  last_email_at timestamptz,
  unsub uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  unique (owner, gid)
);
alter table public.businesses enable row level security;
-- Il titolare vede i suoi locali e può solo spegnere/accendere le email o togliere il locale;
-- l'iscrizione passa da claim_business (email presa dall'account, non scritta a mano)
drop policy if exists "locali propri" on public.businesses;
create policy "locali propri" on public.businesses for select using (owner = auth.uid());
drop policy if exists "locali propri modifica" on public.businesses;
create policy "locali propri modifica" on public.businesses for update using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "locali propri cancella" on public.businesses;
create policy "locali propri cancella" on public.businesses for delete using (owner = auth.uid());
revoke insert, update on public.businesses from anon, authenticated;
grant update (notify_email) on public.businesses to authenticated;

-- Salvataggi da comunicare ai titolari. Chi ha salvato resta qui solo per non avvisare due volte: l'app non lo legge mai.
create table if not exists public.business_hits (
  business_id uuid not null references public.businesses on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  verdict text not null,
  created_at timestamptz not null default now(),
  pushed boolean not null default false,
  emailed boolean not null default false,
  primary key (business_id, user_id)
);
alter table public.business_hits enable row level security;
revoke all on public.business_hits from anon, authenticated;

create or replace function public.claim_business(p_gid text, p_name text, p_address text) returns uuid
language plpgsql security definer set search_path = public as $$
declare bid uuid;
declare mail text;
begin
  if auth.uid() is null then raise exception 'accesso richiesto'; end if;
  if coalesce(trim(p_gid), '') = '' then raise exception 'locale non valido'; end if;
  if (select count(*) from businesses where owner = auth.uid()) >= 3 then raise exception 'massimo 3 locali'; end if;
  select u.email into mail from auth.users u where u.id = auth.uid();
  insert into businesses (owner, gid, name, address, email)
    values (auth.uid(), trim(p_gid), left(coalesce(nullif(trim(p_name), ''), 'Il tuo locale'), 80), left(coalesce(p_address, ''), 160), coalesce(mail, ''))
    on conflict (owner, gid) do update set name = excluded.name, address = excluded.address, email = excluded.email, notify_email = true, consent_at = now()
    returning id into bid;
  return bid;
end $$;
revoke all on function public.claim_business(text, text, text) from anon;

-- Numeri per il pannello del titolare: un giudizio per persona (l'ultimo), solo chi condivide i suoi posti
create or replace function public.my_business_stats()
returns table (id uuid, gid text, name text, address text, notify_email boolean, email text,
               tornarci int, andarci int, sconsigliato int, last30 int)
language sql security definer stable set search_path = public as $$
  with latest as (
    select distinct on (p.user_id, p.gid) p.user_id, p.gid, p.verdict, p.created_at
    from places p
    join businesses b on b.gid = p.gid and b.owner = auth.uid()
    left join profiles pr on pr.id = p.user_id
    where not p.deleted and p.user_id <> auth.uid() and coalesce(pr.share_places, true)
    order by p.user_id, p.gid, p.updated_at desc
  )
  select b.id, b.gid, b.name, b.address, b.notify_email, b.email,
         (count(l.*) filter (where l.verdict in ('tornarci', 'consigliato')))::int,
         (count(l.*) filter (where l.verdict = 'andarci'))::int,
         (count(l.*) filter (where l.verdict in ('sconsigliato', 'nonandarci')))::int,
         (count(l.*) filter (where l.verdict in ('tornarci', 'consigliato', 'andarci')
                              and l.created_at > (extract(epoch from now()) * 1000 - 30::bigint * 86400000)))::int
  from businesses b
  left join latest l on l.gid = b.gid
  where b.owner = auth.uid()
  group by b.id
  order by b.created_at;
$$;
revoke all on function public.my_business_stats() from anon;

-- Disiscrizione dal link nell'email (senza entrare nell'app)
create or replace function public.business_unsubscribe(token uuid) returns text
language sql security definer set search_path = public as $$
  update businesses set notify_email = false where unsub = token returning name;
$$;
grant execute on function public.business_unsubscribe(uuid) to anon;

-- Quando qualcuno salva un locale iscritto come Tornarci o Andarci, preparo l'avviso per il titolare.
-- Non deve mai bloccare il salvataggio del posto: in caso di errore lo salto.
create or replace function public.places_business_hit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.gid = '' or new.deleted or new.verdict not in ('tornarci', 'andarci', 'consigliato') then return new; end if;
  if tg_op = 'UPDATE' and old.gid = new.gid and old.verdict = new.verdict and not old.deleted then return new; end if;
  if exists (select 1 from profiles pr where pr.id = new.user_id and not pr.share_places) then return new; end if;
  insert into business_hits (business_id, user_id, verdict)
    select b.id, new.user_id, new.verdict from businesses b where b.gid = new.gid and b.owner <> new.user_id
    on conflict do nothing;
  return new;
exception when others then
  return new;
end $$;

drop trigger if exists places_business_hit on public.places;
create trigger places_business_hit after insert or update of verdict, gid, deleted on public.places
  for each row execute function public.places_business_hit();
