// Tag NFC (medaglietta dell'animale, casco, oggetto...): sul tag va il link wespot.me/#t=<codice>.
// Chi la legge vede la pagina tag.html (senza account) e può mandare al padrone la sua posizione.
// Qui il padrone crea le medagliette, le scrive (Android con Chrome) e vede le segnalazioni sulla mappa.

(function () {
  const AUTH = window.SPOTIT_AUTH;
  const item = document.querySelector('#dlgMenu [data-go="tags"]');
  if (!AUTH) { if (item) item.parentElement.hidden = true; return; }
  const sb = AUTH.sb;
  const SEEN_KEY = 'spotit.tagSeen';
  const LINK = code => `https://wespot.me/#t=${code}`;
  const canWrite = 'NDEFReader' in window;

  // Tipi di tag: cambiano etichette, esempi e il testo delle notifiche
  const KINDS = {
    animale: { ico: '🐾', label: 'Animale', name: "Nome dell'animale", namePh: 'Es. Fido', msg: 'Messaggio per chi lo trova',
      msgPh: 'Es. Mi sono perso! Sono buono. Microchip 380…. Per favore avvisa il mio padrone, grazie.', phone: 'Il tuo telefono (facoltativo, lo vede chi legge il tag)',
      found: n => `Qualcuno ha trovato ${n || 'il tuo animale'}` },
    casco: { ico: '⛑️', label: 'Casco', name: 'Nome di chi lo indossa', namePh: 'Es. Flavio Di Properzio', msg: 'Informazioni di emergenza',
      msgPh: 'Es. Gruppo sanguigno 0+. Allergie: nessuna. Farmaci: nessuno. Avvisare: Maria (moglie).', phone: 'Telefono del contatto di emergenza (lo vede chi legge il tag)',
      found: n => `Qualcuno ha letto il casco${n ? ' di ' + n : ''}` },
    oggetto: { ico: '🔑', label: 'Oggetto', name: "Che cos'è", namePh: 'Es. Chiavi di casa, zaino, bici', msg: 'Messaggio per chi lo trova',
      msgPh: 'Es. Grazie per averle trovate! Chiamami o lasciale al bar della piazza.', phone: 'Il tuo telefono (facoltativo, lo vede chi legge il tag)',
      found: n => `Qualcuno ha trovato ${n || 'il tuo oggetto'}` },
    altro: { ico: '📲', label: 'Altro', name: 'Nome del tag', namePh: 'Es. Zaino di emergenza', msg: 'Messaggio per chi lo legge',
      msgPh: 'Es. Questo zaino appartiene al G.O.S. Roma.', phone: 'Il tuo telefono (facoltativo, lo vede chi legge il tag)',
      found: n => `Qualcuno ha letto il tag ${n || ''}`.trim() }
  };
  const kindOf = t => KINDS[(t && t.kind)] ? t.kind : 'animale';
  let draftKind = 'animale';

  let tags = [];       // le mie medagliette
  let sightings = [];  // segnalazioni di tutte le mie medagliette, le più recenti prima
  let current = null;  // tag aperto (null = nuovo)
  let draftPhoto = '';
  let markers = null;

  const pad = n => String(n).padStart(2, '0');
  function when(ts) {
    const d = new Date(ts), now = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return `oggi alle ${hm}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `ieri alle ${hm}`;
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} alle ${hm}`;
  }
  function newCode() {
    const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const r = crypto.getRandomValues(new Uint8Array(7));
    return [...r].map(x => abc[x % abc.length]).join('');
  }
  function okPhoto(s) { return typeof s === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(s); }
  const ofTag = id => sightings.filter(s => s.tag_id === id);

  async function load() {
    const [t, s] = await Promise.all([
      sb.from('pet_tags').select('id, kind, name, message, phone, photo, created_at').order('created_at'),
      sb.from('tag_sightings').select('id, tag_id, lat, lng, acc, note, phone, created_at').order('created_at', { ascending: false }).limit(200)
    ]);
    if (t.error) throw t.error;
    tags = t.data || [];
    sightings = (s.data || []);
  }

  // ---------- Elenco ----------

  async function openTags(focus) {
    if (!AUTH.user()) { toast('Entra con il tuo account per usare i tag NFC'); return; }
    $('tagList').replaceChildren(el('li', { class: 'muted reg-empty' }, 'Carico i tag…'));
    if (!$('dlgTags').open) $('dlgTags').showModal();
    try { await load(); } catch {
      $('tagList').replaceChildren(el('li', { class: 'muted reg-empty' }, 'I tag non sono ancora attivi o manca la connessione. Riprova tra poco.'));
      return;
    }
    markSeen();
    drawList();
    const t = focus && tags.find(x => x.id === focus);
    if (t) openTag(t);
  }

  function drawList() {
    if (!tags.length) {
      $('tagList').replaceChildren(el('li', { class: 'muted reg-empty' }, 'Non hai ancora tag. Creane uno per il tuo cane, il casco, le chiavi…'));
      return;
    }
    $('tagList').replaceChildren(...tags.map(t => {
      const last = ofTag(t.id)[0];
      return el('li', {}, el('button', { type: 'button', class: 'tag-row', onclick: () => openTag(t) },
        okPhoto(t.photo) ? el('img', { src: t.photo, alt: '', class: 'tag-thumb' }) : el('span', { class: 'tag-thumb', 'aria-hidden': 'true' }, KINDS[kindOf(t)].ico),
        el('span', { class: 'tag-txt' },
          el('strong', {}, `${okPhoto(t.photo) ? KINDS[kindOf(t)].ico + ' ' : ''}${t.name || 'Senza nome'}`),
          el('span', { class: 'muted small' }, last ? `Ultima segnalazione ${when(last.created_at)}` : 'Nessuna segnalazione'))));
    }));
  }

  // ---------- Scheda di un tag ----------

  function openTag(t) {
    current = t || null;
    draftPhoto = (t && t.photo) || '';
    draftKind = kindOf(t);
    $('tagTitle').textContent = t ? `${KINDS[draftKind].ico} ${t.name || 'Tag NFC'}` : 'Nuovo tag NFC';
    $('tagName').value = (t && t.name) || '';
    $('tagMsg').value = (t && t.message) || '';
    $('tagPhone').value = (t && t.phone) || (t ? '' : (prefs.phone || ''));
    drawPhoto();
    drawKind();
    $('tagLinkBox').hidden = !t;
    $('tagDelete').hidden = !t;
    $('tagSave').textContent = t ? 'Salva le modifiche' : 'Crea il tag';
    $('tagNfcMsg').textContent = '';
    if (t) {
      $('tagLink').textContent = LINK(t.id);
      $('tagTest').href = `tag.html#t=${t.id}`;
      $('tagWrite').hidden = !canWrite;
      $('tagHowIos').hidden = canWrite;
    }
    drawSightings();
    if (!$('dlgTag').open) $('dlgTag').showModal();
    $('dlgTag').scrollTop = 0;
  }

  function drawKind() {
    const k = KINDS[draftKind];
    $('tagKinds').replaceChildren(...Object.entries(KINDS).map(([id, x]) => el('button', {
      type: 'button', class: 'tag-kind', role: 'radio', 'aria-checked': String(id === draftKind),
      onclick: () => { draftKind = id; drawKind(); }
    }, `${x.ico} ${x.label}`)));
    $('tagNameLabel').textContent = k.name; $('tagName').placeholder = k.namePh;
    $('tagMsgLabel').textContent = k.msg; $('tagMsg').placeholder = k.msgPh;
    $('tagPhoneLabel').textContent = k.phone;
    if (!okPhoto(draftPhoto)) drawPhoto();
  }

  function drawPhoto() {
    const box = $('tagPhotoBox');
    const input = el('input', { type: 'file', accept: 'image/*', class: 'sr' });
    input.onchange = async () => {
      const f = input.files[0]; if (!f) return;
      try { draftPhoto = await shrinkPhoto(f, 640); drawPhoto(); } catch { toast('Non riesco a leggere la foto'); }
    };
    box.replaceChildren(
      okPhoto(draftPhoto) ? el('img', { src: draftPhoto, alt: 'Foto', class: 'tag-photo' }) : el('span', { class: 'tag-photo empty', 'aria-hidden': 'true' }, KINDS[draftKind].ico),
      el('span', { class: 'row' },
        el('label', { class: 'btn ghost' }, okPhoto(draftPhoto) ? 'Cambia foto' : '📷 Aggiungi foto', input),
        okPhoto(draftPhoto) ? el('button', { type: 'button', class: 'link-btn', onclick: () => { draftPhoto = ''; drawPhoto(); } }, 'Togli') : null));
  }

  function drawSightings() {
    const list = current ? ofTag(current.id) : [];
    $('tagSeenBox').hidden = !current;
    if (!current) return;
    $('tagSeenList').replaceChildren(...(list.length ? list.map(s => el('li', { class: 'card tag-seen' },
      el('strong', {}, `${KINDS[kindOf(current)].ico} ${when(s.created_at)}`),
      s.lat != null
        ? el('span', { class: 'muted small' }, `Posizione del telefono di chi l'ha trovato${s.acc ? ` (precisione circa ${s.acc} m)` : ''}`)
        : el('span', { class: 'muted small' }, 'Senza posizione'),
      s.note ? el('span', { class: 'tag-note' }, `"${s.note}"`) : null,
      el('span', { class: 'row wrap' },
        s.lat != null ? el('button', { type: 'button', class: 'btn primary', onclick: () => showOnMap(s) }, '🗺️ Vedi sulla mappa') : null,
        s.lat != null ? el('a', { class: 'btn ghost', href: `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`, target: '_blank', rel: 'noopener' }, '🧭 Portami lì') : null,
        s.phone ? el('a', { class: 'btn ghost', href: `tel:${s.phone}` }, `📞 ${s.phone}`) : null),
      el('button', { type: 'button', class: 'link-btn', onclick: () => delSighting(s) }, 'Cancella'))) :
      [el('li', { class: 'muted' }, 'Quando qualcuno legge il tag e invia la posizione, la trovi qui e ti arriva una notifica.')]));
  }

  function showOnMap(s) {
    $('dlgTag').close(); $('dlgTags').close();
    setView('map');
    if (!markers) markers = L.layerGroup().addTo(map);
    markers.clearLayers();
    const t = tags.find(x => x.id === s.tag_id);
    const name = (t && t.name) || 'Il tuo tag';
    if (s.acc && s.acc > 30) L.circle([s.lat, s.lng], { radius: Math.min(s.acc, 2000), color: '#B45309', weight: 1, fillOpacity: 0.12 }).addTo(markers);
    L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', html: `<span class="tag-pin">${KINDS[kindOf(t)].ico}</span>`, iconSize: [40, 40], iconAnchor: [20, 20] }) })
      .addTo(markers)
      .bindPopup(`<strong>${escHtml(name)}</strong><br>Segnalato ${when(s.created_at)}${s.note ? `<br>"${escHtml(s.note)}"` : ''}<br><a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}" target="_blank" rel="noopener">Portami lì</a>`)
      .openPopup();
    map.setView([s.lat, s.lng], 17);
  }
  function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function delSighting(s) {
    const { error } = await sb.from('tag_sightings').delete().eq('id', s.id);
    if (error) { toast('Non riesco a cancellare, riprova'); return; }
    sightings = sightings.filter(x => x.id !== s.id);
    drawSightings(); drawList();
  }

  $('tagForm').addEventListener('submit', async e => {
    e.preventDefault();
    const row = {
      kind: draftKind,
      name: $('tagName').value.trim().slice(0, 40),
      message: $('tagMsg').value.trim().slice(0, 500),
      phone: $('tagPhone').value.replace(/[^0-9+]/g, '').replace(/(?!^)\+/g, '').slice(0, 16),
      photo: okPhoto(draftPhoto) ? draftPhoto : '',
      updated_at: new Date().toISOString()
    };
    $('tagSave').disabled = true;
    try {
      if (current) {
        const { error } = await sb.from('pet_tags').update(row).eq('id', current.id);
        if (error) throw error;
        Object.assign(current, row);
        toast('Tag salvato');
      } else {
        let saved = null;
        for (let i = 0; i < 3 && !saved; i++) {
          const { data, error } = await sb.from('pet_tags').insert({ id: newCode(), ...row }).select('id, kind, name, message, phone, photo, created_at').single();
          if (!error) saved = data; else if (error.code !== '23505') throw error;
        }
        if (!saved) throw new Error('codice');
        tags.push(saved);
        toast('Tag creato: ora scrivi il link sul tag');
        openTag(saved);
      }
      drawList();
    } catch {
      toast('Non riesco a salvare, riprova tra poco');
    } finally {
      $('tagSave').disabled = false;
    }
  });

  $('tagDelete').onclick = async () => {
    if (!current) return;
    $('tagDelete').hidden = true; $('tagDelSure').hidden = false;
  };
  $('tagDelNo').onclick = () => { $('tagDelSure').hidden = true; $('tagDelete').hidden = false; };
  $('tagDelYes').onclick = async () => {
    const { error } = await sb.from('pet_tags').delete().eq('id', current.id);
    $('tagDelSure').hidden = true;
    if (error) { toast('Non riesco a eliminare, riprova'); $('tagDelete').hidden = false; return; }
    tags = tags.filter(t => t.id !== current.id);
    sightings = sightings.filter(s => s.tag_id !== current.id);
    $('dlgTag').close(); drawList();
    toast('Tag eliminato: il link non funziona più');
  };

  $('tagCopy').onclick = async () => {
    if (!current) return;
    try { await navigator.clipboard.writeText(LINK(current.id)); toast('Link copiato'); }
    catch { toast(LINK(current.id)); }
  };

  // Android con Chrome: scrivo il link direttamente sul tag
  $('tagWrite').onclick = async () => {
    if (!current || !canWrite) return;
    const msg = $('tagNfcMsg');
    msg.textContent = 'Avvicina il tag al retro del telefono e tienilo fermo…';
    try {
      const nd = new window.NDEFReader();
      await nd.write({ records: [{ recordType: 'url', data: LINK(current.id) }] }, { overwrite: true });
      msg.textContent = '✅ Tag scritto! Prova ad avvicinarlo al telefono di un amico.';
    } catch (e) {
      msg.textContent = e && e.name === 'NotAllowedError'
        ? 'Serve il permesso NFC: toccalo di nuovo e scegli "Consenti". Controlla anche che l\'NFC sia acceso nelle impostazioni.'
        : 'Scrittura non riuscita. Controlla che l\'NFC sia acceso e riprova tenendo il tag fermo.';
    }
  };

  $('tagNew').onclick = () => openTag(null);
  $('dlgTag').addEventListener('close', () => { $('tagDelSure').hidden = true; });

  // ---------- Avvisi nella campanella ----------

  function seenAt() { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } }
  function markSeen() { try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch {} }

  async function checkNew() {
    if (!AUTH.user()) return;
    const since = seenAt();
    if (!since) { markSeen(); return; } // prima volta su questo telefono: non riempio la campanella con cose vecchie
    const { data } = await sb.from('tag_sightings').select('id, tag_id, lat, created_at, pet_tags(name, kind)')
      .gt('created_at', new Date(since).toISOString()).order('created_at').limit(20);
    for (const s of data || []) {
      const k = KINDS[kindOf(s.pet_tags)];
      if (window.spotitNotify) window.spotitNotify(`tag-${s.id}`, k.ico, `${k.found(s.pet_tags && s.pet_tags.name)}${s.lat != null ? ' e ha inviato la posizione' : ''}`, `tag:${s.tag_id}`);
    }
  }

  // Aperta dalla notifica: wespot.me/#tf=<codice>
  const fromPush = (location.hash.match(/^#tf=([A-Za-z0-9]{7})/) || [])[1];
  if (fromPush) history.replaceState(null, '', location.pathname + location.search);
  let started = false;
  AUTH.onUser(() => {
    if (started) return; started = true;
    if (fromPush) openTags(fromPush).catch(() => {});
    else checkNew().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNew().catch(() => {}); });

  window.spotitOpenTags = openTags;
})();
