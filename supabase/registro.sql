-- Registro presenze e note dei partecipanti (2026-11-08).
-- Da eseguire una volta nell'editor SQL del progetto, dopo outings.sql, arrivals.sql e delay.sql.
-- Poi va ripubblicata la funzione notify-outing (supabase/functions/notify-outing/index.ts) per le notifiche delle note.

-- ---------- Note dei partecipanti ----------

create table if not exists public.outing_notes (
  id uuid primary key default gen_random_uuid(),
  outing_id uuid not null references public.outings on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null default '' check (char_length(name) <= 60),
  body text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
create index if not exists outing_notes_outing on public.outing_notes (outing_id, created_at);
alter table public.outing_notes enable row level security;

drop policy if exists "note visibili nel gruppo" on public.outing_notes;
create policy "note visibili nel gruppo" on public.outing_notes
  for select using (public.in_outing(outing_id));
drop policy if exists "note scritte da chi è nel gruppo" on public.outing_notes;
create policy "note scritte da chi è nel gruppo" on public.outing_notes
  for insert with check (user_id = auth.uid() and public.in_outing(outing_id));
drop policy if exists "note tolte dall'autore o dall'organizzatore" on public.outing_notes;
create policy "note tolte dall'autore o dall'organizzatore" on public.outing_notes
  for delete using (user_id = auth.uid() or exists (select 1 from public.outings o where o.id = outing_id and o.owner = auth.uid()));

-- Il nome sotto la nota lo mette il server: quello con cui sei nel gruppo (o "chi invita" per l'organizzatore)
create or replace function public.outing_note_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  new.created_at := now();
  new.name := left(coalesce(
    (select m.name from outing_members m where m.outing_id = new.outing_id and m.user_id = auth.uid() limit 1),
    (select nullif(o.owner_name, '') from outings o where o.id = new.outing_id and o.owner = auth.uid()),
    'Organizzatore'), 60);
  return new;
end;
$$;
drop trigger if exists outing_note_name on public.outing_notes;
create trigger outing_note_name before insert on public.outing_notes
  for each row execute function public.outing_note_name();

-- ---------- Registro ----------
-- Una riga per ogni uscita o evento, copiata dal server a ogni cambio. Resta anche quando l'uscita
-- viene annullata o eliminata. La vede per intero solo chi l'ha organizzata; chi ha partecipato
-- la vede nel suo registro con la sua sola presenza (funzione registro_mio).

create table if not exists public.registro (
  outing_id uuid primary key,
  owner uuid not null references auth.users on delete cascade,
  member_uids uuid[] not null default '{}',
  starts_at text not null,
  -- { owner_name, place, starts_at, note, is_event, members: [{id, uid, name, status, arrival, arrival_at, delay_min}], notes: [{id, name, body, at}] }
  data jsonb not null,
  -- Correzioni a mano dell'organizzatore: { idPartecipante: true | false }
  presenze jsonb not null default '{}'::jsonb,
  -- Presenti aggiunti a mano nel registro: [ "Nome", ... ]
  extra jsonb not null default '[]'::jsonb,
  stato text not null default 'attivo' check (stato in ('attivo', 'annullato')),
  updated_at timestamptz not null default now()
);
create index if not exists registro_owner on public.registro (owner, starts_at);
create index if not exists registro_members on public.registro using gin (member_uids);
alter table public.registro enable row level security;

drop policy if exists "registro di chi organizza" on public.registro;
create policy "registro di chi organizza" on public.registro
  for select using (owner = auth.uid());
drop policy if exists "presenze corrette da chi organizza" on public.registro;
create policy "presenze corrette da chi organizza" on public.registro
  for update using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "registro cancellato da chi organizza" on public.registro;
create policy "registro cancellato da chi organizza" on public.registro
  for delete using (owner = auth.uid());
revoke insert, update on public.registro from anon, authenticated;
grant select, delete on public.registro to authenticated;
grant update (presenze, extra) on public.registro to authenticated;

-- "2026-11-08T09:30" è ora italiana
create or replace function public.rome_ts(local text) returns timestamptz
language sql immutable set search_path = public as $$
  select (local || ':00')::timestamp at time zone 'Europe/Rome';
$$;

-- Copia l'uscita nel registro. Dopo l'inizio chi esce dal gruppo resta nel registro.
create or replace function public.registro_sync(oid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  o outings;
  mem jsonb;
  uids uuid[];
  prev registro;
begin
  select * into o from outings where id = oid;
  if not found then return; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'uid', m.user_id, 'name', m.name, 'status', m.status,
      'arrival', m.arrival, 'arrival_at', m.arrival_at, 'delay_min', m.delay_min) order by m.created_at), '[]'::jsonb),
    coalesce(array_agg(distinct m.user_id) filter (where m.user_id is not null), '{}')
    into mem, uids
    from outing_members m where m.outing_id = oid;
  select * into prev from registro where outing_id = oid;
  if found and public.rome_ts(o.starts_at) <= now() then
    mem := mem || coalesce((select jsonb_agg(x) from jsonb_array_elements(prev.data -> 'members') x
                            where not exists (select 1 from outing_members m where m.id::text = x ->> 'id')), '[]'::jsonb);
    uids := array(select distinct u from unnest(uids || prev.member_uids) u);
  end if;
  insert into registro as r (outing_id, owner, member_uids, starts_at, data, stato, updated_at)
  values (o.id, o.owner, uids, o.starts_at, jsonb_build_object(
      'owner_name', o.owner_name,
      'place', o.place - 'ic' - 'f' - 'fb' - 'c',
      'starts_at', o.starts_at,
      'note', o.note,
      'is_event', coalesce((o.place ->> 'pv')::text, '') <> '',
      'created_at', o.created_at,
      'members', mem,
      'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name, 'body', n.body, 'at', n.created_at) order by n.created_at)
                         from outing_notes n where n.outing_id = oid), '[]'::jsonb)),
    'attivo', now())
  on conflict (outing_id) do update
    set owner = excluded.owner, member_uids = excluded.member_uids, starts_at = excluded.starts_at,
        data = excluded.data, stato = 'attivo', updated_at = now();
end;
$$;
revoke all on function public.registro_sync(uuid) from public, anon, authenticated;

create or replace function public.registro_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'outings' then
    if tg_op = 'DELETE' then
      perform public.registro_sync(old.id);
      -- Eliminata prima dell'inizio: resta nel registro come annullata
      update registro set stato = 'annullato', updated_at = now()
        where outing_id = old.id and public.rome_ts(old.starts_at) > now();
      return old;
    end if;
    perform public.registro_sync(new.id);
    return new;
  end if;
  if tg_op = 'DELETE' then perform public.registro_sync(old.outing_id); return old; end if;
  perform public.registro_sync(new.outing_id);
  return new;
end;
$$;

drop trigger if exists registro_outings on public.outings;
create trigger registro_outings after insert or update on public.outings
  for each row execute function public.registro_trg();
drop trigger if exists registro_outings_del on public.outings;
create trigger registro_outings_del before delete on public.outings
  for each row execute function public.registro_trg();
drop trigger if exists registro_members on public.outing_members;
create trigger registro_members after insert or update or delete on public.outing_members
  for each row execute function public.registro_trg();
drop trigger if exists registro_notes on public.outing_notes;
create trigger registro_notes after insert or delete on public.outing_notes
  for each row execute function public.registro_trg();

-- Il mio registro: per intero quello che organizzo, solo la mia riga in quelli dove ho partecipato
create or replace function public.registro_mio() returns json
language sql security definer stable set search_path = public as $$
  select coalesce(json_agg(x order by x.starts_at desc), '[]'::json) from (
    select r.outing_id, r.starts_at, r.stato, true as mine, r.presenze, r.extra, r.data, r.updated_at
      from registro r where r.owner = auth.uid()
    union all
    select r.outing_id, r.starts_at, r.stato, false,
      coalesce((select jsonb_object_agg(k, v) from jsonb_each(r.presenze) e(k, v)
                where k in (select x ->> 'id' from jsonb_array_elements(r.data -> 'members') x where x ->> 'uid' = auth.uid()::text)), '{}'::jsonb),
      '[]'::jsonb,
      jsonb_set(r.data, '{members}', coalesce((select jsonb_agg(x - 'uid') from jsonb_array_elements(r.data -> 'members') x
                                               where x ->> 'uid' = auth.uid()::text), '[]'::jsonb)),
      r.updated_at
      from registro r where auth.uid() = any (r.member_uids) and r.owner <> auth.uid()
  ) x where auth.uid() is not null;
$$;
revoke all on function public.registro_mio() from anon;

-- Le uscite e gli eventi che esistono già entrano subito nel registro
select public.registro_sync(id) from public.outings;
