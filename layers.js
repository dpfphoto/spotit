// Livelli della mappa: i posti di tutti (anonimi, con giudizi e note) e gli eventi pubblici, oppure solo i miei.

(function () {
  const AUTH = window.SPOTIT_AUTH;
  if (!AUTH) { $('btnLayers').hidden = true; $('shareBox').hidden = true; return; }
  const sb = AUTH.sb;
  const LAYER_KEY = 'spotit.layer';
  let mode = load(LAYER_KEY, 'all');
  let pub = [];          // posti degli altri nella zona inquadrata
  let pubEv = [];        // eventi pubblici in arrivo nella zona
  let shown = null;      // posto aperto nella scheda
  let timer = null;
  const pubLayer = L.layerGroup().addTo(map);
  const VKEYS = ['tornarci', 'andarci', 'sconsigliato'];
  // Chi non ha ancora aggiornato l'app può avere i giudizi vecchi: li unisco nei tre di adesso
  function merge(p) {
    return { ...p, tornarci: (p.tornarci || 0) + (p.consigliato || 0), sconsigliato: (p.sconsigliato || 0) + (p.nonandarci || 0), consigliato: 0, nonandarci: 0 };
  }

  function total(p) { return VKEYS.reduce((n, k) => n + (p[k] || 0), 0); }
  // Il giudizio più dato; a parità vince il più positivo
  function top(p) { return VKEYS.reduce((best, k) => (p[k] || 0) > (p[best] || 0) ? k : best, VKEYS[0]); }
  // Giudizio della community: consigliato se i Tornarci superano gli Sconsigliato
  function verdictOf(p) {
    const t = p.tornarci || 0, s = p.sconsigliato || 0;
    return t > s ? 'good' : s > 0 ? 'bad' : 'try';
  }
  const COMMUNITY = {
    good: { color: '#2563EB', label: 'Consigliato dalla community', filter: 'tornarci' },
    bad: { color: '#6B7280', label: 'Sconsigliato dalla community', filter: 'sconsigliato' },
    try: { color: '#93C5FD', label: 'Da provare: qualcuno vuole andarci', filter: 'andarci' }
  };
  function triangle(color, n) {
    return `<svg class="tri" width="32" height="30" viewBox="0 0 32 30" aria-hidden="true"><path d="M16 2.5 L29.5 27 H2.5 Z" fill="${color}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>${n > 1 ? `<text x="16" y="23" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">${n}</text>` : ''}</svg>`;
  }
  // Posto che ho già tra i miei: non lo ripeto
  function isMine(p) {
    return places.some(x => (p.gid && x.gid === p.gid) ||
      (x.name.toLowerCase() === (p.name || '').toLowerCase() && metersBetween(x, p) < 40));
  }

  // ---------- Scelta del livello ----------

  function drawMode() {
    $('dlgLayers').querySelectorAll('[data-layer]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.layer === mode)));
    $('btnLayers').classList.toggle('on', mode === 'all');
    $('btnLayers').setAttribute('aria-label', mode === 'all' ? 'Livelli: posti di tutti' : 'Livelli: solo i miei posti');
  }
  $('btnLayers').onclick = () => { drawMode(); drawInfo(); $('dlgLayers').showModal(); };
  $('dlgLayers').addEventListener('click', e => {
    const b = e.target.closest('[data-layer]'); if (!b) return;
    mode = b.dataset.layer; save(LAYER_KEY, mode);
    drawMode();
    $('dlgLayers').close();
    if (mode === 'all') { toast('Ora vedi anche i posti degli altri: sono i triangoli'); fetchPublic(); }
    else { pub = []; pubEv = []; publicKinds = []; drawPublic(); }
  });

  // ---------- Posti degli altri ----------

  async function fetchPublic() {
    if (mode !== 'all' || !AUTH.user()) return;
    const b = map.getBounds().pad(0.3);
    const box = { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
    const d = new Date(Date.now() - 12 * 3600000);
    const since = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const [a, ev] = await Promise.all([
      Promise.resolve(sb.rpc('public_places', box)).catch(() => ({ error: true })),
      Promise.resolve(sb.rpc('public_events', { ...box, since })).catch(() => ({ error: true }))
    ]);
    if (!a.error) pub = (a.data || []).map(merge);
    if (!ev.error) pubEv = ev.data || [];
    publicKinds = pub.map(p => p.kind).filter(Boolean);
    lastErr = a.error ? String(a.error.message || 'errore') : '';
    drawPublic();
    drawInfo();
  }
  // Riga di controllo nella scelta del livello: dice cosa sta arrivando dagli altri utenti
  let lastErr = '';
  function drawInfo() {
    const n = pub.filter(p => !isMine(p)).length;
    $('layerInfo').textContent = mode !== 'all' ? 'Stai vedendo solo i tuoi posti.'
      : lastErr ? `Non riesco a leggere i posti degli altri (${lastErr}).`
      : `Nella zona che stai guardando: ${n} ${n === 1 ? 'posto' : 'posti'} di altri utenti.`;
  }
  function drawPublic() {
    pubLayer.clearLayers();
    if (mode !== 'all') return;
    for (const p of pub) {
      if (!Number.isFinite(p.lat) || isMine(p)) continue;
      const c = COMMUNITY[verdictOf(p)];
      if (filter && c.filter !== filter) continue;
      if (!matchKind(p)) continue;
      const n = total(p);
      const icon = L.divIcon({ className: '', html: triangle(c.color, n), iconSize: [32, 30], iconAnchor: [16, 20] });
      L.marker([p.lat, p.lng], { icon, title: p.name, alt: `${p.name}, ${c.label}, ${n} ${n === 1 ? 'persona' : 'persone'}` })
        .on('click', () => openPublic(p))
        .addTo(pubLayer);
    }
    const mineEv = window.SPOTIT_MY_OUTINGS || new Set();
    for (const g of pubEv) {
      if (!Number.isFinite(g.lat) || mineEv.has(g.id)) continue;
      const html = window.spotitPinHtml ? window.spotitPinHtml(g.icon, 'ev-pin pub') : '<span class="ev-pin pub">🎉</span>';
      const icon = L.divIcon({ className: '', html, iconSize: [30, 30], iconAnchor: [15, 15] });
      L.marker([g.lat, g.lng], { icon, title: g.name, alt: `${g.name}, evento pubblico`, zIndexOffset: 400 })
        .on('click', () => openPublicEvent(g))
        .addTo(pubLayer);
    }
  }
  function openPublicEvent(g) {
    shown = null;
    $('puName').textContent = `🎉 ${g.name}`;
    $('puAddress').textContent = g.address || '';
    $('puCover').hidden = true;
    $('puWhen').hidden = false;
    $('puWhen').textContent = whenLabel(g.starts_at);
    $('puNote').hidden = !g.note;
    $('puNote').textContent = g.note ? `"${g.note}"` : '';
    $('puCount').textContent = `Evento pubblico · ${g.going} ${g.going === 1 ? 'persona ci va' : 'persone ci vanno'}`;
    $('puVotes').replaceChildren();
    $('puNotes').hidden = true;
    $('puSave').hidden = true;
    $('puVerdict').hidden = true; $('puContacts').hidden = true;
    $('puRoute').href = `https://www.google.com/maps/dir/?api=1&destination=${g.lat},${g.lng}`;
    $('dlgPublic').showModal();
  }
  map.on('moveend', () => { clearTimeout(timer); timer = setTimeout(fetchPublic, 400); });
  // Quando cambiano i miei posti o il filtro, ridisegno anche questi
  const renderMine = render;
  render = function () { renderMine(); drawPublic(); };

  function openPublic(p) {
    shown = p;
    $('puName').textContent = p.name;
    $('puCover').hidden = false;
    $('puAddress').textContent = p.address || '';
    showCover($('puCover'), { gphoto: p.gphoto || '', gphotoBy: p.gphoto_by || '' });
    const n = total(p);
    $('puCount').textContent = `${p.kind ? p.kind + ' · ' : ''}${n} ${n === 1 ? 'persona l\'ha salvato' : 'persone l\'hanno salvato'} su WeSpot`;
    $('puVotes').replaceChildren(...VKEYS.filter(k => p[k]).map(k =>
      el('span', { class: 'badge', style: `background:${V[k].bg};color:${V[k].color}` }, `${V[k].label} ${p[k]}`)));
    const c = COMMUNITY[verdictOf(p)];
    $('puVerdict').hidden = false;
    $('puVerdict').replaceChildren(el('span', { class: 'tri-dot', style: `border-bottom-color:${c.color}` }), c.label);
    showContacts(p);
    const notes = p.notes || [];
    $('puNotes').hidden = !notes.length;
    $('puNotes').replaceChildren(...notes.map(t => el('li', {}, `"${t}"`)));
    $('puWhen').hidden = true; $('puNote').hidden = true; $('puSave').hidden = false;
    $('puRoute').href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
    $('dlgPublic').showModal();
  }
  // Telefono, sito e orari da Google, solo quando apro la scheda (e tenuti in memoria)
  const contactCache = {};
  async function showContacts(p) {
    const box = $('puContacts');
    box.hidden = true; box.replaceChildren();
    if (!p.gid || typeof GOOGLE_KEY === 'undefined' || !GOOGLE_KEY) return;
    let d = contactCache[p.gid];
    if (!d) {
      try {
        const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(p.gid)}?languageCode=it`, {
          headers: { 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': 'nationalPhoneNumber,internationalPhoneNumber,websiteUri,currentOpeningHours.openNow' }
        });
        if (!res.ok) return;
        d = contactCache[p.gid] = await res.json();
      } catch { return; }
    }
    if (shown !== p) return;
    const items = [];
    const open = d.currentOpeningHours && d.currentOpeningHours.openNow;
    if (open === true || open === false) items.push(el('span', { class: 'badge ' + (open ? 'open' : 'closed') }, open ? 'Aperto ora' : 'Chiuso ora'));
    const tel = d.internationalPhoneNumber || d.nationalPhoneNumber;
    if (tel) items.push(el('a', { class: 'btn ghost small', href: 'tel:' + tel.replace(/[^+\d]/g, '') }, '📞 ' + (d.nationalPhoneNumber || tel)));
    if (d.websiteUri && /^https?:\/\//.test(d.websiteUri)) items.push(el('a', { class: 'btn ghost small', href: d.websiteUri, target: '_blank', rel: 'noopener' }, '🌐 Sito'));
    box.replaceChildren(...items);
    box.hidden = !items.length;
  }
  window.spotitRefreshPublic = fetchPublic;
  // I posti degli altri cambiano mentre l'app è aperta: li riprendo ogni minuto e al ritorno nell'app
  setInterval(() => { if (!document.hidden) fetchPublic(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchPublic(); });
  $('puSave').onclick = () => {
    const p = shown; if (!p) return;
    $('dlgPublic').close();
    openAdd('');
    startDraft({ name: p.name, kind: p.kind || '', address: p.address || '', lat: p.lat, lng: p.lng, gid: p.gid || '', gphoto: p.gphoto || '', gphotoBy: p.gphoto_by || '' });
  };

  // ---------- Condivisione dei miei posti (profilo) ----------

  async function loadShare() {
    const u = AUTH.user(); if (!u) return;
    const { data } = await sb.from('profiles').select('share_places').eq('id', u.id).maybeSingle();
    $('shareToggle').checked = !data || data.share_places !== false;
  }
  $('shareToggle').addEventListener('change', async () => {
    const u = AUTH.user(); if (!u) return;
    const on = $('shareToggle').checked;
    const { error } = await sb.from('profiles').upsert({ id: u.id, share_places: on });
    if (error) { $('shareToggle').checked = !on; toast('Non riesco a salvare ora. Riprova.'); return; }
    toast(on ? 'I tuoi posti compaiono anonimi sulla mappa di tutti' : 'I tuoi posti ora li vedi solo tu');
  });

  drawMode();
  AUTH.onUser(() => { loadShare(); fetchPublic(); });
  if (AUTH.user()) { loadShare(); fetchPublic(); }
})();
