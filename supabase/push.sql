-- Notifiche di SpotIt. Da eseguire una volta nell'editor SQL del progetto, dopo outings.sql.

-- Telefoni che hanno chiesto le notifiche (uno per browser)
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "notifiche proprie" on public.push_subscriptions;
create policy "notifiche proprie" on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Chiavi del servizio notifiche: le crea e le legge solo la funzione notify-outing (nessun accesso dall'app)
create table if not exists public.app_secrets (
  name text primary key,
  value jsonb not null
);
alter table public.app_secrets enable row level security;

-- Così l'organizzatore riceve un solo avviso per persona
alter table public.outing_members add column if not exists notified boolean not null default false;

-- Numero di telefono dei partecipanti: lo vede solo l'organizzatore (per scrivergli su WhatsApp)
alter table public.outing_members add column if not exists phone text not null default '' check (phone ~ '^[0-9]{0,15}$');
revoke select on public.outing_members from anon, authenticated;
grant select (id, outing_id, user_id, name, status, created_at, notified) on public.outing_members to authenticated;

create or replace function public.outing_phones(oid uuid) returns table (id uuid, phone text)
language sql security definer stable set search_path = public as $$
  select m.id, m.phone from outing_members m
  join outings o on o.id = m.outing_id
  where m.outing_id = oid and o.owner = auth.uid() and m.phone <> '';
$$;
revoke all on function public.outing_phones(uuid) from anon;

-- Entrare dal link lasciando anche il proprio numero (facoltativo)
drop function if exists public.join_outing(uuid, uuid, text, text);
create or replace function public.join_outing(oid uuid, claim uuid, display_name text, answer text, my_phone text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare mid uuid;
declare ph text := left(regexp_replace(coalesce(my_phone, ''), '\D', '', 'g'), 15);
begin
  if auth.uid() is null then raise exception 'accesso richiesto'; end if;
  if answer not in ('si', 'forse', 'no') then raise exception 'risposta non valida'; end if;
  if not exists (select 1 from outings where id = oid) then raise exception 'uscita non trovata'; end if;
  select id into mid from outing_members where outing_id = oid and user_id = auth.uid();
  if mid is null and claim is not null then
    update outing_members set user_id = auth.uid()
      where id = claim and outing_id = oid and user_id is null returning id into mid;
  end if;
  if mid is null then
    insert into outing_members (outing_id, user_id, name, status)
      values (oid, auth.uid(), left(coalesce(nullif(trim(display_name), ''), 'Amico'), 40), answer)
      returning id into mid;
  end if;
  update outing_members set status = answer,
    -- il nome dell'account sostituisce quello scritto a mano dall'organizzatore
    name = left(coalesce(nullif(trim(display_name), ''), name), 40),
    phone = case when ph <> '' then ph else phone end
    where id = mid;
  return mid;
end;
$$;
revoke all on function public.join_outing(uuid, uuid, text, text, text) from anon;
