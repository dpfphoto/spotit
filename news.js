// Finestra "Novità": compare una volta sola, dopo l'accesso, quando non c'è nessun'altra finestra aperta.
// Per una novità nuova basta cambiare NEWS.id (e i testi in #dlgNews).

(function () {
  const AUTH = window.SPOTIT_AUTH;
  const NEWS = { id: 'tag-nfc-2026-11' };
  const KEY = 'spotit.news';
  let seen = '';
  try { seen = localStorage.getItem(KEY) || ''; } catch {}
  if (!AUTH || seen === NEWS.id) return;

  const dlg = $('dlgNews');
  const mark = () => { try { localStorage.setItem(KEY, NEWS.id); } catch {} };
  dlg.addEventListener('close', mark);
  $('newsMore').addEventListener('click', mark);
  $('newsTry').onclick = () => { mark(); dlg.close(); if (window.spotitOpenTags) window.spotitOpenTags().catch(() => {}); };

  let tries = 0, started = false;
  function tryShow() {
    if (dlg.open) return;
    try { if (localStorage.getItem(KEY) === NEWS.id) return; } catch {}
    // Aspetto che l'utente abbia finito: nessun'altra finestra aperta (accesso, profilo, invito…)
    if (document.querySelector('dialog[open]') || document.hidden) { if (++tries < 40) setTimeout(tryShow, 3000); return; }
    dlg.showModal();
  }
  AUTH.onUser(u => { if (u && !started) { started = true; setTimeout(tryShow, 2500); } });
})();
