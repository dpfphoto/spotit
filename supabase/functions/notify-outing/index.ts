// Notifiche push: l'organizzatore quando un amico risponde "Ci sono", chi partecipa quando l'uscita viene annullata,
// e il promemoria prima dell'uscita (azione 'tick', chiamata ogni 5 minuti da pg_cron).
// Nello stesso giro avvisa i titolari dei locali iscritti quando qualcuno li salva (notifica subito, email al massimo una al giorno).
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

// ---------- Locali iscritti ----------

const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
function savesLabel(n: number) { return n === 1 ? 'Una persona ha' : `${n} persone hanno`; }

// Email con Resend: la chiave sta in app_secrets ('resend' = { key, from }). Finché manca, partono solo le notifiche.
async function sendEmail(to: string, subject: string, html: string) {
  const { data } = await admin.from('app_secrets').select('value').eq('name', 'resend').maybeSingle();
  const cfg = data && data.value as { key?: string; from?: string };
  if (!cfg || !cfg.key) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.from || 'WeSpot <avvisi@wespot.me>', to: [to], subject, html })
  });
  return res.ok;
}

function bizEmail(name: string, n: number, unsub: string) {
  const stop = `${APP_URL}stop.html?t=${unsub}`;
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#111">
<h2 style="color:#0F766E">Ciao ${esc(name)}! 👋</h2>
<p style="font-size:16px">${savesLabel(n)} appena salvato <b>${esc(name)}</b> su WeSpot tra i posti dove vuole andare o tornare.</p>
<p style="font-size:16px">Vieni a vedere quante persone ti hanno scelto:</p>
<p><a href="${APP_URL}#locale" style="background:#0F766E;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Apri WeSpot</a></p>
<p style="color:#666;font-size:13px;margin-top:32px">Ricevi questa email perché hai iscritto il tuo locale su WeSpot. Chi salva il locale resta anonimo.
<a href="${stop}" style="color:#666">Non voglio più ricevere queste email</a>.</p></div>`;
}

async function businessTick() {
  const { data: hits } = await admin.from('business_hits').select('business_id, user_id, pushed, emailed, created_at')
    .or('pushed.eq.false,emailed.eq.false').limit(500);
  if (!hits || !hits.length) return 0;
  const ids = [...new Set(hits.map(h => h.business_id))];
  const { data: biz } = await admin.from('businesses').select('id, owner, name, email, notify_email, last_email_at, unsub').in('id', ids);
  let sent = 0;
  for (const b of biz || []) {
    const mine = hits.filter(h => h.business_id === b.id);
    const toPush = mine.filter(h => !h.pushed);
    if (toPush.length) {
      const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth, sound').eq('user_id', b.owner);
      sent += await pushTo(subs || [], {
        title: `${b.name}: ${toPush.length === 1 ? 'una persona ti ha' : toPush.length + ' persone ti hanno'} salvato! ❤️`,
        body: 'Vieni a vedere quante persone hanno scelto il tuo locale su WeSpot',
        url: `${APP_URL}#locale`, tag: `locale-${b.id}`
      }, 86400);
      await admin.from('business_hits').update({ pushed: true }).eq('business_id', b.id).in('user_id', toPush.map(h => h.user_id));
    }
    const toMail = mine.filter(h => !h.emailed);
    if (!toMail.length) continue;
    // Email solo se attive, al massimo una ogni 24 ore con tutti i salvataggi nuovi
    if (!b.notify_email || !b.email) {
      await admin.from('business_hits').update({ emailed: true }).eq('business_id', b.id).in('user_id', toMail.map(h => h.user_id));
      continue;
    }
    if (b.last_email_at && Date.parse(b.last_email_at) > Date.now() - 864e5) continue;
    const ok = await sendEmail(b.email, `${b.name}: ${toMail.length === 1 ? 'qualcuno ti ha' : toMail.length + ' persone ti hanno'} salvato su WeSpot`, bizEmail(b.name, toMail.length, b.unsub));
    if (!ok) continue; // servizio email non ancora attivo: riprovo al prossimo giro
    sent++;
    await admin.from('businesses').update({ last_email_at: new Date().toISOString() }).eq('id', b.id);
    await admin.from('business_hits').update({ emailed: true }).eq('business_id', b.id).in('user_id', toMail.map(h => h.user_id));
  }
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
      const sent = await tick();
      let biz = 0;
      try { biz = await businessTick(); } catch { /* i locali non devono fermare i promemoria */ }
      return json({ sent, biz });
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
