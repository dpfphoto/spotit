-- Copertina personalizzata di uscite ed eventi: covers/<id uscita>.jpg.
-- Cartella pubblica in lettura (il nome è l'id dell'uscita, lo conosce solo chi ha il link);
-- la può caricare, cambiare o togliere solo chi organizza.
-- Da eseguire una volta nell'editor SQL del progetto.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 1048576, array['image/jpeg'])
on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

create or replace function public.owns_cover(file text) returns boolean
language sql security definer stable set search_path = public as $$
  select case when file ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
    then exists (select 1 from outings where id = split_part(file, '.', 1)::uuid and owner = auth.uid())
    else false end;
$$;

drop policy if exists "copertine di chi organizza" on storage.objects;
create policy "copertine di chi organizza" on storage.objects
  for all to authenticated
  using (bucket_id = 'covers' and public.owns_cover(name))
  with check (bucket_id = 'covers' and public.owns_cover(name));
