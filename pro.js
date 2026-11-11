// WeSpot Pro: chi ce l'ha e il foglio che spiega cosa serve. Per ora i rinnovi li segna l'admin dal pannello.
// Con Pro: più di 3 posti, uscite ed eventi, creare e modificare i tag. I tag funzionano sempre, anche senza.
// I controlli veri sono nell'archivio (supabase/pro.sql): qui si evita solo di riempire un modulo per niente.

(function () {
  const AUTH = window.SPOTIT_AUTH;
  const CONTACT = 'flaviodiproperzio@gmail.com';
  const WHY = {
    places: 'Senza Pro puoi salvare fino a 3 posti. Con Pro non hai limiti.',
    outing: 'Per organizzare uscite di gruppo serve WeSpot Pro. Rispondere agli inviti degli altri resta gratis.',
    event: 'Per creare eventi serve WeSpot Pro. Rispondere agli inviti degli altri resta gratis.',
    tag: 'Per creare, modificare e scrivere i tag serve WeSpot Pro. I tuoi tag continuano comunque a funzionare e le segnalazioni ti arrivano sempre.'
  };
  let st = null; // { pro, until, trial, admin }

  const day = t => new Date(t).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

  function draw() {
    const label = $('menuProState');
    const box = $('proStatus');
    if (!st) { label.textContent = ''; return; }
    let text, cls;
    if (st.admin) { text = '✅ Pro sempre attivo (admin)'; cls = 'ok'; }
    else if (st.pro && st.trial) { text = `🎁 Prova gratuita fino al ${day(st.until)}`; cls = 'wait'; }
    else if (st.pro) { text = `✅ Pro attivo fino al ${day(st.until)}`; cls = 'ok'; }
    else { text = st.until ? `Pro scaduto il ${day(st.until)}` : 'Pro non attivo'; cls = 'off'; }
    box.textContent = text; box.className = 'pro-status ' + cls;
    label.textContent = st.admin ? '' : st.pro ? (st.trial ? 'prova' : 'attivo') : 'non attivo';
    label.className = 'menu-pro ' + cls;
    $('proContact').textContent = st.pro && !st.admin ? '✉️ Rinnova WeSpot Pro' : '✉️ Attiva WeSpot Pro';
  }

  function open(why) {
    $('proWhy').textContent = WHY[why] || '';
    $('proWhy').hidden = !WHY[why];
    draw();
    if (!$('dlgPro').open) $('dlgPro').showModal();
    refresh().catch(() => {});
  }

  async function refresh() {
    if (!AUTH || !AUTH.user()) return;
    const { data, error } = await AUTH.sb.rpc('my_pro');
    if (!error && data) { st = data; draw(); }
  }

  $('proContact').onclick = () => {
    const u = AUTH && AUTH.user();
    const body = `Ciao, vorrei ${st && st.pro ? 'rinnovare' : 'attivare'} WeSpot Pro.\nIl mio account: ${(u && u.email) || ''}`;
    location.href = `mailto:${CONTACT}?subject=${encodeURIComponent('WeSpot Pro')}&body=${encodeURIComponent(body)}`;
  };
  // Codice omaggio (es. gruppo di Protezione Civile): aggiunge mesi di Pro
  function promoMsg(text, kind) { const m = $('promoMsg'); m.textContent = text; m.hidden = !text; m.className = 'nfc-msg' + (kind ? ' ' + kind : ''); }
  $('promoForm').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('promoCode').value.trim();
    if (!code || !AUTH || !AUTH.user()) return;
    $('promoGo').disabled = true; promoMsg('⏳ Controllo il codice…', 'wait');
    try {
      const { data, error } = await AUTH.sb.rpc('redeem_promo', { p_code: code });
      if (error) {
        promoMsg(/già usato/.test(error.message) ? '❌ Hai già usato questo codice.'
          : /sconto/.test(error.message) ? '❌ Questo è un codice sconto: vale quando richiedi un tag, nella scheda di richiesta.'
          : '❌ Codice non valido o scaduto.', 'err');
        return;
      }
      promoMsg(`✅ Codice valido! WeSpot Pro attivo fino al ${day(data.until)}.`, 'ok');
      $('promoCode').value = '';
      if (navigator.vibrate) navigator.vibrate(200);
      refresh().catch(() => {});
    } catch { promoMsg('❌ Non riesco a collegarmi ora. Riprova tra poco.', 'err'); }
    finally { $('promoGo').disabled = false; }
  });
  $('dlgPro').addEventListener('close', () => promoMsg(''));

  $('proClaim').onclick = () => { $('dlgPro').close(); if (window.spotitOpenClaim) window.spotitOpenClaim(); };

  if (AUTH) AUTH.onUser(() => { refresh().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });

  window.spotitPro = {
    // Finché non so lo stato (offline, primo avvio) non blocco nulla: decide l'archivio
    is: () => !st || !!st.pro,
    need(why) { if (!st || st.pro) return true; open(why); return false; },
    open, refresh
  };
})();
