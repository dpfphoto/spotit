// Uscite di gruppo (archivio online): crei l'uscita da un posto, inviti gli amici
// con un link su WhatsApp o li aggiungi tu, e ognuno risponde se c'è.

(function () {
  const AUTH = window.SPOTIT_AUTH;
  if (!AUTH) {
    // Senza archivio online resta l'invito semplice con il link
    $('oCreate').hidden = true;
    $('oOld').hidden = false;
    $('oMine').hidden = false;
    $('btnEvent').hidden = true;
    return;
  }
  const sb = AUTH.sb;
  const PENDING_KEY = 'spotit.pendingGroup';
  // Numeri scritti dall'organizzatore prima che esistesse l'archivio dei numeri: { idPartecipante: numero }
  const PHONES_KEY = 'spotit.phones';
  let phones = load(PHONES_KEY, {});
  const STATUS = {
    si: { label: 'Ci sono', cls: 'yes' },
    forse: { label: 'Forse', cls: 'maybe' },
    no: { label: 'Non può', cls: 'no' },
    invitato: { label: 'Invitato', cls: 'wait' }
  };
  // Servizio notifiche: Authorization con la chiave anon (accettata dal gateway), l'utente in x-user-token
  async function callNotify(body) {
    const { data } = await sb.auth.getSession();
    const token = data.session && data.session.access_token;
    const res = await fetch(`${window.SPOTIT_CONFIG.supabaseUrl}/functions/v1/notify-outing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: window.SPOTIT_CONFIG.supabaseKey,
        Authorization: `Bearer ${window.SPOTIT_CONFIG.supabaseKey}`,
        ...(token ? { 'x-user-token': token } : {})
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('notify ' + res.status);
    return res.json();
  }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  let group = null;      // uscita aperta: { id, owner, owner_name, place, starts_at, note, members }
  let claimId = null;    // persona scelta in "Chi sei?"
  let travel = null;
  let pollTimer = null;
  let upcoming = [];
  let events = [];       // eventi privati di cui faccio parte, anche passati

  function me() { return AUTH.user(); }
  function myName() {
    const u = me();
    return prefs.name || (u && u.email ? u.email.split('@')[0] : '') || 'Amico';
  }
  // Evento privato (festa, cena a casa): non è un locale, sta solo sulla mappa di chi è nel gruppo
  function isEvent(g) { return !!(g && g.place && g.place.pv); }
  // Finita la festa: dopo 12 ore dall'inizio diventa "passato"
  function isPast(g) { return new Date(g.starts_at).getTime() + 12 * 3600000 < Date.now(); }
  function groupUrl(id) { return `${appUrl()}#g=${id}`; }
  function asOuting(g) {
    const p = g.place || {};
    return { n: p.n, a: p.a, la: p.la, lo: p.lo, t: g.starts_at, m: g.note || undefined, b: g.owner_name || undefined };
  }
  function placeOf(g) {
    const p = g.place || {};
    return { name: p.n, address: p.a || '', lat: p.la, lng: p.lo, gphoto: p.f || '', gphotoBy: p.fb || '' };
  }
  // Numero in formato internazionale per WhatsApp (in Italia si può scrivere senza +39)
  function normPhone(raw) {
    let d = String(raw || '').replace(/[^\d+]/g, '');
    if (d.startsWith('+')) d = d.slice(1);
    else if (d.startsWith('00')) d = d.slice(2);
    else if (/^3\d{8,9}$/.test(d)) d = '39' + d;
    d = d.replace(/\D/g, '');
    return d.length >= 8 && d.length <= 15 ? d : '';
  }
  function inviteText(g, name) {
    const o = asOuting(g);
    const hi = name ? `Ciao ${name}! ` : '';
    if (isEvent(g)) return `${hi}${myName()} ti invita a "${o.n}"${o.a ? ` (${o.a})` : ''} ${whenLabel(o.t)}${o.m ? `. ${o.m}` : ''}. Ci sei? Rispondi qui: ${groupUrl(g.id)}`;
    return `${hi}${myName()} organizza un'uscita da "${o.n}" ${whenLabel(o.t)}${o.m ? ` (${o.m})` : ''}. Ci sei? Rispondi qui: ${groupUrl(g.id)}`;
  }

  // ---------- Crea ----------

  $('oCreate').onclick = async () => {
    const o = readOuting(); if (!o) return;
    if (!me()) { toast('Entra con il tuo account per creare l\'uscita'); return; }
    const btn = $('oCreate');
    btn.disabled = true; btn.textContent = 'Creo…';
    try {
      const place = { n: o.n, a: o.a, la: o.la, lo: o.lo };
      if (o.g) place.g = o.g;
      if (o.f) { place.f = o.f; place.fb = o.fb || ''; }
      const { data, error } = await sb.from('outings')
        .insert({ owner_name: myName(), place, starts_at: o.t, note: o.m || '' })
        .select().single();
      if (error) throw error;
      const { error: e2 } = await sb.from('outing_members').insert({ outing_id: data.id, user_id: me().id, name: myName(), status: 'si' });
      if (e2) throw e2;
      $('dlgOuting').close();
      $('dlgPlace').close();
      await openGroup(data.id);
      toast('Uscita creata: ora invita gli amici');
    } catch (e) {
      toast('Non riesco a creare l\'uscita ora. Controlla la connessione e riprova.');
    }
    btn.disabled = false; btn.textContent = 'Crea l\'uscita';
  };

  // ---------- Evento privato ----------

  let evPlace = null; // { a, la, lo }
  function setEvPlace(p) {
    evPlace = p;
    $('eChosen').hidden = !p;
    $('ePick').hidden = !!p;
    $('eChosenText').textContent = p ? `📍 ${p.a}` : '';
  }
  $('btnEvent').onclick = () => {
    $('dlgAdd').close();
    const t = new Date();
    if (t.getHours() >= 20) t.setDate(t.getDate() + 1);
    t.setHours(21, 0, 0, 0);
    $('eName').value = ''; $('eAddr').value = ''; $('eMsgText').value = '';
    $('eMsg').textContent = ''; $('eResults').replaceChildren();
    $('eDate').value = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
    $('eDate').min = new Date().toISOString().slice(0, 10);
    $('eTime').value = '21:00';
    setEvPlace(null);
    $('dlgEvent').showModal();
  };
  $('eChange').onclick = () => { setEvPlace(null); $('eAddr').focus(); };
  $('eSearch').onsubmit = async e => {
    e.preventDefault();
    const q = $('eAddr').value.trim(); if (!q) return;
    $('eMsg').textContent = 'Cerco…'; $('eResults').replaceChildren();
    let data;
    try {
      try { data = GOOGLE_KEY ? await googleSearch(q) : await osmSearch(q); }
      catch (err) { if (!GOOGLE_KEY) throw err; data = await osmSearch(q); }
    } catch { $('eMsg').textContent = 'Ricerca non disponibile ora. Prova con "Usa la mia posizione".'; return; }
    $('eMsg').textContent = data.length ? 'Tocca l\'indirizzo giusto:' : 'Non trovo questo indirizzo. Aggiungi la città.';
    $('eResults').replaceChildren(...data.map(r => el('li', {}, el('button', {
      type: 'button',
      onclick: () => setEvPlace({ a: [r.name, r.address].filter(Boolean).join(', ').slice(0, 160), la: +r.lat.toFixed(6), lo: +r.lng.toFixed(6) })
    }, el('span', { class: 'name' }, r.name), el('span', { class: 'addr' }, r.address)))));
  };
  $('eHere').onclick = async () => {
    const b = $('eHere');
    b.disabled = true; b.textContent = 'Cerco la tua posizione…';
    try {
      const pos = await getPosition(false);
      const a = await reverseAddress(pos).catch(() => '');
      setEvPlace({ a: a || 'La mia posizione', la: +pos.lat.toFixed(6), lo: +pos.lng.toFixed(6) });
    } catch { toast('Posizione non disponibile: scrivi l\'indirizzo'); }
    b.disabled = false; b.textContent = '📍 Usa la mia posizione';
  };
  $('eCreate').onclick = async () => {
    const name = $('eName').value.trim();
    if (!name) { toast('Dai un nome all\'evento'); $('eName').focus(); return; }
    if (!evPlace) { toast('Scegli dove si fa'); return; }
    if (!$('eDate').value || !$('eTime').value) { toast('Scegli giorno e ora'); return; }
    if (!me()) { toast('Entra con il tuo account per creare l\'evento'); return; }
    const btn = $('eCreate');
    btn.disabled = true; btn.textContent = 'Creo…';
    try {
      const place = { n: name.slice(0, 80), a: evPlace.a, la: evPlace.la, lo: evPlace.lo, pv: 1 };
      const { data, error } = await sb.from('outings')
        .insert({ owner_name: myName(), place, starts_at: `${$('eDate').value}T${$('eTime').value}`, note: $('eMsgText').value.trim() })
        .select().single();
      if (error) throw error;
      const { error: e2 } = await sb.from('outing_members').insert({ outing_id: data.id, user_id: me().id, name: myName(), status: 'si' });
      if (e2) throw e2;
      $('dlgEvent').close();
      await openGroup(data.id);
      toast('Evento creato: ora invita gli amici');
    } catch {
      toast('Non riesco a creare l\'evento ora. Controlla la connessione e riprova.');
    }
    btn.disabled = false; btn.textContent = 'Crea l\'evento e invita';
  };

  // ---------- Apri ----------

  async function fetchGroup(id) {
    const { data, error } = await sb.from('outings').select('*, outing_members(id, user_id, name, status, created_at)').eq('id', id).maybeSingle();
    if (error) throw error;
    if (data) {
      data.members = (data.outing_members || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
      data.joined = true;
      // I numeri li vede solo l'organizzatore
      if (me() && data.owner === me().id) {
        const { data: ph } = await sb.rpc('outing_phones', { oid: id });
        for (const r of ph || []) { const m = data.members.find(x => x.id === r.id); if (m) m.phone = r.phone; }
      }
      return data;
    }
    // Non ne faccio ancora parte: anteprima dal link
    const { data: prev, error: e2 } = await sb.rpc('outing_preview', { oid: id });
    if (e2) throw e2;
    if (!prev) return null;
    prev.members = prev.members || [];
    prev.joined = false;
    return prev;
  }

  async function openGroup(id) {
    if (!UUID.test(id)) { toast('Invito non valido'); return; }
    let g;
    try { g = await fetchGroup(id); } catch { toast('Non riesco ad aprire l\'uscita ora. Riprova tra poco.'); return; }
    if (!g) { toast('Questa uscita non esiste più'); return; }
    group = g; claimId = null; travel = null;
    const p = placeOf(g);
    showCover($('gCover'), p);
    const ev = isEvent(g);
    $('gTitle').textContent = g.owner === (me() && me().id) ? (ev ? 'Il tuo evento' : 'La tua uscita') : (g.owner_name ? `${g.owner_name} ti invita` : 'Sei invitato');
    $('gName').textContent = p.name;
    $('gAddress').textContent = p.address;
    $('gWhen').textContent = (ev && isPast(g) ? 'Passato · ' : '') + whenLabel(g.starts_at) + (ev ? ' · 🔒 privato' : '');
    $('gCancel').textContent = ev ? (isPast(g) ? 'Elimina l\'evento' : 'Annulla l\'evento per tutti') : 'Annulla l\'uscita';
    $('gLeaveGroup').textContent = ev ? 'Togli dalla mia mappa' : 'Esci dal gruppo';
    $('gNote').hidden = !g.note;
    $('gNote').textContent = g.note ? `"${g.note}"` : '';
    $('gRoute').href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
    drawGroup();
    if (!$('dlgGroup').open) $('dlgGroup').showModal();
    if (typeof map !== 'undefined' && p.lat) map.setView([p.lat, p.lng], 15);
    showLeave(g);
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, 15000);
  }
  $('dlgGroup').addEventListener('close', () => { clearInterval(pollTimer); group = null; loadUpcoming(); });

  async function refresh() {
    if (!group || document.hidden) return;
    try {
      const g = await fetchGroup(group.id);
      if (g && group && g.id === group.id) { group = g; drawGroup(); }
    } catch { /* riprovo al prossimo giro */ }
  }

  async function showLeave(g) {
    const box = $('gLeave');
    box.hidden = false;
    box.textContent = 'Calcolo quando partire da dove sei…';
    try {
      const pos = await getPosition(false);
      const p = placeOf(g);
      travel = await travelMinutes(pos, p);
      const leave = new Date(new Date(g.starts_at).getTime() - (travel.min + MARGIN_MIN) * 60000);
      const hhmm = leave.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      box.replaceChildren(el('strong', {}, `Parti alle ${hhmm}`),
        ` · ${travel.exact ? '' : 'circa '}${travel.min} min in auto, con ${MARGIN_MIN} min di margine`);
    } catch {
      box.textContent = 'Attiva la posizione per sapere a che ora partire.';
    }
  }

  function drawGroup() {
    const g = group; if (!g) return;
    const u = me();
    const isOwner = u && g.owner === u.id;
    const mine = g.joined && u ? g.members.find(m => m.user_id === u.id) : null;

    // "Chi sei?": solo per chi arriva dal link ed è stato aggiunto a mano dall'organizzatore
    const free = g.joined ? [] : g.members.filter(m => !m.joined);
    $('gClaim').hidden = !free.length;
    $('gPhoneBox').hidden = g.joined;
    if (!g.joined && !$('gMyPhone').value) $('gMyPhone').value = prefs.phone || '';
    $('gClaimList').replaceChildren(...free.map(m => el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(claimId === m.id),
      onclick: () => { claimId = claimId === m.id ? null : m.id; drawGroup(); }
    }, m.name)), free.length ? el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(claimId === null),
      onclick: () => { claimId = null; drawGroup(); }
    }, `Sono ${myName()}`) : '');

    const answer = mine ? mine.status : null;
    $('gAnswer').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.a === answer)));

    const yes = g.members.filter(m => m.status === 'si').length;
    $('gCount').textContent = `${yes} ${yes === 1 ? 'c\'è' : 'ci sono'} su ${g.members.length}`;
    $('gMembers').replaceChildren(...g.members.map(m => {
      const st = STATUS[m.status] || STATUS.invitato;
      const phone = isOwner && (m.phone || phones[m.id]);
      const isMe = u && (m.user_id === u.id);
      return el('li', {},
        el('span', { class: 'm-name' }, m.name + (isMe ? ' (tu)' : ''),
          phone ? el('small', { class: 'm-phone' }, '+' + phone) : ''),
        el('span', { class: `m-status ${st.cls}` }, st.label),
        phone ? el('a', {
          class: 'm-wa', target: '_blank', rel: 'noopener', 'aria-label': `Manda l'invito a ${m.name} su WhatsApp`,
          href: `https://wa.me/${phone}?text=${encodeURIComponent(inviteText(g, m.name))}`
        }, 'WhatsApp') : '',
        isOwner && !isMe ? el('button', {
          type: 'button', class: 'm-del', 'aria-label': `Togli ${m.name}`, onclick: () => removeMember(m)
        }, '✕') : '');
    }));

    $('gAddForm').hidden = !isOwner;
    $('gNotify').hidden = !isOwner;
    if (isOwner) drawNotify();
    $('gCancel').hidden = !isOwner;
    $('gLeaveGroup').hidden = isOwner || !mine;
  }

  // ---------- Risposte ----------

  $('gAnswer').addEventListener('click', async e => {
    const b = e.target.closest('button[data-a]');
    if (!b || !group) return;
    const a = b.dataset.a;
    const u = me(); if (!u) return;
    try {
      const mine = group.joined ? group.members.find(m => m.user_id === u.id) : null;
      let memberId = mine && mine.id;
      if (mine) {
        const { error } = await sb.from('outing_members').update({ status: a }).eq('id', mine.id);
        if (error) throw error;
      } else {
        const raw = $('gMyPhone').value.trim();
        const myPhone = raw ? normPhone(raw) : '';
        if (raw && !myPhone) { toast('Numero non valido: scrivilo con il prefisso, es. +39 333 1234567'); return; }
        if (myPhone) { prefs.phone = raw; savePrefs(); }
        const args = { oid: group.id, claim: claimId, display_name: myName(), answer: a };
        let { data, error } = await sb.rpc('join_outing', myPhone ? { ...args, my_phone: myPhone } : args);
        // archivio non ancora aggiornato per i numeri: entro comunque
        if (error && myPhone) ({ data, error } = await sb.rpc('join_outing', args));
        if (error) throw error;
        memberId = data;
        saveGroupPlace(group);
      }
      // Avviso all'organizzatore (una volta sola per persona)
      if (a === 'si' && memberId && group.owner !== u.id) {
        callNotify({ action: 'going', member_id: memberId }).catch(() => {});
      }
      toast(a === 'si' ? 'Perfetto, ci sei!' : a === 'forse' ? 'Segnato come forse' : 'Ok, avviso il gruppo che non puoi');
      const g = await fetchGroup(group.id);
      if (g) { group = g; drawGroup(); }
    } catch {
      toast('Non riesco a salvare la risposta ora. Riprova.');
    }
  });

  // Chi entra nel gruppo trova il posto anche tra i suoi, come "Andarci"
  function saveGroupPlace(g) {
    if (isEvent(g)) return; // l'evento privato sta già sulla mappa come evento
    const p = placeOf(g);
    if (!p.name || places.some(x => x.name === p.name && Math.abs(x.lat - p.lat) < 1e-5)) return;
    const c = cleanPlace({ ...p, gid: (g.place && g.place.g) || '', from: g.owner_name || '', verdict: 'andarci', id: uid(), createdAt: Date.now() });
    if (c) { places.push(c); persist(); }
  }

  // ---------- Organizzatore ----------

  $('gAddForm').onsubmit = async e => {
    e.preventDefault();
    if (!group) return;
    const name = $('gAddName').value.trim().slice(0, 40);
    const rawPhone = $('gAddPhone').value.trim();
    const phone = rawPhone ? normPhone(rawPhone) : '';
    if (!name) return;
    if (rawPhone && !phone) { toast('Numero non valido: scrivilo con il prefisso, es. +39 333 1234567'); return; }
    try {
      const row = { outing_id: group.id, name, status: 'invitato' };
      let { data, error } = await sb.from('outing_members').insert(phone ? { ...row, phone } : row).select('id').single();
      if (error && phone) {
        // archivio non ancora aggiornato per i numeri: il numero resta su questo telefono
        ({ data, error } = await sb.from('outing_members').insert(row).select('id').single());
        if (!error) { phones[data.id] = phone; save(PHONES_KEY, phones); }
      }
      if (error) throw error;
      $('gAddName').value = ''; $('gAddPhone').value = '';
      if (phone) {
        window.open(`https://wa.me/${phone}?text=${encodeURIComponent(inviteText(group, name))}`, '_blank', 'noopener');
      } else toast(`${name} aggiunto`);
      const g = await fetchGroup(group.id);
      if (g) { group = g; drawGroup(); }
    } catch {
      toast('Non riesco ad aggiungerlo ora. Riprova.');
    }
  };

  async function removeMember(m) {
    if (!confirm(`Togliere ${m.name} dall'uscita?`)) return;
    const { error } = await sb.from('outing_members').delete().eq('id', m.id);
    if (error) { toast('Non riesco a toglierlo ora'); return; }
    delete phones[m.id]; save(PHONES_KEY, phones);
    refresh();
  }

  $('gCancel').onclick = async () => {
    const ev = isEvent(group);
    if (!group || !confirm(ev ? 'Eliminare l\'evento per tutti? Sparisce dalla mappa di tutti.' : 'Annullare l\'uscita per tutti?')) return;
    const { error } = await sb.from('outings').delete().eq('id', group.id);
    if (error) { toast('Non riesco ad annullarla ora'); return; }
    $('dlgGroup').close();
    toast(ev ? 'Evento eliminato' : 'Uscita annullata');
  };

  $('gLeaveGroup').onclick = async () => {
    const u = me();
    const mine = group && u && group.members.find(m => m.user_id === u.id);
    if (!mine || !confirm(isEvent(group) ? 'Togliere l\'evento dalla tua mappa? Esci anche dal gruppo.' : 'Uscire da questo gruppo?')) return;
    const { error } = await sb.from('outing_members').delete().eq('id', mine.id);
    if (error) { toast('Non riesco ora, riprova'); return; }
    $('dlgGroup').close();
  };

  // ---------- Notifiche all'organizzatore ----------

  const pushOk = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  async function currentSub() {
    if (!pushOk) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }
  async function drawNotify() {
    const b = $('gNotify');
    const on = pushOk && Notification.permission === 'granted' && await currentSub();
    b.textContent = on ? '🔔 Notifiche attive: ti avviso quando qualcuno dice "Ci sono"' : '🔔 Avvisami quando qualcuno dice "Ci sono"';
    b.classList.toggle('on', !!on);
  }
  function b64ToBytes(b64) {
    const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
  $('gNotify').onclick = async () => {
    if (isIos && !isStandalone) {
      toast('Su iPhone le notifiche arrivano solo se SpotIt è sulla schermata Home: Condividi → Aggiungi alla schermata Home');
      return;
    }
    if (!pushOk) { toast('Questo telefono non supporta le notifiche dal browser'); return; }
    // Il permesso va chiesto subito, dentro il tocco
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifiche non permesse: puoi attivarle dalle impostazioni del telefono'); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const data = await callNotify({ action: 'key' });
        if (!data || !data.publicKey) throw new Error('chiave');
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(data.publicKey) });
      }
      const j = sub.toJSON();
      const { error } = await sb.from('push_subscriptions').upsert({ endpoint: j.endpoint, user_id: me().id, p256dh: j.keys.p256dh, auth: j.keys.auth });
      if (error) throw error;
      toast('Fatto: ti avviso quando qualcuno dice "Ci sono"');
    } catch {
      toast('Non riesco ad attivare le notifiche ora. Riprova tra poco.');
    }
    drawNotify();
  };

  // ---------- Inviti ----------

  $('gWhatsapp').onclick = () => {
    if (!group) return;
    window.open('https://wa.me/?text=' + encodeURIComponent(inviteText(group)), '_blank', 'noopener');
  };
  $('gCalendar').onclick = () => { if (group) downloadIcs(asOuting(group), travel); };

  // ---------- Le tue uscite (in cima alla lista) ----------

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T00:00`;
  }
  async function loadUpcoming() {
    if (!me()) { upcoming = []; events = []; drawEvents(); return; }
    try {
      const { data, error } = await sb.from('outings').select('id, place, starts_at, owner_name, outing_members(status)')
        .order('starts_at').limit(200);
      if (error) throw error;
      const all = data || [];
      upcoming = all.filter(g => g.starts_at >= today() && !(isEvent(g) && isPast(g))).slice(0, 10);
      events = all.filter(isEvent);
      render();
      drawEvents();
      drawTripBtn();
    } catch { /* la lista resta quella di prima */ }
  }
  // Sulla mappa: gli eventi privati, in rosso quando sono passati
  const evLayer = L.layerGroup().addTo(map);
  function drawEvents() {
    evLayer.clearLayers();
    for (const g of events) {
      const p = g.place || {};
      if (!Number.isFinite(p.la) || !Number.isFinite(p.lo)) continue;
      const past = isPast(g);
      const icon = L.divIcon({ className: '', html: `<span class="ev-pin${past ? ' past' : ''}">🎉</span>`, iconSize: [36, 36], iconAnchor: [18, 18] });
      L.marker([p.la, p.lo], { icon, title: p.n, alt: `${p.n}, evento ${past ? 'passato' : 'privato'}`, zIndexOffset: 500 })
        .on('click', () => openGroup(g.id))
        .addTo(evLayer);
    }
  }
  // Sulla mappa: pulsante per la prossima uscita
  function dayLabel(t) {
    const d = new Date(t), now = new Date();
    const tm = new Date(now); tm.setDate(now.getDate() + 1);
    const hhmm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `${d.getHours() >= 18 ? 'stasera' : 'oggi'} alle ${hhmm}`;
    if (d.toDateString() === tm.toDateString()) return `domani alle ${hhmm}`;
    return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' }) + ` alle ${hhmm}`;
  }
  function drawTripBtn() {
    const b = $('tripBtn');
    const g = upcoming[0];
    b.hidden = !g || view !== 'map';
    if (!g) return;
    const yes = (g.outing_members || []).filter(m => m.status === 'si').length;
    b.textContent = `${isEvent(g) ? '🎉' : '🍽️'} ${(g.place && g.place.n) || 'Uscita'} · ${dayLabel(g.starts_at)}`;
    b.setAttribute('aria-label', `Apri l'uscita: ${yes} ci sono`);
    b.onclick = () => openGroup(g.id);
  }
  $('tabMap').addEventListener('click', drawTripBtn);
  $('tabList').addEventListener('click', drawTripBtn);

  const renderPlaces = renderList;
  renderList = function (list) {
    renderPlaces(list);
    if (!upcoming.length) return;
    const box = $('list');
    const block = el('div', { class: 'trips' }, el('p', { class: 'trips-title' }, 'Le tue uscite'),
      ...upcoming.map(g => {
        const yes = (g.outing_members || []).filter(m => m.status === 'si').length;
        return el('button', { type: 'button', class: 'item trip', onclick: () => openGroup(g.id) },
          el('span', { class: 'trip-ico', 'aria-hidden': 'true' }, isEvent(g) ? '🎉' : '🍽️'),
          el('span', { class: 'txt' }, el('div', { class: 'name' }, (g.place && g.place.n) || 'Uscita'),
            el('div', { class: 'addr when' }, whenLabel(g.starts_at))),
          el('span', { class: 'side' }, el('span', { class: 'dist' }, `${yes} ci sono`)));
      }));
    box.prepend(block);
  };

  // ---------- Link d'invito ----------

  function checkGroupLink() {
    const m = location.hash.match(/^#g=([0-9a-f-]{36})/);
    if (!m) return;
    history.replaceState(null, '', appUrl());
    // Se devo ancora entrare, lo apro subito dopo l'accesso
    save(PENDING_KEY, m[1]);
    if (me()) openPending();
  }
  function openPending() {
    const id = load(PENDING_KEY, null);
    if (!id) return;
    localStorage.removeItem(PENDING_KEY);
    openGroup(id);
  }
  window.addEventListener('hashchange', checkGroupLink);
  checkGroupLink();
  AUTH.onUser(() => { openPending(); loadUpcoming(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadUpcoming(); });
})();
