-- Arrivi: il telefono di chi ha detto "Ci sono" segna "In arrivo" o "Arrivato" vicino all'ora dell'uscita.
-- Si salva solo lo stato, mai la posizione. Da eseguire una volta nell'editor SQL del progetto, dopo push.sql.

alter table public.outing_members add column if not exists arrival text not null default '' check (arrival in ('', 'in_arrivo', 'arrivato'));
alter table public.outing_members add column if not exists arrival_at timestamptz;
grant select (arrival, arrival_at) on public.outing_members to authenticated;

-- Solo per sé stessi, solo se ha detto "Ci sono"; "Arrivato" non torna indietro a "In arrivo"
create or replace function public.set_arrival(oid uuid, state text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'accesso richiesto'; end if;
  if state not in ('in_arrivo', 'arrivato') then raise exception 'stato non valido'; end if;
  update outing_members set arrival = state, arrival_at = now()
  where outing_id = oid and user_id = auth.uid() and status = 'si'
    and arrival <> 'arrivato' and arrival <> state;
end;
$$;
revoke all on function public.set_arrival(uuid, text) from anon;
