// Il tuo locale: il titolare iscrive il suo locale e vede quante persone l'hanno salvato (mai chi).
// Quando qualcuno lo salva come Tornarci o Andarci riceve una notifica e un'email (supabase/business.sql).

(function () {
  const AUTH = window.SPOTIT_AUTH;
  if (!AUTH) { $('dlgMenu').querySelector('[data-go="business"]').parentElement.hidden = true; return; }
  const sb = AUTH.sb;
  let picked = null;
  let mine = [];

  async function loadMine() {
    const { data, error } = await sb.rpc('my_business_stats');
    if (error) throw error;
    mine = data || [];
  }

  function num(n, label, v) {
    return el('div', { style: `background:${V[v].bg};color:${V[v].color}` }, el('b', {}, String(n)), label);
  }

  async function drawMine() {
    const box = $('bizMine');
    box.replaceChildren();
    const pushOn = window.spotitPushOn ? await window.spotitPushOn() : false;
    for (const b of mine) {
      const saved = b.tornarci + b.andarci;
      const card = el('section', { class: 'biz-card' },
        el('h3', {}, b.name),
        el('p', { class: 'muted' }, b.address),
        el('p', { class: 'pu-count' }, saved === 1 ? '1 persona ha salvato il tuo locale' : `${saved} persone hanno salvato il tuo locale`),
        el('div', { class: 'biz-nums' },
          num(b.tornarci, 'Ci tornerebbero', 'tornarci'),
          num(b.andarci, 'Vogliono andarci', 'andarci'),
          num(b.sconsigliato, 'Sconsigliato', 'sconsigliato')),
        el('p', { class: 'muted' }, b.last30 ? `Negli ultimi 30 giorni: ${b.last30} ${b.last30 === 1 ? 'nuovo salvataggio' : 'nuovi salvataggi'}` : 'Negli ultimi 30 giorni nessun nuovo salvataggio, per ora.'));
      const mail = el('input', { type: 'checkbox' });
      mail.checked = b.notify_email;
      mail.onchange = async () => {
        const { error } = await sb.from('businesses').update({ notify_email: mail.checked }).eq('id', b.id);
        if (error) { mail.checked = !mail.checked; toast('Non riesco a salvare ora, riprova'); return; }
        b.notify_email = mail.checked;
        toast(mail.checked ? 'Email attive' : 'Email spente');
      };
      card.append(el('label', { class: 'check' }, mail, el('span', {}, 'Avvisami via email', el('small', {}, `Al massimo una al giorno, a ${b.email || 'la tua email'}`))));
      if (!pushOn) {
        const bell = el('button', { type: 'button', class: 'btn ghost full' }, '🔔 Avvisami anche con le notifiche sul telefono');
        bell.onclick = async () => { if (window.spotitEnablePush) await window.spotitEnablePush(); drawMine(); };
        card.append(bell);
      }
      const del = el('button', { type: 'button', class: 'btn danger-link' }, 'Togli il locale');
      del.onclick = async () => {
        if (!confirm(`Togliere "${b.name}"? Non riceverai più avvisi.`)) return;
        const { error } = await sb.from('businesses').delete().eq('id', b.id);
        if (error) { toast('Non riesco a toglierlo ora, riprova'); return; }
        await refresh();
      };
      card.append(del);
      box.append(card);
    }
    $('bizIntro').textContent = mine.length
      ? 'Hai un altro locale? Cercalo qui sotto per iscriverlo (al massimo 3).'
      : 'Hai un bar, un ristorante o un negozio? Iscrivilo: ogni volta che qualcuno lo salva tra i posti dove vuole andare o tornare, ti avvisiamo. Chi salva resta sempre anonimo: vedi quanti, mai chi.';
    $('bizJoin').hidden = mine.length >= 3;
  }

  async function refresh() {
    try { await loadMine(); } catch { toast('Non riesco a caricare i tuoi locali ora'); }
    await drawMine();
  }

  function resetJoin() {
    picked = null;
    $('bizResults').replaceChildren();
    $('bizPick').hidden = true;
    $('bizConsent').checked = false;
    $('bizClaim').disabled = true;
  }

  $('bizSearch').onsubmit = async e => {
    e.preventDefault();
    const q = $('bizQ').value.trim();
    if (!q) return;
    resetJoin();
    const ul = $('bizResults');
    ul.append(el('li', { class: 'muted' }, 'Cerco…'));
    let found = [];
    try { found = (await googleSearch(q)).filter(r => r.gid); } catch { /* sotto */ }
    ul.replaceChildren();
    if (!found.length) { ul.append(el('li', { class: 'muted' }, 'Nessun locale trovato: prova con il nome e la città')); return; }
    for (const r of found) {
      const b = el('button', { type: 'button' }, el('span', { class: 'name' }, r.name), el('span', { class: 'addr' }, r.address));
      b.onclick = () => {
        picked = r;
        ul.replaceChildren();
        $('bizPickName').textContent = r.name;
        $('bizPickAddr').textContent = r.address;
        const u = AUTH.user();
        $('bizEmailHint').textContent = `Le email arrivano a ${(u && u.email) || 'l\'email del tuo account'}, al massimo una al giorno. Puoi spegnerle quando vuoi.`;
        $('bizPick').hidden = false;
      };
      ul.append(el('li', {}, b));
    }
  };
  $('bizConsent').onchange = () => { $('bizClaim').disabled = !$('bizConsent').checked; };
  $('bizClaim').onclick = async () => {
    if (!picked || !$('bizConsent').checked) return;
    $('bizClaim').disabled = true;
    const { error } = await sb.rpc('claim_business', { p_gid: picked.gid, p_name: picked.name, p_address: picked.address });
    if (error) {
      $('bizClaim').disabled = false;
      toast(/massimo/.test(error.message) ? 'Puoi iscrivere al massimo 3 locali' : 'Non riesco a iscriverlo ora, riprova');
      return;
    }
    toast(`Fatto: ${picked.name} è iscritto. Ti avvisiamo quando qualcuno lo salva`);
    $('bizQ').value = '';
    resetJoin();
    await refresh();
  };

  async function open() {
    resetJoin();
    $('bizMine').replaceChildren(el('p', { class: 'muted' }, 'Carico…'));
    if (!$('dlgBiz').open) $('dlgBiz').showModal();
    await refresh();
  }
  window.spotitOpenBusiness = open;

  // Link dall'email o dalla notifica: wespot.me/#locale
  function fromLink() {
    if (location.hash !== '#locale') return;
    history.replaceState(null, '', location.pathname + location.search);
    let done = false;
    AUTH.onUser(() => { if (!done) { done = true; open(); } });
  }
  fromLink();
  window.addEventListener('hashchange', fromLink);
})();
