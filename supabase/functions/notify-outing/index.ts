// Avvisa l'organizzatore quando un amico risponde "Ci sono" a un'uscita.
// Le chiavi per le notifiche (VAPID) le crea questa funzione al primo uso e restano nel database.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const APP_URL = 'https://dpfphoto.github.io/spotit/';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-token'
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

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const keys = await vapidKeys();
    const body = await req.json().catch(() => ({}));
    if (body.action === 'key') return json({ publicKey: keys.publicKey });

    // I token degli utenti sono firmati con la chiave nuova del progetto: l'app li manda in x-user-token
    // (Authorization porta la chiave pubblica anon, che il gateway di Supabase accetta)
    const jwt = req.headers.get('x-user-token') || (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await admin.auth.getUser(jwt);
    const user = auth && auth.user;
    if (!user) return json({ error: 'accesso richiesto' }, 401);

    if (body.action !== 'going' || typeof body.member_id !== 'string') return json({ error: 'richiesta non valida' }, 400);
    const { data: m } = await admin.from('outing_members')
      .select('id, name, status, user_id, notified, outing_id').eq('id', body.member_id).maybeSingle();
    // Solo chi ha risposto può far partire l'avviso, e una volta sola
    if (!m || m.user_id !== user.id || m.status !== 'si' || m.notified) return json({ sent: 0 });
    const { data: o } = await admin.from('outings').select('owner, place, starts_at').eq('id', m.outing_id).maybeSingle();
    if (!o || o.owner === user.id) return json({ sent: 0 });
    await admin.from('outing_members').update({ notified: true }).eq('id', m.id);

    const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth').eq('user_id', o.owner);
    const payload = JSON.stringify({
      title: `${m.name} c'è!`,
      body: `Ha risposto "Ci sono" per ${(o.place && o.place.n) || 'la tua uscita'}`,
      url: `${APP_URL}#g=${m.outing_id}`,
      tag: `uscita-${m.outing_id}`
    });
    let sent = 0;
    for (const s of subs || []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // Telefono che non accetta più notifiche: lo tolgo
        if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      }
    }
    return json({ sent });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
