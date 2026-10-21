-- Livello "Di tutti" sulla mappa: i posti degli altri utenti, anonimi e raggruppati.
-- Si vedono nome, indirizzo, posizione, foto di Google, giudizi e note: mai chi li ha salvati.
-- Da eseguire una volta nell'editor SQL del progetto, dopo schema.sql.

alter table public.profiles add column if not exists share_places boolean not null default true;

drop function if exists public.public_places(double precision, double precision, double precision, double precision);
create or replace function public.public_places(s double precision, w double precision, n double precision, e double precision)
returns table (
  name text, address text, lat double precision, lng double precision,
  gid text, gphoto text, gphoto_by text,
  tornarci int, andarci int, consigliato int, sconsigliato int, nonandarci int,
  notes text[]
)
language sql security definer stable set search_path = public as $$
  select min(p.name), min(p.address), avg(p.lat), avg(p.lng),
         max(p.gid), max(p.gphoto), max(p.gphoto_by),
         (count(*) filter (where p.verdict = 'tornarci'))::int,
         (count(*) filter (where p.verdict = 'andarci'))::int,
         (count(*) filter (where p.verdict = 'consigliato'))::int,
         (count(*) filter (where p.verdict = 'sconsigliato'))::int,
         (count(*) filter (where p.verdict = 'nonandarci'))::int,
         (array_remove(array_agg(nullif(trim(p.note), '') order by p.updated_at desc), null))[1:5]
  from places p
  left join profiles pr on pr.id = p.user_id
  where auth.uid() is not null
    and p.user_id <> auth.uid()
    and not p.deleted
    and coalesce(pr.share_places, true)
    and p.lat between s and n and p.lng between w and e
  -- stesso posto salvato da più persone: stesso id Google, oppure stesso nome nello stesso punto
  group by case when p.gid <> '' then p.gid
                else lower(p.name) || '@' || round(p.lat::numeric, 4) || ',' || round(p.lng::numeric, 4) end
  limit 400;
$$;

revoke all on function public.public_places(double precision, double precision, double precision, double precision) from anon;

-- Eventi privati resi pubblici dall'organizzatore (spunta "Rendilo pubblico sulla mappa").
-- Anonimi: nome, posto, ora, messaggio e quanti ci vanno. Solo quelli non ancora passati.
alter table public.outings add column if not exists is_public boolean not null default false;

create or replace function public.public_events(s double precision, w double precision, n double precision, e double precision, since text)
returns table (id uuid, name text, address text, lat double precision, lng double precision, starts_at text, note text, going int)
language sql security definer stable set search_path = public as $$
  select o.id, o.place->>'n', coalesce(o.place->>'a', ''), (o.place->>'la')::float8, (o.place->>'lo')::float8,
         o.starts_at, o.note,
         (select count(*) from outing_members m where m.outing_id = o.id and m.status = 'si')::int
  from outings o
  where auth.uid() is not null
    and o.is_public
    and o.starts_at >= since
    and (o.place->>'la')::float8 between s and n and (o.place->>'lo')::float8 between w and e
  order by o.starts_at
  limit 200;
$$;

revoke all on function public.public_events(double precision, double precision, double precision, double precision, text) from anon;
