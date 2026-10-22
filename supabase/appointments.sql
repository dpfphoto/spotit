-- Quarto giudizio "Appuntamento" (2026-10-22): un posto dove hai un appuntamento, che può sparire da solo dopo 24 ore.
-- Gli appuntamenti sono personali: non compaiono nella mappa di tutti.
-- Da eseguire una volta nell'editor SQL del progetto, dopo kinds.sql.

alter table public.places drop constraint if exists places_verdict_check;
alter table public.places add constraint places_verdict_check
  check (verdict in ('tornarci', 'andarci', 'consigliato', 'sconsigliato', 'nonandarci', 'appuntamento'));
-- Quando eliminarlo da solo (millisecondi); 0 = mai
alter table public.places add column if not exists expires_at bigint not null default 0;

drop function if exists public.public_places(double precision, double precision, double precision, double precision);
create or replace function public.public_places(s double precision, w double precision, n double precision, e double precision)
returns table (
  name text, address text, lat double precision, lng double precision,
  gid text, gphoto text, gphoto_by text,
  tornarci int, andarci int, consigliato int, sconsigliato int, nonandarci int,
  notes text[], kind text
)
language sql security definer stable set search_path = public as $$
  select min(p.name), min(p.address), avg(p.lat), avg(p.lng),
         max(p.gid), max(p.gphoto), max(p.gphoto_by),
         (count(*) filter (where p.verdict = 'tornarci'))::int,
         (count(*) filter (where p.verdict = 'andarci'))::int,
         (count(*) filter (where p.verdict = 'consigliato'))::int,
         (count(*) filter (where p.verdict = 'sconsigliato'))::int,
         (count(*) filter (where p.verdict = 'nonandarci'))::int,
         (array_remove(array_agg(nullif(trim(p.note), '') order by p.updated_at desc), null))[1:5],
         coalesce(mode() within group (order by nullif(trim(p.kind), '')), '')
  from places p
  left join profiles pr on pr.id = p.user_id
  where auth.uid() is not null
    and p.user_id <> auth.uid()
    and not p.deleted
    and p.verdict <> 'appuntamento'
    and coalesce(pr.share_places, true)
    and p.lat between s and n and p.lng between w and e
  group by case when p.gid <> '' then p.gid
                else lower(p.name) || '@' || round(p.lat::numeric, 4) || ',' || round(p.lng::numeric, 4) end
  limit 400;
$$;

revoke all on function public.public_places(double precision, double precision, double precision, double precision) from anon;
