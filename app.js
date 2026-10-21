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
    gphoto: /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(p.gphoto || '') && String(p.gphoto).length < 1000 ? p.gphoto : '',
    gphotoBy: String(p.gphotoBy || '').slice(0, 80),
    createdAt: Number(p.createdAt) || Date.now(),
    updatedAt: Number(p.updatedAt) || Number(p.createdAt) || Date.now()
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

// fresh: false accetta la posizione appena letta (è immediata)
function getPosition(fresh = true) {
  if (!fresh && lastPos) return Promise.resolve(lastPos);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no-geo'));
    navigator.geolocation.getCurrentPosition(
      p => { lastPos = { lat: p.coords.latitude, lng: p.coords.longitude }; resolve(lastPos); },
      reject,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}

async function locate() {
  try {
    const pos = await getPosition();
    if (meMarker) meMarker.remove();
    meMarker = L.circleMarker([pos.lat, pos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563EB', fillOpacity: 1 }).addTo(map);
    map.setView([pos.lat, pos.lng], 16);
  } catch {
    toast('Posizione non disponibile: controlla i permessi');
  }
}

// ---------- Locali intorno a te sulla mappa ----------
// Puntini bianchi: i locali vicini da toccare e salvare al volo


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
  const all = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(filter === null), onclick: () => { filter = null; render(); focusFilter(); } }, `Tutti ${places.length}`);
  box.append(all);
  for (const v of VERDICTS) {
    const n = places.filter(p => p.verdict === v.id).length;
    box.append(el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(filter === v.id),
      onclick: () => { filter = filter === v.id ? null : v.id; render(); focusFilter(); }
    }, el('span', { class: 'dot', style: `background:${v.color}` }), `${v.label} ${n}`));
  }
}

// Dopo aver scelto un filtro: avvisa se è vuoto, altrimenti inquadra quei posti
function focusFilter() {
  const list = filter ? places.filter(p => p.verdict === filter) : places;
  if (!list.length) {
    toast(filter ? `Nessun posto "${V[filter].label}" ancora` : 'Non hai ancora salvato nessun posto');
    return;
  }
  if (view === 'map') map.fitBounds(L.latLngBounds(list.map(p => [p.lat, p.lng])).pad(0.2), { maxZoom: 16 });
}
function metersBetween(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function formatDistance(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toLocaleString('it-IT', { maximumFractionDigits: m < 10000 ? 1 : 0 })} km`;
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
  // Con la posizione nota: i più vicini in alto, con la distanza; altrimenti i più recenti
  const d = p => lastPos ? metersBetween(lastPos, p) : 0;
  const sorted = [...list].sort((a, b) => lastPos ? d(a) - d(b) : b.createdAt - a.createdAt);
  for (const p of sorted) {
    box.append(el('button', { type: 'button', class: 'item', onclick: () => openPlace(p.id) },
      el('span', { class: 'dot', style: `background:${V[p.verdict].color}` }),
      el('span', { class: 'txt' }, el('div', { class: 'name' }, p.name), el('div', { class: 'addr' }, p.address || '')),
      el('span', { class: 'side' }, badge(p.verdict), lastPos ? el('span', { class: 'dist' }, formatDistance(d(p))) : '')));
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
  if (v === 'map') setTimeout(() => map.invalidateSize(), 0);
  // aggiorna le distanze con la posizione attuale
  if (v === 'list') getPosition().then(render).catch(() => {});
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
// Prima foto del locale su Google: salvo solo il riferimento, l'immagine la carica Google
function googlePhoto(r) {
  const ph = r.photos && r.photos[0];
  if (!ph) return {};
  const by = ph.authorAttributions && ph.authorAttributions[0];
  return { gphoto: ph.name, gphotoBy: (by && by.displayName) || '' };
}
function gPhotoUrl(name, w = 800) {
  return `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${w}&key=${encodeURIComponent(GOOGLE_KEY)}`;
}
function showCover(box, p) {
  const ok = GOOGLE_KEY && p && p.gphoto;
  box.hidden = !ok;
  if (!ok) return;
  const img = box.querySelector('img');
  img.referrerPolicy = 'no-referrer-when-downgrade';
  img.onerror = () => { box.hidden = true; };
  img.src = gPhotoUrl(p.gphoto);
  box.querySelector('figcaption').textContent = p.gphotoBy ? `Foto: ${p.gphotoBy} su Google` : 'Foto da Google';
}

async function googleSearch(q) {
  const body = { textQuery: q, languageCode: 'it', regionCode: 'IT', pageSize: 6 };
  if (lastPos) body.locationBias = { circle: { center: { latitude: lastPos.lat, longitude: lastPos.lng }, radius: 30000 } };
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    // la chiave è limitata a dpfphoto.github.io/spotit/: Google deve vedere l'indirizzo completo
    referrerPolicy: 'no-referrer-when-downgrade',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.photos'
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
    gid: r.id,
    ...googlePhoto(r)
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

// Sono nel posto: apro subito la scheda sul punto GPS, nome e indirizzo arrivano dopo se possibile
$('btnHere').onclick = async () => {
  const btn = $('btnHere');
  btn.disabled = true;
  btn.textContent = 'Cerco la tua posizione…';
  let pos;
  try { pos = await getPosition(false); } catch { pos = null; }
  btn.disabled = false;
  btn.textContent = 'Sono qui: aggiungi questo posto';
  if (!pos) { toast('Posizione non disponibile: controlla i permessi di posizione'); return; }
  startDraft({ name: '', address: '', lat: pos.lat, lng: pos.lng, gid: '' });
  const d = draft;
  $('draftAddress').textContent = 'Cerco l\'indirizzo…';
  suggestHere(pos, d);
  const addr = await reverseAddress(pos).catch(() => '');
  if (draft !== d) return;
  if (!d.address) { d.address = addr; $('draftAddress').textContent = addr || 'Posizione salvata'; }
};

// Indirizzo della posizione (gratis, OpenStreetMap)
async function reverseAddress(pos) {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 8000);
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=it&lat=${pos.lat}&lon=${pos.lng}`, { signal: ctl.signal });
  if (!res.ok) return '';
  const a = (await res.json()).address || {};
  const street = [a.road || a.pedestrian || a.square, a.house_number].filter(Boolean).join(' ');
  return [street, a.city || a.town || a.village || a.suburb].filter(Boolean).join(', ');
}

// Propone i nomi dei locali più vicini: un tocco e nome/indirizzo si compilano
async function suggestHere(pos, d) {
  const box = $('draftSuggest');
  box.replaceChildren(el('span', { class: 'muted' }, 'Cerco i locali qui intorno…'));
  let near = [];
  try { near = GOOGLE_KEY ? await googleNearby(pos, 500) : await osmNearby(pos, 500, 10); } catch { near = []; }
  // se Google non risponde, provo i dati gratuiti
  if (!near.length && GOOGLE_KEY) { try { near = await osmNearby(pos, 500, 10); } catch { near = []; } }
  if (draft !== d) return;
  if (!near.length) { box.replaceChildren(el('span', { class: 'muted' }, 'Nessun locale trovato qui intorno: scrivi tu il nome.')); return; }
  const meters = r => Math.round(Math.hypot((r.lat - pos.lat) * 111320, (r.lng - pos.lng) * 111320 * Math.cos(pos.lat * Math.PI / 180)) / 10) * 10;
  box.replaceChildren(el('span', { class: 'muted' }, 'Locali qui intorno, tocca quello giusto:'), ...near.map(r => el('button', {
    type: 'button', class: 'chip', onclick: () => {
      Object.assign(d, { name: r.name, address: r.address || d.address, lat: r.lat, lng: r.lng, gid: r.gid, gphoto: r.gphoto || '', gphotoBy: r.gphotoBy || '' });
      showCover($('draftCover'), d);
      $('draftName').value = r.name;
      $('draftAddress').textContent = d.address;
      box.replaceChildren();
    }
  }, r.name, el('span', { class: 'dist' }, `${meters(r)} m`))));
}

// Locali vicini da OpenStreetMap (gratis), usato finché non c'è la chiave Google
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function osmNearby(pos, radius, limit = 8) {
  const tags = 'amenity~"^(restaurant|bar|cafe|pub|fast_food|ice_cream|biergarten|food_court)$"';
  const around = `around:${radius},${pos.lat},${pos.lng}`;
  const q = `[out:json][timeout:15];(nwr(${around})[${tags}][name];` +
    `nwr(${around})[tourism~"^(hotel|museum|attraction|guest_house)$"][name];` +
    `nwr(${around})[shop~"^(bakery|pastry|confectionery|wine|deli|ice_cream)$"][name];);out center 60;`;
  const body = 'data=' + encodeURIComponent(q);
  // I server gratuiti a volte sono lenti o occupati: provo il successivo dopo 8 secondi
  let data = null;
  for (const server of OVERPASS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(server, { method: 'POST', body, signal: ctl.signal });
      if (res.ok) { data = await res.json(); break; }
    } catch { /* provo il prossimo */ }
    finally { clearTimeout(timer); }
  }
  if (!data) throw new Error('overpass');
  const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180));
  return (data.elements || []).map(e => {
    const t = e.tags || {};
    const lat = e.lat ?? (e.center && e.center.lat), lng = e.lon ?? (e.center && e.center.lon);
    const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    return { name: t.name, address: [street, t['addr:city']].filter(Boolean).join(', '), lat, lng, gid: '' };
  }).filter(r => r.name && Number.isFinite(r.lat))
    .sort((a, b) => dist(a, pos) - dist(b, pos))
    .slice(0, limit);
}

async function googleNearby(pos, radius = 120) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    // la chiave è limitata a dpfphoto.github.io/spotit/: Google deve vedere l'indirizzo completo
    referrerPolicy: 'no-referrer-when-downgrade',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.photos'
    },
    body: JSON.stringify({
      maxResultCount: radius > 200 ? 20 : 6,
      // solo locali, niente fermate del bus o bancomat
      includedTypes: ['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway', 'ice_cream_shop', 'night_club', 'lodging', 'museum'],
      rankPreference: 'DISTANCE',
      languageCode: 'it',
      locationRestriction: { circle: { center: { latitude: pos.lat, longitude: pos.lng }, radius } }
    })
  });
  if (!res.ok) throw new Error(res.status);
  const data = await res.json();
  return (data.places || []).map(r => ({
    name: (r.displayName && r.displayName.text) || '',
    address: r.formattedAddress || '',
    lat: r.location.latitude,
    lng: r.location.longitude,
    gid: r.id,
    ...googlePhoto(r)
  })).filter(r => r.name);
}

function startDraft(d) {
  draft = { ...d, verdict: null, note: '', photos: [] };
  $('addStep1').hidden = true;
  $('addStep2').hidden = false;
  $('draftName').value = d.name;
  $('draftAddress').textContent = d.address;
  $('draftSuggest').replaceChildren();
  showCover($('draftCover'), d);
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
  showCover($('pCover'), p);
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
  const data = { n: p.name, a: p.address, la: +p.lat.toFixed(6), lo: +p.lng.toFixed(6), v: p.verdict, t: p.note, b: prefs.name, g: p.gid || undefined, f: p.gphoto || undefined, fb: p.gphotoBy || undefined };
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
  const p = cleanPlace({ name: d.n, address: d.a, lat: d.la, lng: d.lo, verdict: d.v, note: d.t, from: d.b, gid: d.g, gphoto: d.f, gphotoBy: d.fb });
  if (!p) { toast('Link non valido'); return; }
  incoming = { ...p, mine: p.verdict === 'sconsigliato' || p.verdict === 'nonandarci' ? 'nonandarci' : 'andarci' };
  $('sTitle').textContent = p.from ? `${p.from} ti consiglia` : 'Ti hanno consigliato';
  $('sName').textContent = p.name;
  $('sAddress').textContent = p.address;
  showCover($('sCover'), p);
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

// ---------- Uscite con gli amici ----------
// Niente account per ora: l'invito è un link con posto, giorno e ora.
// Chi lo apre vede quando partire da dove si trova e mette il promemoria nel calendario.

function pad2(n) { return String(n).padStart(2, '0'); }
function outingFromPlace(p) {
  return { n: p.name, a: p.address, la: +p.lat.toFixed(6), lo: +p.lng.toFixed(6), g: p.gid || undefined, f: p.gphoto || undefined, fb: p.gphotoBy || undefined };
}
function whenLabel(t) {
  const d = new Date(t);
  return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }) + ' alle ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

let outing = null;
$('pOuting').onclick = () => {
  const p = current(); if (!p) return;
  const t = new Date(Date.now() + 86400000); t.setHours(20, 30, 0, 0);
  outing = outingFromPlace(p);
  $('oPlace').textContent = p.name;
  $('oDate').value = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
  $('oDate').min = new Date().toISOString().slice(0, 10);
  $('oTime').value = '20:30';
  $('oMsg').value = '';
  $('dlgOuting').showModal();
};
function readOuting() {
  if (!$('oDate').value || !$('oTime').value) { toast('Scegli giorno e ora'); return null; }
  return { ...outing, t: `${$('oDate').value}T${$('oTime').value}`, m: $('oMsg').value.trim() || undefined, b: prefs.name || undefined };
}
function inviteText(o) {
  const who = prefs.name || 'Un amico';
  const url = `${appUrl()}#u=${encode(o)}`;
  return `${who} ti invita da "${o.n}" ${whenLabel(o.t)}${o.m ? ` (${o.m})` : ''}. Apri per sapere quando partire: ${url}`;
}
$('oWhatsapp').onclick = () => {
  const o = readOuting(); if (!o) return;
  if (!prefs.name) toast('Suggerimento: metti il tuo nome nel profilo');
  window.open('https://wa.me/?text=' + encodeURIComponent(inviteText(o)), '_blank', 'noopener');
};
$('oMore').onclick = async () => {
  const o = readOuting(); if (!o) return;
  const text = inviteText(o);
  if (navigator.share) { try { await navigator.share({ title: o.n, text }); } catch { /* annullato */ } }
  else { try { await navigator.clipboard.writeText(text); toast('Invito copiato'); } catch { prompt('Copia l\'invito', text); } }
};
$('oMine').onclick = async () => {
  const o = readOuting(); if (!o) return;
  const travel = lastPos ? await travelMinutes(lastPos, { lat: o.la, lng: o.lo }) : null;
  downloadIcs(o, travel);
};

// Tempo di viaggio in auto: Google se disponibile, altrimenti una stima dalla distanza
async function travelMinutes(from, to) {
  if (GOOGLE_KEY) {
    try {
      const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        referrerPolicy: 'no-referrer-when-downgrade',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': 'routes.duration' },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
          destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
          travelMode: 'DRIVE'
        })
      });
      if (res.ok) {
        const r = (await res.json()).routes;
        const sec = r && r[0] && parseInt(r[0].duration, 10);
        if (sec) return { min: Math.ceil(sec / 60), exact: true };
      }
    } catch { /* uso la stima */ }
  }
  // in città circa 25 km/h considerando le curve delle strade
  const km = metersBetween(from, to) * 1.3 / 1000;
  return { min: Math.max(5, Math.ceil(km / 25 * 60)), exact: false };
}

const MARGIN_MIN = 10;
function icsDate(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
}
function icsEscape(s) { return String(s || '').replace(/[\;,]/g, c => '\\' + c).replace(/\n/g, '\\n'); }
function downloadIcs(o, travel) {
  const start = new Date(o.t);
  const end = new Date(start.getTime() + 2 * 3600000);
  const before = (travel ? travel.min : 30) + MARGIN_MIN;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SpotIt//IT', 'BEGIN:VEVENT',
    `UID:${uid()}@spotit`, `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(o.n)}${o.m ? ' - ' + icsEscape(o.m) : ''}`,
    `LOCATION:${icsEscape(o.a || o.n)}`,
    `DESCRIPTION:${icsEscape('Uscita organizzata con SpotIt' + (o.b ? ' da ' + o.b : ''))}`,
    `GEO:${o.la};${o.lo}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape('È ora di partire per ' + o.n)}`, `TRIGGER:-PT${before}M`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'uscita-spotit.ics' });
  document.body.append(a); a.click(); a.remove();
  toast(`Promemoria ${before} minuti prima`);
}

let invite = null;
async function checkInvite() {
  const m = location.hash.match(/^#u=([A-Za-z0-9_-]+)/);
  if (!m) return;
  history.replaceState(null, '', appUrl());
  let o;
  try { o = decode(m[1]); } catch { toast('Invito non valido'); return; }
  const p = cleanPlace({ name: o.n, address: o.a, lat: o.la, lng: o.lo, gid: o.g, gphoto: o.f, gphotoBy: o.fb, from: o.b, verdict: 'andarci' });
  if (!p || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(o.t || '')) { toast('Invito non valido'); return; }
  invite = { o: { ...o, n: p.name, a: p.address, b: p.from, m: String(o.m || '').slice(0, 120) }, p, travel: null };
  $('iTitle').textContent = p.from ? `${p.from} ti invita` : 'Sei invitato';
  showCover($('iCover'), p);
  $('iName').textContent = p.name;
  $('iAddress').textContent = p.address;
  $('iWhen').textContent = whenLabel(o.t);
  $('iMsg').hidden = !invite.o.m;
  $('iMsg').textContent = invite.o.m ? `"${invite.o.m}"` : '';
  $('iRoute').href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
  $('iLeave').textContent = 'Calcolo quando partire da dove sei…';
  map.setView([p.lat, p.lng], 15);
  $('dlgInvite').showModal();
  try {
    const pos = await getPosition();
    invite.travel = await travelMinutes(pos, p);
    const leave = new Date(new Date(o.t).getTime() - (invite.travel.min + MARGIN_MIN) * 60000);
    const hhmm = leave.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    $('iLeave').replaceChildren(el('strong', {}, `Parti alle ${hhmm}`),
      ` · ${invite.travel.exact ? '' : 'circa '}${invite.travel.min} min in auto, con ${MARGIN_MIN} min di margine`);
  } catch {
    $('iLeave').textContent = 'Attiva la posizione per sapere a che ora partire.';
  }
}
$('iCalendar').onclick = () => { if (invite) downloadIcs(invite.o, invite.travel); };
$('iSave').onclick = () => {
  if (!invite) return;
  const p = invite.p;
  if (!places.some(x => x.name === p.name && Math.abs(x.lat - p.lat) < 1e-5)) {
    places.push(cleanPlace({ ...p, id: uid(), createdAt: Date.now(), note: invite.o.m || '' }));
    persist();
  }
  toast('Salvato tra i tuoi posti come "Andarci"');
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
if (!/^#[su]=/.test(location.hash) && !location.search) locate();
checkIncoming();
checkInvite();
checkShareTarget();
