-- "Ritardo di..." (2026-10-23): chi viene a un'uscita può far sapere al gruppo che arriva con qualche minuto di ritardo.
-- Da eseguire una volta nell'editor SQL del progetto, dopo arrivals.sql.

alter table public.outing_members add column if not exists delay_min int not null default 0 check (delay_min between 0 and 180);
grant select (delay_min) on public.outing_members to authenticated;

-- Solo per sé stessi, solo se ha detto "Ci sono" o "Forse" e non è ancora arrivato; 0 toglie il ritardo
create or replace function public.set_delay(oid uuid, minutes int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'accesso richiesto'; end if;
  if minutes < 0 or minutes > 180 then raise exception 'ritardo non valido'; end if;
  update outing_members set delay_min = minutes
  where outing_id = oid and user_id = auth.uid() and status in ('si', 'forse') and arrival <> 'arrivato';
end;
$$;
revoke all on function public.set_delay(uuid, int) from anon;
