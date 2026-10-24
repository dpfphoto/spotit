-- Link corti per gli inviti ai gruppi (2026-10-24): nel link vanno solo le prime 12 cifre del codice del gruppo,
-- es. wespot.me/#g=1a2b3c4d5e6f. Questa funzione trova il gruppo completo. I vecchi link lunghi funzionano ancora.
-- Da eseguire una volta nell'editor SQL del progetto.

create or replace function public.outing_by_short(s text) returns uuid
language sql security definer stable set search_path = public as $$
  -- solo chi ha fatto l'accesso, come outing_preview; se due gruppi avessero lo stesso inizio non ne apro nessuno
  select case when auth.uid() is null or s !~ '^[0-9a-f]{12}$' then null else (
    select case when count(*) = 1 then min(id::text)::uuid end
    from outings where left(replace(id::text, '-', ''), 12) = s) end;
$$;

revoke all on function public.outing_by_short(text) from public, anon;
grant execute on function public.outing_by_short(text) to authenticated;
