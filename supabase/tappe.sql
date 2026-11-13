-- Tappe (v79, 2026-11-13): un evento o un'uscita può avere più posti, ognuno con giorno e ora.
-- La prima tappa resta place + starts_at (con place.sn = nome della tappa, es. "Albergo");
-- le altre stanno in "stops": [{ n, a, la, lo, t }] con t = "AAAA-MM-GGTHH:MM" locale.
-- Da eseguire una volta nell'editor SQL, dopo outings.sql.

alter table public.outings add column if not exists stops jsonb not null default '[]';
alter table public.outings drop constraint if exists outings_stops_check;
alter table public.outings add constraint outings_stops_check
  check (jsonb_typeof(stops) = 'array' and jsonb_array_length(stops) <= 10 and length(stops::text) <= 6000);

-- Anteprima dal link d'invito: in più le tappe
create or replace function public.outing_preview(oid uuid) returns json
language sql security definer stable set search_path = public as $$
  select case when auth.uid() is null then null else (
    select json_build_object(
      'id', o.id, 'owner_name', o.owner_name, 'place', o.place, 'starts_at', o.starts_at, 'note', o.note, 'stops', o.stops,
      'members', coalesce((select json_agg(json_build_object('id', m.id, 'name', m.name, 'status', m.status, 'joined', m.user_id is not null) order by m.created_at)
                            from outing_members m where m.outing_id = o.id), '[]'::json))
    from outings o where o.id = oid) end;
$$;
revoke all on function public.outing_preview(uuid) from anon;
