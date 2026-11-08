-- Tipi di tag NFC (v72, 2026-11-08, Flavio): "casco" diventa "DPI" e si aggiunge "abiti".
-- 'casco' resta ammesso per le app non ancora aggiornate (l'app lo mostra come DPI). Da eseguire una volta.

alter table public.pet_tags drop constraint if exists pet_tags_kind_check;
update public.pet_tags set kind = 'dpi' where kind = 'casco';
alter table public.pet_tags add constraint pet_tags_kind_check
  check (kind in ('animale', 'dpi', 'abiti', 'oggetto', 'altro', 'casco'));
