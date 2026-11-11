-- WeSpot Pro (v77, 2026-11-11). Per ora senza pagamenti online: i rinnovi li segna l'admin dal pannello.
-- Con Pro: aggiungere più di 3 posti, creare uscite di gruppo ed eventi, creare e modificare i tag NFC.
-- Senza Pro: fino a 3 posti, rispondere agli inviti, collegare i tag ricevuti, ricevere le segnalazioni dei tag.
-- I tag funzionano sempre, con o senza Pro. Collegare un tag acquistato aggiunge un anno di Pro.
-- I nuovi iscritti hanno 14 giorni di prova. Chi era già iscritto riceve Pro gratis fino al 31/12/2026.
-- Da eseguire una volta nell'editor SQL del progetto, dopo tag-clienti.sql.

create table if not exists public.pro_accounts (
  user_id uuid primary key references auth.users on delete cascade,
  until timestamptz not null,
  trial boolean not null default false,
  note text not null default '' check (length(note) <= 200),
  updated_at timestamptz not null default now()
);
alter table public.pro_accounts enable row level security;
revoke all on public.pro_accounts from anon, authenticated;

-- Chi era già iscritto prima di Pro: regalo fino a fine anno (non tocca chi ha già una riga)
insert into public.pro_accounts (user_id, until, note)
  select id, timestamptz '2027-01-01 00:00 Europe/Rome', 'iscritto prima di Pro' from auth.users
  on conflict (user_id) do nothing;

create or replace function public.is_pro(uid uuid default auth.uid())
returns boolean
language sql security definer stable set search_path = public as $$
  select uid is not null and (
    exists (select 1 from admins where user_id = uid)
    or exists (select 1 from pro_accounts where user_id = uid and until > now()));
$$;
revoke all on function public.is_pro(uuid) from public, anon;
grant execute on function public.is_pro(uuid) to authenticated;

-- Stato di Pro per l'app. Al primo accesso di un nuovo iscritto parte la prova di 14 giorni.
create or replace function public.my_pro()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r pro_accounts; adm boolean;
begin
  if auth.uid() is null then return jsonb_build_object('pro', false); end if;
  adm := exists (select 1 from admins where user_id = auth.uid());
  select * into r from pro_accounts where user_id = auth.uid();
  if not found then
    insert into pro_accounts (user_id, until, trial, note) values (auth.uid(), now() + interval '14 days', true, 'prova')
      on conflict (user_id) do nothing;
    select * into r from pro_accounts where user_id = auth.uid();
  end if;
  return jsonb_build_object('pro', adm or r.until > now(), 'until', r.until, 'trial', r.trial, 'admin', adm);
end $$;
revoke all on function public.my_pro() from public, anon;
grant execute on function public.my_pro() to authenticated;

-- Uscite, eventi e tag: crearli (e modificare i tag) richiede Pro.
-- Sono regole "restrictive": si aggiungono a quelle già presenti senza cambiarle.
drop policy if exists "creare uscite richiede pro" on public.outings;
create policy "creare uscite richiede pro" on public.outings as restrictive
  for insert to authenticated with check (public.is_pro());
drop policy if exists "creare tag richiede pro" on public.pet_tags;
create policy "creare tag richiede pro" on public.pet_tags as restrictive
  for insert to authenticated with check (public.is_pro());
drop policy if exists "modificare tag richiede pro" on public.pet_tags;
create policy "modificare tag richiede pro" on public.pet_tags as restrictive
  for update to authenticated using (public.is_pro());

-- Collegare un tag acquistato aggiunge un anno di Pro (dalla scadenza attuale, o da oggi se è già scaduto)
create or replace function public.claim_tag(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); t pet_tags; u timestamptz;
begin
  if auth.uid() is null then raise exception 'entra con il tuo account' using errcode = '42501'; end if;
  select * into t from pet_tags where claim_code = c;
  if not found then raise exception 'codice non valido'; end if;
  if t.claimed_at is not null then
    if t.owner = auth.uid() then
      return jsonb_build_object('id', t.id, 'kind', t.kind, 'name', t.name, 'pro_until', (select until from pro_accounts where user_id = auth.uid()));
    end if;
    raise exception 'codice già usato';
  end if;
  update pet_tags set owner = auth.uid(), claimed_at = now(), updated_at = now() where id = t.id;
  delete from tag_sightings where tag_id = t.id;
  insert into pro_accounts (user_id, until, trial, note) values (auth.uid(), now() + interval '1 year', false, 'tag ' || t.id)
    on conflict (user_id) do update
      set until = greatest(pro_accounts.until, now()) + interval '1 year', trial = false,
          note = left('tag ' || t.id || ' · ' || pro_accounts.note, 200), updated_at = now()
    returning until into u;
  return jsonb_build_object('id', t.id, 'kind', t.kind, 'name', t.name, 'pro_until', u);
end $$;
revoke all on function public.claim_tag(text) from public, anon;
grant execute on function public.claim_tag(text) to authenticated;

-- Pannello admin: iscritti con la scadenza di Pro
drop function if exists public.admin_users();
create or replace function public.admin_users()
returns table (id uuid, email text, name text, joined timestamptz, last_seen timestamptz, places int,
               pro_until timestamptz, pro_trial boolean, is_admin boolean)
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'non autorizzato' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, coalesce(pr.name, '')::text, u.created_at, u.last_sign_in_at,
           (select count(*) from places p where p.user_id = u.id and not p.deleted)::int,
           pa.until, coalesce(pa.trial, false), exists (select 1 from admins a where a.user_id = u.id)
    from auth.users u
    left join profiles pr on pr.id = u.id
    left join pro_accounts pa on pa.user_id = u.id
    order by u.created_at desc;
end;
$$;
revoke all on function public.admin_users() from public, anon;
grant execute on function public.admin_users() to authenticated;

-- Pannello admin: rinnovo a mano (mesi in più dalla scadenza, o da oggi se è già scaduto; 0 = toglie Pro)
create or replace function public.admin_pro_add(p_user uuid, p_months int)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare u timestamptz;
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  if p_months < 0 or p_months > 60 then raise exception 'mesi non validi'; end if;
  insert into pro_accounts (user_id, until, trial, note)
    values (p_user, case when p_months = 0 then now() else now() + make_interval(months => p_months) end, false, 'admin')
    on conflict (user_id) do update
      set until = case when p_months = 0 then now() else greatest(pro_accounts.until, now()) + make_interval(months => p_months) end,
          trial = false, updated_at = now()
    returning until into u;
  return u;
end $$;
revoke all on function public.admin_pro_add(uuid, int) from public, anon;
grant execute on function public.admin_pro_add(uuid, int) to authenticated;
