// Uscite di gruppo (archivio online): crei l'uscita da un posto, inviti gli amici
// con un link su WhatsApp o li aggiungi tu, e ognuno risponde se c'è.

(function () {
  const AUTH = window.SPOTIT_AUTH;
  if (!AUTH) {
    // Senza archivio online resta l'invito semplice con il link
    $('oCreate').hidden = true;
    $('oOld').hidden = false;
    $('oMine').hidden = false;
    return;
  }
  const sb = AUTH.sb;
  const PENDING_KEY = 'spotit.pendingGroup';
  // I numeri di telefono restano solo su questo telefono: { idPartecipante: numero }
  const PHONES_KEY = 'spotit.phones';
  let phones = load(PHONES_KEY, {});
  const STATUS = {
    si: { label: 'Ci sono', cls: 'yes' },
    forse: { label: 'Forse', cls: 'maybe' },
    no: { label: 'Non può', cls: 'no' },
    invitato: { label: 'Invitato', cls: 'wait' }
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  let group = null;      // uscita aperta: { id, owner, owner_name, place, starts_at, note, members }
  let claimId = null;    // persona scelta in "Chi sei?"
  let travel = null;
  let pollTimer = null;
  let upcoming = [];

  function me() { return AUTH.user(); }
  function myName() {
    const u = me();
    return prefs.name || (u && u.email ? u.email.split('@')[0] : '') || 'Amico';
  }
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

  // ---------- Apri ----------

  async function fetchGroup(id) {
    const { data, error } = await sb.from('outings').select('*, outing_members(id, user_id, name, status, created_at)').eq('id', id).maybeSingle();
    if (error) throw error;
    if (data) {
      data.members = (data.outing_members || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
      data.joined = true;
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
    $('gTitle').textContent = g.owner === (me() && me().id) ? 'La tua uscita' : (g.owner_name ? `${g.owner_name} ti invita` : 'Sei invitato');
    $('gName').textContent = p.name;
    $('gAddress').textContent = p.address;
    $('gWhen').textContent = whenLabel(g.starts_at);
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
      const phone = isOwner && phones[m.id];
      const isMe = u && (m.user_id === u.id);
      return el('li', {},
        el('span', { class: 'm-name' }, m.name + (isMe ? ' (tu)' : '')),
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
      if (mine) {
        const { error } = await sb.from('outing_members').update({ status: a }).eq('id', mine.id);
        if (error) throw error;
      } else {
        const { error } = await sb.rpc('join_outing', { oid: group.id, claim: claimId, display_name: myName(), answer: a });
        if (error) throw error;
        saveGroupPlace(group);
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
      const { data, error } = await sb.from('outing_members').insert({ outing_id: group.id, name, status: 'invitato' }).select().single();
      if (error) throw error;
      $('gAddName').value = ''; $('gAddPhone').value = '';
      if (phone) {
        phones[data.id] = phone; save(PHONES_KEY, phones);
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
    if (!group || !confirm('Annullare l\'uscita per tutti?')) return;
    const { error } = await sb.from('outings').delete().eq('id', group.id);
    if (error) { toast('Non riesco ad annullarla ora'); return; }
    $('dlgGroup').close();
    toast('Uscita annullata');
  };

  $('gLeaveGroup').onclick = async () => {
    const u = me();
    const mine = group && u && group.members.find(m => m.user_id === u.id);
    if (!mine || !confirm('Uscire da questo gruppo?')) return;
    const { error } = await sb.from('outing_members').delete().eq('id', mine.id);
    if (error) { toast('Non riesco ora, riprova'); return; }
    $('dlgGroup').close();
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
    if (!me()) { upcoming = []; return; }
    try {
      const { data, error } = await sb.from('outings').select('id, place, starts_at, owner_name, outing_members(status)')
        .gte('starts_at', today()).order('starts_at').limit(10);
      if (error) throw error;
      upcoming = data || [];
      render();
    } catch { /* la lista resta quella di prima */ }
  }
  const renderPlaces = renderList;
  renderList = function (list) {
    renderPlaces(list);
    if (!upcoming.length) return;
    const box = $('list');
    const block = el('div', { class: 'trips' }, el('p', { class: 'trips-title' }, 'Le tue uscite'),
      ...upcoming.map(g => {
        const yes = (g.outing_members || []).filter(m => m.status === 'si').length;
        return el('button', { type: 'button', class: 'item trip', onclick: () => openGroup(g.id) },
          el('span', { class: 'trip-ico', 'aria-hidden': 'true' }, '🍽️'),
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
