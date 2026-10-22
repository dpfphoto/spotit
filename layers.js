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
  $('btnLayers').onclick = () => { drawMode(); $('dlgLayers').showModal(); };
  $('dlgLayers').addEventListener('click', e => {
    const b = e.target.closest('[data-layer]'); if (!b) return;
    mode = b.dataset.layer; save(LAYER_KEY, mode);
    drawMode();
    $('dlgLayers').close();
    if (mode === 'all') { toast('Ora vedi anche i posti degli altri, con il bordo tratteggiato'); fetchPublic(); }
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
      sb.rpc('public_places', box).catch(() => ({ error: true })),
      sb.rpc('public_events', { ...box, since }).catch(() => ({ error: true }))
    ]);
    if (!a.error) pub = (a.data || []).map(merge);
    if (!ev.error) pubEv = ev.data || [];
    publicKinds = pub.map(p => p.kind).filter(Boolean);
    drawPublic();
  }
  function drawPublic() {
    pubLayer.clearLayers();
    if (mode !== 'all') return;
    for (const p of pub) {
      if (!Number.isFinite(p.lat) || isMine(p)) continue;
      const v = top(p);
      if (filter && v !== filter) continue;
      if (!matchKind(p)) continue;
      const n = total(p);
      const icon = L.divIcon({
        className: '',
        html: `<span class="pin pub" style="background:${V[v].color}">${n > 1 ? n : ''}</span>`,
        iconSize: [26, 26], iconAnchor: [13, 13]
      });
      L.marker([p.lat, p.lng], { icon, title: p.name, alt: `${p.name}, ${V[v].label}, ${n} ${n === 1 ? 'persona' : 'persone'}` })
        .on('click', () => openPublic(p))
        .addTo(pubLayer);
    }
    const mineEv = window.SPOTIT_MY_OUTINGS || new Set();
    for (const g of pubEv) {
      if (!Number.isFinite(g.lat) || mineEv.has(g.id)) continue;
      const icon = L.divIcon({ className: '', html: '<span class="ev-pin pub">🎉</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
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
    const notes = p.notes || [];
    $('puNotes').hidden = !notes.length;
    $('puNotes').replaceChildren(...notes.map(t => el('li', {}, `"${t}"`)));
    $('puWhen').hidden = true; $('puNote').hidden = true; $('puSave').hidden = false;
    $('puRoute').href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
    $('dlgPublic').showModal();
  }
  window.spotitRefreshPublic = fetchPublic;
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
