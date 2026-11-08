// Registro presenze: ogni uscita o evento resta qui con tutti i dati, anche dopo che è passato
// o è stato annullato (lo tiene il server, registro.sql). Chi organizza corregge le presenze
// e scarica tutto in Excel o PDF.

(function () {
  const AUTH = window.SPOTIT_AUTH;
  const item = document.querySelector('#dlgMenu [data-go="registro"]');
  if (!AUTH) { if (item) item.parentElement.hidden = true; return; }
  const sb = AUTH.sb;

  const ANSWER = { si: 'Ci sono', forse: 'Forse', no: 'Non può', invitato: 'Invitato', extra: 'Aggiunto nel registro' };
  let entries = [];   // dal server: { outing_id, starts_at, stato, mine, presenze, extra, data }
  let current = null; // voce aperta nel dettaglio

  const pad = n => String(n).padStart(2, '0');
  function dateIt(t) { const [d] = String(t).split('T'); const [y, m, g] = d.split('-'); return `${g}/${m}/${y}`; }
  function timeIt(t) { return String(t).slice(11, 16); }
  function clock(ts) { if (!ts) return ''; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function stamp(ts) { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${clock(ts)}`; }
  function titleOf(e) { return (e.data.place && e.data.place.n) || 'Uscita'; }
  function addrOf(e) { return (e.data.place && e.data.place.a) || ''; }

  // Presente: la correzione dell'organizzatore, se c'è, altrimenti "Arrivato" segnato dal telefono
  function isPresent(e, m) {
    const p = e.presenze || {};
    if (Object.prototype.hasOwnProperty.call(p, m.id)) return !!p[m.id];
    return m.arrival === 'arrivato';
  }
  // Persone del registro: i partecipanti e i presenti aggiunti a mano
  function people(e) {
    const list = (e.data.members || []).map(m => ({ ...m, present: isPresent(e, m), fixed: Object.prototype.hasOwnProperty.call(e.presenze || {}, m.id) }));
    for (const [i, name] of (Array.isArray(e.extra) ? e.extra : []).entries()) {
      list.push({ id: `extra-${i}`, extraIndex: i, name, status: 'extra', present: true, fixed: true });
    }
    return list;
  }
  function presentCount(e) { return people(e).filter(p => p.present).length; }

  // ---------- Elenco ----------

  async function openRegistro() {
    if (!AUTH.user()) { toast('Entra con il tuo account per vedere il registro'); return; }
    $('regList').replaceChildren(el('li', { class: 'muted reg-empty' }, 'Carico il registro…'));
    $('regInfo').textContent = '';
    if (!$('dlgReg').open) $('dlgReg').showModal();
    await reload();
  }
  async function reload() {
    try {
      const { data, error } = await sb.rpc('registro_mio');
      if (error) throw error;
      entries = Array.isArray(data) ? data : [];
      drawList();
    } catch {
      entries = [];
      $('regList').replaceChildren(el('li', { class: 'muted reg-empty' }, 'Il registro non è ancora attivo o manca la connessione. Riprova tra poco.'));
    }
  }
  function filtered() {
    const from = $('regFrom').value, to = $('regTo').value;
    const q = $('regSearch').value.trim().toLowerCase();
    return entries.filter(e => {
      const day = e.starts_at.slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (!q) return true;
      const hay = [titleOf(e), addrOf(e), e.data.owner_name || '', e.data.note || '', ...people(e).map(p => p.name)].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  function drawList() {
    const list = filtered();
    $('regInfo').textContent = entries.length
      ? `${list.length} ${list.length === 1 ? 'voce' : 'voci'}${list.length !== entries.length ? ` su ${entries.length}` : ''}`
      : '';
    $('regXlsx').disabled = $('regPdf').disabled = !list.length;
    if (!list.length) {
      $('regList').replaceChildren(el('li', { class: 'muted reg-empty' }, entries.length
        ? 'Nessuna voce per questa ricerca.'
        : 'Il registro è vuoto. Le uscite e gli eventi che organizzi o a cui partecipi compaiono qui.'));
      return;
    }
    $('regList').replaceChildren(...list.map(e => {
      const ps = people(e);
      let side;
      if (e.mine) side = `${presentCount(e)} presenti su ${ps.length}`;
      else side = ps.length ? (ps[0].present ? 'Tu: presente' : 'Tu: assente') : '';
      return el('li', {}, el('button', { type: 'button', class: 'reg-item', onclick: () => openItem(e.outing_id) },
        el('span', { class: 'reg-date' }, el('strong', {}, dateIt(e.starts_at)), el('span', {}, timeIt(e.starts_at))),
        el('span', { class: 'reg-txt' },
          el('span', { class: 'reg-name' }, (e.data.is_event ? '📍 ' : '🍽️ ') + titleOf(e)),
          el('span', { class: 'muted' }, [addrOf(e), e.mine ? 'organizzato da te' : (e.data.owner_name ? `da ${e.data.owner_name}` : '')].filter(Boolean).join(' · ')),
          e.stato === 'annullato' ? el('span', { class: 'reg-badge' }, 'Annullato') : ''),
        el('span', { class: 'reg-side' }, side)));
    }));
  }
  $('regFrom').addEventListener('change', drawList);
  $('regTo').addEventListener('change', drawList);
  $('regSearch').addEventListener('input', drawList);

  // ---------- Dettaglio ----------

  function openItem(id) {
    current = entries.find(e => e.outing_id === id);
    if (!current) return;
    drawItem();
    if (!$('dlgRegItem').open) $('dlgRegItem').showModal();
  }
  function drawItem() {
    const e = current; if (!e) return;
    const d = e.data;
    $('riTitle').textContent = e.stato === 'annullato' ? 'Annullato' : (d.is_event ? 'Evento' : 'Uscita');
    $('riName').textContent = titleOf(e);
    $('riAddress').textContent = addrOf(e);
    $('riWhen').textContent = `${whenLabel(e.starts_at)} · ${dateIt(e.starts_at)}`;
    $('riBy').textContent = e.mine ? `Organizzato da te${d.owner_name ? ` (${d.owner_name})` : ''}` : (d.owner_name ? `Organizzato da ${d.owner_name}` : '');
    $('riNote').hidden = !d.note;
    $('riNote').textContent = d.note ? `"${d.note}"` : '';
    const ps = people(e);
    $('riCount').textContent = `${ps.filter(p => p.present).length} presenti su ${ps.length}`;
    $('riHint').hidden = !e.mine;
    $('riAddForm').hidden = !e.mine;
    $('riDelete').hidden = !e.mine;
    $('riOpen').hidden = e.stato === 'annullato' || !window.spotitOpenGroup;
    $('riMembers').replaceChildren(...ps.map(p => {
      const info = [ANSWER[p.status] || p.status];
      if (p.arrival === 'arrivato' && p.arrival_at) info.push(`arrivato alle ${clock(p.arrival_at)}`);
      else if (p.arrival === 'in_arrivo') info.push('era in arrivo');
      if (p.fixed && p.status !== 'extra') info.push('corretto a mano');
      const toggle = e.mine
        ? el('span', { class: 'pres-toggle', role: 'group', 'aria-label': `Presenza di ${p.name}` },
            el('button', { type: 'button', class: 'pres yes', 'aria-pressed': String(p.present), onclick: () => setPresence(p, true) }, 'Presente'),
            el('button', { type: 'button', class: 'pres no', 'aria-pressed': String(!p.present), onclick: () => setPresence(p, false) }, 'Assente'))
        : el('span', { class: `m-status ${p.present ? 'here' : 'no'}` }, p.present ? 'Presente' : 'Assente');
      return el('li', {},
        el('span', { class: 'm-name' }, p.name, el('small', { class: 'm-phone' }, info.join(' · '))),
        toggle);
    }));
    const notes = d.notes || [];
    $('riNotesBox').hidden = !notes.length;
    $('riNotes').replaceChildren(...notes.map(n => el('li', {},
      el('div', { class: 'gn-head' }, el('strong', {}, n.name || 'Partecipante'), el('span', { class: 'muted' }, stamp(n.at))),
      el('p', {}, n.body))));
  }
  async function saveEntry(patch) {
    const e = current; if (!e) return false;
    const { error } = await sb.from('registro').update(patch).eq('outing_id', e.outing_id);
    if (error) { toast('Non riesco a salvare ora. Riprova.'); return false; }
    Object.assign(e, patch);
    drawItem(); drawList();
    return true;
  }
  async function setPresence(p, val) {
    const e = current; if (!e || !e.mine) return;
    if (p.status === 'extra') {
      if (val) return;
      if (!confirm(`Togliere ${p.name} dal registro?`)) return;
      const extra = (e.extra || []).filter((_, i) => i !== p.extraIndex);
      await saveEntry({ extra });
      return;
    }
    const presenze = { ...(e.presenze || {}) };
    // Se torna uguale a quello segnato dal telefono, tolgo la correzione
    if (val === (p.arrival === 'arrivato')) delete presenze[p.id]; else presenze[p.id] = val;
    await saveEntry({ presenze });
  }
  $('riAddForm').onsubmit = async ev => {
    ev.preventDefault();
    const e = current; if (!e) return;
    const name = $('riAddName').value.trim().slice(0, 60);
    if (!name) return;
    if (await saveEntry({ extra: [...(e.extra || []), name] })) { $('riAddName').value = ''; toast(`${name} segnato presente`); }
  };
  $('riDelete').onclick = async () => {
    const e = current; if (!e) return;
    if (!confirm('Togliere questa voce dal registro? Non si potrà recuperare.')) return;
    const { error } = await sb.from('registro').delete().eq('outing_id', e.outing_id);
    if (error) { toast('Non riesco a toglierla ora'); return; }
    entries = entries.filter(x => x !== e);
    current = null;
    $('dlgRegItem').close();
    drawList();
  };
  $('riOpen').onclick = () => {
    const e = current; if (!e) return;
    $('dlgRegItem').close(); $('dlgReg').close();
    window.spotitOpenGroup(e.outing_id);
  };
  $('dlgRegItem').addEventListener('close', () => { current = null; });

  // ---------- Righe per Excel e PDF ----------

  function rowsOf(list) {
    const rows = [], notes = [];
    for (const e of list) {
      const base = [dateIt(e.starts_at), timeIt(e.starts_at), titleOf(e), addrOf(e), e.data.owner_name || '', e.stato === 'annullato' ? 'Annullato' : (e.data.is_event ? 'Evento' : 'Uscita')];
      for (const p of people(e)) {
        rows.push([...base, p.name, ANSWER[p.status] || p.status, p.arrival === 'arrivato' ? clock(p.arrival_at) : '', p.present ? 'Presente' : 'Assente']);
      }
      for (const n of e.data.notes || []) notes.push([dateIt(e.starts_at), titleOf(e), n.name || '', stamp(n.at), n.body]);
    }
    return { rows, notes };
  }
  const HEAD = ['Data', 'Ora', 'Titolo', 'Luogo', 'Organizzatore', 'Tipo', 'Partecipante', 'Risposta', 'Arrivato alle', 'Presenza'];
  const NOTE_HEAD = ['Data', 'Titolo', 'Autore', 'Scritta il', 'Nota'];

  function fileName(list, ext) {
    const today = new Date();
    const t = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    if (list.length === 1) {
      const slug = titleOf(list[0]).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
      return `registro-${list[0].starts_at.slice(0, 10)}-${slug || 'evento'}.${ext}`;
    }
    return `registro-presenze-${t}.${ext}`;
  }

  // ---------- Excel (.xlsx scritto qui, senza librerie) ----------

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const [name, text] of files) {
      const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), nb, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), nb);
      offset += 30 + nb.length + data.length;
    }
    const size = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const xml = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function col(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function sheet(head, rows, widths) {
    const all = [head, ...rows];
    const body = all.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) =>
      `<c r="${col(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join('')}</row>`).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
      `<sheetData>${body}</sheetData>` +
      (rows.length ? `<autoFilter ref="A1:${col(head.length - 1)}${rows.length + 1}"/>` : '') +
      '</worksheet>';
  }
  function xlsx(list) {
    const { rows, notes } = rowsOf(list);
    const sheets = [['Presenze', sheet(HEAD, rows, [11, 7, 28, 30, 20, 10, 24, 18, 12, 11])]];
    if (notes.length) sheets.push(['Note', sheet(NOTE_HEAD, notes, [11, 28, 20, 12, 60])]);
    const ns = 'http://schemas.openxmlformats.org/';
    return zip([
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Types xmlns="${ns}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="${ns}package/2006/relationships"><Relationship Id="rId1" Type="${ns}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<workbook xmlns="${ns}spreadsheetml/2006/main" xmlns:r="${ns}officeDocument/2006/relationships"><sheets>` +
        sheets.map(([n], i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets>' + (rows.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Presenze!$A$1:$${col(HEAD.length - 1)}$${rows.length + 1}</definedName></definedNames>` : '') + '</workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="${ns}package/2006/relationships">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${ns}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<styleSheet xmlns="${ns}spreadsheetml/2006/main">` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>'],
      ...sheets.map(([, s], i) => [`xl/worksheets/sheet${i + 1}.xml`, s])
    ]);
  }

  // Sul telefono si apre la condivisione (WhatsApp, mail, File); sul computer si scarica
  async function deliver(blob, name) {
    const file = typeof File === 'function' ? new File([blob], name, { type: blob.type }) : null;
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  function exportXlsx(list) {
    if (!list.length) return;
    deliver(xlsx(list), fileName(list, 'xlsx')).catch(() => toast('Non riesco a creare il file ora'));
  }

  // ---------- PDF (stampa del telefono o del computer: "Salva come PDF") ----------

  function printList(list) {
    if (!list.length) return;
    const area = $('printArea');
    const today = new Date();
    const blocks = list.map(e => {
      const ps = people(e);
      const d = e.data;
      return el('section', { class: 'pr-entry' },
        el('h2', {}, `${titleOf(e)}${e.stato === 'annullato' ? ' (annullato)' : ''}`),
        el('p', {}, el('strong', {}, `${dateIt(e.starts_at)} alle ${timeIt(e.starts_at)}`), addrOf(e) ? ` · ${addrOf(e)}` : ''),
        d.owner_name ? el('p', {}, `Organizzato da: ${d.owner_name}`) : '',
        d.note ? el('p', {}, `Nota: ${d.note}`) : '',
        el('p', {}, `Presenti: ${ps.filter(p => p.present).length} su ${ps.length}`),
        el('table', {},
          el('thead', {}, el('tr', {}, ...['#', 'Partecipante', 'Risposta', 'Arrivato alle', 'Presenza', 'Firma'].map(h => el('th', {}, h)))),
          el('tbody', {}, ...ps.map((p, i) => el('tr', {},
            el('td', {}, String(i + 1)), el('td', {}, p.name), el('td', {}, ANSWER[p.status] || p.status),
            el('td', {}, p.arrival === 'arrivato' ? clock(p.arrival_at) : ''), el('td', {}, p.present ? 'Presente' : 'Assente'), el('td', { class: 'pr-sign' }, ''))))),
        (d.notes || []).length ? el('div', { class: 'pr-notes' }, el('h3', {}, 'Note dei partecipanti'),
          el('ul', {}, ...d.notes.map(n => el('li', {}, el('strong', {}, `${n.name} (${stamp(n.at)}): `), n.body)))) : '',
        el('p', { class: 'pr-firma' }, 'Firma del responsabile ______________________________'));
    });
    area.replaceChildren(
      el('header', { class: 'pr-head' }, el('h1', {}, 'Registro presenze'),
        el('p', {}, `WeSpot · stampato il ${pad(today.getDate())}/${pad(today.getMonth() + 1)}/${today.getFullYear()} · ${list.length} ${list.length === 1 ? 'voce' : 'voci'}`)),
      ...blocks);
    const done = () => { document.body.classList.remove('printing'); area.replaceChildren(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    document.body.classList.add('printing');
    const prevTitle = document.title;
    document.title = fileName(list, 'pdf').replace(/\.pdf$/, '');
    setTimeout(() => { window.print(); document.title = prevTitle; }, 50);
  }

  $('regXlsx').onclick = () => exportXlsx(filtered());
  $('regPdf').onclick = () => printList(filtered());
  $('riXlsx').onclick = () => { if (current) exportXlsx([current]); };
  $('riPdf').onclick = () => { if (current) printList([current]); };

  window.spotitOpenRegistro = openRegistro;
  // Per le prove: il file Excel come Blob
  window.spotitRegistroXlsx = list => xlsx(list || entries);
})();
