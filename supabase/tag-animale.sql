-- Dati dell'animale sui tag (v79, 2026-11-11): specie, razza, sesso, microchip.
-- Stanno in una colonna "pet" (jsonb) del tag e della richiesta: { specie, razza, sesso, chip }.
-- Li vede anche chi trova il tag (il microchip serve al veterinario o al canile).
-- Da eseguire una volta nell'editor SQL, dopo tag-clienti.sql e pro.sql.

-- Ripulisce i dati: solo le 4 voci, testi corti, sesso maschio/femmina, microchip solo cifre e lettere
create or replace function public.tag_pet(p jsonb)
returns jsonb
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p) = 'object' then jsonb_strip_nulls(jsonb_build_object(
    'specie', nullif(left(trim(coalesce(p ->> 'specie', '')), 40), ''),
    'razza', nullif(left(trim(coalesce(p ->> 'razza', '')), 60), ''),
    'sesso', case when p ->> 'sesso' in ('maschio', 'femmina') then p ->> 'sesso' end,
    'chip', nullif(left(upper(regexp_replace(coalesce(p ->> 'chip', ''), '[^0-9A-Za-z]', '', 'g')), 20), '')
  )) else '{}'::jsonb end
$$;

alter table public.pet_tags add column if not exists pet jsonb not null default '{}';
alter table public.tag_requests add column if not exists pet jsonb not null default '{}';

-- Dall'app il tag si salva direttamente: ripulisco i dati prima di scriverli
create or replace function public.pet_tags_clean_pet()
returns trigger
language plpgsql set search_path = public as $$
begin
  new.pet := public.tag_pet(new.pet);
  return new;
end $$;
drop trigger if exists pet_tags_clean_pet on public.pet_tags;
create trigger pet_tags_clean_pet before insert or update of pet on public.pet_tags
  for each row execute function public.pet_tags_clean_pet();

grant insert (pet) on public.pet_tags to authenticated;
grant update (pet) on public.pet_tags to authenticated;

-- Pagina di chi legge il tag: in più i dati dell'animale
create or replace function public.get_tag(code text)
returns jsonb
language sql security definer stable set search_path = public as $$
  select jsonb_build_object('kind', kind, 'name', name, 'message', message, 'phone', phone, 'photo', photo, 'pet', pet,
                            'pending', claim_code is not null and claimed_at is null)
  from pet_tags where id = code
$$;
revoke all on function public.get_tag(text) from public;
grant execute on function public.get_tag(text) to anon, authenticated;

-- Pannello admin: crea il tag con anche i dati dell'animale (sostituisce la versione senza)
drop function if exists public.admin_create_tag(text, text, text, text, text, text, uuid);
create or replace function public.admin_create_tag(p_kind text, p_name text, p_message text, p_phone text, p_client text,
  p_photo text default '', p_request uuid default null, p_pet jsonb default '{}')
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
      insert into pet_tags (id, owner, kind, name, message, phone, client, claim_code, photo, pet)
        values (tid, auth.uid(), coalesce(nullif(p_kind, ''), 'animale'), left(trim(coalesce(p_name, '')), 40),
                left(trim(coalesce(p_message, '')), 500), ph, left(trim(coalesce(p_client, '')), 80), cc,
                case when coalesce(p_photo, '') ~ '^data:image/(png|jpeg|webp);base64,' and length(p_photo) <= 400000 then p_photo else '' end,
                case when coalesce(nullif(p_kind, ''), 'animale') = 'animale' then public.tag_pet(p_pet) else '{}'::jsonb end);
      if p_request is not null then
        update tag_requests set status = 'evasa', tag_id = tid where id = p_request;
      end if;
      return jsonb_build_object('id', tid, 'claim', cc);
    exception when unique_violation then null;
    end;
  end loop;
  raise exception 'non riesco a creare il codice, riprova';
end $$;
revoke all on function public.admin_create_tag(text, text, text, text, text, text, uuid, jsonb) from public, anon;
grant execute on function public.admin_create_tag(text, text, text, text, text, text, uuid, jsonb) to authenticated;

-- Scheda di richiesta con i dati dell'animale (le versioni senza restano per le pagine già aperte)
create or replace function public.submit_tag_request(p_kind text, p_name text, p_message text, p_phone text, p_photo text,
  p_buyer_name text, p_buyer_email text, p_buyer_phone text, p_address text, p_notes text, p_consent boolean, p_promo text, p_pet jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  rid := public.submit_tag_request(p_kind, p_name, p_message, p_phone, p_photo, p_buyer_name, p_buyer_email, p_buyer_phone, p_address, p_notes, p_consent, p_promo);
  if p_kind = 'animale' then update tag_requests set pet = public.tag_pet(p_pet) where id = rid; end if;
  return rid;
end $$;
revoke all on function public.submit_tag_request(text, text, text, text, text, text, text, text, text, text, boolean, text, jsonb) from public;
grant execute on function public.submit_tag_request(text, text, text, text, text, text, text, text, text, text, boolean, text, jsonb) to anon, authenticated;

-- admin_tag_requests restituisce "setof tag_requests": la ricreo perché includa la nuova colonna
create or replace function public.admin_tag_requests()
returns setof public.tag_requests
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  return query select * from tag_requests order by created_at desc limit 200;
end $$;
revoke all on function public.admin_tag_requests() from public, anon;
grant execute on function public.admin_tag_requests() to authenticated;
