-- Tag NFC di più tipi (v70, 2026-11-08): oltre alla medaglietta dell'animale anche casco, oggetto o altro.
-- I tag già creati restano 'animale'. Da eseguire una volta nell'editor SQL del progetto, dopo medagliette.sql.

alter table public.pet_tags add column if not exists kind text not null default 'animale';
alter table public.pet_tags drop constraint if exists pet_tags_kind_check;
alter table public.pet_tags add constraint pet_tags_kind_check check (kind in ('animale', 'casco', 'oggetto', 'altro'));

create or replace function public.get_tag(code text)
returns jsonb
language sql security definer stable set search_path = public as $$
  select jsonb_build_object('kind', kind, 'name', name, 'message', message, 'phone', phone, 'photo', photo)
  from pet_tags where id = code
$$;
revoke all on function public.get_tag(text) from public;
grant execute on function public.get_tag(text) to anon, authenticated;
