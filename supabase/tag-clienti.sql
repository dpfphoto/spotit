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
create or replace function public.admin_create_tag(p_kind text, p_name text, p_message text, p_phone text, p_client text)
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
      insert into pet_tags (id, owner, kind, name, message, phone, client, claim_code)
        values (tid, auth.uid(), coalesce(nullif(p_kind, ''), 'animale'), left(trim(coalesce(p_name, '')), 40),
                left(trim(coalesce(p_message, '')), 500), ph, left(trim(coalesce(p_client, '')), 80), cc);
      return jsonb_build_object('id', tid, 'claim', cc);
    exception when unique_violation then null;
    end;
  end loop;
  raise exception 'non riesco a creare il codice, riprova';
end $$;
revoke all on function public.admin_create_tag(text, text, text, text, text) from public, anon;
grant execute on function public.admin_create_tag(text, text, text, text, text) to authenticated;

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
