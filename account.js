// Account e archivio online (Supabase).
// I posti restano sempre anche sul telefono: l'archivio online è una copia sincronizzata,
// così l'app funziona anche senza rete e senza account.

(function () {
  const CFG = window.SPOTIT_CONFIG || {};
  if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase) return;

  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'spotit.auth' }
  });
  const SYNC_KEY = 'spotit.sync.v1';
  let user = null;
  // Ultima versione di ogni posto allineata con l'archivio online: serve a capire cosa è cambiato
  let sync = load(SYNC_KEY, { uid: null, snap: {} });
  let syncing = false, again = false;
  // Ritorno da Google o dal link email: dopo l'accesso lo dico chiaramente
  const fromLogin = /access_token=|[?&]code=/.test(location.hash + location.search);
  const loginError = /error_description=/.test(location.hash + location.search);

  $('account').hidden = false;

  // Contenuto di un posto senza la data di modifica: se cambia, va caricato online
  function fingerprint(p) {
    const { updatedAt, ...rest } = p;
    return JSON.stringify(rest);
  }
  function toRow(p) {
    return {
      user_id: user.id, id: p.id, name: p.name, address: p.address, lat: p.lat, lng: p.lng,
      verdict: p.verdict, note: p.note, from_name: p.from, gid: p.gid, gphoto: p.gphoto || '',
      gphoto_by: p.gphotoBy || '', created_at: p.createdAt, updated_at: p.updatedAt, deleted: false
    };
  }
  function fromRow(r) {
    return cleanPlace({
      id: r.id, name: r.name, address: r.address, lat: r.lat, lng: r.lng, verdict: r.verdict,
      note: r.note, from: r.from_name, gid: r.gid, gphoto: r.gphoto, gphotoBy: r.gphoto_by,
      createdAt: r.created_at, updatedAt: r.updated_at
    });
  }
  function saveSync() { save(SYNC_KEY, sync); }

  // Salva sul telefono senza ripartire con la sincronizzazione
  const persistLocal = persist;
  persist = function () { persistLocal(); scheduleSync(); };

  let timer = null;
  function scheduleSync() {
    if (!user) return;
    clearTimeout(timer);
    timer = setTimeout(runSync, 800);
  }

  async function runSync() {
    if (!user) return;
    if (syncing) { again = true; return; }
    syncing = true;
    setSyncMsg('Sincronizzo…');
    try {
      await pull();
      await push();
      setSyncMsg(`${places.length} posti salvati online`);
    } catch (e) {
      setSyncMsg('Non riesco a sincronizzare ora: i posti restano sul telefono e riprovo dopo.');
    }
    syncing = false;
    if (again) { again = false; runSync(); }
  }

  // Scarica i posti online e li unisce a quelli del telefono (vince la modifica più recente)
  async function pull() {
    const { data, error } = await sb.from('places').select('*').eq('user_id', user.id);
    if (error) throw error;
    let changed = false;
    for (const r of data) {
      const i = places.findIndex(p => p.id === r.id);
      const local = i >= 0 ? places[i] : null;
      if (r.deleted) {
        if (local && local.updatedAt <= r.updated_at) { places.splice(i, 1); changed = true; }
        delete sync.snap[r.id];
        continue;
      }
      const p = fromRow(r);
      if (!p) continue;
      if (!local) {
        // Se l'avevo già allineato e ora non c'è più, l'ho eliminato io: lo cancellerà push()
        if (sync.snap[r.id]) continue;
        places.push(p); changed = true;
      } else if (r.updated_at > local.updatedAt) {
        places[i] = p; changed = true;
      } else continue;
      sync.snap[p.id] = fingerprint(p);
    }
    saveSync();
    if (changed) persistLocal();
  }

  // Carica online i posti nuovi o modificati e segna quelli eliminati
  async function push() {
    const now = Date.now();
    const dirty = places.filter(p => sync.snap[p.id] !== fingerprint(p));
    for (const p of dirty) if (sync.snap[p.id]) p.updatedAt = now;
    const ids = new Set(places.map(p => p.id));
    const gone = Object.keys(sync.snap).filter(id => !ids.has(id));
    if (dirty.length) {
      const { error } = await sb.from('places').upsert(dirty.map(toRow));
      if (error) throw error;
      for (const p of dirty) sync.snap[p.id] = fingerprint(p);
      persistLocal();
    }
    if (gone.length) {
      const { error } = await sb.from('places').update({ deleted: true, updated_at: now }).eq('user_id', user.id).in('id', gone);
      if (error) throw error;
      for (const id of gone) delete sync.snap[id];
    }
    saveSync();
  }

  async function syncProfile() {
    const { data } = await sb.from('profiles').select('name').eq('id', user.id).maybeSingle();
    if (data && data.name && !prefs.name) {
      prefs.name = data.name; savePrefs(); $('myName').value = data.name;
    } else if (prefs.name && (!data || data.name !== prefs.name)) {
      await sb.from('profiles').upsert({ id: user.id, name: prefs.name });
    } else if (!data) {
      await sb.from('profiles').upsert({ id: user.id, name: '' });
    }
  }
  $('myName').addEventListener('change', () => { if (user) sb.from('profiles').upsert({ id: user.id, name: prefs.name }); });

  function setSyncMsg(t) { $('accSync').textContent = t; }

  function showAccount() {
    $('accOut').hidden = !!user;
    $('accIn').hidden = !user;
    $('localNote').hidden = !!user;
    $('btnSettings').classList.toggle('signed', !!user);
    if (user) $('accWho').textContent = user.email || 'utente';
  }

  async function onUser(u) {
    const changedUser = (u && u.id) !== (user && user.id);
    user = u;
    showAccount();
    if (!user || !changedUser) return;
    // Su questo telefono entra un altro account: ricomincio l'allineamento da capo
    if (sync.uid !== user.id) { sync = { uid: user.id, snap: {} }; saveSync(); }
    if (fromLogin) toast(`Sei dentro come ${user.email || 'utente'}: i tuoi posti ora sono salvati online`);
    syncProfile().catch(() => {});
    runSync();
  }

  if (loginError) toast('Accesso non riuscito, riprova dal Profilo');

  sb.auth.onAuthStateChange((_event, session) => { onUser(session ? session.user : null); });
  sb.auth.getSession().then(({ data }) => onUser(data.session ? data.session.user : null));

  // Accesso con Google (si torna nell'app già dentro)
  $('accGoogle').onclick = async () => {
    $('accMsg').textContent = 'Ti porto da Google…';
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl() } });
    if (error) $('accMsg').textContent = 'Accesso con Google non disponibile ora. Riprova tra poco.';
  };

  // Accesso con link via email (riserva)
  $('accEmailForm').onsubmit = async e => {
    e.preventDefault();
    const email = $('accEmail').value.trim();
    if (!email) return;
    $('accMsg').textContent = 'Invio il link…';
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: appUrl() } });
    $('accMsg').textContent = error
      ? 'Non riesco a mandare l\'email ora. Prova con "Entra con Google".'
      : `Ti ho mandato un link a ${email}: aprilo da questo telefono (guarda anche nello spam).`;
  };
  $('accLogout').onclick = async () => {
    if (!confirm('Uscire dall\'account? I posti restano su questo telefono.')) return;
    await sb.auth.signOut();
    toast('Sei uscito');
  };

  // Al ritorno nell'app riallinea (es. posti aggiunti da un altro telefono)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(); });
})();
