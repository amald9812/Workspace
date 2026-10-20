/* =============================================================================
   ETHIX v2 — APP (sign-in, shell, live Home)
   Talks to the same Apps Script backend as the current app. Nothing is stored
   on the device except your team's names for the sign-in screen and a few view choices.
   ============================================================================= */
(() => {
  'use strict';

  // ------------------------------------------------------------------ basics
  const CFG = window.ETHIX_CONFIG || {};
  const API_URL = String(CFG.apiUrl || '').trim();
  const DAY = 864e5;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };
  const nice = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const isTouch = () => window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760;

  // --------------------------------------------------------------------- API
  class ApiError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }
  const api = {
    token: null,
    connected: /^https:\/\/script\.google\.com\/.+\/exec$/.test(API_URL),
    async call(fn, args = [], opts = {}) {
      if (!this.connected) throw new ApiError('App not connected yet — paste your Apps Script /exec link into config.js.', 'config');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeout || 45000);
      let res;
      try {
        const r = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ fn, args, token: this.token }), redirect: 'follow', cache: 'no-store', signal: ctrl.signal });
        const txt = await r.text();
        try { res = JSON.parse(txt); } catch (e) { throw new ApiError('The server sent an unexpected reply. Check the Apps Script deployment.', 'server'); }
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(e && e.name === 'AbortError' ? 'The server took too long to answer. Please try again.' : 'Connection problem — check your internet and try again.', 'network');
      } finally { clearTimeout(timer); }
      if (res && res.ok) return res.data;
      if (res && res.auth) { if (this.token) sessionLost(res.error); throw new ApiError(res.error || 'Please sign in.', 'auth'); }
      throw new ApiError((res && res.error) || 'Unknown server error.', 'server');
    },
    logout() {
      if (!this.token || !this.connected) { this.token = null; return; }
      const body = JSON.stringify({ fn: 'ethixLogout', args: [], token: this.token });
      this.token = null;
      try { if (!(navigator.sendBeacon && navigator.sendBeacon(API_URL, body))) throw new Error('no beacon'); }
      catch (e) { fetch(API_URL, { method: 'POST', body, keepalive: true }).catch(() => {}); }
    }
  };

  // ------------------------------------------------------------------- state
  const state = {
    user: null, role: null, jobs: [], users: [], recent: [], syncedAt: 0,
    scope: 'all', lastActive: Date.now(), pick: null, busy: false
  };

  // ---------------------------------------------------------- dates & parsing
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const MON_UP = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const DOW_UP = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  function today0() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function mk(y, m, d) {
    if (!(y > 1990 && y < 2200) || !(m >= 0 && m <= 11) || !(d >= 1 && d <= 31)) return null;
    const x = new Date(y, m, d); return x.getMonth() === m ? x : null;
  }
  const yr = (s) => { const n = +s; return s.length === 2 ? 2000 + n : n; };
  function parseDate(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || /^(not applicable|n\/?a|-|—|tbc|tba)$/i.test(s)) return null;
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return mk(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(/^(\d{1,2})[-\/. ]([A-Za-z]{3,})[-\/. ,]*(\d{2,4})\b/))) return mk(yr(m[3]), MON[m[2].slice(0, 3).toLowerCase()], +m[1]);
    if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\b/))) return mk(yr(m[3]), +m[2] - 1, +m[1]);
    if ((m = s.match(/^([A-Za-z]{3,})[ -](\d{1,2}),? (\d{4})/))) return mk(+m[3], MON[m[1].slice(0, 3).toLowerCase()], +m[2]);
    return null;
  }
  const days = (a, b) => Math.round((b - a) / DAY);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fmt = (d, year) => (d ? String(d.getDate()).padStart(2, '0') + ' ' + MON_UP[d.getMonth()] + (year ? ' ' + d.getFullYear() : '') : '—');
  const fmtLong = (d) => DOW_UP[d.getDay()] + ' · ' + fmt(d, true);
  const num = (v) => { const n = parseInt(String(v || '').replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; };

  // ------------------------------------------------------------ job columns
  const RULES = [
    ['status', (h) => h === 'STATUS', 0], ['jobNo', (h) => h.startsWith('JOB NO'), 2], ['type', (h) => h === 'TYPE', 3],
    ['c20', (h) => h.startsWith('20'), 4], ['c40', (h) => h.startsWith('40'), 5], ['dg', (h) => h.startsWith('DG/') || h === 'DG', 6],
    ['customer', (h) => h === 'CUSTOMER', 7], ['vendor', (h) => h.includes('VENDOR'), 8], ['pod', (h) => h === 'POD', 9],
    ['cs', (h) => h === 'CS', 10], ['opened', (h) => h.startsWith('JOB OPEN'), 11], ['etd', (h) => h.startsWith('ETD'), 12],
    ['siCut', (h) => h.startsWith('SI CUTOFF'), 13], ['remarks', (h) => h.startsWith('REMARK'), 14], ['loadlist', (h) => h.startsWith('LOADLIST'), 15],
    ['sido', (h) => h.startsWith('SI /') || h.startsWith('SI/'), 16], ['ed', (h) => h === 'ED STATUS', 17], ['bl', (h) => h.startsWith('BL'), 18],
    ['delivery', (h) => h.startsWith('DELIVERY'), 19], ['docs', (h) => h.startsWith('ORIGINAL DOC'), 20], ['costing', (h) => h.includes('COSTING'), 21],
    ['sales', (h) => h.startsWith('SALES'), 22], ['eta', (h) => h.startsWith('ETA'), 23], ['pol', (h) => h === 'POL', 24],
    ['edCut', (h) => h.startsWith('ED CUTOFF'), 25], ['dgCut', (h) => h.startsWith('DG CUTOFF'), 26], ['lineFree', (h) => h.startsWith('LINE FREE'), 27],
    ['portFree', (h) => h.startsWith('PORT FREE'), 28], ['against', (h) => h.startsWith('AGAINST'), 29], ['freight', (h) => h.startsWith('LINE FREIGHT'), 30]
  ];
  const EXPORT = ['SFEF', 'SFEL', 'AFE'], IMPORT = ['SFIF', 'SFIL', 'AFI', 'CND'], CROSS = ['SFC', 'AFC', 'CRR'], AIR = ['AFE', 'AFI', 'AFC'];
  const TYPE_NAMES = { SFEF: 'Sea export · FCL', SFEL: 'Sea export · LCL', AFE: 'Air export', SFIF: 'Sea import · FCL', SFIL: 'Sea import · LCL', AFI: 'Air import', CND: 'Clearance & delivery', SFC: 'Sea cross-trade', AFC: 'Air cross-trade', CRR: 'Courier', MIS: 'Miscellaneous' };

  function mapHeaders(headers) {
    const H = headers.map((h) => String(h || '').toUpperCase().replace(/\s+/g, ' ').trim());
    const ix = {};
    RULES.forEach(([k, test, fallback]) => { const i = H.findIndex(test); ix[k] = i > -1 ? i : fallback; });
    return ix;
  }

  function freeEnd(eta, value) {
    if (!eta || value == null || value === '') return null;
    const s = String(value).trim();
    if (/^\d{1,3}$/.test(s)) return addDays(eta, +s);       // number of days from arrival
    const d = parseDate(s);                                   // a date is read as the end date
    return d && d >= eta ? d : null;
  }

  function buildJob(row, ix, t0) {
    const g = (k) => String(row[ix[k]] == null ? '' : row[ix[k]]).trim();
    const type = g('type').toUpperCase();
    const status = g('status').toUpperCase();
    const j = {
      jobNo: g('jobNo'), status, type,
      cat: EXPORT.includes(type) ? 'EXPORT' : IMPORT.includes(type) ? 'IMPORT' : CROSS.includes(type) ? 'CROSS' : type === 'MIS' ? 'MISC' : 'OTHER',
      mode: AIR.includes(type) ? 'air' : type === 'CRR' ? 'courier' : type === 'MIS' ? 'misc' : 'sea',
      customer: g('customer'), vendor: g('vendor'), pol: g('pol').toUpperCase(), pod: g('pod').toUpperCase(),
      cs: g('cs').toUpperCase(), sales: g('sales').toUpperCase(), dg: g('dg').toUpperCase(),
      c20: num(g('c20')), c40: num(g('c40')), remarks: g('remarks'), freight: g('freight'), against: g('against'),
      loadlist: g('loadlist').toUpperCase(), sido: g('sido').toUpperCase(), ed: g('ed').toUpperCase(), bl: g('bl').toUpperCase(),
      docs: g('docs').toUpperCase(), costing: g('costing').toUpperCase(),
      opened: parseDate(g('opened')), etd: parseDate(g('etd')), eta: parseDate(g('eta')),
      siCut: parseDate(g('siCut')), edCut: parseDate(g('edCut')), dgCut: parseDate(g('dgCut')), delivery: parseDate(g('delivery')),
      lineFreeRaw: g('lineFree'), portFreeRaw: g('portFree')
    };
    j.active = !!j.jobNo && !['COMPLETED', 'CANCELLED', 'CLOSED'].includes(status);
    j.hold = status === 'HOLD';
    j.route = (j.pol || '—') + ' → ' + (j.pod || '—');
    j.typeName = TYPE_NAMES[type] || type || '—';
    j.cargo = [j.c20 ? j.c20 + '×20′' : '', j.c40 ? j.c40 + '×40′' : ''].filter(Boolean).join(' + ') || (['SFEL', 'SFIL'].includes(type) ? 'LCL' : '');
    j.lineFreeEnd = freeEnd(j.eta, j.lineFreeRaw);
    j.portFreeEnd = freeEnd(j.eta, j.portFreeRaw);
    // where is it now?
    j.atSea = j.active && !j.hold && (j.mode === 'sea' || j.mode === 'air') && j.etd && j.eta && t0 >= j.etd && t0 < j.eta;
    j.arrived = !!(j.eta && t0 >= j.eta);
    if (j.atSea) {
      const total = Math.max(1, days(j.etd, j.eta)), done = days(j.etd, t0);
      j.dayN = done; j.dayT = total; j.pct = Math.min(0.97, Math.max(0.03, done / total));
    } else { j.pct = j.arrived ? 1 : 0; }
    return j;
  }

  // ---------------------------------------------------------- what matters
  const PENDING = (v) => v === 'PENDING';
  const isCostingPending = (j) => ['', 'PENDING', 'JOB UPDATED'].includes(j.costing);
  function whenText(d) {
    if (d < 0) return -d + (d === -1 ? ' day' : ' days') + ' overdue';
    if (d === 0) return 'Today';
    if (d === 1) return 'Tomorrow';
    return 'in ' + d + ' days';
  }

  function computeHome(jobs, t0) {
    const active = jobs.filter((j) => j.active);
    const watch = [];
    active.forEach((j) => {
      if (j.hold) return;
      if (j.cat === 'EXPORT' && !(j.etd && j.etd < t0)) {
        const add = (date, what, pendingFlag) => {
          if (!date || !pendingFlag) return;
          const d = days(t0, date);
          if (d <= 1 && d >= -7) watch.push({ j, what, d, level: d <= 0 ? 'urgent' : 'soon', when: whenText(d) });
        };
        add(j.siCut, 'SI CUTOFF', j.sido === '' || PENDING(j.sido));
        add(j.edCut, 'ED CUTOFF', j.ed === '' || PENDING(j.ed));
        if (j.dg === 'DG') add(j.dgCut, 'DG CUTOFF', true);
      }
      if ((j.cat === 'EXPORT' || j.cat === 'CROSS') && j.etd) {
        const d = days(t0, j.etd);
        if (d >= 0 && d <= 2) watch.push({ j, what: j.mode === 'air' ? 'FLIGHT DEPARTS' : 'VESSEL SAILS', d, level: 'calm', when: d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : DOW_UP[j.etd.getDay()] + ' ' + fmt(j.etd) });
      }
      if (j.cat === 'IMPORT' && j.arrived && !j.delivery && j.lineFreeEnd) {
        const d = days(t0, j.lineFreeEnd);
        if (d <= 2 && d >= -30) watch.push({ j, what: d < 0 ? 'FREE TIME OVER' : 'LINE FREE TIME ENDS', d, level: 'urgent', when: d < 0 ? 'over by ' + (-d) + (d === -1 ? ' day' : ' days') : d === 0 ? 'Today' : 'in ' + d + (d === 1 ? ' day' : ' days'), free: true });
      }
    });
    const rank = { urgent: 0, soon: 1, calm: 2 };
    watch.sort((a, b) => rank[a.level] - rank[b.level] || a.d - b.d);

    const atSea = active.filter((j) => j.atSea).sort((a, b) => a.eta - b.eta);
    const costing = active.filter(isCostingPending);
    const sied = active.filter((j) => j.cat === 'EXPORT' && (PENDING(j.sido) || PENDING(j.ed)));
    const cut24 = sied.filter((j) => [j.siCut, j.edCut].some((c) => c && days(t0, c) <= 1 && days(t0, c) >= 0)).length;
    const freeJobs = Array.from(new Set(watch.filter((w) => w.free).map((w) => w.j)));
    const week = addDays(t0, 6);
    const arriving = active.filter((j) => j.eta && j.eta >= t0 && j.eta <= week).sort((a, b) => a.eta - b.eta);
    const departing = active.filter((j) => j.etd && j.etd >= t0 && j.etd <= week).sort((a, b) => a.etd - b.etd);
    const hold = active.filter((j) => j.hold);
    return {
      active, watch, atSea, costing, sied, cut24, freeJobs, arriving, departing, hold,
      costingSailed: costing.filter((j) => j.etd && j.etd < t0).length,
      deadlines: watch.filter((w) => w.level !== 'calm').length
    };
  }

  // ----------------------------------------------------------------- icons
  const I = {
    home: '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>',
    jobs: '<path d="M3 6h18M3 12h18M3 18h12"/>',
    fleet: '<path d="M3 7h10M3 12h16M3 17h7"/><circle cx="17" cy="7" r="2"/><circle cx="14" cy="17" r="2"/>',
    enq: '<path d="M4 4h16v12H8l-4 4z"/>',
    costing: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h3"/>',
    analysis: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    admin: '<path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
    anchor: '<circle cx="12" cy="5" r="3"/><path d="M12 22V8M5 12H2a10 10 0 0 0 20 0h-3"/>',
    logout: '<path d="M15 4h4v16h-4M10 16l4-4-4-4M14 12H4"/>'
  };
  const icon = (name, size = 18) => '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true">' + I[name] + '</svg>';
  const SHIP = (w = 30) => '<svg class="art track-ship-svg" viewBox="0 0 64 30" width="' + w + '" height="' + (w / 2) + '" aria-hidden="true"><path d="M2 19 H62 L55 28 H9 Z" fill="#0B1B2B"/><rect x="7" y="8" width="9" height="11" fill="#0B1B2B"/><rect x="19" y="12" width="9" height="7" fill="#48BEBF"/><rect x="30" y="12" width="9" height="7" fill="#1C5179"/><rect x="41" y="12" width="9" height="7" fill="#A9DEDD"/></svg>';
  const PLANE = (s = 22) => '<svg class="art" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true"><path transform="rotate(90 12 12)" fill="#1C5179" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';

  const SHIELD = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z"/></svg>';

  // ============================================================== SIGN IN
  // Names appear only on a device where someone has signed in before. The list
  // comes from the server after a successful sign-in and is kept on the device
  // (names and team only — nothing else).
  const TEAM_KEY = 'ethix.v2.team', LAST_KEY = 'ethix.v2.last';
  const TEAM_LABEL = { cs: 'CS · OPS', sales: 'SALES' };
  const sign = { step: 'who', tab: 'cs', team: null, pickTeam: null };
  const uniqSort = (a) => Array.from(new Set(a)).sort();

  function loadTeam() {
    const t = store.get(TEAM_KEY, null);
    if (t && Array.isArray(t.cs) && Array.isArray(t.sales)) return t;
    const old = store.get('ethix.v2.recent', null);           // v2.0 kept people who signed in here
    if (Array.isArray(old)) {
      const cs = old.map((x) => x && String(x.n || '').toUpperCase()).filter((n) => n && n !== 'MASTER');
      if (cs.length) return { cs: uniqSort(cs), sales: [] };
    }
    return null;
  }
  function saveTeam(users) {
    if (!Array.isArray(users) || !users.length) return;
    const cs = [], sales = [];
    users.forEach((u) => {
      const n = String((u && u.name) || '').toUpperCase().trim();
      if (!n || n === 'MASTER' || n === 'GUEST') return;
      (String((u && u.role) || '').toUpperCase().trim() === 'SALES' ? sales : cs).push(n);
    });
    store.set(TEAM_KEY, { cs: uniqSort(cs), sales: uniqSort(sales), at: Date.now() });
    try { localStorage.removeItem('ethix.v2.recent'); } catch (e) { /* ignore */ }
  }
  const hasTeam = () => !!(sign.team && (sign.team.cs.length || sign.team.sales.length));

  function showStep(step) {
    sign.step = step;
    $('#signinCard').dataset.step = step;
    $('#stepWho').hidden = step !== 'who';
    $('#stepFirst').hidden = step !== 'first';
    $('#stepPin').hidden = step !== 'pin';
    if (step === 'who') requestAnimationFrame(updateTeamFade);
  }

  function renderTeam() {
    const t = sign.team || { cs: [], sales: [] };
    const last = store.get(LAST_KEY, null);
    ['cs', 'sales'].forEach((k) => {
      const tab = $(k === 'cs' ? '#tabCs' : '#tabSales');
      tab.setAttribute('aria-selected', String(sign.tab === k));
      tab.tabIndex = sign.tab === k ? 0 : -1;
      $(k === 'cs' ? '#countCs' : '#countSales').textContent = t[k].length;
    });
    $('#teamGrid').setAttribute('aria-labelledby', sign.tab === 'cs' ? 'tabCs' : 'tabSales');
    const list = t[sign.tab];
    $('#teamGrid').innerHTML = list.length ? list.map((n) =>
      '<button type="button" class="member' + (last && last.n === n ? ' is-last' : '') + '" data-name="' + esc(n) + '" aria-label="Sign in as ' + esc(nice(n)) + '">' +
      '<span class="disc">' + esc(n.charAt(0)) + '</span><span class="member-name">' + esc(n) + '</span></button>'
    ).join('') : (sign.tab === 'sales'
      ? '<div class="team-empty"><strong>No sales team yet</strong>Sales sign-ins will show here once they’re added.</div>'
      : '<div class="team-empty"><strong>No one here yet</strong>Use “Not in the list?” below to sign in.</div>');
    $('#teamScroll').scrollTop = 0;
    requestAnimationFrame(updateTeamFade);
  }
  function updateTeamFade() {
    const s = $('#teamScroll'); if (!s) return;
    const more = s.scrollHeight - s.clientHeight - s.scrollTop > 4;
    s.classList.toggle('is-scrollable', more);
  }

  function pick(name, opts = {}) {
    state.pick = name;
    sign.pickTeam = opts.team || null;
    $('#pinDisc').innerHTML = opts.admin ? SHIELD : esc(name.charAt(0));
    $('#pinName').textContent = opts.label || name;
    $('#pinSub').textContent = opts.sub || (opts.team ? TEAM_LABEL[opts.team] : '');
    showStep('pin');
    setMsg('');
    resetPin();
    if (!isTouch()) $('#pinInput').focus();
  }
  function backToNames() {
    if (state.busy) return;
    state.pick = null;
    resetPin(); setMsg('');
    if (hasTeam()) { renderTeam(); showStep('who'); const tab = $(sign.tab === 'cs' ? '#tabCs' : '#tabSales'); if (!isTouch()) tab.focus(); }
    else { $('#backToListBtn').hidden = true; showStep('first'); if (!isTouch()) $('#firstName').focus(); }
  }

  function resetPin() {
    const inp = $('#pinInput'); inp.value = ''; inp.disabled = false;
    $('#pinWells').classList.remove('error', 'busy', 'shake');
    drawWells();
  }
  function drawWells() {
    const n = $('#pinInput').value.length;
    $$('#pinWells span').forEach((s, i) => { s.classList.toggle('filled', i < n); s.classList.toggle('next', i === n); });
  }
  function setMsg(text, kind) {
    const m = $('#pinMsg');
    m.className = 'pin-msg' + (kind ? ' is-' + kind : '');
    m.textContent = text || '';
  }

  async function submitPin() {
    const inp = $('#pinInput');
    const pin = inp.value;
    if (pin.length !== 4 || !state.pick || state.busy) return;
    state.busy = true; inp.disabled = true;
    $('#pinWells').classList.add('busy');
    setMsg('Signing in…');
    try {
      const res = await api.call('verifyPinServer', [state.pick, pin, true], { timeout: 60000 });
      if (res && res.success && res.token) {
        api.token = res.token;
        let boot = res.boot;
        if (!boot) boot = await legacyBoot(state.pick, res.role);   // backend without the fast-load update
        if (state.pick !== 'MASTER') store.set(LAST_KEY, { n: state.pick, t: sign.pickTeam || null });
        $('#signinCard').classList.add('leaving');
        setTimeout(() => enterApp(boot, state.pick, res.role), 280);
        return;
      }
      const wells = $('#pinWells');
      wells.classList.remove('busy'); wells.classList.add('error', 'shake');
      if (res && res.locked) setMsg(res.message || 'Too many wrong PINs. Try again later.', 'locked');
      else if (res && res.offline) setMsg(res.message, 'error');
      else setMsg('Incorrect PIN. Try again.', 'error');
      setTimeout(() => { resetPin(); if (!isTouch() && sign.step === 'pin') inp.focus(); }, 650);
    } catch (e) {
      $('#pinWells').classList.remove('busy');
      setMsg(e.message, 'error');
      setTimeout(() => { resetPin(); if (!isTouch() && sign.step === 'pin') inp.focus(); }, 650);
    } finally { state.busy = false; }
  }

  async function legacyBoot(name, role) {
    const [jobs, users] = await Promise.all([api.call('getSheetData'), api.call('getAllUsers')]);
    return { me: { user: name, role: String(role || '').toUpperCase() }, jobs, users, recent: [], serverTime: Date.now() };
  }

  function initSignin() {
    sign.team = loadTeam();
    if (hasTeam()) {
      const last = store.get(LAST_KEY, null);
      sign.tab = last && last.t === 'sales' && sign.team.sales.length ? 'sales' : (sign.team.cs.length ? 'cs' : 'sales');
      renderTeam(); showStep('who');
    } else { $('#backToListBtn').hidden = true; showStep('first'); }

    // tabs
    $('.team-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('.team-tab'); if (!b || sign.tab === b.dataset.team) return;
      sign.tab = b.dataset.team; renderTeam();
    });
    $('.team-tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); sign.tab = sign.tab === 'cs' ? 'sales' : 'cs'; renderTeam();
      $(sign.tab === 'cs' ? '#tabCs' : '#tabSales').focus();
    });
    $('#teamScroll').addEventListener('scroll', updateTeamFade, { passive: true });
    window.addEventListener('resize', () => { if (sign.step === 'who') updateTeamFade(); });

    // pick a person
    $('#teamGrid').addEventListener('click', (e) => {
      const b = e.target.closest('.member'); if (!b || state.busy) return;
      b.classList.add('is-pressed');
      setTimeout(() => pick(b.dataset.name, { team: sign.tab }), 140);
    });
    $('#notListedBtn').addEventListener('click', () => {
      $('#backToListBtn').hidden = !hasTeam(); $('#firstName').value = '';
      showStep('first'); if (!isTouch()) $('#firstName').focus();
    });
    $('#backToListBtn').addEventListener('click', () => { renderTeam(); showStep('who'); });
    $('#stepFirst').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#firstName').value.trim().toUpperCase().replace(/\s+/g, ' ');
      if (!name) { $('#firstName').focus(); return; }
      const team = sign.team && sign.team.sales.includes(name) ? 'sales' : (sign.team && sign.team.cs.includes(name) ? 'cs' : null);
      pick(name, { team, sub: team ? undefined : 'FIRST SIGN-IN HERE' });
    });
    $('#switchBtn').addEventListener('click', backToNames);
    $('#adminBtn').addEventListener('click', () => { if (!state.busy) pick('MASTER', { label: 'ADMIN', sub: 'ADMIN ACCESS', admin: true }); });

    // PIN entry (keyboard on laptops, keypad on phones)
    const inp = $('#pinInput');
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '').slice(0, 4);
      $('#pinWells').classList.remove('error');
      if ($('#pinMsg').classList.contains('is-error')) setMsg('');
      drawWells();
      if (inp.value.length === 4) submitPin();
    });
    $('#pinWells').addEventListener('click', () => { if (!isTouch()) inp.focus(); });
    $('#keypad').addEventListener('click', (e) => {
      const k = e.target.closest('button'); if (!k || inp.disabled) return;
      if (k.dataset.k === 'back') inp.value = inp.value.slice(0, -1);
      else if (inp.value.length < 4) inp.value += k.dataset.k;
      inp.dispatchEvent(new Event('input'));
    });
    document.addEventListener('keydown', (e) => {
      if (!document.body.classList.contains('is-signin')) return;
      if (e.key === 'Escape' && sign.step === 'pin') backToNames();
      else if (sign.step === 'pin' && /^\d$/.test(e.key) && document.activeElement !== inp && !inp.disabled && !isTouch()) { inp.focus(); }
    });

    if (!api.connected) {
      const note = document.createElement('div');
      note.className = 'team-empty'; note.id = 'setupNote';
      note.innerHTML = '<strong>Not connected yet</strong>Paste your Apps Script /exec link into config.js.';
      $('#signinCard').insertBefore(note, $('.card-foot'));
    }
  }

  // ================================================================ APP
  const FIT_QUERY = window.matchMedia('(min-width: 1024px) and (min-height: 600px)');
  const isFit = () => FIT_QUERY.matches;
  function applyFit() { document.body.classList.toggle('fit', isFit()); }

  function applyBoot(boot) {
    const rows = Array.isArray(boot.jobs) ? boot.jobs : [];
    const ix = mapHeaders(rows[0] || []);
    const t0 = today0();
    state.jobs = rows.slice(1).map((r) => buildJob(r, ix, t0)).filter((j) => j.jobNo);
    state.users = Array.isArray(boot.users) ? boot.users : [];
    state.recent = Array.isArray(boot.recent) ? boot.recent : [];
    state.syncedAt = Date.now();
  }

  const isAdmin = () => ['ADMIN', 'CO-ADMIN', 'MASTER'].includes(state.role) || state.user === 'MASTER';
  function roleLabel(role, name) {
    const r = String(role || '').toUpperCase();
    if (name === 'MASTER' || ['ADMIN', 'CO-ADMIN', 'MASTER'].includes(r)) return 'ADMIN';
    if (r === 'SALES') return 'SALES';
    return 'OPERATIONS';
  }

  function enterApp(boot, name, role) {
    state.user = (boot.me && boot.me.user) || name;
    state.role = String((boot.me && boot.me.role) || role || '').toUpperCase();
    applyBoot(boot);
    saveTeam(state.users);
    const savedScope = store.get('ethix.v2.scope.' + state.user, null);
    const hasMine = state.jobs.some((j) => j.active && j.cs === state.user);
    state.scope = savedScope || (hasMine && !isAdmin() ? 'mine' : 'all');
    document.body.classList.remove('is-signin');
    $('#signin').hidden = true;
    const shell = $('#shell'); shell.hidden = false; shell.classList.add('entering');
    renderChrome();
    renderHome(true);
    startTimers();
    $('#view').focus({ preventScroll: true });
  }

  function navItems() {
    const items = [
      { id: 'home', label: 'Home', icon: 'home' },
      { id: 'jobs', label: 'Jobs', icon: 'jobs', soon: true },
      { id: 'fleet', label: 'Fleet', icon: 'fleet', soon: true },
      { id: 'enq', label: 'Enquiries', icon: 'enq', soon: true },
      { id: 'costing', label: 'Costing', icon: 'costing', soon: true },
      { id: 'analysis', label: 'Analysis', icon: 'analysis', soon: true }
    ];
    if (isAdmin()) items.push({ id: 'admin', label: 'Admin', icon: 'admin', soon: true });
    return items;
  }

  function renderChrome() {
    $('#navList').innerHTML = navItems().map((n) =>
      '<button type="button" class="nav-item" ' + (n.id === 'home' ? 'aria-current="page"' : 'disabled title="Coming soon"') + ' aria-label="' + esc(n.label) + '">' +
      icon(n.icon) + '<span class="nav-label">' + esc(n.label) + '</span>' + (n.soon ? '<span class="soon">SOON</span>' : '') + '</button>'
    ).join('');
    $('#sideAvatar').textContent = state.user.charAt(0);
    $('#sideName').textContent = state.user === 'MASTER' ? 'ADMIN' : state.user;
    $('#sideRole').textContent = roleLabel(state.role, state.user);
    $('#bottomBar').innerHTML =
      '<button type="button" class="tab" aria-current="page">' + icon('home', 22) + 'Home</button>' +
      '<button type="button" class="tab" disabled title="Coming soon">' + icon('jobs', 22) + 'Jobs</button>' +
      '<button type="button" class="tab-plus" disabled aria-label="New job (coming soon)">' + icon('plus', 22) + '</button>' +
      '<button type="button" class="tab" disabled title="Coming soon">' + icon('fleet', 22) + 'Fleet</button>' +
      '<button type="button" class="tab" data-act="more">' + icon('more', 22) + 'More</button>';
  }

  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
  function syncText() {
    const s = Math.round((Date.now() - state.syncedAt) / 1000);
    if (s < 60) return 'SYNCED JUST NOW';
    return 'SYNCED ' + Math.round(s / 60) + ' MIN AGO';
  }
  function scoped() { return state.scope === 'mine' ? state.jobs.filter((j) => j.cs === state.user) : state.jobs; }

  function track(j, w) {
    const pct = Math.round((j.pct || 0) * 1000) / 10;
    const left = j.pct >= 1 ? 'calc(100% - ' + w + 'px)' : j.pct <= 0 ? '0px' : 'calc(' + pct + '% - ' + (w / 2) + 'px)';
    const mover = j.mode === 'air' ? PLANE(20) : SHIP(w);
    return '<div class="track" aria-hidden="true"><span class="track-ahead"></span><span class="track-done" style="width:' + pct + '%"></span><span class="track-a"></span><span class="track-b"></span><span class="track-ship" style="left:' + left + '">' + mover + '</span></div>';
  }

  // How many rows each tile shows. In one-screen mode the tile scrolls instead.
  const cap = (n) => (isFit() ? 60 : n);
  const seeAll = (id, total, shown, dark) => (total > shown ? '<button type="button" class="tile-link"' + (dark ? ' style="color:#7FD6D5"' : '') + ' data-list="' + id + '">See all ' + total + '</button>' : '');
  function tile(cls, id, title, headRight, body, anim, d) {
    return '<section class="tile ' + cls + anim + '" style="--d:' + d + 'ms" aria-labelledby="' + id + '">' +
      '<div class="tile-head"><h2 class="tile-title" id="' + id + '">' + title + '</h2>' + headRight + '</div>' +
      '<div class="tile-body">' + body + '</div></section>';
  }

  function watchTile(m, anim) {
    const items = m.watch.slice(0, cap(6));
    const chip = (w) => w.level === 'urgent' ? 'chip chip-urgent' : w.level === 'soon' ? 'chip chip-soon-dark' : 'chip chip-calm-dark';
    const sub = '<span class="watch-sub">' + (m.deadlines ? m.deadlines + (m.deadlines === 1 ? ' deadline' : ' deadlines') + ' in the next 48 h' : 'Nothing urgent in the next 48 h') + '</span>';
    const body = (items.length ? items.map((w) =>
      '<button type="button" class="watch-item" data-job="' + esc(w.j.jobNo) + '">' +
      '<span class="watch-job">' + esc(w.j.jobNo) + '</span>' +
      '<span class="watch-text"><span class="watch-what">' + esc(w.what) + '</span><span class="watch-cust">' + esc(w.j.customer || '—') + ' · ' + esc(nice(w.j.route)) + '</span></span>' +
      '<span class="' + chip(w) + '">' + (w.level === 'urgent' ? icon('alert', 13) : '') + esc(w.when) + '</span></button>'
    ).join('') : '<div class="tile-empty">No cutoffs, sailings or free-time deadlines in the next 48 hours.</div>') +
      (m.watch.length > items.length ? '<div style="padding-top:10px">' + seeAll('watch', m.watch.length, items.length, true) + '</div>' : '');
    return tile('tile-ink t-watch', 'watchTitle', 'TODAY’S WATCH', sub, body, anim, 120);
  }

  function kpiTiles(m, anim) {
    const k = (id, label, n, sub, urgent, d) =>
      '<button type="button" class="kpi' + (urgent ? ' is-urgent' : '') + anim + '" style="--d:' + d + 'ms" data-list="' + id + '">' +
      '<span class="kpi-label">' + label + '</span><span class="kpi-num">' + n + '</span><span class="kpi-sub">' + esc(sub) + '</span></button>';
    return '<div class="kpis">' +
      k('active', 'ACTIVE JOBS', m.active.length, m.atSea.length + ' on the way now', false, 40) +
      k('costing', 'COSTING PENDING', m.costing.length, m.costingSailed + ' already sailed', false, 70) +
      k('sied', 'SI / ED PENDING', m.sied.length, m.cut24 + (m.cut24 === 1 ? ' cutoff' : ' cutoffs') + ' within 24 h', false, 100) +
      k('free', 'FREE TIME', m.freeJobs.length, m.freeJobs.length ? 'Ending within 2 days' : 'All clear', m.freeJobs.length > 0, 130) +
      '</div>';
  }

  function seaTile(m, anim) {
    const items = m.atSea.slice(0, cap(5));
    const right = items.length < m.atSea.length ? seeAll('atsea', m.atSea.length, items.length) : '<span class="tile-meta">' + m.atSea.length + ' ON THE WAY</span>';
    const body = items.length ? items.map((j) =>
      '<button type="button" class="sea-item" data-job="' + esc(j.jobNo) + '"><span class="sea-job">' + esc(j.jobNo) + '</span><span class="sea-route">' + esc(j.route) + '</span>' + track(j, 30) +
      '<span class="sea-day">DAY ' + j.dayN + '/' + j.dayT + '</span></button>'
    ).join('') : '<div class="tile-empty">Nothing at sea or in the air right now.</div>';
    return tile('t-sea', 'seaTitle', 'AT SEA NOW', right, body, anim, 160);
  }

  function holdTile(m, anim) {
    const items = m.hold.slice(0, cap(4));
    const right = items.length < m.hold.length ? seeAll('hold', m.hold.length, items.length) : '<span class="chip chip-hold">' + m.hold.length + '</span>';
    const body = items.length ? items.map((j) =>
      '<button type="button" class="list-item" data-job="' + esc(j.jobNo) + '"><span class="li-main"><span class="li-job">' + esc(j.jobNo) + ' · ' + esc(j.type) + '</span><span class="li-sub">' + esc(j.customer || '—') + ' · ' + esc(nice(j.route)) + '</span>' +
      (j.remarks ? '<span class="li-note">“' + esc(j.remarks) + '”</span>' : '') + '</span></button>'
    ).join('') : '<div class="tile-empty">No jobs on hold.</div>';
    return tile('t-hold', 'holdTitle', 'ON HOLD', right, body, anim, 260);
  }

  function dateList(title, id, cls, list, field, dark, anim, d) {
    const items = list.slice(0, cap(5));
    const right = items.length < list.length ? seeAll(id, list.length, items.length) : '<span class="tile-meta">' + list.length + '</span>';
    const body = items.length ? items.map((j) =>
      '<button type="button" class="list-item" data-job="' + esc(j.jobNo) + '"><span class="date-chip' + (dark ? ' is-dark' : '') + '"><span class="dow">' + DOW_UP[j[field].getDay()] + '</span><span class="day">' + j[field].getDate() + '</span></span>' +
      '<span class="li-main"><span class="li-job">' + esc(j.jobNo) + '</span><span class="li-sub">' + esc(nice(j.route)) + (j.cargo ? ' · ' + esc(j.cargo) : '') + '</span></span></button>'
    ).join('') : '<div class="tile-empty">Nothing this week.</div>';
    return tile(cls, id, title, right, body, anim, d);
  }

  function activityTile(anim) {
    const rows = state.recent.slice(0, 10);
    const body = rows.length ? rows.map((r) =>
      '<div class="act"><span class="avatar">' + esc(String(r[1] || '?').charAt(0)) + '</span><div class="act-text"><div><strong>' + esc(r[1]) + '</strong> ' + esc(String(r[2] || '').toLowerCase()) + '</div>' +
      '<div class="act-meta">' + esc([r[3], r[0]].filter(Boolean).join(' · ')) + '</div></div></div>'
    ).join('') : '<div class="tile-empty">No recent activity yet.</div>';
    return tile('t-act', 'actTitle', 'RECENT ACTIVITY', '', body, anim, 300);
  }

  let lastMetrics = null;
  function renderHome(first) {
    const t0 = today0();
    const m = computeHome(scoped(), t0);
    lastMetrics = m;
    const anim = first ? ' reveal' : '';
    const view = $('#view');
    // keep the reader's place when the screen refreshes itself
    const keep = { view: view.scrollTop, win: window.scrollY, tiles: {} };
    $$('.tile', view).forEach((t) => { const b = $('.tile-body', t); if (b) keep.tiles[t.className.split(' ').find((c) => c.startsWith('t-'))] = b.scrollTop; });
    const searchVal = $('#searchInput') ? $('#searchInput').value : '';
    view.innerHTML =
      '<div class="home">' +
      '<header class="page-head' + anim + '" style="--d:0ms">' +
        '<div class="head-left"><div class="meta-line"><span>' + esc(fmtLong(t0)) + '</span><span class="sync" id="sync"><span class="sync-dot"></span><span id="syncText">' + syncText() + '</span></span>' +
          '<button type="button" class="icon-btn icon-btn-sm" id="refreshBtn" data-act="refresh" aria-label="Refresh now" title="Refresh now">' + icon('refresh', 15) + '</button></div>' +
        '<h1 class="greeting">' + greeting() + ', ' + esc(state.user === 'MASTER' ? 'Admin' : nice(state.user)) + '</h1></div>' +
        '<div class="head-actions">' +
          '<div class="seg" role="group" aria-label="Whose jobs"><button type="button" data-scope="mine" aria-pressed="' + (state.scope === 'mine') + '">My jobs</button><button type="button" data-scope="all" aria-pressed="' + (state.scope === 'all') + '">Everyone</button></div>' +
          '<div class="search-wrap"><label class="search">' + icon('search') + '<input id="searchInput" type="search" placeholder="Job no, customer, port…" aria-label="Search jobs" autocomplete="off" value="' + esc(searchVal) + '"><kbd>/</kbd></label><div class="search-results glass" id="searchResults" hidden></div></div>' +
        '</div>' +
      '</header>' +
      kpiTiles(m, anim) +
      '<div class="bento">' +
        watchTile(m, anim) + seaTile(m, anim) +
        dateList('ARRIVING THIS WEEK', 'arriving', 't-arr', m.arriving, 'eta', false, anim, 200) +
        dateList('DEPARTING THIS WEEK', 'departing', 't-dep', m.departing, 'etd', true, anim, 230) +
        holdTile(m, anim) + activityTile(anim) +
      '</div>' +
      '</div>';
    if (!first) {
      view.scrollTop = keep.view; if (!isFit()) window.scrollTo(0, keep.win);
      $$('.tile', view).forEach((t) => { const k = t.className.split(' ').find((c) => c.startsWith('t-')); const b = $('.tile-body', t); if (b && keep.tiles[k]) b.scrollTop = keep.tiles[k]; });
    }
  }

  // ------------------------------------------------------------ interactions
  function findJob(no) { return state.jobs.find((j) => j.jobNo === no); }

  function statusChip(v) {
    const s = String(v || '').toUpperCase();
    if (!s) return '<span class="chip chip-calm">—</span>';
    if (s === 'NOT APPLICABLE') return '<span class="chip chip-calm">N/A</span>';
    if (/(APPROVED|SUBMITTED|PASSED|PAID|ISSUED|CONFIRMED|RECEIVED|DONE|YES|COMPLETED)/.test(s)) return '<span class="chip chip-done">' + esc(s) + '</span>';
    return '<span class="chip chip-calm">' + esc(s) + '</span>';
  }

  function openPeek(j, opener) {
    if (!j) return;
    const kv = (k, v) => '<div class="kv"><span class="kv-k">' + esc(k) + '</span><span class="kv-v">' + v + '</span></div>';
    const statusPill = j.hold ? '<span class="chip chip-hold">ON HOLD</span>' : j.active ? '<span class="chip chip-done">' + esc(j.status || 'ONGOING') + '</span>' : '<span class="chip chip-calm">' + esc(j.status) + '</span>';
    const where = j.hold ? 'On hold' : j.atSea ? 'Day ' + j.dayN + ' of ' + j.dayT + (j.mode === 'air' ? ' in the air' : ' at sea') : j.arrived ? 'Arrived ' + fmt(j.eta) : j.etd ? 'Departs ' + fmt(j.etd) : 'Not scheduled yet';
    let freeLine = '';
    if (j.cat === 'IMPORT' && j.lineFreeEnd) {
      const d = days(today0(), j.lineFreeEnd);
      freeLine = kv('Line free time ends', esc(fmt(j.lineFreeEnd, true)) + (d <= 2 && !j.delivery ? ' <span class="chip chip-urgent" style="margin-left:6px">' + esc(d < 0 ? 'OVER' : d + 'D LEFT') + '</span>' : ''));
    }
    $('#drawerKicker').textContent = j.typeName.toUpperCase();
    $('#drawerBody').innerHTML =
      '<div><h2 class="peek-job" id="drawerTitle">' + esc(j.jobNo) + '</h2>' +
      '<div class="peek-tags"><span class="badge">' + esc(j.type || '—') + '</span>' + statusPill + (j.dg === 'DG' ? '<span class="chip chip-soon">DG</span>' : '') + '</div>' +
      '<div class="peek-cust">' + esc(j.customer || '—') + '</div><div class="peek-route">' + esc(j.route) + '</div></div>' +
      '<div class="peek-card"><h3>' + esc(where.toUpperCase()) + '</h3>' + (j.mode === 'sea' || j.mode === 'air' ? track(j, 34) : '') +
        '<div style="display:flex;justify-content:space-between;font-family:var(--f-mono);font-size:11px;color:var(--ink-2);margin-top:4px"><span>' + esc(j.pol || '—') + ' · ' + esc(fmt(j.etd)) + '</span><span>' + esc(j.pod || '—') + ' · ' + esc(fmt(j.eta)) + '</span></div></div>' +
      '<div class="peek-card"><h3>KEY DATES</h3>' +
        kv('Job opened', esc(fmt(j.opened, true))) +
        (j.cat === 'EXPORT' || j.cat === 'CROSS' ? kv('SI cutoff', esc(fmt(j.siCut, true))) : '') +
        (j.cat === 'EXPORT' ? kv('ED cutoff', esc(fmt(j.edCut, true))) : '') +
        (j.dg === 'DG' ? kv('DG cutoff', esc(fmt(j.dgCut, true))) : '') +
        kv('ETD', esc(fmt(j.etd, true))) + kv('ETA', esc(fmt(j.eta, true))) +
        (j.cat === 'IMPORT' ? kv('Delivered', esc(fmt(j.delivery, true))) : '') + freeLine +
      '</div>' +
      '<div class="peek-card"><h3>STATUS</h3>' +
        kv(j.cat === 'IMPORT' ? 'DO' : 'SI', statusChip(j.sido)) + kv(j.cat === 'IMPORT' ? 'Customs (ED)' : 'ED', statusChip(j.ed)) +
        kv(j.mode === 'air' ? 'AWB' : 'BL', statusChip(j.bl)) + (j.mode === 'sea' ? kv(j.cat === 'IMPORT' ? 'Discharge list' : 'Loadlist', statusChip(j.loadlist)) : '') +
        (j.cat === 'IMPORT' ? kv('Original docs', statusChip(j.docs)) : '') + kv('Costing', statusChip(j.costing)) +
      '</div>' +
      '<div class="peek-card"><h3>CARGO &amp; PEOPLE</h3>' +
        kv('Cargo', esc([j.cargo || '—', j.dg].filter(Boolean).join(' · '))) + (j.vendor ? kv('Line / vendor', esc(j.vendor)) : '') + (j.freight ? kv('Line freight USD', esc(j.freight)) : '') +
        kv('CS', esc(j.cs || '—')) + kv('Sales', esc(j.sales || '—')) +
        (j.remarks ? '<div class="kv"><span class="kv-k">Remarks</span><span style="font-size:13px;text-align:right">' + esc(j.remarks) + '</span></div>' : '') +
      '</div>' +
      '<div class="peek-note">The full voyage view with one-tap updates is coming soon.</div>';
    showDrawer(opener);
  }

  function openList(kind, opener) {
    const m = lastMetrics; if (!m) return;
    const map = {
      active: ['ACTIVE JOBS', m.active], costing: ['COSTING PENDING', m.costing], sied: ['SI / ED PENDING', m.sied],
      free: ['FREE TIME ENDING ≤ 2 DAYS', m.freeJobs], atsea: ['AT SEA NOW', m.atSea], arriving: ['ARRIVING THIS WEEK', m.arriving],
      departing: ['DEPARTING THIS WEEK', m.departing], hold: ['ON HOLD', m.hold], watch: ['TODAY’S WATCH', m.watch.map((w) => w.j)]
    };
    const entry = map[kind]; if (!entry) return;
    const list = Array.from(new Set(entry[1]));
    $('#drawerKicker').textContent = list.length + (list.length === 1 ? ' JOB' : ' JOBS');
    $('#drawerBody').innerHTML = '<h2 class="peek-job" id="drawerTitle" style="font-family:var(--f-display);font-stretch:120%;font-weight:800;font-size:26px">' + esc(entry[0]) + '</h2>' +
      (list.length ? '<div>' + list.map((j) =>
        '<button type="button" class="list-row" data-job="' + esc(j.jobNo) + '"><span style="min-width:0"><span class="li-job">' + esc(j.jobNo) + ' · ' + esc(j.type) + '</span>' +
        '<span class="li-sub" style="font-weight:700;color:var(--ink)">' + esc(j.customer || '—') + '</span><span class="li-sub">' + esc(j.route) + '</span></span>' +
        '<span class="mono small">' + esc(j.cs || '') + '</span></button>'
      ).join('') + '</div>' : '<div class="tile-empty">Nothing here right now.</div>');
    showDrawer(opener);
  }

  function openMore(opener) {
    $('#drawerKicker').textContent = 'ACCOUNT';
    $('#drawerBody').innerHTML =
      '<div style="display:flex;align-items:center;gap:12px"><span class="avatar">' + esc(state.user.charAt(0)) + '</span><div><div id="drawerTitle" style="font-weight:800">' + esc(state.user === 'MASTER' ? 'ADMIN' : state.user) + '</div><div class="mono small">' + esc(roleLabel(state.role, state.user)) + '</div></div></div>' +
      '<button type="button" class="btn-brutal" data-act="logout" style="width:100%">Log out</button>' +
      '<div class="peek-card"><h3>COMING SOON</h3>' + ['Jobs and the voyage view', 'Fleet timeline', 'Sales enquiries', 'Costing, analysis and admin'].map((t) => '<div class="kv"><span class="kv-k">' + esc(t) + '</span><span class="soon">SOON</span></div>').join('') + '</div>';
    showDrawer(opener);
  }

  let drawerOpener = null;
  function showDrawer(opener) {
    drawerOpener = opener || document.activeElement;
    $('#scrim').hidden = false; $('#drawer').hidden = false;
    $('#drawerBody').scrollTop = 0;
    $('#drawerClose').focus();
  }
  function hideDrawer() {
    $('#scrim').hidden = true; $('#drawer').hidden = true;
    if (drawerOpener && document.body.contains(drawerOpener)) drawerOpener.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ search
  let searchIndex = -1;
  function runSearch(q) {
    const box = $('#searchResults'); if (!box) return;
    q = q.trim().toUpperCase();
    if (!q) { box.hidden = true; return; }
    const hits = state.jobs.filter((j) => (j.jobNo + ' ' + j.customer + ' ' + j.pol + ' ' + j.pod + ' ' + j.cs + ' ' + j.sales + ' ' + j.type).toUpperCase().includes(q))
      .sort((a, b) => (b.active - a.active) || (a.jobNo.startsWith(q) ? -1 : 0))
      .slice(0, 8);
    searchIndex = -1;
    box.innerHTML = hits.length ? hits.map((j) =>
      '<button type="button" class="result" data-job="' + esc(j.jobNo) + '"><span class="result-job">' + esc(j.jobNo) + '</span><span class="result-cust">' + esc(j.customer || '—') + '</span><span class="result-route">' + esc(j.route) + ' · ' + esc(j.type) + (j.active ? '' : ' · ' + esc(j.status)) + '</span></button>'
    ).join('') : '<div class="result-empty">No jobs match “' + esc(q) + '”.</div>';
    box.hidden = false;
  }

  // ----------------------------------------------------------------- refresh
  async function refresh(manual) {
    if (state.refreshing) return;
    state.refreshing = true;
    const busy = (on) => { const b = $('#refreshBtn'), s = $('#sync'); if (b) b.classList.toggle('is-busy', on); if (s) s.classList.toggle('is-busy', on); };
    busy(true);
    try {
      let boot;
      try { boot = await api.call('ethixBootstrap'); }
      catch (e) { if (e.kind === 'server' && /not available/i.test(e.message)) boot = await legacyBoot(state.user, state.role); else throw e; }
      applyBoot(boot);
      renderHome(false);
      if (manual) toast('Up to date');
    } catch (e) {
      if (e.kind !== 'auth') toast(e.message, true);
    } finally {
      state.refreshing = false;
      busy(false);
    }
  }

  // ------------------------------------------------------------ session & timers
  let ending = false;
  function sessionLost(msg) {
    if (ending) return; ending = true; api.token = null;
    toast(msg || 'Your session has ended. Please sign in again.', true);
    setTimeout(() => window.location.reload(), 1800);
  }
  function startTimers() {
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => { state.lastActive = Date.now(); }, { passive: true }));
    setInterval(() => { const el = $('#syncText'); if (el) el.textContent = syncText(); }, 30000);
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !api.token) return;
      if (Date.now() - state.lastActive < 10 * 60 * 1000) refresh(false);      // you're working: keep data fresh
      else api.call('ethixPing').catch(() => {});                              // idle: just check the session
    }, 3 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && api.token && Date.now() - state.syncedAt > 3 * 60 * 1000) refresh(false);
    });
  }

  function confirmLogout() {
    const wrap = $('#confirmWrap'); wrap.hidden = false; $('#confirmNo').focus();
    const close = () => { wrap.hidden = true; };
    $('#confirmNo').onclick = close;
    $('#confirmYes').onclick = () => { api.logout(); document.body.style.opacity = '0.6'; setTimeout(() => window.location.reload(), 250); };
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
  }

  function toast(text, isError) {
    const t = document.createElement('div');
    t.className = 'toast' + (isError ? ' is-error' : '');
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, isError ? 4200 : 2200);
  }

  function initApp() {
    $('#view').addEventListener('click', (e) => {
      const jobBtn = e.target.closest('[data-job]');
      if (jobBtn) { const box = $('#searchResults'); if (box) box.hidden = true; openPeek(findJob(jobBtn.dataset.job), jobBtn); return; }
      const listBtn = e.target.closest('[data-list]');
      if (listBtn) { openList(listBtn.dataset.list, listBtn); return; }
      const scopeBtn = e.target.closest('[data-scope]');
      if (scopeBtn) { state.scope = scopeBtn.dataset.scope; store.set('ethix.v2.scope.' + state.user, state.scope); renderHome(false); return; }
      if (e.target.closest('[data-act="refresh"]')) { refresh(true); }
    });
    $('#view').addEventListener('input', (e) => { if (e.target.id === 'searchInput') runSearch(e.target.value); });
    $('#view').addEventListener('keydown', (e) => {
      if (e.target.id !== 'searchInput') return;
      const box = $('#searchResults'); const items = box ? $$('.result', box) : [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!items.length) return;
        searchIndex = (searchIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((x, i) => x.classList.toggle('is-active', i === searchIndex));
      } else if (e.key === 'Enter') {
        e.preventDefault();   // stop the same Enter from also pressing the drawer's close button
        const target = items[searchIndex >= 0 ? searchIndex : 0]; if (target) target.click();
      } else if (e.key === 'Escape') { e.target.value = ''; if (box) box.hidden = true; }
    });
    document.addEventListener('click', (e) => { const box = $('#searchResults'); if (box && !e.target.closest('.search-wrap')) box.hidden = true; });
    document.addEventListener('keydown', (e) => {
      if (document.body.classList.contains('is-signin')) return;
      if (e.key === 'Escape' && !$('#drawer').hidden) { hideDrawer(); return; }
      if (e.key === 'Escape' && !$('#confirmWrap').hidden) { $('#confirmWrap').hidden = true; return; }
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { const s = $('#searchInput'); if (s) { e.preventDefault(); s.focus(); } }
    });
    $('#drawerBody').addEventListener('click', (e) => {
      const jobBtn = e.target.closest('[data-job]'); if (jobBtn) { openPeek(findJob(jobBtn.dataset.job), drawerOpener); return; }
      if (e.target.closest('[data-act="logout"]')) { hideDrawer(); confirmLogout(); }
    });
    $('#drawerClose').addEventListener('click', hideDrawer);
    $('#scrim').addEventListener('click', hideDrawer);
    $('#logoutBtn').addEventListener('click', confirmLogout);
    $('#bottomBar').addEventListener('click', (e) => { const b = e.target.closest('[data-act="more"]'); if (b) openMore(b); });
    const onFitChange = () => { applyFit(); if (state.user) renderHome(false); };
    if (FIT_QUERY.addEventListener) FIT_QUERY.addEventListener('change', onFitChange); else FIT_QUERY.addListener(onFitChange);
  }

  // -------------------------------------------------------------------- start
  function start() {
    applyFit();
    initSignin();
    initApp();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // exposed for automated tests only (no data, no token)
  window.__ethix = { parseDate, mapHeaders, buildJob, computeHome, today0 };
})();
