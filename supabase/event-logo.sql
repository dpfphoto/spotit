-- Logo di chi organizza al posto del 🎉 sugli eventi pubblici (place->>'ic', immagine piccola incorporata).
-- Da eseguire una volta nell'editor SQL del progetto, dopo layers.sql.

drop function if exists public.public_events(double precision, double precision, double precision, double precision, text);
create or replace function public.public_events(s double precision, w double precision, n double precision, e double precision, since text)
returns table (id uuid, name text, address text, lat double precision, lng double precision, starts_at text, note text, going int, icon text)
language sql security definer stable set search_path = public as $$
  select o.id, o.place->>'n', coalesce(o.place->>'a', ''), (o.place->>'la')::float8, (o.place->>'lo')::float8,
         o.starts_at, o.note,
         (select count(*) from outing_members m where m.outing_id = o.id and m.status = 'si')::int,
         case when o.place->>'ic' ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' and length(o.place->>'ic') < 60000
              then o.place->>'ic' else '' end
  from outings o
  where auth.uid() is not null
    and o.is_public
    and o.starts_at >= since
    and (o.place->>'la')::float8 between s and n and (o.place->>'lo')::float8 between w and e
  order by o.starts_at
  limit 200;
$$;

revoke all on function public.public_events(double precision, double precision, double precision, double precision, text) from anon;
