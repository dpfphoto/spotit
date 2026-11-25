-- Foto e locandine di uscite ed eventi (v81): oltre alla copertina <id>.jpg, chi organizza
-- può mettere fino a 8 foto nella stessa cartella pubblica "covers", con nome <id>_<numero>.jpg.
-- Allarga solo i nomi ammessi: la regola resta "le carica, cambia o toglie solo chi organizza".
-- Da eseguire una volta nell'editor SQL del progetto.

create or replace function public.owns_cover(file text) returns boolean
language sql security definer stable set search_path = public as $$
  select case when file ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_[0-9]{1,16})?\.jpg$'
    then exists (select 1 from outings where id = left(file, 36)::uuid and owner = auth.uid())
    else false end;
$$;
