-- Il logo personale segue l'account (PC e telefono). Da eseguire una volta nell'editor SQL.
alter table public.profiles add column if not exists logo text not null default '' check (char_length(logo) <= 60000);
