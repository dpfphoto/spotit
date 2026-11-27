-- Co-amministratori di uscite ed eventi (v82, 2026-11-27).
-- Chi organizza può nominare co-amministratore un partecipante entrato con il link.
-- Il co-amministratore fa quasi tutto come chi organizza: modifica data, titolo, nota, tappe, copertina e foto,
-- aggiunge e toglie partecipanti, vede i loro numeri, toglie le note, e riceve gli stessi avvisi.
-- Solo chi organizza può: nominare o togliere co-amministratori, annullare/eliminare l'uscita.
-- Da eseguire una volta nell'editor SQL, dopo outings.sql, push.sql, registro.sql ed event-photos.sql.

alter table public.outing_members add column if not exists role text not null default '';
alter table public.outing_members drop constraint if exists outing_members_role_check;
alter table public.outing_members add constraint outing_members_role_check check (role in ('', 'admin'));
grant select (role) on public.outing_members to authenticated;

-- Organizzatore o co-amministratore
create or replace function public.is_outing_admin(oid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from outings where id = oid and owner = auth.uid())
      or exists (select 1 from outing_members where outing_id = oid and user_id = auth.uid() and role = 'admin');
$$;
revoke all on function public.is_outing_admin(uuid) from anon;

-- Chi organizza resta sempre lo stesso; il ruolo si cambia solo con set_outing_admin qui sotto
create or replace function public.outings_keep_owner() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.owner is distinct from old.owner then raise exception 'non si cambia chi organizza'; end if;
  return new;
end $$;
drop trigger if exists outings_keep_owner on public.outings;
create trigger outings_keep_owner before update on public.outings for each row execute function public.outings_keep_owner();

create or replace function public.outing_members_role_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('wespot.role_ok', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' and new.role <> '' then new.role := ''; end if;
  if tg_op = 'UPDATE' and new.role is distinct from old.role then new.role := old.role; end if;
  return new;
end $$;
drop trigger if exists outing_members_role_guard on public.outing_members;
create trigger outing_members_role_guard before insert or update on public.outing_members
  for each row execute function public.outing_members_role_guard();

-- Modifiche all'uscita: anche i co-amministratori (eliminarla resta solo di chi organizza)
drop policy if exists "uscite gestite dall'organizzatore" on public.outings;
create policy "uscite gestite dall'organizzatore" on public.outings
  for update using (public.is_outing_admin(id)) with check (public.is_outing_admin(id));

-- Partecipanti: li aggiungono e li tolgono anche i co-amministratori,
-- ma chi organizza e gli altri co-amministratori li toglie solo chi organizza
drop policy if exists "partecipanti aggiunti dall'organizzatore" on public.outing_members;
create policy "partecipanti aggiunti dall'organizzatore" on public.outing_members
  for insert with check (public.is_outing_admin(outing_id));
drop policy if exists "risposta propria o dell'organizzatore" on public.outing_members;
create policy "risposta propria o dell'organizzatore" on public.outing_members
  for update using (user_id = auth.uid() or public.is_outing_admin(outing_id));
drop policy if exists "rimozione propria o dell'organizzatore" on public.outing_members;
create policy "rimozione propria o dell'organizzatore" on public.outing_members
  for delete using (
    user_id = auth.uid()
    or exists (select 1 from public.outings o where o.id = outing_id and o.owner = auth.uid())
    or (public.is_outing_admin(outing_id) and role = ''
        and user_id is distinct from (select o.owner from public.outings o where o.id = outing_id)));

-- Note: le toglie l'autore, chi organizza o un co-amministratore
drop policy if exists "note tolte dall'autore o dall'organizzatore" on public.outing_notes;
create policy "note tolte dall'autore o dall'organizzatore" on public.outing_notes
  for delete using (user_id = auth.uid() or public.is_outing_admin(outing_id));

-- Numeri dei partecipanti: anche per i co-amministratori
create or replace function public.outing_phones(oid uuid) returns table (id uuid, phone text)
language sql security definer stable set search_path = public as $$
  select m.id, m.phone from outing_members m
  where m.outing_id = oid and public.is_outing_admin(oid) and m.phone <> '';
$$;
revoke all on function public.outing_phones(uuid) from anon;

-- Copertina e foto: anche i co-amministratori
create or replace function public.owns_cover(file text) returns boolean
language sql security definer stable set search_path = public as $$
  select case when file ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_[0-9]{1,16})?\.jpg$'
    then public.is_outing_admin(left(file, 36)::uuid)
    else false end;
$$;

-- Nomina o toglie un co-amministratore: solo chi organizza, e solo chi è entrato con il link
create or replace function public.set_outing_admin(p_member uuid, p_admin boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m outing_members;
begin
  select * into m from outing_members where id = p_member;
  if not found then raise exception 'partecipante non trovato'; end if;
  if not exists (select 1 from outings where id = m.outing_id and owner = auth.uid()) then
    raise exception 'solo chi organizza' using errcode = '42501';
  end if;
  if m.user_id is null then raise exception 'non è ancora entrato con il link'; end if;
  if m.user_id = auth.uid() then raise exception 'sei già chi organizza'; end if;
  perform set_config('wespot.role_ok', '1', true);
  update outing_members set role = case when p_admin then 'admin' else '' end where id = p_member;
end $$;
revoke all on function public.set_outing_admin(uuid, boolean) from public, anon;
grant execute on function public.set_outing_admin(uuid, boolean) to authenticated;
