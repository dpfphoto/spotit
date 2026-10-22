-- Pannello admin (admin.html): chi può aprirlo e i numeri che vede.
-- Da eseguire una volta nell'editor SQL del progetto, dopo layers.sql e event-logo.sql.
-- Mostra totali e conteggi, più l'elenco degli iscritti (email e nome) solo a chi è admin.

-- Chi è admin. Nessuno la legge o la scrive dall'app: si cambia solo da qui.
create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

-- Per aggiungere un altro admin: stessa riga con la sua email.
insert into public.admins (user_id)
  select id from auth.users where email = 'flaviodiproperzio@gmail.com'
  on conflict do nothing;

create or replace function public.is_admin()
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.admin_stats()
returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  ms_7d bigint := (extract(epoch from now() - interval '7 days') * 1000)::bigint;
  today_local text := to_char(now() at time zone 'Europe/Rome', 'YYYY-MM-DD"T"HH24:MI');
  r jsonb;
begin
  if not public.is_admin() then
    raise exception 'non autorizzato' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'users', jsonb_build_object(
      'total', (select count(*) from auth.users),
      'new_7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
      'new_30d', (select count(*) from auth.users where created_at > now() - interval '30 days'),
      'signed_in_7d', (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
      'with_places', (select count(distinct user_id) from places where not deleted),
      'not_sharing', (select count(*) from profiles where share_places = false)
    ),
    'places', jsonb_build_object(
      'total', (select count(*) from places where not deleted),
      'new_7d', (select count(*) from places where not deleted and created_at >= ms_7d),
      'shared', (select count(*) from places p left join profiles pr on pr.id = p.user_id
                 where not p.deleted and p.verdict <> 'appuntamento' and coalesce(pr.share_places, true)),
      'by_verdict', coalesce((select jsonb_object_agg(verdict, n) from
                 (select verdict, count(*) n from places where not deleted group by verdict) v), '{}'::jsonb),
      'top_kinds', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'n', n)) from
                 (select kind, count(*) n from places where not deleted and kind <> '' group by kind order by n desc, kind limit 8) k), '[]'::jsonb)
    ),
    'outings', jsonb_build_object(
      'groups', (select count(*) from outings where coalesce(place->>'pv', '') <> '1'),
      'events', (select count(*) from outings where coalesce(place->>'pv', '') = '1'),
      'public_events', (select count(*) from outings where is_public),
      'upcoming', (select count(*) from outings where starts_at >= today_local),
      'new_7d', (select count(*) from outings where created_at > now() - interval '7 days'),
      'members', (select count(*) from outing_members),
      'going', (select count(*) from outing_members where status = 'si')
    ),
    'notifications', jsonb_build_object('phones', (select count(*) from push_subscriptions)),
    'storage', jsonb_build_object(
      'photo_files', (select count(*) from storage.objects where bucket_id = 'photos'),
      'photo_bytes', coalesce((select sum((metadata->>'size')::bigint) from storage.objects where bucket_id = 'photos'), 0),
      'cover_files', (select count(*) from storage.objects where bucket_id = 'covers'),
      'cover_bytes', coalesce((select sum((metadata->>'size')::bigint) from storage.objects where bucket_id = 'covers'), 0),
      'db_bytes', pg_database_size(current_database())
    ),
    'daily', jsonb_build_object(
      'signups', (select jsonb_agg(jsonb_build_object('d', d::date, 'n', (select count(*) from auth.users u where u.created_at::date = d::date))
                  order by d) from generate_series(current_date - 29, current_date, interval '1 day') d),
      'places', (select jsonb_agg(jsonb_build_object('d', d::date, 'n', (select count(*) from places p
                  where not p.deleted and to_timestamp(p.created_at / 1000.0)::date = d::date)) order by d)
                  from generate_series(current_date - 29, current_date, interval '1 day') d)
    )
  ) into r;
  return r;
end;
$$;
revoke all on function public.admin_stats() from public, anon;
grant execute on function public.admin_stats() to authenticated;

-- Elenco degli iscritti (solo per gli admin): email, nome, date e quanti posti hanno salvato.
create or replace function public.admin_users()
returns table (email text, name text, joined timestamptz, last_seen timestamptz, places int)
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'non autorizzato' using errcode = '42501';
  end if;
  return query
    select u.email::text, coalesce(pr.name, '')::text, u.created_at, u.last_sign_in_at,
           (select count(*) from places p where p.user_id = u.id and not p.deleted)::int
    from auth.users u
    left join profiles pr on pr.id = u.id
    order by u.created_at desc;
end;
$$;
revoke all on function public.admin_users() from public, anon;
grant execute on function public.admin_users() to authenticated;
