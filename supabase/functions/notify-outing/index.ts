// Notifiche push: l'organizzatore quando un amico risponde "Ci sono", chi partecipa quando l'uscita viene annullata
// o quando qualcuno ritarda, sta arrivando o è arrivato,
// e il promemoria prima dell'uscita (azione 'tick', chiamata ogni 5 minuti da pg_cron).
// Le chiavi per le notifiche (VAPID) le crea questa funzione al primo uso e restano nel database.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const APP_URL = 'https://wespot.me/';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-token, x-cron-secret'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

async function vapidKeys() {
  const read = () => admin.from('app_secrets').select('value').eq('name', 'vapid').maybeSingle();
  let { data } = await read();
  if (!data) {
    const k = webpush.generateVAPIDKeys();
    await admin.from('app_secrets').insert({ name: 'vapid', value: k });
    ({ data } = await read()); // se due richieste arrivano insieme vince la prima chiave salvata
  }
  const k = data!.value as { publicKey: string; privateKey: string };
  webpush.setVapidDetails('mailto:flaviodiproperzio@gmail.com', k.publicKey, k.privateKey);
  return k;
}

type Sub = { endpoint: string; p256dh: string; auth: string; sound?: boolean };
async function pushTo(subs: Sub[], payload: { title: string; body: string; url: string; tag: string }, ttl = 3600) {
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ ...payload, silent: s.sound === false }), { TTL: ttl });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // Telefono che non accetta più notifiche: lo tolgo
      if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
    }
  }
  return sent;
}

// "2026-10-23T20:30" è ora italiana: la porto in millisecondi veri
function romeMs(local: string) {
  const asUtc = Date.parse(local + ':00Z');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(asUtc));
  const g = (t: string) => Number(parts.find(p => p.type === t)!.value);
  const shown = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  return asUtc - (shown - asUtc);
}
function leadLabel(min: number) {
  if (min >= 1440) return `${Math.round(min / 1440)} giorno`;
  if (min >= 60) return `${Math.round(min / 60)} ${min >= 120 ? 'ore' : 'ora'}`;
  return `${min} minuti`;
}
function hhmm(local: string) { return local.slice(11, 16); }

async function tick() {
  const now = Date.now();
  const lo = new Date(now - 36e5).toISOString().slice(0, 16), hi = new Date(now + 3 * 864e5).toISOString().slice(0, 16);
  const { data: outs } = await admin.from('outings').select('id, place, starts_at, outing_members(user_id, status)').gte('starts_at', lo).lte('starts_at', hi);
  let sent = 0;
  for (const o of outs || []) {
    const start = romeMs(o.starts_at);
    if (start <= now) continue;
    const users = [...new Set((o.outing_members || []).filter((m: { user_id: string | null; status: string }) => m.user_id && (m.status === 'si' || m.status === 'forse')).map((m: { user_id: string }) => m.user_id))];
    if (!users.length) continue;
    const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth, lead_min, sound').in('user_id', users);
    for (const s of subs || []) {
      if (!s.lead_min || start - s.lead_min * 60000 > now) continue;
      const key = `${o.id}|${s.endpoint}|${o.starts_at}`;
      const { error } = await admin.from('push_sent').insert({ key });
      if (error) continue; // già avvisato
      const name = (o.place && o.place.n) || 'la tua uscita';
      const left = Math.max(1, Math.round((start - now) / 60000));
      sent += await pushTo([s], {
        title: `Tra ${left >= 90 ? leadLabel(Math.round(left / 30) * 30) : left + ' minuti'}: ${name}`,
        body: `Ci vediamo alle ${hhmm(o.starts_at)}${o.place && o.place.a ? ' · ' + o.place.a : ''}`,
        url: `${APP_URL}#g=${o.id}`, tag: `promemoria-${o.id}`
      }, 1800);
    }
  }
  await admin.from('push_sent').delete().lt('created_at', new Date(now - 7 * 864e5).toISOString());
  return sent;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const keys = await vapidKeys();
    const body = await req.json().catch(() => ({}));
    if (body.action === 'key') return json({ publicKey: keys.publicKey });

    if (body.action === 'tick') {
      const { data: sec } = await admin.from('app_secrets').select('value').eq('name', 'cron').maybeSingle();
      const given = req.headers.get('x-cron-secret');
      if (!sec || !given || given !== (sec.value as { s: string }).s) return json({ error: 'non autorizzato' }, 401);
      return json({ sent: await tick() });
    }

    // I token degli utenti sono firmati con la chiave nuova del progetto: l'app li manda in x-user-token
    // (Authorization porta la chiave pubblica anon, che il gateway di Supabase accetta)
    const jwt = req.headers.get('x-user-token') || (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await admin.auth.getUser(jwt);
    const user = auth && auth.user;
    if (!user) return json({ error: 'accesso richiesto' }, 401);

    if (body.action === 'cancel' && typeof body.outing_id === 'string') {
      const { data: o } = await admin.from('outings').select('id, owner, place, starts_at, outing_members(user_id, status)').eq('id', body.outing_id).maybeSingle();
      if (!o || o.owner !== user.id) return json({ sent: 0 });
      const users = [...new Set((o.outing_members || []).filter((m: { user_id: string | null; status: string }) => m.user_id && m.user_id !== user.id && (m.status === 'si' || m.status === 'forse')).map((m: { user_id: string }) => m.user_id))];
      if (!users.length) return json({ sent: 0 });
      const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth, sound').in('user_id', users);
      const sent = await pushTo(subs || [], {
        title: 'Uscita annullata',
        body: `"${(o.place && o.place.n) || 'Un\'uscita'}" è stata annullata`,
        url: APP_URL, tag: `uscita-${o.id}`
      });
      return json({ sent });
    }

    if (body.action === 'late' && typeof body.outing_id === 'string') {
      const { data: o } = await admin.from('outings').select('id, place, starts_at, outing_members(user_id, name, status, delay_min)').eq('id', body.outing_id).maybeSingle();
      if (!o) return json({ sent: 0 });
      const mem = (o.outing_members || []) as { user_id: string | null; name: string; status: string; delay_min: number }[];
      const mine = mem.find(m => m.user_id === user.id);
      if (!mine || !(mine.delay_min > 0) || !['si', 'forse'].includes(mine.status)) return json({ sent: 0 });
      const users = [...new Set(mem.filter(m => m.user_id && m.user_id !== user.id && (m.status === 'si' || m.status === 'forse')).map(m => m.user_id as string))];
      if (!users.length) return json({ sent: 0 });
      const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth, sound').in('user_id', users);
      const sent = await pushTo(subs || [], {
        title: `${mine.name} ritarda ${mine.delay_min > 60 ? 'di oltre 1 ora' : mine.delay_min === 60 ? 'di 1 ora' : 'di ' + mine.delay_min + ' minuti'}`,
        body: `Per "${(o.place && o.place.n) || 'l\'uscita'}" delle ${hhmm(o.starts_at)}`,
        url: `${APP_URL}#g=${o.id}`, tag: `ritardo-${o.id}-${user.id}`
      }, 1800);
      return json({ sent });
    }

    // "Sta arrivando" / "È arrivato": avviso tutto il gruppo (una volta per ogni stato segnato)
    if (body.action === 'arrival' && typeof body.outing_id === 'string') {
      const { data: o } = await admin.from('outings').select('id, place, starts_at, outing_members(user_id, name, status, arrival, arrival_at)').eq('id', body.outing_id).maybeSingle();
      if (!o) return json({ sent: 0 });
      const mem = (o.outing_members || []) as { user_id: string | null; name: string; status: string; arrival: string; arrival_at: string | null }[];
      const mine = mem.find(m => m.user_id === user.id);
      if (!mine || mine.status !== 'si' || !['in_arrivo', 'arrivato'].includes(mine.arrival)) return json({ sent: 0 });
      const { error: dup } = await admin.from('push_sent').insert({ key: `arrivo|${o.id}|${user.id}|${mine.arrival}|${mine.arrival_at}` });
      if (dup) return json({ sent: 0 });
      const users = [...new Set(mem.filter(m => m.user_id && m.user_id !== user.id && (m.status === 'si' || m.status === 'forse')).map(m => m.user_id as string))];
      if (!users.length) return json({ sent: 0 });
      const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth, sound').in('user_id', users);
      const here = mine.arrival === 'arrivato';
      const sent = await pushTo(subs || [], {
        title: here ? `📍 ${mine.name} è arrivato` : `🚗 ${mine.name} sta arrivando`,
        body: `A "${(o.place && o.place.n) || 'l\'uscita'}" delle ${hhmm(o.starts_at)}`,
        url: `${APP_URL}#g=${o.id}`, tag: `arrivo-${o.id}-${user.id}`
      }, 1800);
      return json({ sent });
    }

    if (body.action !== 'going' || typeof body.member_id !== 'string') return json({ error: 'richiesta non valida' }, 400);
    const { data: m } = await admin.from('outing_members')
      .select('id, name, status, user_id, notified, outing_id').eq('id', body.member_id).maybeSingle();
    // Solo chi ha risposto può far partire l'avviso, e una volta sola
    if (!m || m.user_id !== user.id || m.status !== 'si' || m.notified) return json({ sent: 0 });
    const { data: o } = await admin.from('outings').select('owner, place, starts_at').eq('id', m.outing_id).maybeSingle();
    if (!o || o.owner === user.id) return json({ sent: 0 });
    await admin.from('outing_members').update({ notified: true }).eq('id', m.id);

    const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth, sound').eq('user_id', o.owner);
    const sent = await pushTo(subs || [], {
      title: `${m.name} c'è!`,
      body: `Ha risposto "Ci sono" per ${(o.place && o.place.n) || 'la tua uscita'}`,
      url: `${APP_URL}#g=${m.outing_id}`,
      tag: `uscita-${m.outing_id}`
    });
    return json({ sent });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
