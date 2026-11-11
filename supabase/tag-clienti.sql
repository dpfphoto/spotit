-- Tag NFC preconfigurati per i clienti (v76, 2026-11-11).
-- L'admin crea il tag dal pannello admin con i dati del cliente, lo scrive sull'oggetto e lo spedisce
-- con un codice di attivazione. Il cliente entra in WeSpot e, con il codice, il tag passa al suo account.
-- Finché non è attivato il tag funziona già e le segnalazioni arrivano all'admin.
-- Da eseguire una volta nell'editor SQL del progetto, dopo tag-kinds-2.sql e admin.sql.

alter table public.pet_tags add column if not exists client text not null default '';
alter table public.pet_tags add column if not exists claim_code text;
alter table public.pet_tags add column if not exists claimed_at timestamptz;
alter table public.pet_tags drop constraint if exists pet_tags_client_check;
alter table public.pet_tags add constraint pet_tags_client_check check (length(client) <= 80);
alter table public.pet_tags drop constraint if exists pet_tags_claim_code_check;
alter table public.pet_tags add constraint pet_tags_claim_code_check check (claim_code ~ '^[A-HJ-NP-Z2-9]{8}$');
create unique index if not exists pet_tags_claim_code on public.pet_tags (claim_code) where claim_code is not null;

-- Richieste dalla scheda pubblica (richiesta.html): il cliente compila i dati del tag e i suoi recapiti.
-- Le legge solo l'admin, dal pannello. Nessuno le legge o scrive direttamente: solo con le funzioni qui sotto.
create table if not exists public.tag_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'animale' check (kind in ('animale', 'dpi', 'abiti', 'oggetto', 'altro')),
  name text not null default '' check (length(name) <= 40),
  message text not null default '' check (length(message) <= 500),
  phone text not null default '' check (phone ~ '^\+?[0-9]{0,15}$'),
  photo text not null default '' check (length(photo) <= 400000),
  buyer_name text not null check (length(buyer_name) between 1 and 80),
  buyer_email text not null default '' check (length(buyer_email) <= 120),
  buyer_phone text not null default '' check (buyer_phone ~ '^\+?[0-9]{0,15}$'),
  address text not null default '' check (length(address) <= 300),
  notes text not null default '' check (length(notes) <= 500),
  status text not null default 'nuova' check (status in ('nuova', 'evasa', 'annullata')),
  tag_id text,
  notified boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists tag_requests_created on public.tag_requests (created_at desc);
alter table public.tag_requests enable row level security;
revoke all on public.tag_requests from anon, authenticated;

-- Caratteri casuali (da gen_random_uuid, che è crittografico): niente 0/O e 1/I per non confondersi
create or replace function public.tag_random(abc text, len int)
returns text
language plpgsql volatile set search_path = public as $$
declare b bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()); s text := ''; i int := 0; pos int := 0;
begin
  while length(s) < len loop
    -- salto i byte di versione e variante degli uuid (6, 8, 22, 24)
    if pos not in (6, 8, 22, 24) then s := s || substr(abc, get_byte(b, pos) % length(abc) + 1, 1); end if;
    pos := pos + 1;
  end loop;
  return s;
end $$;
revoke all on function public.tag_random(text, int) from public, anon, authenticated;

-- Pannello admin: crea un tag per un cliente. Restituisce il codice del tag e il codice di attivazione.
drop function if exists public.admin_create_tag(text, text, text, text, text);
create or replace function public.admin_create_tag(p_kind text, p_name text, p_message text, p_phone text, p_client text,
  p_photo text default '', p_request uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare tid text; cc text; ph text := left(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), 16);
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  if ph !~ '^\+?[0-9]{0,15}$' then ph := ''; end if;
  for i in 1..5 loop
    tid := public.tag_random('abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', 7);
    cc := public.tag_random('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);
    begin
      insert into pet_tags (id, owner, kind, name, message, phone, client, claim_code, photo)
        values (tid, auth.uid(), coalesce(nullif(p_kind, ''), 'animale'), left(trim(coalesce(p_name, '')), 40),
                left(trim(coalesce(p_message, '')), 500), ph, left(trim(coalesce(p_client, '')), 80), cc,
                case when coalesce(p_photo, '') ~ '^data:image/(png|jpeg|webp);base64,' and length(p_photo) <= 400000 then p_photo else '' end);
      -- creato da una richiesta della scheda pubblica: la segno come evasa
      if p_request is not null then
        update tag_requests set status = 'evasa', tag_id = tid where id = p_request;
      end if;
      return jsonb_build_object('id', tid, 'claim', cc);
    exception when unique_violation then null;
    end;
  end loop;
  raise exception 'non riesco a creare il codice, riprova';
end $$;
revoke all on function public.admin_create_tag(text, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.admin_create_tag(text, text, text, text, text, text, uuid) to authenticated;

-- Pannello admin: tutti i tag fatti per i clienti, attivati o no (anche quelli passati ad altri account)
create or replace function public.admin_tags()
returns table (id text, kind text, name text, client text, claim_code text, created_at timestamptz,
               claimed_at timestamptz, owner_email text, sightings int)
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  return query
    select t.id, t.kind, t.name, t.client, t.claim_code, t.created_at, t.claimed_at,
           case when t.claimed_at is null then '' else coalesce(u.email, '')::text end,
           (select count(*) from tag_sightings s where s.tag_id = t.id)::int
    from pet_tags t left join auth.users u on u.id = t.owner
    where t.claim_code is not null
    order by t.created_at desc;
end $$;
revoke all on function public.admin_tags() from public, anon;
grant execute on function public.admin_tags() to authenticated;

-- Pannello admin: elimina un tag non ancora attivato
create or replace function public.admin_delete_tag(p_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  delete from pet_tags where id = p_id and claim_code is not null and claimed_at is null;
  if not found then raise exception 'tag già attivato o non trovato'; end if;
end $$;
revoke all on function public.admin_delete_tag(text) from public, anon;
grant execute on function public.admin_delete_tag(text) to authenticated;

-- Il cliente collega il tag al suo account con il codice di attivazione.
-- Le segnalazioni fatte prima (le prove prima della spedizione) vengono cancellate.
create or replace function public.claim_tag(p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare c text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')); t pet_tags;
begin
  if auth.uid() is null then raise exception 'entra con il tuo account' using errcode = '42501'; end if;
  select * into t from pet_tags where claim_code = c;
  if not found then raise exception 'codice non valido'; end if;
  if t.claimed_at is not null then
    if t.owner = auth.uid() then return jsonb_build_object('id', t.id, 'kind', t.kind, 'name', t.name); end if;
    raise exception 'codice già usato';
  end if;
  update pet_tags set owner = auth.uid(), claimed_at = now(), updated_at = now() where id = t.id;
  delete from tag_sightings where tag_id = t.id;
  return jsonb_build_object('id', t.id, 'kind', t.kind, 'name', t.name);
end $$;
revoke all on function public.claim_tag(text) from public, anon;
grant execute on function public.claim_tag(text) to authenticated;

-- Pagina di chi legge il tag: in più dice se il tag aspetta ancora di essere attivato dal cliente
create or replace function public.get_tag(code text)
returns jsonb
language sql security definer stable set search_path = public as $$
  select jsonb_build_object('kind', kind, 'name', name, 'message', message, 'phone', phone, 'photo', photo,
                            'pending', claim_code is not null and claimed_at is null)
  from pet_tags where id = code
$$;
revoke all on function public.get_tag(text) from public;
grant execute on function public.get_tag(text) to anon, authenticated;

-- Dall'app si cambiano solo i dati del tag, non il codice di attivazione né il cliente
revoke insert, update on public.pet_tags from authenticated;
grant insert (id, kind, name, message, phone, photo, updated_at) on public.pet_tags to authenticated;
grant update (kind, name, message, phone, photo, updated_at) on public.pet_tags to authenticated;

-- Scheda pubblica: invio di una richiesta (senza account). Al massimo 20 richieste ogni 10 minuti in tutto.
create or replace function public.submit_tag_request(p_kind text, p_name text, p_message text, p_phone text, p_photo text,
  p_buyer_name text, p_buyer_email text, p_buyer_phone text, p_address text, p_notes text, p_consent boolean)
returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid;
declare ph text := left(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), 16);
declare bph text := left(regexp_replace(coalesce(p_buyer_phone, ''), '[^0-9+]', '', 'g'), 16);
begin
  if p_consent is not true then raise exception 'serve il consenso'; end if;
  if length(trim(coalesce(p_buyer_name, ''))) = 0 then raise exception 'manca il nome'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'manca il nome del tag'; end if;
  if trim(coalesce(p_buyer_email, '')) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(bph) < 6 then raise exception 'serve un contatto'; end if;
  if (select count(*) from tag_requests where created_at > now() - interval '10 minutes') >= 20 then
    raise exception 'troppe richieste, riprova tra qualche minuto';
  end if;
  if ph !~ '^\+?[0-9]{0,15}$' then ph := ''; end if;
  if bph !~ '^\+?[0-9]{0,15}$' then bph := ''; end if;
  insert into tag_requests (kind, name, message, phone, photo, buyer_name, buyer_email, buyer_phone, address, notes)
    values (case when p_kind in ('animale', 'dpi', 'abiti', 'oggetto', 'altro') then p_kind else 'altro' end,
            left(trim(p_name), 40), left(trim(coalesce(p_message, '')), 500), ph,
            case when coalesce(p_photo, '') ~ '^data:image/(png|jpeg|webp);base64,' and length(p_photo) <= 400000 then p_photo else '' end,
            left(trim(p_buyer_name), 80), left(trim(coalesce(p_buyer_email, '')), 120), bph,
            left(trim(coalesce(p_address, '')), 300), left(trim(coalesce(p_notes, '')), 500))
    returning id into rid;
  return rid;
end $$;
revoke all on function public.submit_tag_request(text, text, text, text, text, text, text, text, text, text, boolean) from public;
grant execute on function public.submit_tag_request(text, text, text, text, text, text, text, text, text, text, boolean) to anon, authenticated;

-- Pannello admin: le richieste, le più recenti prima (le ultime 200)
create or replace function public.admin_tag_requests()
returns setof public.tag_requests
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  return query select * from tag_requests order by created_at desc limit 200;
end $$;
revoke all on function public.admin_tag_requests() from public, anon;
grant execute on function public.admin_tag_requests() to authenticated;

-- Pannello admin: segna una richiesta come annullata o di nuovo da fare
create or replace function public.admin_set_request(p_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  if p_status not in ('nuova', 'annullata') then raise exception 'stato non valido'; end if;
  update tag_requests set status = p_status where id = p_id and status <> 'evasa';
end $$;
revoke all on function public.admin_set_request(uuid, text) from public, anon;
grant execute on function public.admin_set_request(uuid, text) to authenticated;
