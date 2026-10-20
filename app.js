'use strict';

const VERDICTS = [
  { id: 'tornarci', label: 'Tornarci', color: '#15803D', bg: '#DCFCE7' },
  { id: 'andarci', label: 'Andarci', color: '#1D4ED8', bg: '#DBEAFE' },
  { id: 'consigliato', label: 'Consigliato', color: '#7E22CE', bg: '#F3E8FF' },
  { id: 'sconsigliato', label: 'Sconsigliato', color: '#C2410C', bg: '#FFEDD5' },
  { id: 'nonandarci', label: 'Non andarci', color: '#475569', bg: '#E2E8F0' }
];
const V = Object.fromEntries(VERDICTS.map(v => [v.id, v]));
const STORE_KEY = 'spotit.places.v1';
const PREF_KEY = 'spotit.prefs.v1';

const $ = id => document.getElementById(id);

// ---------- Dati ----------

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('Impossibile salvare su questo telefono'); }
}

let places = load(STORE_KEY, []);
let prefs = load(PREF_KEY, { name: '', installDismissed: false });
let filter = null;
let view = 'map';

function persist() { save(STORE_KEY, places); render(); }
function savePrefs() { save(PREF_KEY, prefs); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function cleanPlace(p) {
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const name = String(p.name || '').trim().slice(0, 80);
  if (!name) return null;
  return {
    id: String(p.id || uid()).slice(0, 40),
    name,
    address: String(p.address || '').slice(0, 160),
    lat, lng,
    verdict: V[p.verdict] ? p.verdict : 'andarci',
    note: String(p.note || '').slice(0, 280),
    from: String(p.from || '').slice(0, 40),
    gid: /^[A-Za-z0-9_-]{10,300}$/.test(p.gid || '') ? p.gid : '',
    createdAt: Number(p.createdAt) || Date.now()
  };
}

// ---------- UI di base ----------

function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function badge(v) {
  return el('span', { class: 'badge', style: `background:${V[v].bg};color:${V[v].color}` }, V[v].label);
}

function verdictPicker(container, selected, onPick) {
  container.querySelectorAll('button').forEach(b => b.remove());
  for (const v of VERDICTS) {
    const on = v.id === selected;
    container.append(el('button', {
      type: 'button',
      'aria-pressed': String(on),
      style: on
        ? `background:${v.color};border-color:${v.color};color:#fff`
        : `background:${v.bg};border-color:${v.bg};color:${v.color}`,
      onclick: () => onPick(v.id)
    }, v.label));
  }
}

document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

// ---------- Mappa ----------

const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([42.5, 12.5], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
const layer = L.layerGroup().addTo(map);
let meMarker = null;
let lastPos = null;

const locateBtn = el('button', { type: 'button', class: 'locate', 'aria-label': 'Mostra dove sono', onclick: locate });
locateBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path></svg>';
$('map').parentElement.append(locateBtn);

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no-geo'));
    navigator.geolocation.getCurrentPosition(
      p => { lastPos = { lat: p.coords.latitude, lng: p.coords.longitude }; resolve(lastPos); },
      reject,
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

async function locate() {
  try {
    const pos = await getPosition();
    if (meMarker) meMarker.remove();
    meMarker = L.circleMarker([pos.lat, pos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563EB', fillOpacity: 1 }).addTo(map);
    map.setView([pos.lat, pos.lng], 17);
    loadNearby(pos);
  } catch {
    toast('Posizione non disponibile: controlla i permessi');
  }
}

// ---------- Locali intorno a te sulla mappa ----------
// Puntini bianchi: i locali vicini da toccare e salvare al volo

const nearLayer = L.layerGroup().addTo(map);
const areaBtn = el('button', { type: 'button', class: 'area-btn', hidden: '', onclick: () => loadNearby(centerOf(map), radiusOfView()) }, 'Cerca locali in questa zona');
$('map').parentElement.append(areaBtn);
let nearLoading = false;

function centerOf(m) { const c = m.getCenter(); return { lat: c.lat, lng: c.lng }; }
function radiusOfView() {
  const b = map.getBounds();
  return Math.min(800, Math.round(map.distance(b.getCenter(), b.getNorthEast()) * 0.7));
}

async function loadNearby(pos, radius) {
  if (nearLoading) return;
  nearLoading = true;
  areaBtn.hidden = true;
  toast('Cerco i locali qui intorno…');
  try {
    let list = GOOGLE_KEY ? await googleNearby(pos) : await osmNearby(pos, radius || 250, 40);
    if (!list.length && !GOOGLE_KEY && !radius) list = await osmNearby(pos, 600, 40);
    const isSaved = r => places.some(p => p.name === r.name && Math.abs(p.lat - r.lat) < 0.0005 && Math.abs(p.lng - r.lng) < 0.0005);
    nearLayer.clearLayers();
    for (const r of list.filter(r => !isSaved(r))) {
      const icon = L.divIcon({ className: 'near', html: `<span class="near-ico">${r.emoji || '📍'}</span><span class="near-name">${esc(r.name)}</span>`, iconSize: [44, 44], iconAnchor: [22, 22] });
      L.marker([r.lat, r.lng], { icon, title: r.name, alt: r.name, riseOnHover: true })
        .on('click', () => { openAdd(''); startDraft(r); })
        .addTo(nearLayer);
    }
    toast(list.length ? 'Tocca un locale sulla mappa per salvarlo' : 'Nessun locale trovato qui intorno');
  } catch {
    toast('Non riesco a cercare i locali in questo momento');
  }
  nearLoading = false;
}

map.on('moveend', () => {
  if (view === 'map' && map.getZoom() >= 15 && !nearLoading) areaBtn.hidden = false;
});

let fittedOnce = false;
function renderMap(list) {
  layer.clearLayers();
  for (const p of list) {
    const icon = L.divIcon({ className: '', html: `<span class="pin" style="background:${V[p.verdict].color}"></span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    L.marker([p.lat, p.lng], { icon, title: p.name, alt: `${p.name}, ${V[p.verdict].label}` })
      .on('click', () => openPlace(p.id))
      .addTo(layer);
  }
  if (!fittedOnce && list.length) {
    fittedOnce = true;
    map.fitBounds(L.latLngBounds(list.map(p => [p.lat, p.lng])).pad(0.3), { maxZoom: 15 });
  }
}

// ---------- Lista e filtri ----------

function renderFilters() {
  const box = $('filters');
  box.replaceChildren();
  const all = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(filter === null), onclick: () => { filter = null; render(); } }, `Tutti ${places.length}`);
  box.append(all);
  for (const v of VERDICTS) {
    const n = places.filter(p => p.verdict === v.id).length;
    box.append(el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(filter === v.id),
      onclick: () => { filter = filter === v.id ? null : v.id; render(); }
    }, el('span', { class: 'dot', style: `background:${v.color}` }), `${v.label} ${n}`));
  }
}

function renderList(list) {
  const box = $('list');
  box.replaceChildren();
  if (!list.length) {
    box.append(el('p', { class: 'empty' }, places.length
      ? 'Nessun posto con questo giudizio.'
      : 'Non hai ancora salvato nessun posto. Tocca "Salva un posto" per iniziare.'));
    return;
  }
  for (const p of [...list].sort((a, b) => b.createdAt - a.createdAt)) {
    box.append(el('button', { type: 'button', class: 'item', onclick: () => openPlace(p.id) },
      el('span', { class: 'dot', style: `background:${V[p.verdict].color}` }),
      el('span', { class: 'txt' }, el('div', { class: 'name' }, p.name), el('div', { class: 'addr' }, p.address || '')),
      badge(p.verdict)));
  }
}

function render() {
  const list = filter ? places.filter(p => p.verdict === filter) : places;
  renderFilters();
  renderMap(list);
  renderList(list);
}

function setView(v) {
  view = v;
  $('tabMap').setAttribute('aria-selected', String(v === 'map'));
  $('tabList').setAttribute('aria-selected', String(v === 'list'));
  $('list').hidden = v !== 'list';
  locateBtn.hidden = v !== 'map';
  if (v !== 'map') areaBtn.hidden = true;
  if (v === 'map') setTimeout(() => map.invalidateSize(), 0);
}
$('tabMap').onclick = () => setView('map');
$('tabList').onclick = () => setView('list');

// ---------- Salva un posto ----------

let draft = null;

function openAdd(prefill) {
  draft = null;
  $('addStep1').hidden = false;
  $('addStep2').hidden = true;
  $('results').replaceChildren();
  $('searchMsg').textContent = '';
  $('searchInput').value = prefill || '';
  $('dlgAdd').showModal();
  if (prefill) search(prefill);
}
$('fab').onclick = () => openAdd('');

// Prova a leggere nome e coordinate da un link di Google Maps
function parseMapsLink(text) {
  const m = text.match(/https?:\/\/\S+/);
  if (!m) return null;
  const url = m[0];
  const out = { url };
  const name = url.match(/\/place\/([^/@?]+)/);
  if (name) out.name = decodeURIComponent(name[1].replace(/\+/g, ' '));
  const coords = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || url.match(/[?&](?:q|ll|query)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (coords) { out.lat = Number(coords[1]); out.lng = Number(coords[2]); }
  const rest = text.replace(url, '').trim();
  if (!out.name && rest) out.name = rest.split('\n')[0].slice(0, 80);
  return out;
}

const GOOGLE_KEY = (window.SPOTIT_CONFIG && window.SPOTIT_CONFIG.googlePlacesKey) || '';

// Ricerca con Google Places (New): trova i locali come Google Maps
async function googleSearch(q) {
  const body = { textQuery: q, languageCode: 'it', regionCode: 'IT', pageSize: 6 };
  if (lastPos) body.locationBias = { circle: { center: { latitude: lastPos.lat, longitude: lastPos.lng }, radius: 30000 } };
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  return (data.places || []).map(r => ({
    name: (r.displayName && r.displayName.text) || '',
    address: r.formattedAddress || '',
    lat: r.location.latitude,
    lng: r.location.longitude,
    gid: r.id
  }));
}

async function osmSearch(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&accept-language=it&q=' + encodeURIComponent(q);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status);
  return (await res.json()).map(r => ({
    name: r.name || r.display_name.split(',')[0],
    address: r.display_name.split(',').slice(1, 4).join(',').trim(),
    lat: Number(r.lat),
    lng: Number(r.lon),
    gid: ''
  }));
}

async function search(raw) {
  const q0 = raw.trim();
  if (!q0) return;
  const link = parseMapsLink(q0);
  if (link && link.name && Number.isFinite(link.lat)) {
    startDraft({ name: link.name, address: '', lat: link.lat, lng: link.lng });
    return;
  }
  const q = link ? (link.name || '') : q0;
  if (!q) {
    $('searchMsg').textContent = 'Da questo link non riesco a leggere il posto: scrivi il nome e la città.';
    return;
  }
  $('searchInput').value = q;
  $('searchMsg').textContent = 'Cerco…';
  $('results').replaceChildren();
  try {
    const data = GOOGLE_KEY ? await googleSearch(q) : await osmSearch(q);
    $('searchMsg').textContent = data.length ? '' : 'Nessun risultato. Prova ad aggiungere la città.';
    for (const r of data) {
      $('results').append(el('li', {}, el('button', {
        type: 'button',
        onclick: () => startDraft(r)
      }, el('span', { class: 'name' }, r.name), el('span', { class: 'addr' }, r.address))));
    }
  } catch {
    $('searchMsg').textContent = 'Ricerca non disponibile in questo momento. Riprova tra poco.';
  }
}

$('searchForm').onsubmit = e => { e.preventDefault(); search($('searchInput').value); };

$('btnHere').onclick = async () => {
  $('searchMsg').textContent = 'Cerco la tua posizione…';
  try {
    const pos = await getPosition();
    const here = { name: '', address: 'Posizione attuale', lat: pos.lat, lng: pos.lng, gid: '' };
    let near = [];
    $('searchMsg').textContent = 'Cerco i locali qui intorno…';
    let failed = false;
    try {
      near = GOOGLE_KEY ? await googleNearby(pos) : await osmNearby(pos, 150);
      // Il GPS al chiuso può sbagliare di qualche centinaio di metri: allarga la ricerca
      if (!near.length && !GOOGLE_KEY) near = await osmNearby(pos, 500);
    } catch { failed = true; }
    // Il posto davanti a cui sei: i locali più vicini, il primo è quasi sempre quello giusto
    $('searchMsg').textContent = near.length ? 'Sei davanti a uno di questi?'
      : failed ? 'Non riesco a cercare i locali vicini in questo momento. Riprova tra poco, oppure salva il punto e scrivi tu il nome.'
      : 'Non ho trovato locali qui vicino. Puoi salvare il punto e scrivere tu il nome.';
    $('results').replaceChildren(...near.map(r => el('li', {}, el('button', {
      type: 'button', onclick: () => startDraft(r)
    }, el('span', { class: 'name' }, r.name), el('span', { class: 'addr' }, r.address)))),
    el('li', {}, el('button', { type: 'button', onclick: () => startDraft(here) },
      el('span', { class: 'name' }, 'Non è in elenco'), el('span', { class: 'addr' }, 'Salva questo punto e scrivi tu il nome'))));
  } catch {
    $('searchMsg').textContent = 'Posizione non disponibile: controlla i permessi del browser.';
  }
};

// Locali vicini da OpenStreetMap (gratis), usato finché non c'è la chiave Google
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function osmEmoji(t) {
  const k = t.amenity || t.shop || t.tourism || '';
  return ({ restaurant: '🍝', fast_food: '🍔', bar: '🍸', pub: '🍺', biergarten: '🍺', cafe: '☕', ice_cream: '🍦',
    food_court: '🍽️', bakery: '🥐', pastry: '🍰', confectionery: '🍬', wine: '🍷', deli: '🧀',
    hotel: '🏨', guest_house: '🏡', museum: '🏛️', attraction: '⭐' })[k] || '📍';
}

async function osmNearby(pos, radius, limit = 8) {
  const tags = 'amenity~"^(restaurant|bar|cafe|pub|fast_food|ice_cream|biergarten|food_court)$"';
  const around = `around:${radius},${pos.lat},${pos.lng}`;
  const q = `[out:json][timeout:15];(nwr(${around})[${tags}][name];` +
    `nwr(${around})[tourism~"^(hotel|museum|attraction|guest_house)$"][name];` +
    `nwr(${around})[shop~"^(bakery|pastry|confectionery|wine|deli|ice_cream)$"][name];);out center 60;`;
  const body = 'data=' + encodeURIComponent(q);
  // Se il server principale è occupato, prova un server alternativo
  let res;
  try { res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body }); } catch { res = null; }
  if (!res || !res.ok) res = await fetch('https://overpass.kumi.systems/api/interpreter', { method: 'POST', body });
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180));
  return (data.elements || []).map(e => {
    const t = e.tags || {};
    const lat = e.lat ?? (e.center && e.center.lat), lng = e.lon ?? (e.center && e.center.lon);
    const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    return { name: t.name, address: [street, t['addr:city']].filter(Boolean).join(', '), lat, lng, gid: '', emoji: osmEmoji(t) };
  }).filter(r => r.name && Number.isFinite(r.lat))
    .sort((a, b) => dist(a, pos) - dist(b, pos))
    .slice(0, limit);
}

async function googleNearby(pos) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location'
    },
    body: JSON.stringify({
      maxResultCount: 6,
      rankPreference: 'DISTANCE',
      languageCode: 'it',
      locationRestriction: { circle: { center: { latitude: pos.lat, longitude: pos.lng }, radius: 120 } }
    })
  });
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  return (data.places || []).map(r => ({
    name: (r.displayName && r.displayName.text) || '',
    address: r.formattedAddress || '',
    lat: r.location.latitude,
    lng: r.location.longitude,
    gid: r.id
  })).filter(r => r.name);
}

function startDraft(d) {
  draft = { ...d, verdict: null, note: '', photos: [] };
  $('addStep1').hidden = true;
  $('addStep2').hidden = false;
  $('draftName').value = d.name;
  $('draftAddress').textContent = d.address;
  $('draftNote').value = '';
  drawDraftVerdicts();
  drawDraftPhotos();
  if (!d.name) $('draftName').focus();
}
function drawDraftVerdicts() {
  verdictPicker($('draftVerdicts'), draft.verdict, v => { draft.verdict = v; drawDraftVerdicts(); });
  $('btnSave').disabled = !draft.verdict;
}
$('btnBack').onclick = () => { $('addStep1').hidden = false; $('addStep2').hidden = true; };
$('addStep2').onsubmit = e => {
  e.preventDefault();
  if (!draft || !draft.verdict) return;
  const p = cleanPlace({ ...draft, name: $('draftName').value, note: $('draftNote').value, createdAt: Date.now(), id: uid() });
  if (!p) { toast('Scrivi il nome del posto'); return; }
  places.push(p);
  persist();
  if (draft.photos.length) setPhotos(p.id, draft.photos).catch(() => toast('Spazio esaurito: foto non salvate'));
  $('dlgAdd').close();
  map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15));
  toast(`Salvato come "${V[p.verdict].label}"`);
};

// ---------- Foto ----------
// Le foto stanno in IndexedDB (localStorage è troppo piccolo), ridotte a 1280 px.

const MAX_PHOTOS = 8;
let dbPromise = null;
function photoDb() {
  dbPromise = dbPromise || new Promise((resolve, reject) => {
    const req = indexedDB.open('spotit', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('photos');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function getPhotos(id) {
  try {
    const db = await photoDb();
    return await new Promise(res => {
      const r = db.transaction('photos').objectStore('photos').get(id);
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => res([]);
    });
  } catch { return []; }
}
async function setPhotos(id, list) {
  const db = await photoDb();
  await new Promise((res, rej) => {
    const tx = db.transaction('photos', 'readwrite');
    if (list.length) tx.objectStore('photos').put(list, id); else tx.objectStore('photos').delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function shrinkPhoto(file) {
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return c.toDataURL('image/jpeg', 0.75);
}

// Disegna miniature + pulsante "Aggiungi foto"; onChange riceve la nuova lista
function photoStrip(box, list, onChange) {
  const input = el('input', { type: 'file', accept: 'image/*', multiple: '', class: 'sr' });
  input.onchange = async () => {
    const files = [...input.files].slice(0, MAX_PHOTOS - list.length);
    if (!files.length) return;
    toast('Aggiungo la foto…');
    const added = [];
    for (const f of files) { try { added.push(await shrinkPhoto(f)); } catch {} }
    if (added.length) onChange([...list, ...added]); else toast('Non riesco a leggere la foto');
  };
  const thumbs = list.map((src, i) => el('button', { type: 'button', class: 'thumb', 'aria-label': `Foto ${i + 1}`,
    onclick: () => showPhoto(src, () => onChange(list.filter((_, j) => j !== i))) }, el('img', { src, alt: '' })));
  const add = list.length < MAX_PHOTOS
    ? el('label', { class: 'thumb add' }, input, el('span', { 'aria-hidden': 'true' }, '📷'), el('span', {}, list.length ? 'Altra foto' : 'Aggiungi foto'))
    : null;
  box.replaceChildren(...thumbs, ...(add ? [add] : []));
}

let onPhotoDelete = null;
function showPhoto(src, onDelete) {
  $('photoBig').src = src;
  onPhotoDelete = onDelete;
  $('dlgPhoto').showModal();
}
$('photoDelete').onclick = () => {
  if (!confirm('Eliminare questa foto?')) return;
  $('dlgPhoto').close();
  if (onPhotoDelete) onPhotoDelete();
};

function drawDraftPhotos() {
  photoStrip($('draftPhotos'), draft.photos, l => { draft.photos = l; drawDraftPhotos(); });
}
let currentPhotos = [];
async function drawPlacePhotos(id) {
  const list = await getPhotos(id);
  if (currentId !== id) return;
  currentPhotos = list;
  $('pAttachRow').hidden = !list.length;
  if (!list.length) $('pAttach').checked = false;
  photoStrip($('pPhotos'), list, async l => {
    try { await setPhotos(id, l); } catch { toast('Spazio esaurito sul telefono'); }
    drawPlacePhotos(id);
  });
}

// ---------- Scheda posto ----------

let currentId = null;

function openPlace(id) {
  const p = places.find(x => x.id === id);
  if (!p) return;
  currentId = id;
  $('pName').textContent = p.name;
  $('pAddress').textContent = p.address;
  $('pFrom').hidden = !p.from;
  $('pFrom').textContent = p.from ? `Consigliato da ${p.from}` : '';
  $('pNote').value = p.note;
  $('pDirections').href = mapsUrl(p);
  drawPlaceVerdicts(p);
  $('pPhotos').replaceChildren();
  $('pAttach').checked = false;
  $('pAttachRow').hidden = true;
  currentPhotos = [];
  drawPlacePhotos(id);
  if (!$('dlgPlace').open) $('dlgPlace').showModal();
}
// Apre il posto in Google Maps (scheda del locale se abbiamo il suo id Google)
function mapsUrl(p) {
  return p.gid
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}&query_place_id=${encodeURIComponent(p.gid)}`
    : `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
}

function drawPlaceVerdicts(p) {
  verdictPicker($('pVerdicts'), p.verdict, v => { p.verdict = v; persist(); drawPlaceVerdicts(p); });
}
$('pNote').onchange = () => {
  const p = places.find(x => x.id === currentId);
  if (p) { p.note = $('pNote').value.slice(0, 280); persist(); }
};
$('pDelete').onclick = () => {
  const p = places.find(x => x.id === currentId);
  if (!p || !confirm(`Eliminare "${p.name}"?`)) return;
  places = places.filter(x => x.id !== currentId);
  setPhotos(p.id, []).catch(() => {});
  persist();
  $('dlgPlace').close();
};

// ---------- Condivisione ----------

function encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}
function appUrl() { return location.origin + location.pathname; }

function shareText(p) {
  const by = prefs.name || 'Un amico';
  const data = { n: p.name, a: p.address, la: +p.lat.toFixed(6), lo: +p.lng.toFixed(6), v: p.verdict, t: p.note, b: prefs.name, g: p.gid || undefined };
  const url = `${appUrl()}#s=${encode(data)}`;
  return { text: `${by} ti consiglia "${p.name}" (${V[p.verdict].label}) su SpotIt`, url };
}
function current() { return places.find(x => x.id === currentId); }

// Condivide link + foto con il menu del telefono (si sceglie WhatsApp). true se è andata.
// Niente attese prima di navigator.share: Safari lo blocca se il tocco è "scaduto".
function shareWithPhotos(p) {
  const s = shareText(p);
  const files = currentPhotos.map((src, i) => {
    const bin = atob(src.split(',')[1]);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new File([bytes], `spotit-${i + 1}.jpg`, { type: 'image/jpeg' });
  });
  // Il link va nel testo: con le foto alcune app ignorano il campo url
  const data = { files, text: `${s.text}: ${s.url}` };
  if (!files.length || !navigator.canShare || !navigator.canShare(data)) {
    toast('Questo telefono non permette di allegare le foto: invio solo il link');
    return false;
  }
  navigator.share(data).catch(() => { /* annullato */ });
  return true;
}

$('pShare').onclick = async () => {
  const p = current(); if (!p) return;
  if (!prefs.name) toast('Suggerimento: metti il tuo nome nel profilo');
  if ($('pAttach').checked && shareWithPhotos(p)) return;
  const s = shareText(p);
  window.open('https://wa.me/?text=' + encodeURIComponent(`${s.text}: ${s.url}`), '_blank', 'noopener');
};
$('pShareMore').onclick = async () => {
  const p = current(); if (!p) return;
  if ($('pAttach').checked && shareWithPhotos(p)) return;
  const s = shareText(p);
  if (navigator.share) {
    try { await navigator.share({ title: p.name, text: s.text, url: s.url }); } catch { /* annullato */ }
  } else {
    try { await navigator.clipboard.writeText(`${s.text}: ${s.url}`); toast('Link copiato'); } catch { prompt('Copia il link', s.url); }
  }
};

// Apertura di un link ricevuto da un amico
let incoming = null;
function checkIncoming() {
  const m = location.hash.match(/^#s=([A-Za-z0-9_-]+)/);
  if (!m) return;
  history.replaceState(null, '', appUrl());
  let d;
  try { d = decode(m[1]); } catch { toast('Link non valido'); return; }
  const p = cleanPlace({ name: d.n, address: d.a, lat: d.la, lng: d.lo, verdict: d.v, note: d.t, from: d.b, gid: d.g });
  if (!p) { toast('Link non valido'); return; }
  incoming = { ...p, mine: p.verdict === 'sconsigliato' || p.verdict === 'nonandarci' ? 'nonandarci' : 'andarci' };
  $('sTitle').textContent = p.from ? `${p.from} ti consiglia` : 'Ti hanno consigliato';
  $('sName').textContent = p.name;
  $('sAddress').textContent = p.address;
  $('sBadge').replaceWith(Object.assign(badge(p.verdict), { id: 'sBadge' }));
  $('sNote').hidden = !p.note;
  $('sNote').textContent = p.note ? `"${p.note}"` : '';
  drawIncomingVerdicts();
  $('dlgShared').showModal();
}
function drawIncomingVerdicts() {
  verdictPicker($('sVerdicts'), incoming.mine, v => { incoming.mine = v; drawIncomingVerdicts(); });
}
$('sSave').onclick = () => {
  const exists = places.find(x => Math.abs(x.lat - incoming.lat) < 1e-5 && Math.abs(x.lng - incoming.lng) < 1e-5 && x.name === incoming.name);
  if (!exists) {
    places.push(cleanPlace({ ...incoming, verdict: incoming.mine, note: '', id: uid(), createdAt: Date.now() }));
    persist();
  }
  $('dlgShared').close();
  setView('map');
  map.setView([incoming.lat, incoming.lng], 15);
  toast(exists ? 'Era già tra i tuoi posti' : 'Salvato tra i tuoi posti');
};
window.addEventListener('hashchange', checkIncoming);

// Link condiviso verso l'app da Android (share target) o con ?q=
function checkShareTarget() {
  const qs = new URLSearchParams(location.search);
  const parts = [qs.get('title'), qs.get('text'), qs.get('url'), qs.get('q')].filter(Boolean);
  if (!parts.length) return;
  history.replaceState(null, '', appUrl());
  openAdd(parts.join('\n'));
}

// ---------- Profilo ----------

$('btnSettings').onclick = () => {
  $('myName').value = prefs.name;
  const box = $('counts');
  box.replaceChildren(...VERDICTS.map(v => el('div', { style: `background:${v.bg};color:${v.color}` },
    el('b', {}, String(places.filter(p => p.verdict === v.id).length)), v.label)));
  $('dlgSettings').showModal();
};
$('myName').onchange = () => { prefs.name = $('myName').value.trim().slice(0, 40); savePrefs(); };
$('btnInvite').onclick = () => {
  const by = prefs.name ? `${prefs.name} ti invita su SpotIt` : 'Prova SpotIt';
  window.open('https://wa.me/?text=' + encodeURIComponent(`${by}: salva i posti dove vuoi andare o tornare e scopri quelli che consigliano gli amici. ${appUrl()}`), '_blank', 'noopener');
};
$('btnExport').onclick = async () => {
  const photos = {};
  for (const p of places) { const l = await getPhotos(p.id); if (l.length) photos[p.id] = l; }
  const blob = new Blob([JSON.stringify({ app: 'spotit', v: 1, places, photos })], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `spotit-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
};
$('importFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incomingPlaces = (data.places || []).map(cleanPlace).filter(Boolean);
    const ids = new Set(places.map(p => p.id));
    const added = incomingPlaces.filter(p => !ids.has(p.id));
    places.push(...added);
    const photos = data.photos || {};
    for (const p of added) {
      const l = (photos[p.id] || []).filter(x => typeof x === 'string' && x.startsWith('data:image/')).slice(0, MAX_PHOTOS);
      if (l.length) await setPhotos(p.id, l).catch(() => {});
    }
    persist();
    toast(`Ripristinati ${added.length} posti`);
  } catch {
    toast('File non valido');
  }
  e.target.value = '';
};

// ---------- Installazione ----------

const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installEvent = null;

function showBanner(text, action, onAction) {
  if (prefs.installDismissed || isStandalone) return;
  $('installText').textContent = text;
  $('installBtn').textContent = action;
  $('installBtn').onclick = onAction;
  $('installBanner').hidden = false;
}
$('installClose').onclick = () => { $('installBanner').hidden = true; prefs.installDismissed = true; savePrefs(); };

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  showBanner('Installa SpotIt sul telefono', 'Installa', async () => {
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    $('installBanner').hidden = true;
  });
});
if (isIos && !isStandalone) {
  showBanner('Aggiungi SpotIt alla Home per usarla come app', 'Come fare', () => $('dlgIos').showModal());
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- Avvio ----------

places = places.map(cleanPlace).filter(Boolean);
render();
setView('map');
if (!/^#s=/.test(location.hash) && !location.search) locate();
checkIncoming();
checkShareTarget();
