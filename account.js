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
      verdict: p.verdict, note: p.note, kind: p.kind || '', from_name: p.from, gid: p.gid, gphoto: p.gphoto || '',
      gphoto_by: p.gphotoBy || '', created_at: p.createdAt, updated_at: p.updatedAt, deleted: false
    };
  }
  function fromRow(r) {
    return cleanPlace({
      id: r.id, name: r.name, address: r.address, lat: r.lat, lng: r.lng, verdict: r.verdict,
      note: r.note, kind: r.kind, from: r.from_name, gid: r.gid, gphoto: r.gphoto, gphotoBy: r.gphoto_by,
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
      // archivio senza la colonna del tipo: tengo quello scritto sul telefono
      if (!('kind' in r) && local) p.kind = local.kind;
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
      let { error } = await sb.from('places').upsert(dirty.map(toRow));
      // archivio non ancora aggiornato col tipo di locale: carico il resto e riprovo il tipo la prossima volta
      const noKind = error && /kind/i.test(error.message || '');
      if (noKind) ({ error } = await sb.from('places').upsert(dirty.map(p => { const { kind, ...row } = toRow(p); return row; })));
      if (error) throw error;
      if (!noKind) for (const p of dirty) sync.snap[p.id] = fingerprint(p);
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

  // Senza account l'app non si usa: la schermata di accesso copre tutto finché non entri
  const gate = $('dlgGate');
  gate.addEventListener('cancel', e => e.preventDefault());
  function showAccount() {
    $('accIn').hidden = !user;
    $('btnSettings').classList.toggle('signed', !!user);
    if (user) $('accWho').textContent = user.email || 'utente';
    if (user && gate.open) gate.close();
    // Riaperta sopra a tutto, anche sopra un posto ricevuto da un amico, che resta lì sotto
    if (!user && !gate.open) { $('dlgSettings').close(); gate.showModal(); }
  }

  async function onUser(u) {
    const changedUser = (u && u.id) !== (user && user.id);
    user = u;
    showAccount();
    if (!user || !changedUser) return;
    // Su questo telefono entra un altro account: ricomincio l'allineamento da capo
    if (sync.uid !== user.id) { sync = { uid: user.id, snap: {} }; saveSync(); }
    // Il nome per gli amici: se manca, quello dell'account Google
    const full = user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name);
    if (!prefs.name && full) { prefs.name = String(full).slice(0, 40); savePrefs(); $('myName').value = prefs.name; }
    if (fromLogin) toast(`Sei dentro come ${user.email || 'utente'}: i tuoi posti ora sono salvati online`);
    syncProfile().catch(() => {}).then(showWelcome);
    runSync();
    for (const fn of readyFns) fn(user);
  }

  // Per le altre parti dell'app (uscite di gruppo)
  const readyFns = [];
  window.SPOTIT_AUTH = {
    sb,
    user: () => user,
    onUser: fn => { readyFns.push(fn); if (user) fn(user); }
  };

  if (loginError) toast('Accesso non riuscito, riprova dal Profilo');

  sb.auth.onAuthStateChange((_event, session) => { onUser(session ? session.user : null); });
  sb.auth.getSession().then(({ data }) => onUser(data.session ? data.session.user : null));

  // Accesso con Google dentro l'app (Google mostra "SpotIt"): il pulsante lo disegna Google
  const gsiBox = $('gsiBtn');
  function showClassicGoogle() {
    gsiBox.hidden = true;
    $('accGoogle').hidden = false;
    $('accGoogleAlt').hidden = true;
  }
  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function startGsi() {
    if (!CFG.googleClientId || !window.google || !google.accounts || !crypto.subtle) return showClassicGoogle();
    // Il nonce lega il token di Google a questo tentativo di accesso
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    google.accounts.id.initialize({
      client_id: CFG.googleClientId,
      nonce: await sha256Hex(nonce),
      ux_mode: 'popup',
      context: 'signin',
      itp_support: true,
      use_fedcm_for_button: true,
      callback: async resp => {
        $('accMsg').textContent = 'Entro…';
        const { error } = await sb.auth.signInWithIdToken({ provider: 'google', token: resp.credential, nonce });
        if (error) {
          $('accMsg').textContent = 'Accesso non riuscito. Prova con l\'accesso alternativo qui sotto.';
          showClassicGoogle();
          return;
        }
        $('accMsg').textContent = '';
        toast('Sei dentro: i tuoi posti ora sono salvati online');
        startGsi(); // nonce nuovo per un eventuale accesso futuro
      }
    });
    gsiBox.replaceChildren();
    google.accounts.id.renderButton(gsiBox, {
      type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with',
      logo_alignment: 'center', locale: 'it', width: Math.min(360, Math.max(240, gsiBox.clientWidth || 320))
    });
    $('accGoogleAlt').hidden = false;
  }
  if (CFG.googleClientId) {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client?hl=it';
    s.async = true;
    s.onload = () => startGsi().catch(showClassicGoogle);
    s.onerror = showClassicGoogle;
    document.head.append(s);
    setTimeout(() => { if (!gsiBox.childElementCount) showClassicGoogle(); }, 8000);
  } else showClassicGoogle();
  $('accGoogleAlt').onclick = () => $('accGoogle').click();

  // Accesso con Google classico, passando dalla pagina di Google (riserva)
  $('accGoogle').onclick = async () => {
    $('accMsg').textContent = 'Ti porto da Google…';
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl() } });
    if (error) $('accMsg').textContent = 'Accesso con Google non disponibile ora. Riprova tra poco.';
  };

  // Accesso con email e password per chi non ha Google: registrazione confermata con un codice via email
  let codeMode = null; // 'signup' o 'recovery'
  const emMsg = t => { $('accMsg').textContent = t; };
  function askCode(mode, email) {
    codeMode = mode;
    $('emForm').hidden = true;
    $('emCodeForm').hidden = false;
    $('emNewPassBox').hidden = mode !== 'recovery';
    $('emCode').value = ''; $('emNewPass').value = '';
    $('emCodeMsg').textContent = `Ti ho mandato un codice a ${email}. Scrivilo qui (guarda anche nello spam).`;
    emMsg('');
    $('emCode').focus();
  }
  function readEmail() {
    const email = $('emEmail').value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) { emMsg('Scrivi la tua email'); $('emEmail').focus(); return null; }
    return email;
  }
  function readPass() {
    const pw = $('emPass').value;
    if (pw.length < 8) { emMsg('La password deve avere almeno 8 caratteri'); $('emPass').focus(); return null; }
    return pw;
  }
  $('emForm').onsubmit = async e => {
    e.preventDefault();
    const email = readEmail(); if (!email) return;
    const pw = readPass(); if (!pw) return;
    emMsg('Entro…');
    const { error } = await sb.auth.signInWithPassword({ email, password: pw });
    if (!error) { emMsg(''); return; }
    if (/confirm/i.test(error.message)) {
      await sb.auth.resend({ type: 'signup', email });
      askCode('signup', email);
    } else emMsg(/invalid/i.test(error.message)
      ? 'Email o password sbagliate. Se non hai ancora un account tocca "Crea account".'
      : 'Non riesco a entrare ora. Riprova tra poco.');
  };
  $('emSignup').onclick = async () => {
    const email = readEmail(); if (!email) return;
    const pw = readPass(); if (!pw) return;
    emMsg('Creo l\'account…');
    const { data, error } = await sb.auth.signUp({ email, password: pw });
    if (error) {
      emMsg(/registered|exists/i.test(error.message) ? 'Questa email ha già un account: tocca "Entra".'
        : /password/i.test(error.message) ? 'Password troppo semplice: usa lettere e numeri.'
        : 'Non riesco a mandare il codice ora. Riprova tra poco.');
      return;
    }
    if (data.session) { emMsg(''); return; } // conferma email non richiesta
    askCode('signup', email);
  };
  $('emForgot').onclick = async () => {
    const email = readEmail(); if (!email) return;
    emMsg('Invio il codice…');
    const { error } = await sb.auth.resetPasswordForEmail(email);
    if (error) { emMsg('Non riesco a mandare il codice ora. Riprova tra poco.'); return; }
    askCode('recovery', email);
  };
  $('emResend').onclick = async () => {
    const email = readEmail(); if (!email) return;
    const { error } = codeMode === 'recovery' ? await sb.auth.resetPasswordForEmail(email) : await sb.auth.resend({ type: 'signup', email });
    toast(error ? 'Aspetta un minuto e riprova' : 'Codice rimandato');
  };
  $('emBack').onclick = () => { $('emCodeForm').hidden = true; $('emForm').hidden = false; emMsg(''); };
  $('emCodeForm').onsubmit = async e => {
    e.preventDefault();
    const email = readEmail(); if (!email) return;
    const token = $('emCode').value.replace(/\D/g, '');
    if (token.length < 6) { emMsg('Scrivi il codice che hai ricevuto'); return; }
    if (codeMode === 'recovery' && $('emNewPass').value.length < 8) { emMsg('La nuova password deve avere almeno 8 caratteri'); return; }
    emMsg('Controllo il codice…');
    const { error } = await sb.auth.verifyOtp({ email, token, type: codeMode === 'recovery' ? 'recovery' : 'signup' });
    if (error) { emMsg('Codice sbagliato o scaduto. Controlla o fattelo rimandare.'); return; }
    if (codeMode === 'recovery') {
      const { error: e2 } = await sb.auth.updateUser({ password: $('emNewPass').value });
      if (e2) { emMsg('Non riesco a cambiare la password ora. Riprova.'); return; }
      toast('Password cambiata');
    }
    emMsg('');
    $('emCodeForm').hidden = true; $('emForm').hidden = false;
  };

  // Dopo la registrazione con email: nome e telefono
  function needsWelcome() {
    const viaEmail = user && user.app_metadata && user.app_metadata.provider === 'email';
    return viaEmail && (!prefs.name || !prefs.phone);
  }
  function showWelcome() {
    if (!needsWelcome()) return;
    $('wName').value = prefs.name || '';
    $('wPhone').value = prefs.phone || '';
    if (!$('dlgWelcome').open) $('dlgWelcome').showModal();
  }
  $('dlgWelcome').addEventListener('cancel', e => e.preventDefault());
  $('wForm').onsubmit = async e => {
    e.preventDefault();
    const name = $('wName').value.trim().slice(0, 40);
    const phone = $('wPhone').value.trim().slice(0, 20);
    if (!name) { $('wName').focus(); return; }
    if (phone.replace(/\D/g, '').length < 8) { toast('Numero non valido: es. 333 1234567'); $('wPhone').focus(); return; }
    prefs.name = name; prefs.phone = phone; savePrefs();
    $('myName').value = name; $('myPhone').value = phone;
    $('dlgWelcome').close();
    sb.from('profiles').upsert({ id: user.id, name }).then(() => {}, () => {});
    toast(`Benvenuto ${name.split(' ')[0]}!`);
  };
  $('accLogout').onclick = async () => {
    if (!confirm('Uscire dall\'account? Per usare SpotIt dovrai rientrare.')) return;
    await sb.auth.signOut();
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
  };

  // Al ritorno nell'app riallinea (es. posti aggiunti da un altro telefono)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(); });
})();
