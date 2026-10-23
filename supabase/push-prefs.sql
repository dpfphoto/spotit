-- Promemoria prima delle uscite, suono e avviso di annullamento. Da eseguire una volta nell'editor SQL, dopo push.sql.
-- Poi va ripubblicata la funzione notify-outing (supabase/functions/notify-outing/index.ts).

-- Per ogni telefono: quanti minuti prima avvisare (0 = mai) e se far suonare
alter table public.push_subscriptions add column if not exists lead_min int not null default 60 check (lead_min between 0 and 2880);
alter table public.push_subscriptions add column if not exists sound boolean not null default true;

-- Promemoria già mandati, per non ripeterli
create table if not exists public.push_sent (
  key text primary key,
  created_at timestamptz not null default now()
);
alter table public.push_sent enable row level security;
revoke all on public.push_sent from anon, authenticated;

-- Controllo automatico ogni 5 minuti: chiama la funzione con un segreto che sta solo nel database
create extension if not exists pg_cron;
create extension if not exists pg_net;
insert into public.app_secrets (name, value)
  values ('cron', jsonb_build_object('s', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')))
  on conflict do nothing;

select cron.unschedule('wespot-promemoria') where exists (select 1 from cron.job where jobname = 'wespot-promemoria');
select cron.schedule('wespot-promemoria', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://rznllkivahwgzmyzpxcb.supabase.co/functions/v1/notify-outing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '__ANON__',
      'Authorization', 'Bearer __ANON__',
      'x-cron-secret', (select value->>'s' from public.app_secrets where name = 'cron')),
    body := '{"action":"tick"}'::jsonb);
$job$);
