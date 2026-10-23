-- Un solo giudizio per persona e per luogo (2026-10-23): se qualcuno salva più volte lo stesso posto,
-- sulla mappa di tutti conta solo l'ultimo giudizio. Cambiare idea (es. Tornarci -> Sconsigliato) sostituisce il voto.
-- Da eseguire una volta nell'editor SQL del progetto, dopo appointments.sql.

drop function if exists public.public_places(double precision, double precision, double precision, double precision);
create or replace function public.public_places(s double precision, w double precision, n double precision, e double precision)
returns table (
  name text, address text, lat double precision, lng double precision,
  gid text, gphoto text, gphoto_by text,
  tornarci int, andarci int, consigliato int, sconsigliato int, nonandarci int,
  notes text[], kind text
)
language sql security definer stable set search_path = public as $$
  with latest as (
    -- per ogni persona e luogo (stesso nome nello stesso punto) tengo solo il salvataggio più recente
    select distinct on (p.user_id, lower(p.name) || '@' || round(p.lat::numeric, 4) || ',' || round(p.lng::numeric, 4)) p.*
    from places p
    where p.user_id <> auth.uid()
      and p.lat between s - 0.001 and n + 0.001 and p.lng between w - 0.001 and e + 0.001
    order by p.user_id, lower(p.name) || '@' || round(p.lat::numeric, 4) || ',' || round(p.lng::numeric, 4), p.updated_at desc
  )
  select min(p.name), min(p.address), avg(p.lat), avg(p.lng),
         max(p.gid), max(p.gphoto), max(p.gphoto_by),
         (count(*) filter (where p.verdict = 'tornarci'))::int,
         (count(*) filter (where p.verdict = 'andarci'))::int,
         (count(*) filter (where p.verdict = 'consigliato'))::int,
         (count(*) filter (where p.verdict = 'sconsigliato'))::int,
         (count(*) filter (where p.verdict = 'nonandarci'))::int,
         (array_remove(array_agg(nullif(trim(p.note), '') order by p.updated_at desc), null))[1:5],
         coalesce(mode() within group (order by nullif(trim(p.kind), '')), '')
  from latest p
  left join profiles pr on pr.id = p.user_id
  where auth.uid() is not null
    and not p.deleted
    and p.verdict <> 'appuntamento'
    and coalesce(pr.share_places, true)
    and p.lat between s and n and p.lng between w and e
  group by case when p.gid <> '' then p.gid
                else lower(p.name) || '@' || round(p.lat::numeric, 4) || ',' || round(p.lng::numeric, 4) end
  limit 400;
$$;

revoke all on function public.public_places(double precision, double precision, double precision, double precision) from anon;
