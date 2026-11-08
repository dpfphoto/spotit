// Medagliette NFC per animali: sulla medaglietta va il link wespot.me/#t=<codice>.
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

  let tags = [];       // le mie medagliette
  let sightings = [];  // segnalazioni di tutte le mie medagliette, le più recenti prima
  let current = null;  // medaglietta aperta (null = nuova)
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
      sb.from('pet_tags').select('id, name, message, phone, photo, created_at').order('created_at'),
      sb.from('tag_sightings').select('id, tag_id, lat, lng, acc, note, phone, created_at').order('created_at', { ascending: false }).limit(200)
    ]);
    if (t.error) throw t.error;
    tags = t.data || [];
    sightings = (s.data || []);
  }

  // ---------- Elenco ----------

  async function openTags(focus) {
    if (!AUTH.user()) { toast('Entra con il tuo account per usare le medagliette'); return; }
    $('tagList').replaceChildren(el('li', { class: 'muted reg-empty' }, 'Carico le medagliette…'));
    if (!$('dlgTags').open) $('dlgTags').showModal();
    try { await load(); } catch {
      $('tagList').replaceChildren(el('li', { class: 'muted reg-empty' }, 'Le medagliette non sono ancora attive o manca la connessione. Riprova tra poco.'));
      return;
    }
    markSeen();
    drawList();
    const t = focus && tags.find(x => x.id === focus);
    if (t) openTag(t);
  }

  function drawList() {
    if (!tags.length) {
      $('tagList').replaceChildren(el('li', { class: 'muted reg-empty' }, 'Non hai ancora medagliette. Creane una per il tuo cane o il tuo gatto.'));
      return;
    }
    $('tagList').replaceChildren(...tags.map(t => {
      const last = ofTag(t.id)[0];
      return el('li', {}, el('button', { type: 'button', class: 'tag-row', onclick: () => openTag(t) },
        okPhoto(t.photo) ? el('img', { src: t.photo, alt: '', class: 'tag-thumb' }) : el('span', { class: 'tag-thumb', 'aria-hidden': 'true' }, '🐾'),
        el('span', { class: 'tag-txt' },
          el('strong', {}, t.name || 'Senza nome'),
          el('span', { class: 'muted small' }, last ? `Ultima segnalazione ${when(last.created_at)}` : 'Nessuna segnalazione'))));
    }));
  }

  // ---------- Scheda di una medaglietta ----------

  function openTag(t) {
    current = t || null;
    draftPhoto = (t && t.photo) || '';
    $('tagTitle').textContent = t ? (t.name || 'Medaglietta') : 'Nuova medaglietta';
    $('tagName').value = (t && t.name) || '';
    $('tagMsg').value = (t && t.message) || '';
    $('tagPhone').value = (t && t.phone) || (t ? '' : (prefs.phone || ''));
    drawPhoto();
    $('tagLinkBox').hidden = !t;
    $('tagDelete').hidden = !t;
    $('tagSave').textContent = t ? 'Salva le modifiche' : 'Crea la medaglietta';
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

  function drawPhoto() {
    const box = $('tagPhotoBox');
    const input = el('input', { type: 'file', accept: 'image/*', class: 'sr' });
    input.onchange = async () => {
      const f = input.files[0]; if (!f) return;
      try { draftPhoto = await shrinkPhoto(f, 640); drawPhoto(); } catch { toast('Non riesco a leggere la foto'); }
    };
    box.replaceChildren(
      okPhoto(draftPhoto) ? el('img', { src: draftPhoto, alt: 'Foto', class: 'tag-photo' }) : el('span', { class: 'tag-photo empty', 'aria-hidden': 'true' }, '🐾'),
      el('span', { class: 'row' },
        el('label', { class: 'btn ghost' }, okPhoto(draftPhoto) ? 'Cambia foto' : '📷 Aggiungi foto', input),
        okPhoto(draftPhoto) ? el('button', { type: 'button', class: 'link-btn', onclick: () => { draftPhoto = ''; drawPhoto(); } }, 'Togli') : null));
  }

  function drawSightings() {
    const list = current ? ofTag(current.id) : [];
    $('tagSeenBox').hidden = !current;
    if (!current) return;
    $('tagSeenList').replaceChildren(...(list.length ? list.map(s => el('li', { class: 'card tag-seen' },
      el('strong', {}, `🐾 ${when(s.created_at)}`),
      s.lat != null
        ? el('span', { class: 'muted small' }, `Posizione del telefono di chi l'ha trovato${s.acc ? ` (precisione circa ${s.acc} m)` : ''}`)
        : el('span', { class: 'muted small' }, 'Senza posizione'),
      s.note ? el('span', { class: 'tag-note' }, `"${s.note}"`) : null,
      el('span', { class: 'row wrap' },
        s.lat != null ? el('button', { type: 'button', class: 'btn primary', onclick: () => showOnMap(s) }, '🗺️ Vedi sulla mappa') : null,
        s.lat != null ? el('a', { class: 'btn ghost', href: `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`, target: '_blank', rel: 'noopener' }, '🧭 Portami lì') : null,
        s.phone ? el('a', { class: 'btn ghost', href: `tel:${s.phone}` }, `📞 ${s.phone}`) : null),
      el('button', { type: 'button', class: 'link-btn', onclick: () => delSighting(s) }, 'Cancella'))) :
      [el('li', { class: 'muted' }, 'Quando qualcuno legge la medaglietta e invia la posizione, la trovi qui e ti arriva una notifica.')]));
  }

  function showOnMap(s) {
    $('dlgTag').close(); $('dlgTags').close();
    setView('map');
    if (!markers) markers = L.layerGroup().addTo(map);
    markers.clearLayers();
    const t = tags.find(x => x.id === s.tag_id);
    const name = (t && t.name) || 'Il tuo animale';
    if (s.acc && s.acc > 30) L.circle([s.lat, s.lng], { radius: Math.min(s.acc, 2000), color: '#B45309', weight: 1, fillOpacity: 0.12 }).addTo(markers);
    L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', html: '<span class="tag-pin">🐾</span>', iconSize: [40, 40], iconAnchor: [20, 20] }) })
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
        toast('Medaglietta salvata');
      } else {
        let saved = null;
        for (let i = 0; i < 3 && !saved; i++) {
          const { data, error } = await sb.from('pet_tags').insert({ id: newCode(), ...row }).select('id, name, message, phone, photo, created_at').single();
          if (!error) saved = data; else if (error.code !== '23505') throw error;
        }
        if (!saved) throw new Error('codice');
        tags.push(saved);
        toast('Medaglietta creata: ora scrivi il link sulla medaglietta');
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
    toast('Medaglietta eliminata: il link non funziona più');
  };

  $('tagCopy').onclick = async () => {
    if (!current) return;
    try { await navigator.clipboard.writeText(LINK(current.id)); toast('Link copiato'); }
    catch { toast(LINK(current.id)); }
  };

  // Android con Chrome: scrivo il link direttamente sulla medaglietta
  $('tagWrite').onclick = async () => {
    if (!current || !canWrite) return;
    const msg = $('tagNfcMsg');
    msg.textContent = 'Avvicina la medaglietta al retro del telefono e tienila ferma…';
    try {
      const nd = new window.NDEFReader();
      await nd.write({ records: [{ recordType: 'url', data: LINK(current.id) }] }, { overwrite: true });
      msg.textContent = '✅ Medaglietta scritta! Prova ad avvicinarla al telefono di un amico.';
    } catch (e) {
      msg.textContent = e && e.name === 'NotAllowedError'
        ? 'Serve il permesso NFC: toccalo di nuovo e scegli "Consenti". Controlla anche che l\'NFC sia acceso nelle impostazioni.'
        : 'Scrittura non riuscita. Controlla che l\'NFC sia acceso e riprova tenendo la medaglietta ferma.';
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
    const { data } = await sb.from('tag_sightings').select('id, tag_id, lat, created_at, pet_tags(name)')
      .gt('created_at', new Date(since).toISOString()).order('created_at').limit(20);
    for (const s of data || []) {
      const name = (s.pet_tags && s.pet_tags.name) || 'il tuo animale';
      if (window.spotitNotify) window.spotitNotify(`tag-${s.id}`, '🐾', `Qualcuno ha trovato ${name}${s.lat != null ? ' e ha inviato la posizione' : ''}`, `tag:${s.tag_id}`);
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
