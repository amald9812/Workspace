/* =============================================================================
   ETHIX v2 — APP (sign-in, Home, Jobs, voyage, new job, people, notifications)
   Talks to the same Apps Script backend as the current app. Nothing is stored
   on the device except the names on the sign-in screen and a few view choices.
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
    scope: 'all', week: 'arr', tab: null, typing: false, lastActive: Date.now(), pick: null, busy: false,
    header: [], ix: {}, rowMap: new Map(), order: [], jobIndex: new Map(), pending: new Map(), saving: new Map(), savingCount: 0,
    stories: new Map(), voyageTab: {}, route: null, overlay: null, dirty: false, navDepth: 0, signedIn: false,
    jobsUi: { cat: 'all', status: 'active', q: '', sort: 'urgent', limit: 120 }, newJob: { type: '' }, editing: null, lists: null,
    notif: null, lastNotes: {}, admin: null, activity: [], actQ: ''
  };

  // ---------------------------------------------------------- dates & parsing
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const MON_UP = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const DOW_UP = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
    ['status', (h) => h === 'STATUS', 0], ['sl', (h) => h.startsWith('SL'), 1], ['jobNo', (h) => h.startsWith('JOB NO'), 2], ['type', (h) => h === 'TYPE', 3],
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
    return d && d > eta ? d : null;                           // a date on/before arrival is not an end date
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
      lineFreeRaw: g('lineFree'), portFreeRaw: g('portFree'), sl: g('sl'), raw: {}
    };
    RULES.forEach(([k]) => { j.raw[k] = g(k); });
    j.active = !!j.jobNo && !['COMPLETED', 'CANCELLED', 'CLOSED'].includes(status);
    j.hold = status === 'HOLD';
    j.route = (j.pol || '—') + ' → ' + (j.pod || '—');
    j.typeName = TYPE_NAMES[type] || type || '—';
    j.cargo = [j.c20 ? j.c20 + '×20′' : '', j.c40 ? j.c40 + '×40′' : ''].filter(Boolean).join(' + ') || (['SFEL', 'SFIL'].includes(type) ? 'LCL' : '');
    j.lineFreeEnd = freeEnd(j.eta, j.lineFreeRaw);
    j.portFreeEnd = freeEnd(j.eta, j.portFreeRaw);
    // where is it now?
    j.atSea = !!(j.active && !j.hold && j.mode !== 'misc' && j.etd && j.eta && t0 >= j.etd && t0 < j.eta);
    j.arrived = !!(j.eta && t0 >= j.eta);
    if (j.atSea) {
      const total = Math.max(1, days(j.etd, j.eta)), done = days(j.etd, t0);
      j.dayN = done; j.dayT = total; j.pct = Math.min(0.97, Math.max(0.03, done / total));
    } else { j.pct = j.arrived ? 1 : 0; }
    j.journey = journeyFor(j, t0);
    j.next = nextStep(j, t0);
    return j;
  }

  // ============================================================ JOURNEYS
  // The stops each job type shows on its voyage (the confirmed journey map).
  // Field stops tick when the tracker field has a "done" value; date stops tick
  // when their date has passed; a field that says NOT APPLICABLE skips itself.
  const NA = 'NOT APPLICABLE';
  const OPTS = {
    status: ['ONGOING', 'HOLD', 'COMPLETED', 'CANCELLED'],
    loadlist: ['NO', 'YES', NA],
    sido: ['PENDING', 'SUBMITTED', 'APPROVED', NA],
    ed: ['PENDING', 'PASSED/PAID', NA],
    bl: ['BL PENDING', 'CONFIRMATION PENDING', 'CONFIRMED OBL', 'CONFIRMED SBL', 'OBL ISSUED', 'SBL ISSUED', NA],
    docs: [NA, 'PENDING', 'RECEIVED'],
    costing: ['PENDING', 'JOB UPDATED', 'COSTING DONE', 'COMPLETED', 'CANCELLED'],
    dg: ['DG', 'NON DG'],
    type: ['SFEF', 'SFEL', 'AFE', 'SFIF', 'SFIL', 'AFI', 'CND', 'SFC', 'AFC', 'CRR', 'MIS']
  };
  const BL_OK = ['CONFIRMED OBL', 'CONFIRMED SBL', 'OBL ISSUED', 'SBL ISSUED'];
  const BL_ISSUED = ['OBL ISSUED', 'SBL ISSUED'];
  const STOP_DEFS = {
    opened:     { name: 'Job opened', kind: 'info' },
    linked:     { name: 'Linked to job no.', kind: 'link', field: 'against', next: 'Link to a job' },
    si:         { name: 'SI submitted', kind: 'field', field: 'sido', done: ['SUBMITTED', 'APPROVED'], primary: 'SUBMITTED', cut: 'siCut', label: 'SI status', next: 'SI to submit' },
    docsReady:  { name: 'Docs ready', kind: 'field', field: 'sido', done: ['SUBMITTED', 'APPROVED'], primary: 'SUBMITTED', label: 'Documents', next: 'Docs to prepare' },
    ed:         { name: 'ED passed', kind: 'field', field: 'ed', done: ['PASSED/PAID', 'PASSED'], primary: 'PASSED/PAID', cut: 'edCut', label: 'ED status', next: 'ED to pass' },
    blConf:     { name: 'BL confirmed', kind: 'field', field: 'bl', done: BL_OK, primary: 'CONFIRMED SBL', choices: ['BL PENDING', 'CONFIRMATION PENDING', 'CONFIRMED OBL', 'CONFIRMED SBL', NA], label: 'BL status', next: 'BL to confirm' },
    blStatus:   { name: 'BL status', kind: 'field', field: 'bl', done: BL_OK, primary: 'CONFIRMED OBL', choices: ['BL PENDING', 'CONFIRMATION PENDING', 'CONFIRMED OBL', 'CONFIRMED SBL', 'OBL ISSUED', 'SBL ISSUED', NA], label: 'BL status', next: 'BL to confirm' },
    blReceived: { name: 'BL received', kind: 'field', field: 'bl', done: BL_OK, primary: 'CONFIRMED OBL', choices: ['BL PENDING', 'CONFIRMATION PENDING', 'CONFIRMED OBL', 'CONFIRMED SBL', 'OBL ISSUED', 'SBL ISSUED', NA], label: 'BL status', next: 'BL to receive' },
    blIss:      { name: 'BL issued', kind: 'field', field: 'bl', done: BL_ISSUED, primary: 'SBL ISSUED', choices: ['CONFIRMED OBL', 'CONFIRMED SBL', 'OBL ISSUED', 'SBL ISSUED', NA], label: 'BL status', next: 'BL issue pending' },
    awbConf:    { name: 'AWB confirmed', kind: 'field', field: 'bl', done: BL_OK, primary: 'CONFIRMED SBL', choices: ['BL PENDING', 'CONFIRMATION PENDING', 'CONFIRMED OBL', 'CONFIRMED SBL', NA], label: 'AWB status', next: 'AWB to confirm' },
    awbStatus:  { name: 'AWB status', kind: 'field', field: 'bl', done: BL_OK, primary: 'CONFIRMED SBL', choices: OPTS.bl, label: 'AWB status', next: 'AWB to confirm' },
    awbIss:     { name: 'AWB issued', kind: 'field', field: 'bl', done: BL_ISSUED, primary: 'SBL ISSUED', choices: ['CONFIRMED OBL', 'CONFIRMED SBL', 'OBL ISSUED', 'SBL ISSUED', NA], label: 'AWB status', next: 'AWB issue pending' },
    tracking:   { name: 'Tracking no. issued', kind: 'field', field: 'bl', done: BL_ISSUED, primary: 'SBL ISSUED', choices: OPTS.bl, label: 'Tracking / AWB status', next: 'Tracking no. pending' },
    costing:    { name: 'Costing done', kind: 'field', field: 'costing', done: ['COSTING DONE', 'COMPLETED'], skip: ['CANCELLED'], primary: 'COSTING DONE', choices: ['PENDING', 'JOB UPDATED', 'COSTING DONE'], label: 'Costing', next: 'Costing pending' },
    discharge:  { name: 'Discharge list', kind: 'field', field: 'loadlist', done: ['YES'], primary: 'YES', label: 'Discharge list', next: 'Discharge list' },
    doRel:      { name: 'DO released', kind: 'field', field: 'sido', done: ['SUBMITTED', 'APPROVED'], primary: 'APPROVED', label: 'DO status', next: 'DO to release' },
    customs:    { name: 'Customs cleared', kind: 'field', field: 'ed', done: ['PASSED/PAID', 'PASSED'], primary: 'PASSED/PAID', label: 'Customs (ED) status', next: 'Customs clearance' },
    customsOpt: { name: 'ED / customs', kind: 'field', field: 'ed', done: ['PASSED/PAID', 'PASSED'], primary: 'PASSED/PAID', label: 'Customs (ED) status', optional: true, next: 'Customs clearance' },
    sailed:     { name: 'Sailed', kind: 'date', field: 'etd', tag: 'ETD', verb: 'Sails', next: 'Sails' },
    departed:   { name: 'Departed', kind: 'date', field: 'etd', tag: 'ETD', verb: 'Departs', next: 'Departs' },
    pickedUp:   { name: 'Picked up', kind: 'date', field: 'etd', tag: 'PICK-UP', verb: 'Pick-up', next: 'Pick-up' },
    arrived:    { name: 'Arrived', kind: 'date', field: 'eta', tag: 'ETA', verb: 'Arrives', next: 'Arrives' },
    deliveredEta: { name: 'Delivered', kind: 'date', field: 'eta', tag: 'ETA', verb: 'Delivery', next: 'Delivery' },
    delivered:  { name: 'Delivered', kind: 'date', field: 'delivery', manual: true, tag: 'DELIVERY', next: 'Delivery' },
    deliveredOpt: { name: 'Delivered', kind: 'date', field: 'delivery', manual: true, optional: true, tag: 'DELIVERY', next: 'Delivery' },
    atSea:      { name: 'At sea', kind: 'auto' },
    inAir:      { name: 'In the air', kind: 'auto' },
    inTransit:  { name: 'In transit', kind: 'auto' },
    vesselArriving: { name: 'Vessel arriving', kind: 'auto', arriving: true },
    completed:  { name: 'Completed', kind: 'status' }
  };
  const JOURNEYS = {
    SEA_EX: { o: ['opened', 'si', 'ed', 'blConf'], t: ['sailed', 'costing', 'blIss'], d: ['arrived', 'completed'], w: [34, 40, 26] },
    SEA_IM: { o: ['opened', 'blStatus', 'sailed'], t: ['atSea'], d: ['arrived', 'discharge', 'doRel', 'customs', 'delivered', 'costing', 'completed'], w: [26, 32, 42] },
    AFE:    { o: ['opened', 'si', 'ed', 'awbConf'], t: ['departed', 'costing', 'awbIss'], d: ['arrived', 'completed'], w: [34, 40, 26] },
    AFI:    { o: ['opened', 'awbStatus', 'departed'], t: ['inAir'], d: ['arrived', 'doRel', 'customs', 'delivered', 'costing', 'completed'], w: [27, 33, 40] },
    CND:    { o: ['opened', 'blReceived'], t: ['vesselArriving'], d: ['arrived', 'discharge', 'doRel', 'customsOpt', 'deliveredOpt', 'costing', 'completed'], w: [24, 30, 46] },
    SFC:    { o: ['opened', 'si', 'blConf'], t: ['sailed', 'costing', 'blIss'], d: ['arrived', 'completed'], w: [32, 42, 26] },
    AFC:    { o: ['opened', 'si', 'awbConf'], t: ['departed', 'costing', 'awbIss'], d: ['arrived', 'completed'], w: [32, 42, 26] },
    CRR:    { o: ['opened', 'docsReady', 'pickedUp'], t: ['tracking', 'inTransit'], d: ['deliveredEta', 'costing', 'completed'], w: [32, 38, 30] },
    MIS:    { o: ['opened', 'linked'], t: [], d: ['costing', 'completed'], w: [50, 0, 50] }
  };
  function journeyKey(type) {
    if (type === 'SFEF' || type === 'SFEL') return 'SEA_EX';
    if (type === 'SFIF' || type === 'SFIL') return 'SEA_IM';
    return JOURNEYS[type] ? type : 'SEA_EX';
  }

  function cutText(d) {
    if (d < 0) return 'CUTOFF PASSED · ' + (-d) + (d === -1 ? ' DAY' : ' DAYS');
    if (d === 0) return 'CUTOFF TODAY';
    if (d === 1) return 'CUTOFF TOMORROW';
    return 'CUTOFF ' + fmt(addDays(today0(), d));
  }
  function soonText(d, date) {
    if (d === 0) return 'TODAY';
    if (d === 1) return 'TOMORROW';
    if (d > 1 && d <= 6) return 'IN ' + d + ' DAYS';
    return fmt(date);
  }

  // Works out the state of every stop for one job.
  function journeyFor(j, t0) {
    const key = journeyKey(j.type);
    const J = JOURNEYS[key];
    const sailed = !!(j.etd && j.etd <= t0);
    const make = (id, region) => {
      const def = STOP_DEFS[id];
      const s = { id, region, def, name: def.name, kind: def.kind, field: def.field, optional: !!def.optional, state: 'todo', sub: '' };
      if (def.kind === 'info') { s.state = 'done'; s.sub = j.opened ? fmt(j.opened) : 'OPENED'; return s; }
      if (def.kind === 'link') { const v = j.against; s.state = v ? 'done' : 'todo'; s.sub = v || 'NOT LINKED YET'; return s; }
      if (def.kind === 'status') { s.state = j.status === 'COMPLETED' ? 'done' : j.status === 'CANCELLED' ? 'skip' : 'todo'; s.sub = j.status === 'COMPLETED' ? 'CLOSED' : j.status === 'CANCELLED' ? 'CANCELLED' : '—'; return s; }
      if (def.kind === 'auto') {
        if (j.arrived) { s.state = 'done'; s.sub = 'ARRIVED'; }
        else if (def.arriving ? !!j.eta : j.atSea) { s.state = 'current'; s.sub = j.atSea ? 'DAY ' + j.dayN + ' OF ' + j.dayT : (j.eta ? 'ETA ' + fmt(j.eta) : '—'); }
        else { s.state = 'todo'; s.sub = j.hold ? 'ON HOLD' : '—'; }
        return s;
      }
      if (def.kind === 'date') {
        const raw = String(j.raw[def.field] || '').toUpperCase();
        const d = j[def.field];
        if (raw === NA) { s.state = 'skip'; s.sub = 'NOT NEEDED'; return s; }
        if (def.manual) {
          if (d) { s.state = 'done'; s.sub = fmt(d); }
          else { s.sub = def.optional ? 'OPTIONAL' : 'PENDING'; }
          return s;
        }
        if (d && d <= t0) { s.state = 'done'; s.sub = fmt(d); }
        else if (d) { s.sub = soonText(days(t0, d), d); s.when = days(t0, d); }
        else { s.sub = def.tag + ' TO CONFIRM'; }
        return s;
      }
      // field stop
      const v = j[def.field] || '';
      s.value = v;
      if (v === NA || (def.skip && def.skip.includes(v))) { s.state = 'skip'; s.sub = 'NOT NEEDED'; return s; }
      if (def.done.includes(v)) { s.state = 'done'; s.sub = v; return s; }
      const cut = def.cut ? j[def.cut] : null;
      if (cut && !sailed) {
        const d = days(t0, cut);
        s.cutDays = d;
        s.sub = cutText(d);
        if (d < 0) s.state = 'late';
      } else {
        s.sub = def.optional ? 'OPTIONAL' : (v && v !== 'PENDING' && v !== 'NO' ? v : 'PENDING');
      }
      return s;
    };
    const origin = J.o.map((id) => make(id, 'o'));
    const transit = J.t.map((id) => make(id, 't'));
    const dest = J.d.map((id) => make(id, 'd'));
    const all = origin.concat(transit, dest);
    const doable = (s) => ['field', 'date', 'status', 'link'].includes(s.kind) && (s.state === 'todo' || s.state === 'late');
    const closeStop = all.find((s) => s.kind === 'status');
    const others = all.filter((s) => s !== closeStop && !s.optional && s.kind !== 'info' && s.kind !== 'auto');
    const ready = others.every((s) => s.state === 'done' || s.state === 'skip');
    if (closeStop && closeStop.state === 'todo' && ready && !j.hold) { closeStop.state = 'current'; closeStop.sub = 'READY TO CLOSE'; }
    let next = all.find((s) => doable(s) && !s.optional && s.kind !== 'status' && !(s.kind === 'field' && s.def.field === 'costing' && j.cat === 'EXPORT' && !sailed));
    if (!next && closeStop && closeStop.state === 'current') next = closeStop;
    if (next && next.state === 'todo') next.state = 'current';
    return { key, w: J.w, origin, transit, dest, all, next, ready };
  }

  // One short "what's next" line for a job, with how urgent it is.
  function nextStep(j, t0) {
    if (j.status === 'COMPLETED') return { text: 'Completed', tone: 'done', rank: 5 };
    if (j.status === 'CANCELLED') return { text: 'Cancelled', tone: 'calm', rank: 6 };
    if (j.hold) return { text: 'On hold' + (j.remarks ? ' · ' + j.remarks : ''), tone: 'hold', rank: 4 };
    const jr = j.journey;
    const late = jr.all.find((s) => s.state === 'late');
    if (late) return { text: late.def.next + ' · cutoff passed', tone: 'urgent', rank: 0 };
    const cut = jr.all.filter((s) => s.cutDays !== undefined && s.state !== 'done' && s.state !== 'skip').sort((a, b) => a.cutDays - b.cutDays)[0];
    if (cut && cut.cutDays === 0) return { text: cut.def.next.replace(/ to .*/, '') + ' cutoff today', tone: 'urgent', rank: 0 };
    if (j.cat === 'IMPORT' && j.arrived && !j.delivery && j.lineFreeEnd) {
      const d = days(t0, j.lineFreeEnd);
      if (d < 0 && d >= -30) return { text: 'Free time over · ' + (-d) + (d === -1 ? ' day' : ' days'), tone: 'urgent', rank: 0 };
      if (d <= 2) return { text: 'Free time: ' + (d === 0 ? 'ends today' : d + (d === 1 ? ' day left' : ' days left')), tone: 'urgent', rank: 0 };
    }
    if (cut && cut.cutDays === 1) return { text: cut.def.next.replace(/ to .*/, '') + ' cutoff tomorrow', tone: 'soon', rank: 1 };
    const n = jr.next;
    if (!n) return { text: 'Nothing pending', tone: 'calm', rank: 3 };
    if (n.kind === 'status') return { text: 'Ready to close', tone: 'done', rank: 3 };
    if (n.kind === 'date') {
      const d = j[n.def.field];
      if (!d) return { text: n.def.tag + ' to confirm', tone: 'calm', rank: 2 };
      const dd = days(t0, d);
      const when = dd === 0 ? 'today' : dd === 1 ? 'tomorrow' : dd <= 6 ? DOW[d.getDay()] + ' ' + d.getDate() : fmt(d).toLowerCase().replace(/^(\d+) (\w)/, (m, a, b) => a + ' ' + b.toUpperCase());
      return { text: n.def.verb ? n.def.verb + ' ' + when : n.name + ' ' + when, tone: 'calm', rank: 2 };
    }
    return { text: n.def.next, tone: 'calm', rank: 2 };
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
    logout: '<path d="M15 4h4v16h-4M10 16l4-4-4-4M14 12H4"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    truck: '<rect x="2" y="7" width="13" height="9"/><path d="M15 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    note: '<path d="M4 4h16v12H8l-4 4z"/><path d="M8 9h8M8 12h5"/>'
  };
  const icon = (name, size = 18) => '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true">' + I[name] + '</svg>';
  const SHIP = (w = 30) => '<svg class="art track-ship-svg" viewBox="0 0 64 30" width="' + w + '" height="' + (w / 2) + '" aria-hidden="true"><path d="M2 19 H62 L55 28 H9 Z" fill="#0B1B2B"/><rect x="7" y="8" width="9" height="11" fill="#0B1B2B"/><rect x="19" y="12" width="9" height="7" fill="#48BEBF"/><rect x="30" y="12" width="9" height="7" fill="#1C5179"/><rect x="41" y="12" width="9" height="7" fill="#A9DEDD"/></svg>';
  const PLANE = (s = 22) => '<svg class="art" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true"><path transform="rotate(90 12 12)" fill="#1C5179" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';

  // ============================================================== SIGN IN
  // Username + password. Nothing about the team is shown before sign-in; a
  // device only remembers the last username used on it.
  const LAST_USER = 'ethix.v2.lastUser';
  ['ethix.v2.team', 'ethix.v2.tab', 'ethix.v2.recent'].forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
  const ROLE_NAMES = { CS: 'CUSTOMER SERVICE', SALES: 'SALES', ADMIN: 'ADMIN', ACCOUNTS: 'ACCOUNTS' };
  const initials = (n) => { const p = String(n || '?').trim().split(/\s+/); return (p.length > 1 ? p[0][0] + p[p.length - 1][0] : String(n || '?').slice(0, 1)).toUpperCase(); };
  const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  function pwProblem(pw, user) {
    if (pw.length < 8) return 'Use at least 8 characters.';
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use letters and numbers.';
    if (user && pw.toUpperCase().includes(String(user).toUpperCase())) return 'Don’t use your name in the password.';
    return '';
  }

  function showKnown() {
    const last = store.get(LAST_USER, '');
    const known = !!last && !state.forgetKnown;
    $('#knownUser').hidden = !known;
    $('#userField').hidden = known;
    if (known) { $('#knownName').textContent = last; $('#knownDisc').textContent = initials(last); $('#loginUser').value = last; }
    $('#signinTitle').textContent = known ? 'Welcome back' : 'Sign in to your workspace';
  }
  function setLoginMsg(el, text, kind) { el.className = 'pin-msg' + (kind ? ' is-' + kind : ''); el.textContent = text || ''; }
  function loginBusy(on, label) {
    const b = $('#loginBtn'); b.disabled = on; b.textContent = on ? (label || 'SIGNING IN…') : 'SIGN IN';
    $('#signinCard').classList.toggle('is-busy', on);
  }
  function shakeCard() { const c = $('#signinCard'); c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); }

  async function submitLogin(e) {
    e.preventDefault();
    if (state.busy) return;
    const user = $('#loginUser').value.trim().toUpperCase().replace(/\s+/g, ' ');
    const pw = $('#loginPass').value;
    const msg = $('#loginMsg');
    if (!user) { setLoginMsg(msg, 'Enter your username.', 'error'); $('#loginUser').focus(); return; }
    if (!pw) { setLoginMsg(msg, 'Enter your password.', 'error'); $('#loginPass').focus(); return; }
    state.busy = true; loginBusy(true); setLoginMsg(msg, '');
    try {
      const res = await api.call('ethixSignIn', [user, pw, true], { timeout: 60000 });
      if (res && res.success && res.token) {
        api.token = res.token;
        state.pendingUser = user;
        if (res.mustChange) { showNewPassword(user); return; }
        store.set(LAST_USER, user);
        let boot = res.boot;
        if (!boot) boot = await api.call('ethixBootstrap');
        $('#signinCard').classList.add('leaving');
        setTimeout(() => enterApp(boot, user, res.role), 280);
        return;
      }
      $('#loginPass').value = '';
      shakeCard();
      if (res && res.locked) setLoginMsg(msg, res.message, 'locked');
      else setLoginMsg(msg, (res && res.message) || 'Wrong username or password.', 'error');
      $('#loginPass').focus();
    } catch (err) {
      setLoginMsg(msg, err.kind === 'auth' ? 'The server needs the Phase 3 Code.gs update before this sign-in works.' : err.message, 'error');
    } finally { state.busy = false; if (!$('#signinCard').classList.contains('leaving')) loginBusy(false); }
  }

  function showNewPassword(user) {
    $('#stepLogin').hidden = true;
    $('#stepNewPw').hidden = false;
    $('#npUser').value = user;
    $('#newPw').value = ''; $('#newPw2').value = '';
    setLoginMsg($('#newPwMsg'), '');
    drawRules();
    $('#newPw').focus();
  }
  function drawRules() {
    const pw = $('#newPw').value, user = $('#npUser').value;
    const ok = { len: pw.length >= 8, mix: /[A-Za-z]/.test(pw) && /[0-9]/.test(pw), name: !!pw && !pw.toUpperCase().includes(user.toUpperCase()) };
    $$('#pwRules [data-rule]').forEach((li) => li.classList.toggle('is-ok', !!ok[li.dataset.rule]));
  }
  async function submitNewPassword(e) {
    e.preventDefault();
    if (state.busy) return;
    const user = $('#npUser').value;
    const pw = $('#newPw').value, pw2 = $('#newPw2').value;
    const msg = $('#newPwMsg');
    const problem = pwProblem(pw, user);
    if (problem) { setLoginMsg(msg, problem, 'error'); return; }
    if (pw !== pw2) { setLoginMsg(msg, 'The two passwords don’t match.', 'error'); $('#newPw2').focus(); return; }
    state.busy = true;
    const btn = $('#newPwBtn'); btn.disabled = true; btn.textContent = 'SAVING…';
    try {
      const res = await api.call('ethixSetPassword', [pw], { timeout: 60000 });
      if (res && res.ok) {
        store.set(LAST_USER, user);
        $('#signinCard').classList.add('leaving');
        setTimeout(() => enterApp(res.boot, user), 280);
        return;
      }
      setLoginMsg(msg, (res && res.error) || 'The password was not saved.', 'error');
    } catch (err) { setLoginMsg(msg, err.message, 'error'); }
    finally { state.busy = false; btn.disabled = false; btn.textContent = 'SAVE AND CONTINUE'; }
  }

  function initSignin() {
    document.body.classList.add('is-signin');
    showKnown();
    $('#stepLogin').addEventListener('submit', submitLogin);
    $('#stepNewPw').addEventListener('submit', submitNewPassword);
    $('#knownUser').addEventListener('click', (e) => {
      if (e.target.closest('#notYou')) { state.forgetKnown = true; showKnown(); $('#loginUser').value = ''; $('#loginUser').focus(); return; }
      $('#loginPass').focus();
    });
    $('#forgotBtn').addEventListener('click', () => { $('#forgotNote').hidden = !$('#forgotNote').hidden; });
    $('#newPw').addEventListener('input', drawRules);
    $('#newPwCancel').addEventListener('click', () => { api.logout(); $('#stepNewPw').hidden = true; $('#stepLogin').hidden = false; $('#loginPass').value = ''; $('#loginPass').focus(); });
    document.addEventListener('click', (e) => {
      const eye = e.target.closest('[data-eye]'); if (!eye) return;
      const inp = document.getElementById(eye.dataset.eye); if (!inp) return;
      const show = inp.type === 'password'; inp.type = show ? 'text' : 'password';
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); eye.classList.toggle('is-on', show);
    });
    $('#loginUser').addEventListener('input', () => { if ($('#loginMsg').classList.contains('is-error')) setLoginMsg($('#loginMsg'), ''); });
    if (!api.connected) { const n = $('#cardNote'); n.hidden = false; n.textContent = 'Not connected yet: paste your Apps Script /exec link into config.js.'; }
    setTimeout(() => { if (!isTouch()) ($('#userField').hidden ? $('#loginPass') : $('#loginUser')).focus(); }, 60);
    startVoyage();
    const wide = window.matchMedia('(min-width: 1024px)');
    const onWide = () => { if (wide.matches) setTimeout(startVoyage, 50); else stopVoyage(); };
    if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);
    let fitTimer = 0;
    window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => { if (!state.signedIn) fitMap(); }, 120); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!state.signedIn) fitMap(); });   // the headline's size depends on its font
  }

  async function legacyBoot(name, role) {
    const [jobs, users] = await Promise.all([api.call('getSheetData'), api.call('getAllUsers')]);
    return { me: { user: name, role: String(role || '').toUpperCase() }, jobs, users, recent: [], serverTime: Date.now() };
  }

  // ------------------------------------------------------------ sign-in map
  // A ship works ETHIX's lanes on a faint map: loads, sails, discharges, moves on, loops.
  // The map is zoomed so the route always sits in the free space under the headline; pins,
  // labels and the ship keep the same size on screen at any zoom. Laptop/tablet only.
  const voyage = { raf: 0, running: false, leg: 0, phase: '', k: 1, redraw: null };
  function fitMap() {
    const hero = $('.signin-hero'), svg = $('#heroMap svg');
    if (!svg || !hero || !hero.offsetWidth) return;
    const hb = hero.getBoundingClientRect(), copy = $('.hero-copy').getBoundingClientRect(), foot = $('.hero-foot').getBoundingClientRect();
    const r = (svg.dataset.route || '58 589 622 847').split(' ').map(Number);
    const padL = parseFloat(getComputedStyle(hero).paddingLeft) || 40;
    // free space for the route, leaving room (in screen pixels) for the port names around it
    const bx0 = Math.max(44, padL * 0.75 + 30), bx1 = hb.width * 0.9 - 34, by0 = copy.bottom - hb.top + 48, by1 = foot.top - hb.top - 40;
    let s = Math.min((bx1 - bx0) / (r[2] - r[0]), (by1 - by0) / (r[3] - r[1]));
    s = Math.max(0.5, Math.min(1.55, s));
    const ox = bx0 + Math.max(0, (bx1 - bx0 - (r[2] - r[0]) * s) / 2);
    const oy = by0 + Math.max(0, (by1 - by0 - (r[3] - r[1]) * s) / 2);
    svg.setAttribute('viewBox', [r[0] - ox / s, r[1] - oy / s, hb.width / s, hb.height / s].map((v) => v.toFixed(1)).join(' '));
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    const k = 1 / s;
    voyage.k = k;
    $$('.hm-port', svg).forEach((g) => g.setAttribute('transform', 'translate(' + g.dataset.x + ' ' + g.dataset.y + ') scale(' + k.toFixed(3) + ')'));
    $$('.hm-done', svg).forEach((p) => { p.style.strokeWidth = (2.2 * k).toFixed(2); });
    if (voyage.redraw) voyage.redraw();
  }
  function startVoyage() {
    const map = $('#heroMap'); const hero = $('.signin-hero');
    if (!map || voyage.running || state.signedIn || !hero || getComputedStyle(hero).display === 'none') return;
    fitMap();
    const svg = $('svg', map);
    const legs = $$('.hm-done', svg).map((el) => ({ el, len: el.getTotalLength(), from: el.dataset.from, to: el.dataset.to, days: +el.dataset.days || 1 }));
    if (!legs.length || !legs[0].len) return;
    const ports = {};
    $$('.hm-port', svg).forEach((g) => { ports[g.dataset.port] = { el: g, name: g.dataset.name, x: +g.dataset.x, y: +g.dataset.y, lx: +g.dataset.lx, ly: +g.dataset.ly }; });
    const ship = $('.hm-ship', svg), wake = $('.hm-wake', ship), cargo = $$('.hm-cargo .k1, .hm-cargo .k2, .hm-cargo .k3', ship), boxes = $$('.hm-box', svg), dones = $('.hm-dones', svg);
    const setOffsets = () => legs.forEach((l) => { l.el.style.strokeDasharray = l.len + ' ' + l.len; l.el.style.strokeDashoffset = l.len; });
    setOffsets();
    const cap = { s: $('#hmState'), l: $('#hmLeg'), u: $('#hmSub') };
    let lastCap = '';
    const caption = (a, b, c) => { const key = a + '|' + b + '|' + c; if (key === lastCap) return; lastCap = key; cap.s.textContent = a; cap.l.textContent = b; cap.u.textContent = c; };
    const ease = (t) => 0.5 - Math.cos(Math.PI * Math.min(1, Math.max(0, t))) / 2;
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const smooth = (v) => { v = clamp01(v); return v * v * (3 - 2 * v); };
    const on = (code, cls, yes) => { if (ports[code]) ports[code].el.classList.toggle(cls, yes); };
    const DOCK = 9;                                               // ships berth just off the pin, on the water side
    const berth = (p) => [p.x - p.lx * DOCK * voyage.k, p.y - p.ly * DOCK * voyage.k];
    const place = (x, y, a) => ship.setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') rotate(' + (a * 180 / Math.PI).toFixed(1) + ') scale(' + (voyage.k * 0.9).toFixed(3) + ')');
    const p0 = legs[0].el.getPointAtLength(0), p1 = legs[0].el.getPointAtLength(5);
    let angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const parkHome = () => { const [hx, hy] = berth(ports.JEA); place(hx, hy, angle); };
    parkHome();
    on('JEA', 'is-on', true);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      caption('HOME PORT', 'JEBEL ALI', 'ETHIX LANES'); wake.style.opacity = 0;
      voyage.redraw = parkHome;
      return;
    }
    voyage.redraw = null;

    // containers between the berthed ship and a stack on the quay; u = 0..1 through the port call
    const PORT_T = 1.8;
    const moveBoxes = (p, u, toQuay) => {
      const k = voyage.k, px = -p.ly, py = p.lx;               // (px, py) runs along the quay
      const [sx, sy] = berth(p);
      boxes.forEach((b, i) => {
        const v = clamp01((u - i * 0.2) / 0.5);
        const qx = p.x + (p.lx * 15 + px * (i - 1) * 6.8) * k, qy = p.y + (p.ly * 15 + py * (i - 1) * 6.8) * k;
        const e = ease(v), f = toQuay ? e : 1 - e;
        const x = sx + (qx - sx) * f, y = sy + (qy - sy) * f - Math.sin(Math.PI * v) * 8 * k;
        b.setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') scale(' + k.toFixed(3) + ')');
        b.setAttribute('opacity', toQuay ? (v > 0 ? 1 : 0) : (v < 1 ? 1 : 0));
        cargo[i].style.opacity = toQuay ? (v > 0.05 ? 0.16 : 1) : (v >= 0.98 ? 1 : 0.16);
      });
    };
    let phase = 'load', leg = 0, t = 0, prev = 0, fresh = true;
    const legTime = (l) => 3.4 + l.len / 60;
    voyage.running = true;
    const tick = (now) => {
      if (!voyage.running) return;
      const dt = Math.min(0.05, prev ? (now - prev) / 1000 : 0); prev = now;
      t += dt;
      const L = legs[leg];
      if (phase === 'load') {
        const p = ports[L.from];
        on(L.from, 'is-on', true);
        moveBoxes(p, t / PORT_T, false);
        const [bx, by] = berth(p); place(bx, by, angle);
        caption('IN PORT', p.name, 'LOADING');
        wake.style.opacity = 0;
        if (t >= PORT_T) {
          if (fresh) { setOffsets(); dones.classList.remove('is-fading'); fresh = false; }
          on(L.from, 'is-on', false); on(L.to, 'is-next', true);
          phase = 'sail'; t = 0;
        }
      } else if (phase === 'sail') {
        const u = t / legTime(L);
        const d = ease(u) * L.len;
        const pt = L.el.getPointAtLength(d);
        const nx = L.el.getPointAtLength(Math.min(L.len, d + 3)), bk = L.el.getPointAtLength(Math.max(0, d - 3));
        const target = Math.atan2(nx.y - bk.y, nx.x - bk.x);
        let diff = target - angle; while (diff > Math.PI) diff -= 2 * Math.PI; while (diff < -Math.PI) diff += 2 * Math.PI;
        angle += diff * Math.min(1, dt * 7);
        const a0 = 1 - smooth(u / 0.14), a1 = smooth((u - 0.86) / 0.14);     // ease off / onto the berths
        const pf = ports[L.from], pd = ports[L.to], k = voyage.k;
        place(pt.x - (pf.lx * a0 + pd.lx * a1) * DOCK * k, pt.y - (pf.ly * a0 + pd.ly * a1) * DOCK * k, angle);
        L.el.style.strokeDashoffset = L.len - d;
        wake.style.opacity = (Math.sin(Math.PI * clamp01(u)) * 0.9).toFixed(2);
        caption('AT SEA', pf.name + ' → ' + pd.name, 'DAY ' + Math.min(L.days, Math.floor(clamp01(u) * L.days) + 1) + ' OF ' + L.days);
        if (u >= 1) { L.el.style.strokeDashoffset = 0; on(L.to, 'is-next', false); phase = 'discharge'; t = 0; }
      } else {
        const p = ports[L.to];
        on(L.to, 'is-on', true);
        moveBoxes(p, t / PORT_T, true);
        const [bx, by] = berth(p); place(bx, by, angle);
        caption('IN PORT', p.name, 'DISCHARGING');
        if (t >= PORT_T) {
          leg = (leg + 1) % legs.length;
          if (leg === 0) { dones.classList.add('is-fading'); fresh = true; }        // back home: a new loop
          phase = 'load'; t = 0;
        }
      }
      voyage.leg = leg; voyage.phase = phase;
      voyage.raf = requestAnimationFrame(tick);
    };
    voyage.raf = requestAnimationFrame(tick);
  }
  function stopVoyage() { voyage.running = false; cancelAnimationFrame(voyage.raf); }

  // ================================================================ APP
  // Roles: CS = Customer Service (works the jobs) · SALES = own jobs, read + notes · ADMIN = people only
  const isAdmin = () => state.role === 'ADMIN';
  const isSales = () => state.role === 'SALES';
  const canEdit = () => state.role === 'CS';
  const canNote = () => state.role === 'CS' || state.role === 'SALES';
  function normRole(r, user) {
    r = String(r || '').toUpperCase().trim();
    if (user === 'MASTER' || ['ADMIN', 'CO-ADMIN', 'MASTER'].includes(r)) return 'ADMIN';
    if (r === 'SALES' || r === 'ACCOUNTS') return r;
    return 'CS';
  }
  const FIELD_KEYS = RULES.map((r) => r[0]);

  // Server rows are kept as they came from the sheet; edits waiting to be
  // confirmed are laid on top, so the screen updates the moment you tap.
  function applyBoot(boot) {
    const rows = Array.isArray(boot.jobs) ? boot.jobs : [];
    state.header = rows[0] || [];
    state.ix = mapHeaders(state.header);
    state.rowMap = new Map();
    state.order = [];
    rows.slice(1).forEach((r) => {
      const no = String(r[state.ix.jobNo] || '').trim();
      if (!no) return;
      const k = no.toUpperCase();
      if (!state.rowMap.has(k)) state.order.push(k);
      state.rowMap.set(k, r);
    });
    state.users = Array.isArray(boot.users) ? boot.users : [];
    state.recent = Array.isArray(boot.recent) ? boot.recent : [];
    state.lastNotes = boot.lastNotes || {};
    if (boot.notif) state.notif = boot.notif;
    if (boot.admin) state.admin = boot.admin;
    if (Array.isArray(boot.activity)) state.activity = boot.activity;
    state.syncedAt = Date.now();
    rebuildJobs();
  }
  function toSheetDisplay(key, v) {
    const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m && ['opened', 'etd', 'siCut', 'eta', 'edCut', 'dgCut', 'delivery', 'lineFree', 'portFree'].includes(key)) return m[3] + '-' + m[2] + '-' + m[1];
    if (['customer', 'vendor', 'pod', 'pol', 'cs', 'sales', 'against'].includes(key)) return String(v || '').toUpperCase().trim();
    return String(v == null ? '' : v).trim();
  }
  function rowFor(k) {
    const base = state.rowMap.get(k);
    const p = state.pending.get(k);
    if (!p) return base;
    const r = base.slice();
    Object.keys(p).forEach((f) => { const c = state.ix[f]; if (c > -1) r[c] = toSheetDisplay(f, p[f]); });
    return r;
  }
  function rebuildJobs() {
    const t0 = today0();
    state.jobs = state.order.map((k) => buildJob(rowFor(k), state.ix, t0));
    state.jobIndex = new Map(state.jobs.map((j, i) => [j.jobNo.toUpperCase(), i]));
  }
  function rebuildJob(k) {
    const i = state.jobIndex.get(k);
    const j = buildJob(rowFor(k), state.ix, today0());
    if (i === undefined) { state.order.push(k); state.jobs.push(j); state.jobIndex.set(k, state.jobs.length - 1); }
    else state.jobs[i] = j;
    return j;
  }
  function findJob(no) { const i = state.jobIndex.get(String(no || '').toUpperCase()); return i === undefined ? null : state.jobs[i]; }

  function enterApp(boot, name, role) {
    state.user = (boot.me && boot.me.user) || name;
    state.role = normRole((boot.me && boot.me.role) || role, state.user);
    applyBoot(boot);
    const savedScope = store.get('ethix.v2.scope.' + state.user, null);
    const hasMine = state.jobs.some((j) => j.active && j.cs === state.user);
    state.scope = canEdit() ? savedScope || (hasMine ? 'mine' : 'all') : 'all';
    stopVoyage();
    document.body.classList.remove('is-signin');
    document.body.dataset.role = state.role.toLowerCase();
    $('#signin').hidden = true;
    const shell = $('#shell'); shell.hidden = false; shell.classList.add('entering');
    state.signedIn = true;
    renderChrome();
    render(true);
    startTimers();
    $('#view').focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- router
  function currentRoute() {
    const h = decodeURIComponent(location.hash || '');
    const m = h.match(/^#\/job\/(.+)$/);
    let r = m ? { name: 'job', jobNo: m[1].trim() } : h === '#/jobs' ? { name: 'jobs' } : h === '#/admin' ? { name: 'admin' } : h === '#/activity' ? { name: 'activity' } : { name: 'home' };
    if (isAdmin()) { if (r.name !== 'activity') r = { name: 'admin' }; }      // admin works with people, not jobs
    else if (r.name === 'admin' || r.name === 'activity') r = { name: 'home' };
    const want = r.name === 'admin' ? '#/admin' : r.name === 'activity' ? '#/activity' : r.name === 'home' && /^#\/(admin|activity)$/.test(h) ? '#/home' : null;
    if (want && h !== want) history.replaceState(null, '', want);
    return r;
  }
  function go(hash) { if (location.hash === hash) render(false); else location.hash = hash; }
  function openJob(no) { closeOverlays(); go('#/job/' + encodeURIComponent(no)); }
  function render(first) {
    if (!state.signedIn) return;
    const r = currentRoute();
    const prev = state.route;
    state.route = r;
    const view = $('#view');
    const changed = !prev || prev.name !== r.name || prev.jobNo !== r.jobNo;
    view.classList.toggle('is-fit', r.name === 'home' || r.name === 'jobs');
    document.body.classList.toggle('on-voyage', r.name === 'job' && canEdit());
    if (r.name === 'admin') renderAdmin(changed || first);
    else if (r.name === 'activity') renderActivity(changed || first);
    else if (r.name === 'jobs') renderJobs(changed || first);
    else if (r.name === 'job') renderVoyage(r.jobNo, changed || first);
    else renderHome(changed || first);
    if (changed) view.scrollTop = 0;
    updateNav();
  }
  // Re-draw the current page after data changed, without losing your place.
  function rerender() {
    if (!state.signedIn) return;
    const view = $('#view');
    const keep = { y: view.scrollTop, inner: $$('#view .tile-body, #view .jobs-scroll').map((e) => e.scrollTop), focus: document.activeElement && document.activeElement.id, sel: null };
    const f = document.activeElement;
    if (f && f.id && (f.tagName === 'INPUT' || f.tagName === 'TEXTAREA') && typeof f.selectionStart === 'number') keep.sel = [f.selectionStart, f.selectionEnd];
    render(false);
    view.scrollTop = keep.y;
    $$('#view .tile-body, #view .jobs-scroll').forEach((e, i) => { if (keep.inner[i]) e.scrollTop = keep.inner[i]; });
    if (state.overlay === 'pop') placePop();
    if (keep.focus) { const el = document.getElementById(keep.focus); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); if (keep.sel && el.setSelectionRange) try { el.setSelectionRange(keep.sel[0], keep.sel[1]); } catch (e) { /* ignore */ } } }
  }

  // ------------------------------------------------------------ chrome
  function navItems() {
    const active = state.jobs.filter((j) => j.active).length;
    if (isAdmin()) return [
      { id: 'admin', label: 'People', icon: 'users', href: '#/admin', count: state.admin ? state.admin.users.length : 0 },
      { id: 'activity', label: 'Activity', icon: 'clock', href: '#/activity' }
    ];
    const items = [
      { id: 'home', label: 'Home', icon: 'home', href: '#/home' },
      { id: 'jobs', label: isSales() ? 'My jobs' : 'Jobs', icon: 'jobs', href: '#/jobs', count: active },
      { id: 'notif', label: 'Notifications', icon: 'bell', act: 'notif' }
    ];
    if (isSales()) items.push({ id: 'enq', label: 'Enquiries', icon: 'enq', soon: true });
    else items.push(
      { id: 'enq', label: 'Enquiries', icon: 'enq', soon: true }, { id: 'round', label: 'Morning round', icon: 'check', soon: true },
      { id: 'fleet', label: 'Fleet', icon: 'fleet', soon: true }, { id: 'costing', label: 'Costing', icon: 'costing', soon: true },
      { id: 'analysis', label: 'Analysis', icon: 'analysis', soon: true });
    return items;
  }
  function renderChrome() {
    $('#navList').innerHTML = navItems().map((n) =>
      '<button type="button" class="nav-item" data-nav="' + n.id + '"' + (n.soon ? ' disabled title="Coming soon"' : n.act ? ' data-act="' + n.act + '"' : ' data-href="' + n.href + '"') + ' aria-label="' + esc(n.label) + '">' +
      '<span class="nav-ic">' + icon(n.icon) + (n.act === 'notif' ? '<span class="badge-dot" hidden></span>' : '') + '</span><span class="nav-label">' + esc(n.label) + '</span>' +
      (n.soon ? '<span class="soon">SOON</span>' : n.count ? '<span class="count">' + n.count + '</span>' : '') + '</button>'
    ).join('');
    $('#sideAvatar').textContent = initials(state.user);
    $('#sideName').textContent = state.user === 'MASTER' ? 'ADMIN' : state.user;
    $('#sideRole').textContent = ROLE_NAMES[state.role] || state.role;
    const tab = (nav, href, ic, label) => '<button type="button" class="tab" data-nav="' + nav + '" data-href="' + href + '">' + icon(ic, 22) + label + '</button>';
    const bell = '<button type="button" class="tab" data-act="notif" aria-label="Notifications"><span class="nav-ic">' + icon('bell', 22) + '<span class="badge-dot" hidden></span></span>Alerts</button>';
    const more = '<button type="button" class="tab" data-act="more">' + icon('more', 22) + 'More</button>';
    const plus = (act, label) => '<button type="button" class="tab-plus" data-act="' + act + '" aria-label="' + label + '">' + icon('plus', 22) + '</button>';
    $('#bottomBar').innerHTML = isAdmin() ? tab('admin', '#/admin', 'users', 'People') + tab('activity', '#/activity', 'clock', 'Activity') + plus('adm-add', 'Add user') + more
      : canEdit() ? tab('home', '#/home', 'home', 'Home') + tab('jobs', '#/jobs', 'jobs', 'Jobs') + plus('new-job', 'New job') + bell + more
      : tab('home', '#/home', 'home', 'Home') + tab('jobs', '#/jobs', 'jobs', isSales() ? 'My jobs' : 'Jobs') + bell + more;
    $('#bottomBar').classList.toggle('is-4', !canEdit());
    drawBadges();
  }
  function updateNav() {
    const r = state.route ? state.route.name : 'home';
    const cur = r === 'job' ? 'jobs' : r;
    $$('[data-nav]').forEach((b) => { if (b.dataset.nav === cur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    const c = $('#navList [data-nav="jobs"] .count'); if (c) c.textContent = state.jobs.filter((j) => j.active).length;
    const p = $('#navList [data-nav="admin"] .count'); if (p && state.admin) p.textContent = state.admin.users.length;
    drawBadges();
  }

  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
  function syncText() {
    const s = Math.round((Date.now() - state.syncedAt) / 1000);
    if (s < 60) return 'SYNCED JUST NOW';
    return 'SYNCED ' + Math.round(s / 60) + ' MIN AGO';
  }
  function scoped() { return canEdit() && state.scope === 'mine' ? state.jobs.filter((j) => j.cs === state.user) : state.jobs; }

  function track(j, w) {
    const pct = Math.round((j.pct || 0) * 1000) / 10;
    const left = j.pct >= 1 ? 'calc(100% - ' + w + 'px)' : j.pct <= 0 ? '0px' : 'calc(' + pct + '% - ' + (w / 2) + 'px)';
    const mover = j.mode === 'air' ? PLANE(20) : j.mode === 'courier' ? VAN(20) : SHIP(w);
    return '<div class="track" aria-hidden="true"><span class="track-ahead"></span><span class="track-done" style="width:' + pct + '%"></span><span class="track-a"></span><span class="track-b"></span><span class="track-ship" style="left:' + left + '">' + mover + '</span></div>';
  }

  // Lists show everything on laptops (the tile scrolls inside itself) and the
  // first 6 elsewhere, with a "See all" link that opens the full list.
  const LIST_MAX = 40;
  const seeAll = (id, n, dark) => n > 6 ? '<button type="button" class="tile-link see-all"' + (dark ? ' style="color:#7FD6D5"' : '') + ' data-list="' + id + '">See all ' + n + '</button>' : '';
  const empty = (iconName, text) => '<div class="tile-empty">' + icon(iconName, 22) + '<span>' + esc(text) + '</span></div>';

  function watchTile(m, anim) {
    const chip = (w) => w.level === 'urgent' ? 'chip chip-urgent' : w.level === 'soon' ? 'chip chip-soon-dark' : 'chip chip-calm-dark';
    return '<section class="tile tile-ink t-watch' + anim + '" style="--d:60ms" aria-labelledby="watchTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="watchTitle">TODAY’S WATCH</h2><span class="watch-sub">' +
      (m.deadlines ? m.deadlines + (m.deadlines === 1 ? ' deadline' : ' deadlines') + ' · next 48 h' : 'Nothing urgent · next 48 h') + '</span></div>' +
      '<div class="tile-body">' +
      (m.watch.length ? m.watch.slice(0, LIST_MAX).map((w) =>
        '<button type="button" class="watch-item li" data-job="' + esc(w.j.jobNo) + '">' +
        '<span class="watch-job">' + esc(w.j.jobNo) + '</span>' +
        '<span class="watch-text"><span class="watch-what">' + esc(w.what) + '</span><span class="watch-cust">' + esc(w.j.customer || '—') + ' · ' + esc(nice(w.j.route)) + '</span></span>' +
        '<span class="' + chip(w) + '">' + (w.level === 'urgent' ? icon('alert', 13) : '') + esc(w.when) + '</span></button>'
      ).join('') : empty('check', 'No cutoffs, sailings or free-time deadlines in the next 48 hours.')) +
      '</div>' + seeAll('watch', m.watch.length, true) + '</section>';
  }

  function kpiTiles(m, anim) {
    const k = (id, label, n, sub, urgent, d) =>
      '<button type="button" class="kpi' + (urgent ? ' is-urgent' : '') + anim + '" style="--d:' + d + 'ms" data-list="' + id + '">' +
      '<span class="kpi-label">' + label + '</span><span class="kpi-num">' + n + '</span><span class="kpi-sub">' + esc(sub) + '</span></button>';
    return '<div class="kpis">' +
      k('active', 'ACTIVE JOBS', m.active.length, m.atSea.length + ' at sea now', false, 100) +
      k('costing', 'COSTING DUE', m.costing.length, m.costingSailed + ' already sailed', false, 130) +
      k('sied', 'SI / ED DUE', m.sied.length, m.cut24 + (m.cut24 === 1 ? ' cutoff' : ' cutoffs') + ' in 24 h', false, 160) +
      k('free', 'FREE TIME', m.freeJobs.length, m.freeJobs.length ? 'ending in ≤ 2 days' : 'all clear', m.freeJobs.length > 0, 190) +
      '</div>';
  }

  function seaTile(m, anim) {
    return '<section class="tile t-sea' + anim + '" style="--d:220ms" aria-labelledby="seaTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="seaTitle">AT SEA NOW</h2><span class="tile-count">' + m.atSea.length + '</span></div>' +
      '<div class="tile-body">' +
      (m.atSea.length ? m.atSea.slice(0, LIST_MAX).map((j) =>
        '<button type="button" class="sea-item li" data-job="' + esc(j.jobNo) + '"><span class="sea-job">' + esc(j.jobNo) + '</span><span class="sea-route">' + esc(j.route) + '</span>' + track(j, 30) +
        '<span class="sea-day">DAY ' + j.dayN + '/' + j.dayT + '</span></button>'
      ).join('') : empty('anchor', 'Nothing at sea or in the air right now.')) +
      '</div>' + seeAll('atsea', m.atSea.length) + '</section>';
  }

  function holdTile(m, anim) {
    return '<section class="tile t-hold' + anim + '" style="--d:250ms" aria-labelledby="holdTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="holdTitle">ON HOLD</h2><span class="chip chip-hold">' + m.hold.length + '</span></div>' +
      '<div class="tile-body">' +
      (m.hold.length ? m.hold.slice(0, LIST_MAX).map((j) =>
        '<button type="button" class="list-item li" data-job="' + esc(j.jobNo) + '"><span class="li-main"><span class="li-job">' + esc(j.jobNo) + ' · ' + esc(j.type) + '</span><span class="li-sub">' + esc(j.customer || '—') + ' · ' + esc(nice(j.route)) + '</span>' +
        (j.remarks ? '<span class="li-sub li-note">“' + esc(j.remarks) + '”</span>' : '') + '</span></button>'
      ).join('') : empty('check', 'No jobs on hold.')) +
      '</div>' + seeAll('hold', m.hold.length) + '</section>';
  }

  function weekTile(m, anim) {
    const dep = state.week === 'dep';
    const list = dep ? m.departing : m.arriving;
    const field = dep ? 'etd' : 'eta';
    return '<section class="tile t-week' + anim + '" style="--d:280ms" aria-labelledby="weekTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="weekTitle">THIS WEEK</h2>' +
      '<div class="seg seg-mini" role="group" aria-label="Arriving or departing"><button type="button" data-week="arr" aria-pressed="' + !dep + '">Arriving ' + m.arriving.length + '</button><button type="button" data-week="dep" aria-pressed="' + dep + '">Departing ' + m.departing.length + '</button></div></div>' +
      '<div class="tile-body">' +
      (list.length ? list.slice(0, LIST_MAX).map((j) =>
        '<button type="button" class="list-item li" data-job="' + esc(j.jobNo) + '"><span class="date-chip' + (dep ? ' is-dark' : '') + '"><span class="dow">' + DOW_UP[j[field].getDay()] + '</span><span class="day">' + j[field].getDate() + '</span></span>' +
        '<span class="li-main"><span class="li-job">' + esc(j.jobNo) + '</span><span class="li-sub">' + esc(nice(j.route)) + (j.cargo ? ' · ' + esc(j.cargo) : '') + '</span></span></button>'
      ).join('') : empty('calendar', dep ? 'Nothing departing in the next 7 days.' : 'Nothing arriving in the next 7 days.')) +
      '</div>' + seeAll(dep ? 'departing' : 'arriving', list.length) + '</section>';
  }

  function activityTile(anim) {
    const rows = state.recent.slice(0, 10);
    return '<section class="tile t-act' + anim + '" style="--d:340ms" aria-labelledby="actTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="actTitle">RECENT ACTIVITY</h2></div>' +
      '<div class="tile-body">' +
      (rows.length ? rows.map((r) =>
        '<div class="act li"><span class="avatar">' + esc(initials(r[1])) + '</span><div class="act-text"><div><strong>' + esc(r[1]) + '</strong> ' + esc(friendly(r[2])) + '</div>' +
        '<div class="act-meta">' + esc([r[3], r[0]].filter(Boolean).join(' · ')) + '</div></div></div>'
      ).join('') : empty('clock', 'No recent activity yet.')) +
      '</div></section>';
  }

  function markOverflow() {
    $$('#view .tile-body, #people').forEach((b) => b.classList.toggle('has-more', b.scrollHeight - b.clientHeight - b.scrollTop > 4));
  }

  let lastMetrics = null;
  function renderHome(first) {
    const t0 = today0();
    const m = computeHome(scoped(), t0);
    lastMetrics = m;
    const anim = first ? ' reveal' : '';
    const searchVal = $('#searchInput') ? $('#searchInput').value : '';
    const view = $('#view');
    view.innerHTML =
      '<div class="wrap home">' +
      '<header class="page-head' + anim + '" style="--d:0ms">' +
        '<div class="head-main"><div class="meta-line"><span>' + (isSales() ? 'SALES · ' : '') + esc(fmtLong(t0)) + '</span><span class="sync" id="sync"><span class="sync-dot"></span><span id="syncText">' + syncText() + '</span></span></div>' +
        '<h1 class="greeting">' + greeting() + ', ' + esc(state.user === 'MASTER' ? 'Admin' : nice(state.user)) + '</h1></div>' +
        '<div class="head-actions">' +
          (canEdit() ? '<div class="seg" role="group" aria-label="Whose jobs"><button type="button" data-scope="mine" aria-pressed="' + (state.scope === 'mine') + '"><span class="l-full">My jobs</span><span class="l-short">Mine</span></button><button type="button" data-scope="all" aria-pressed="' + (state.scope === 'all') + '"><span class="l-full">Everyone</span><span class="l-short">All</span></button></div>' : '') +
          '<div class="search-wrap"><label class="search">' + icon('search') + '<input id="searchInput" type="search" placeholder="Job no, customer, port…" aria-label="Search jobs" autocomplete="off" value="' + esc(searchVal) + '"><kbd>/</kbd></label><div class="search-results glass" id="searchResults" hidden></div></div>' +
          '<button type="button" class="btn-ghost" id="refreshBtn" data-act="refresh" aria-label="Refresh"><span class="spin">' + icon('refresh', 16) + '</span><span class="btn-label">Refresh</span></button>' +
        '</div>' +
      '</header>' +
      '<div class="bento">' +
        watchTile(m, anim) + kpiTiles(m, anim) + seaTile(m, anim) + holdTile(m, anim) + weekTile(m, anim) + activityTile(anim) +
      '</div>' +
      '</div>';
    requestAnimationFrame(markOverflow);
  }

  // ================================================================ JOBS
  const CATS = [['all', 'All'], ['export', 'Export'], ['import', 'Import'], ['cross', 'Cross-trade'], ['air', 'Air'], ['courier', 'Courier'], ['cnd', 'Clearance'], ['misc', 'Misc']];
  const inCat = (j, c) => c === 'all' ? true
    : c === 'export' ? j.cat === 'EXPORT'
    : c === 'import' ? ['SFIF', 'SFIL', 'AFI'].includes(j.type)
    : c === 'cross' ? ['SFC', 'AFC'].includes(j.type)
    : c === 'air' ? j.mode === 'air'
    : c === 'courier' ? j.type === 'CRR'
    : c === 'cnd' ? j.type === 'CND'
    : c === 'misc' ? j.type === 'MIS' : true;
  const inStatus = (j, s) => s === 'all' ? true : s === 'active' ? j.active : s === 'hold' ? j.hold : s === 'completed' ? j.status === 'COMPLETED' : s === 'cancelled' ? j.status === 'CANCELLED' : true;
  const VAN = (s = 22) => '<svg class="art" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true"><path fill="#1C5179" d="M2 6h12v10H2zM14 10h4l4 3v3h-8z"/><circle cx="6" cy="18" r="2" fill="#0B1B2B"/><circle cx="17" cy="18" r="2" fill="#0B1B2B"/></svg>';

  function miniTrack(j, w) {
    const hold = j.hold;
    const pct = j.mode === 'misc' ? 0 : Math.round((j.pct || 0) * 1000) / 10;
    const mw = hold ? 24 : j.mode === 'air' ? 20 : j.mode === 'courier' ? 22 : w;
    const left = pct >= 100 ? 'calc(100% - ' + mw + 'px)' : pct <= 0 ? '0px' : 'calc(' + pct + '% - ' + (mw / 2) + 'px)';
    if (j.mode === 'misc') return '<div class="mini-track is-misc" aria-hidden="true"><span class="mini-misc">' + icon('costing', 14) + ' Costing only</span></div>';
    const mover = hold ? '<span class="mini-hold">' + icon('anchor', 13) + '</span>' : j.mode === 'air' ? PLANE(20) : j.mode === 'courier' ? VAN(20) : SHIP(w);
    return '<div class="mini-track' + (hold ? ' is-hold' : '') + '" aria-hidden="true"><span class="track-ahead"></span><span class="track-done" style="width:' + pct + '%"></span><span class="track-a"></span><span class="track-b"></span><span class="track-ship" style="left:' + left + '">' + mover + '</span></div>';
  }
  const toneChip = (n) => '<span class="chip ' + ({ urgent: 'chip-urgent', soon: 'chip-soon', calm: 'chip-calm', done: 'chip-done', hold: 'chip-hold' }[n.tone] || 'chip-calm') + '">' + (n.tone === 'urgent' ? icon('alert', 13) : '') + '<span class="chip-text" title="' + esc(n.text) + '">' + esc(n.text) + '</span></span>';

  function jobsFiltered() {
    const u = state.jobsUi;
    const q = u.q.trim().toUpperCase();
    let list = scoped().filter((j) => inCat(j, u.cat) && inStatus(j, u.status));
    if (q) list = list.filter((j) => (j.jobNo + ' ' + j.customer + ' ' + j.vendor + ' ' + j.pol + ' ' + j.pod + ' ' + j.cs + ' ' + j.sales + ' ' + j.type + ' ' + j.remarks + ' ' + j.against).toUpperCase().includes(q));
    const t = (d) => (d ? d.getTime() : 9e15);
    const sl = (j) => num(j.sl);
    if (u.sort === 'urgent') list.sort((a, b) => a.next.rank - b.next.rank || t(a.etd) - t(b.etd) || sl(b) - sl(a));
    else if (u.sort === 'newest') list.sort((a, b) => (b.opened ? b.opened.getTime() : 0) - (a.opened ? a.opened.getTime() : 0) || sl(b) - sl(a));
    else if (u.sort === 'etd') list.sort((a, b) => t(a.etd) - t(b.etd));
    else if (u.sort === 'eta') list.sort((a, b) => t(a.eta) - t(b.eta));
    return list;
  }

  function jobRow(j) {
    return '<li><button type="button" class="job-row" data-job="' + esc(j.jobNo) + '">' +
      '<span class="jr-job">' + esc(j.jobNo) + '</span>' +
      '<span class="jr-type"><span class="badge">' + esc(j.type || '—') + '</span><span class="jr-typename">' + esc(j.typeName) + '</span></span>' +
      '<span class="jr-cust"><span class="jr-name">' + esc(j.customer || '—') + '</span><span class="jr-route">' + esc(j.mode === 'misc' ? (j.against ? 'AGAINST ' + j.against : 'COSTING ONLY') : j.route) + '</span></span>' +
      '<span class="jr-track">' + miniTrack(j, 26) + '</span>' +
      '<span class="jr-next">' + toneChip(j.next) + '</span>' +
      '<span class="jr-etd"><span class="jr-k">ETD</span>' + esc(j.etd ? fmt(j.etd) : '—') + '</span>' +
      '<span class="jr-eta"><span class="jr-k">ETA</span>' + esc(j.eta ? fmt(j.eta) : '—') + '</span>' +
      '<span class="jr-people"><span class="jr-cs">' + esc(j.cs || '—') + '</span><span class="jr-sales">' + esc(j.sales || '') + '</span></span>' +
      '<span class="jr-dates">' + esc(j.mode === 'misc' ? (j.cs || '') : (j.etd ? fmt(j.etd) : '—') + ' → ' + (j.eta ? fmt(j.eta) : '—')) + '</span>' +
      '</button></li>';
  }

  function renderJobs(first) {
    const u = state.jobsUi;
    const all = scoped();
    const active = all.filter((j) => j.active);
    const list = jobsFiltered();
    const shown = list.slice(0, u.limit);
    const anim = first ? ' reveal' : '';
    const keepQ = $('#jobsSearch') ? $('#jobsSearch').value : u.q;
    $('#view').innerHTML =
      '<div class="wrap jobs-page">' +
      '<header class="page-head jobs-head' + anim + '">' +
        '<div class="head-main"><div class="meta-line"><span>' + active.length + ' ACTIVE · ' + active.filter((j) => j.hold).length + ' ON HOLD · ' + active.filter((j) => j.atSea).length + ' AT SEA</span></div><h1 class="greeting">' + (isSales() ? 'My jobs' : 'Jobs') + '</h1></div>' +
        '<div class="head-actions">' +
          '<label class="search">' + icon('search') + '<input id="jobsSearch" type="search" placeholder="Job no, customer, port…" aria-label="Search jobs" autocomplete="off" value="' + esc(keepQ) + '"></label>' +
          (canEdit() ? '<button type="button" class="btn-brutal btn-icon" data-act="new-job">' + icon('plus', 16) + '<span>NEW JOB</span></button>' : '') +
        '</div>' +
      '</header>' +
      '<div class="jobs-filters' + anim + '" style="--d:40ms">' +
        '<div class="chips-row" role="group" aria-label="Job category">' + CATS.map(([id, label]) => '<button type="button" class="fchip" data-cat="' + id + '" aria-pressed="' + (u.cat === id) + '">' + label + '</button>').join('') + '</div>' +
        '<div class="filter-tools">' +
          (canEdit() ? '<button type="button" class="toggle" data-act="mine" aria-pressed="' + (state.scope === 'mine') + '"><span class="toggle-track"><span class="toggle-thumb"></span></span>My jobs only</button>' : '') +
          '<label class="select-pill"><span>Show</span><select id="jobsStatus">' + [['active', 'Active'], ['hold', 'On hold'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([v, l]) => '<option value="' + v + '"' + (u.status === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
          '<label class="select-pill"><span>Sort</span><select id="jobsSort">' + [['urgent', 'Most urgent'], ['newest', 'Newest'], ['etd', 'ETD'], ['eta', 'ETA']].map(([v, l]) => '<option value="' + v + '"' + (u.sort === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
        '</div>' +
      '</div>' +
      '<section class="jobs-card' + anim + '" style="--d:80ms" aria-label="Job list">' +
        '<div class="jobs-scroll">' +
          '<div class="jobs-headrow" aria-hidden="true"><span>JOB NO</span><span>TYPE</span><span>CUSTOMER · ROUTE</span><span>VOYAGE</span><span>NEXT STEP</span><span>ETD</span><span>ETA</span><span>CS / SALES</span></div>' +
          (shown.length ? '<ul class="jobs-list">' + shown.map(jobRow).join('') + '</ul>' +
            (list.length > shown.length ? '<div class="jobs-more"><button type="button" class="btn-ghost" data-act="jobs-more">Show ' + Math.min(120, list.length - shown.length) + ' more · ' + list.length + ' in total</button></div>' : '<div class="jobs-end">' + list.length + (list.length === 1 ? ' job' : ' jobs') + '</div>')
            : '<div class="tile-empty jobs-empty">' + icon('search', 22) + '<span>No jobs match these filters.</span><button type="button" class="btn-ghost" data-act="jobs-clear">Clear filters</button></div>') +
        '</div>' +
      '</section>' +
      '</div>';
    if (keepQ && document.activeElement === document.body && state.jobsFocus) { const s = $('#jobsSearch'); s.focus(); s.setSelectionRange(keepQ.length, keepQ.length); }
  }

  function initJobs() {
    const view = $('#view');
    view.addEventListener('input', (e) => {
      if (e.target.id !== 'jobsSearch') return;
      state.jobsUi.q = e.target.value; state.jobsUi.limit = 120;
      clearTimeout(state.jobsTimer);
      state.jobsTimer = setTimeout(() => { state.jobsFocus = true; rerender(); state.jobsFocus = false; }, 140);
    });
    view.addEventListener('change', (e) => {
      if (e.target.id === 'jobsStatus') { state.jobsUi.status = e.target.value; state.jobsUi.limit = 120; rerender(); }
      if (e.target.id === 'jobsSort') { state.jobsUi.sort = e.target.value; rerender(); }
    });
    view.addEventListener('click', (e) => {
      const c = e.target.closest('[data-cat]');
      if (c) { state.jobsUi.cat = c.dataset.cat; state.jobsUi.limit = 120; rerender(); return; }
      if (e.target.closest('[data-act="mine"]') && canEdit()) { state.scope = state.scope === 'mine' ? 'all' : 'mine'; store.set('ethix.v2.scope.' + state.user, state.scope); rerender(); return; }
      if (e.target.closest('[data-act="jobs-more"]')) { state.jobsUi.limit += 120; rerender(); return; }
      if (e.target.closest('[data-act="jobs-clear"]')) { Object.assign(state.jobsUi, { cat: 'all', status: 'all', q: '', limit: 120 }); if (state.scope === 'mine') { state.scope = 'all'; store.set('ethix.v2.scope.' + state.user, 'all'); } rerender(); }
    });
  }

  // ================================================================ VOYAGE
  const SHIP_BIG = '<svg class="art" width="124" height="58" viewBox="0 0 124 58" aria-hidden="true"><rect x="15" y="4" width="7" height="10" fill="#48BEBF"/><rect x="10" y="14" width="18" height="24" fill="#0B1B2B"/><rect x="13" y="18" width="12" height="3" fill="#A9DEDD"/><rect x="13" y="24" width="12" height="3" fill="#A9DEDD"/><rect x="32" y="30" width="9" height="8" fill="#1C5179"/><rect x="42" y="30" width="9" height="8" fill="#48BEBF"/><rect x="52" y="30" width="9" height="8" fill="#A9DEDD"/><rect x="62" y="30" width="9" height="8" fill="#1C5179"/><rect x="72" y="30" width="9" height="8" fill="#44546A"/><rect x="82" y="30" width="9" height="8" fill="#48BEBF"/><rect x="92" y="30" width="9" height="8" fill="#1C5179"/><rect x="37" y="22" width="9" height="8" fill="#44546A"/><rect x="47" y="22" width="9" height="8" fill="#1C5179"/><rect x="57" y="22" width="9" height="8" fill="#48BEBF"/><rect x="67" y="22" width="9" height="8" fill="#A9DEDD"/><rect x="77" y="22" width="9" height="8" fill="#1C5179"/><rect x="87" y="22" width="9" height="8" fill="#44546A"/><rect x="47" y="14" width="9" height="8" fill="#A9DEDD"/><rect x="57" y="14" width="9" height="8" fill="#1C5179"/><rect x="67" y="14" width="9" height="8" fill="#48BEBF"/><rect x="77" y="14" width="9" height="8" fill="#1C5179"/><path d="M4 38 H120 L108 56 H16 Z" fill="#0B1B2B"/><rect x="10" y="45" width="104" height="3" fill="#48BEBF"/></svg>';
  const PLANE_BIG = '<svg class="art" viewBox="0 0 24 24" width="54" height="54" aria-hidden="true"><path transform="rotate(90 12 12)" fill="#1C5179" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';
  const VAN_BIG = '<svg class="art" viewBox="0 0 64 40" width="76" height="48" aria-hidden="true"><rect x="2" y="6" width="36" height="24" rx="3" fill="#1C5179"/><path d="M38 14h12l10 9v7H38z" fill="#0B1B2B"/><rect x="42" y="17" width="8" height="6" fill="#A9DEDD"/><rect x="6" y="11" width="12" height="3" fill="#48BEBF"/><circle cx="14" cy="32" r="5" fill="#0B1B2B"/><circle cx="14" cy="32" r="2" fill="#A9DEDD"/><circle cx="50" cy="32" r="5" fill="#0B1B2B"/><circle cx="50" cy="32" r="2" fill="#A9DEDD"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" class="tick"><path d="M5 12l5 5 9-10"/></svg>';
  const MODE_WORDS = { sea: ['AT SEA', 'days at sea', 'SAILS', 'BERTHED', 'VOYAGE'], air: ['IN THE AIR', 'days in the air', 'DEPARTS', 'LANDED', 'FLIGHT'], courier: ['IN TRANSIT', 'days in transit', 'PICK-UP', 'DELIVERED', 'TRIP'] };

  function statusWord(j) {
    if (j.status === 'COMPLETED') return ['COMPLETED', 'done'];
    if (j.status === 'CANCELLED') return ['CANCELLED', 'calm'];
    if (j.hold) return ['ON HOLD', 'hold'];
    if (j.arrived) return ['ARRIVED', 'done'];
    if (j.atSea) return [j.mode === 'air' ? 'IN THE AIR' : j.mode === 'courier' ? 'IN TRANSIT' : 'AT SEA', 'done'];
    return ['ONGOING', 'done'];
  }
  function stopDot(s) {
    return '<span class="stop-dot">' + (s.state === 'done' ? CHECK : s.state === 'late' ? '!' : s.state === 'current' ? '<i></i>' : s.state === 'skip' ? '–' : '') + '</span>';
  }
  function stopBtn(s, cls) {
    return '<button type="button" class="' + cls + ' is-' + s.state + (s.optional ? ' is-optional' : '') + '" data-stop="' + s.id + '" aria-label="' + esc(s.name + ': ' + s.sub) + '">' + stopDot(s) +
      '<span class="stop-text"><span class="stop-name">' + esc(s.name) + '</span><span class="stop-sub">' + esc(s.sub) + '</span></span></button>';
  }
  const stopList = (list, cls) => list.length ? '<ol class="stops">' + list.map((s) => '<li>' + stopBtn(s, cls) + '</li>').join('') + '</ol>' : '';

  function voyageText(j, t0) {
    const W = MODE_WORDS[j.mode] || MODE_WORDS.sea;
    const total = j.etd && j.eta ? Math.max(1, days(j.etd, j.eta)) : null;
    if (j.status === 'CANCELLED') return { kicker: 'CANCELLED', title: 'Not going ahead', sub: '—', bubble: 'CANCELLED' };
    if (j.hold) return { kicker: 'ON HOLD', title: 'Waiting', sub: j.remarks ? j.remarks.toUpperCase().slice(0, 48) : 'NEXT STEP TO BE CONFIRMED', bubble: '' };
    if (j.arrived) return { kicker: W[4] + ' COMPLETE', title: total ? total + ' of ' + total + ' days' : 'Arrived', sub: 'ARRIVED ' + fmt(j.eta, true), bubble: W[3] + ' ' + fmt(j.eta) };
    if (j.atSea) return { kicker: W[0], title: j.dayN + ' of ' + j.dayT + ' days', sub: days(t0, j.eta) + (days(t0, j.eta) === 1 ? ' DAY' : ' DAYS') + ' TO ARRIVAL', bubble: 'DAY ' + j.dayN + ' OF ' + j.dayT };
    const sub = j.cat === 'EXPORT' ? (j.mode === 'air' ? 'SI, ED AND AWB BEFORE ETD' : 'SI, ED AND BL BEFORE ETD') : j.etd ? W[2] + ' ' + fmt(j.etd, true) : 'DATES TO CONFIRM';
    return { kicker: 'NOT ' + (j.mode === 'air' ? 'DEPARTED' : j.mode === 'courier' ? 'PICKED UP' : 'SAILED') + ' YET', title: total ? total + '-day ' + W[4].toLowerCase() : 'Dates to confirm', sub, bubble: j.etd ? W[2] + ' ' + fmt(j.etd) : '' };
  }
  function portLine(j, which) {
    if (which === 'o') return j.etd ? (j.mode === 'courier' ? 'PICK-UP ' : 'ETD ') + fmt(j.etd, true) : 'ETD TO CONFIRM';
    return j.eta ? (j.arrived ? (j.mode === 'courier' ? 'DELIVERED ' : 'ARRIVED ') : (j.mode === 'courier' ? 'DELIVERY ' : 'ETA ')) + fmt(j.eta, true) : 'ETA TO CONFIRM';
  }

  // The big harbour picture used on laptops.
  function hero(j, jr, t0) {
    const vt = voyageText(j, t0);
    const w = jr.w;
    const p = j.hold || !j.etd ? 0 : j.arrived ? 1 : j.atSea ? j.pct : 0;
    const mode = j.mode === 'air' ? 'air' : j.mode === 'courier' ? 'road' : 'sea';
    const moverW = mode === 'air' ? 54 : mode === 'road' ? 76 : 124;
    const pos = p >= 1 ? 'calc(' + (w[0] + w[1]) + '% - ' + (moverW + 6) + 'px)' : p <= 0 ? 'calc(' + w[0] + '% + 6px)' : 'calc(' + w[0] + '% + ' + (w[1] * p).toFixed(2) + '% - ' + (moverW / 2) + 'px)';
    const centre = p >= 1 ? 'calc(' + (w[0] + w[1]) + '% - ' + (moverW / 2 + 6) + 'px)' : p <= 0 ? 'calc(' + w[0] + '% + ' + (moverW / 2 + 6) + 'px)' : 'calc(' + w[0] + '% + ' + (w[1] * p).toFixed(2) + '%)';
    const travelled = (w[1] * p).toFixed(2) + '%';
    const dg = j.dg === 'DG' && j.dgCut && j.cat === 'EXPORT' && !(j.etd && j.etd <= t0) ? '<div class="vh-dg">DG CUTOFF ' + fmt(j.dgCut) + '</div>' : '';
    return '<section class="vhero is-' + mode + (j.hold ? ' is-hold' : '') + (j.arrived ? ' is-arrived' : '') + (j.atSea ? ' is-moving' : '') + '" style="--o:' + w[0] + '%;--s:' + w[1] + '%;--d:' + w[2] + '%" aria-label="' + esc('Voyage for job ' + j.jobNo + ' from ' + (j.pol || 'origin') + ' to ' + (j.pod || 'destination') + ': ' + vt.kicker.toLowerCase()) + '">' +
      '<div class="vh-sky">' +
        '<div class="vh-port vh-pol"><div class="kicker">ORIGIN · POL</div><div class="vh-name">' + esc(j.pol || '—') + '</div><div class="vh-date">' + esc(portLine(j, 'o')) + '</div>' + dg + '</div>' +
        '<div class="vh-mid"><div class="kicker">' + esc(vt.kicker) + '</div><div class="vh-name">' + esc(vt.title) + '</div><div class="vh-date">' + esc(vt.sub) + '</div></div>' +
        '<div class="vh-port vh-pod"><div class="kicker">DESTINATION · POD</div><div class="vh-name">' + esc(j.pod || '—') + '</div><div class="vh-date">' + esc(portLine(j, 'd')) + '</div></div>' +
        '<span class="crane crane-o" aria-hidden="true"><i></i><b></b></span><span class="crane crane-d" aria-hidden="true"><i></i><b></b></span>' +
        (vt.bubble ? '<div class="vh-bubble" style="left:' + centre + '">' + esc(vt.bubble) + '</div>' : '') +
        '<div class="vh-mover is-' + mode + '" style="left:' + pos + '">' + (mode === 'air' ? PLANE_BIG : mode === 'road' ? VAN_BIG : SHIP_BIG) + '</div>' +
        (j.hold ? '<div class="vh-anchor" style="left:calc(' + w[0] + '% + ' + (moverW / 2) + 'px)">' + icon('anchor', 16) + '</div>' : '') +
      '</div>' +
      '<div class="vh-line" aria-hidden="true"><span class="vh-done" style="width:' + travelled + '"></span><span class="vh-ahead"></span></div>' +
      '<div class="vh-ground">' +
        '<div class="vh-quay vh-o">' + stopList(jr.origin, 'stop on-dark') + '</div>' +
        '<div class="vh-sea"><div class="vh-kicker">' + (jr.transit.length ? 'DURING THE ' + (mode === 'air' ? 'FLIGHT' : mode === 'road' ? 'TRIP' : 'VOYAGE') : '') + '</div>' + (jr.transit.length ? '<div class="vchips">' + jr.transit.map((s) => stopBtn(s, 'vchip')).join('') + '</div>' : '') + '</div>' +
        '<div class="vh-quay vh-d">' + stopList(jr.dest, 'stop' + (j.arrived ? ' on-dark' : '')) + '</div>' +
      '</div>' +
    '</section>';
  }

  // The same voyage, top to bottom, for phones and narrow windows.
  function vcard(j, jr, t0) {
    const vt = voyageText(j, t0);
    const mode = j.mode === 'air' ? 'air' : j.mode === 'courier' ? 'road' : 'sea';
    const rail = (list) => list.length ? '<ol class="vc-stops">' + list.map((s, i) => '<li class="' + (i === list.length - 1 ? 'is-last' : '') + '">' + stopBtn(s, 'vc-stop') + '</li>').join('') + '</ol>' : '';
    return '<section class="vcard is-' + mode + (j.arrived ? ' is-arrived' : '') + (j.hold ? ' is-hold' : '') + '" aria-label="Voyage">' +
      '<div class="vc-port"><div class="kicker">ORIGIN · POL</div><div class="vc-row"><span class="vc-name">' + esc(j.pol || '—') + '</span><span class="vc-date">' + esc(portLine(j, 'o')) + '</span></div></div>' +
      rail(jr.origin) +
      '<div class="vc-sea" aria-hidden="false">' +
        '<div class="vc-progress" style="height:' + Math.round((j.hold ? 0 : j.arrived ? 1 : j.atSea ? j.pct : 0) * 100) + '%"></div>' +
        '<div class="vc-label"><span class="kicker">' + esc(vt.kicker) + '</span><span class="vc-title">' + esc(vt.title) + '</span><span class="vc-sub">' + esc(vt.sub) + '</span></div>' +
        (jr.transit.length ? '<div class="vchips">' + jr.transit.map((s) => stopBtn(s, 'vchip')).join('') + '</div>' : '') +
        '<div class="vc-mover is-' + mode + '">' + (mode === 'air' ? PLANE_BIG : mode === 'road' ? VAN_BIG : SHIP_BIG) + '</div>' +
      '</div>' +
      '<div class="vc-port is-dest"><div class="kicker">DESTINATION · POD</div><div class="vc-row"><span class="vc-name">' + esc(j.pod || '—') + '</span><span class="vc-date">' + esc(portLine(j, 'd')) + '</span></div></div>' +
      rail(jr.dest) +
    '</section>';
  }

  function misCard(j, jr) {
    return '<section class="miscard" aria-label="Costing job">' +
      '<div class="mis-head"><span class="mis-icon">' + icon('costing', 22) + '</span><div><div class="kicker">MISCELLANEOUS · COSTING ONLY</div><div class="mis-title">' + (j.against ? 'Against job <button type="button" class="link-btn" data-job="' + esc(j.against) + '">' + esc(j.against) + '</button>' : 'Not linked to a job yet') + '</div></div></div>' +
      '<ol class="mis-stops">' + jr.all.map((s) => '<li>' + stopBtn(s, 'vc-stop') + '</li>').join('') + '</ol>' +
    '</section>';
  }

  function freeCard(j, t0) {
    if (j.cat !== 'IMPORT' || j.mode === 'air' && !j.lineFreeRaw) return '';
    const lineDays = /^\d+$/.test(j.lineFreeRaw) ? +j.lineFreeRaw : j.eta && j.lineFreeEnd ? days(j.eta, j.lineFreeEnd) : null;
    const portDays = /^\d+$/.test(j.portFreeRaw) ? +j.portFreeRaw : j.eta && j.portFreeEnd ? days(j.eta, j.portFreeEnd) : null;
    if (lineDays === null && portDays === null) return '';
    if (j.delivery || j.status === 'COMPLETED') return '';
    const bars = (total, used, cls) => total ? '<div class="ft-bars ' + cls + '" style="--n:' + Math.min(total, 30) + '">' + Array.from({ length: Math.min(total, 30) }, (_, i) => '<i class="' + (i < used ? 'used' : '') + '"></i>').join('') + '</div>' : '';
    if (!j.arrived || !j.eta) {
      return '<section class="ftcard is-calm"><h2 class="tile-title">FREE TIME</h2><div class="ft-big">' + (lineDays !== null ? lineDays + ' days' : '—') + '</div><div class="ft-note">Line free time starts at arrival' + (j.eta ? ' (ETA ' + fmt(j.eta) + ')' : '') + (portDays !== null ? '. Port: ' + portDays + ' days.' : '.') + '</div></section>';
    }
    const left = j.lineFreeEnd ? days(t0, j.lineFreeEnd) : null;
    const urgent = left !== null && left <= 2;
    const used = lineDays !== null ? Math.max(0, Math.min(lineDays, days(j.eta, t0))) : 0;
    const pLeft = j.portFreeEnd ? days(t0, j.portFreeEnd) : null;
    const pUsed = portDays !== null ? Math.max(0, Math.min(portDays, days(j.eta, t0))) : 0;
    return '<section class="ftcard ' + (urgent ? 'is-urgent' : 'is-calm') + '" aria-labelledby="ftTitle">' +
      '<div class="ft-head"><h2 class="tile-title" id="ftTitle">' + (urgent ? icon('alert', 14) : '') + 'LINE FREE TIME</h2><span class="ft-from">' + (lineDays !== null ? lineDays + ' DAYS FROM ARRIVAL' : '') + '</span></div>' +
      (left === null ? '<div class="ft-big">—</div>' : '<div class="ft-big">' + (left < 0 ? 'Over by ' + (-left) + (left === -1 ? ' day' : ' days') : left === 0 ? 'Ends today' : left + (left === 1 ? ' day' : ' days') + ' <small>left</small>') + '</div>') +
      bars(lineDays, used, 'is-line') +
      (j.lineFreeEnd ? '<div class="ft-note">' + (left < 0 ? 'Ended ' : 'Ends ') + '<strong>' + DOW[j.lineFreeEnd.getDay()] + ' ' + fmt(j.lineFreeEnd) + '</strong>. ' + (left < 0 ? 'Demurrage is running.' : 'Demurrage starts after that.') + '</div>' : '') +
      (portDays !== null ? '<div class="ft-port"><div class="ft-k">PORT FREE TIME</div><div class="ft-v">' + (pLeft === null ? portDays + ' days' : pLeft < 0 ? 'Over by ' + (-pLeft) + ' days' : pLeft + (pLeft === 1 ? ' day' : ' days') + ' left · ends ' + DOW[j.portFreeEnd.getDay()] + ' ' + fmt(j.portFreeEnd)) + '</div>' + bars(portDays, pUsed, 'is-port') + '</div>' : '') +
    '</section>';
  }

  function keyDates(j, t0) {
    const cut = (d, field) => {
      if (!d) return '—';
      const met = j[field] && ['SUBMITTED', 'APPROVED', 'PASSED/PAID', 'PASSED'].includes(j[field]);
      if (met) return fmt(d) + ' · MET';
      const dd = days(t0, d);
      return fmt(d) + (dd < 0 ? ' · PASSED' : dd === 0 ? ' · TODAY' : dd === 1 ? ' · TOMORROW' : '');
    };
    const rows = [['Job opened', fmt(j.opened, true)]];
    if (['EXPORT', 'CROSS'].includes(j.cat) && j.type !== 'CRR') rows.push(['SI cutoff', cut(j.siCut, 'sido')]);
    if (j.cat === 'EXPORT') rows.push(['ED cutoff', cut(j.edCut, 'ed')]);
    if (j.dg === 'DG' && j.cat === 'EXPORT') rows.push(['DG cutoff', j.dgCut ? fmt(j.dgCut, true) : '—']);
    if (j.mode !== 'misc') {
      rows.push([(j.mode === 'courier' ? 'Pick-up' : 'ETD') + (j.pol ? ' ' + nice(j.pol) : ''), fmt(j.etd, true)]);
      rows.push([(j.mode === 'courier' ? 'Delivery' : 'ETA') + (j.pod ? ' ' + nice(j.pod) : ''), fmt(j.eta, true)]);
    }
    if (j.cat === 'IMPORT') {
      rows.push(['Delivered', j.raw.delivery === NA ? 'NOT NEEDED' : fmt(j.delivery, true)]);
      if (j.lineFreeRaw) rows.push(['Line free time', /^\d+$/.test(j.lineFreeRaw) ? j.lineFreeRaw + ' DAYS' : j.lineFreeRaw]);
      if (j.portFreeRaw) rows.push(['Port free time', /^\d+$/.test(j.portFreeRaw) ? j.portFreeRaw + ' DAYS' : j.portFreeRaw]);
      if (j.type !== 'AFI') rows.push(['Original docs', j.docs || '—']);
    }
    return '<section class="tile side-card" aria-labelledby="datesTitle"><div class="tile-head"><h2 class="tile-title" id="datesTitle">KEY DATES</h2></div>' +
      rows.map((r) => '<div class="kv"><span class="kv-k">' + esc(r[0]) + '</span><span class="kv-v">' + esc(r[1]) + '</span></div>').join('') + '</section>';
  }
  function cargoCard(j) {
    const big = j.cargo || (j.mode === 'air' ? 'AIR' : j.mode === 'courier' ? 'COURIER' : j.mode === 'misc' ? 'COSTING' : '—');
    return '<section class="cargo-card" aria-labelledby="cargoTitle"><h2 class="tile-title" id="cargoTitle">CARGO</h2>' +
      '<div class="cargo-big"><span>' + esc(big) + '</span><span class="cargo-dg' + (j.dg === 'DG' ? ' is-dg' : '') + '">' + esc(j.dg || '') + '</span></div>' +
      (j.vendor ? '<div class="cargo-row"><span>' + (j.mode === 'air' ? 'Airline' : j.mode === 'courier' ? 'Courier' : 'Line / vendor') + '</span><span>' + esc(j.vendor) + '</span></div>' : '') +
      (j.freight ? '<div class="cargo-row"><span>Line freight</span><span>USD ' + esc(j.freight) + '</span></div>' : '') + '</section>';
  }
  function peopleCard(j) {
    const person = (n, role, bg) => '<div class="person-row"><span class="avatar" style="' + bg + '">' + esc(initials(n || '?')) + '</span><div><div class="pr-name">' + esc(n || '—') + (n && n === state.user ? ' <span class="you">YOU</span>' : '') + '</div><div class="pr-role">' + role + '</div></div></div>';
    return '<section class="tile side-card" aria-labelledby="peopleTitle"><div class="tile-head"><h2 class="tile-title" id="peopleTitle">PEOPLE</h2></div>' +
      person(j.cs, 'Customer Service · owns this job', '') +
      (j.sales ? person(j.sales, 'Sales · follows this job', 'background:var(--teal-tint);color:var(--teal-text)') : '') + '</section>';
  }

  // ---------- the story so far (notes + every change) ----------
  function parseStamp(s) {
    const m = String(s || '').match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4}),?\s+(\d{1,2}):(\d{2})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
    const d = parseDate(s); return d;
  }
  const stampText = (d) => d ? fmt(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : '';
  function friendly(action) {
    const a = String(action || '');
    let m = a.match(/^SET (.+?) TO (.+)$/);
    if (m) return 'set ' + m[1].toLowerCase().replace(/\bsi\b/g, 'SI').replace(/\bdo\b/g, 'DO').replace(/\bed\b/g, 'ED').replace(/\bbl\b/g, 'BL').replace(/\bawb\b/g, 'AWB').replace(/\betd\b/g, 'ETD').replace(/\beta\b/g, 'ETA').replace(/\bpol\b/g, 'POL').replace(/\bpod\b/g, 'POD').replace(/\bdg\b/g, 'DG').replace(/\bcs\b/g, 'CS') + ' to ' + m[2];
    if (a === 'CREATED NEW JOB') return 'opened the job';
    if (a === 'UPDATED JOB DETAILS') return 'updated the job details';
    m = a.match(/^UPDATED (.+)$/);
    if (m) return 'updated ' + m[1].toLowerCase();
    return a.toLowerCase();
  }
  // Newest on top, always. The server sends an exact time (t) and order (seq) for
  // every note and change, so old rows written in other date formats sort right too.
  function storyItems(no) {
    const st = state.stories.get(String(no).toUpperCase());
    if (!st || !st.data) return null;
    const items = [];
    const ms = (s) => { const d = parseStamp(s); return d ? d.getTime() : 0; };
    (st.data.notes || []).forEach((n, i) => items.push({ t: n.t || ms(n.at), seq: n.seq != null ? n.seq : i, k: 1, who: n.by, note: n.txt }));
    (st.data.events || []).forEach((e, i) => items.push({ t: e[4] || ms(e[0]), seq: e[5] != null ? e[5] : -i, k: 0, who: e[1], what: friendly(e[2]) }));
    items.sort((a, b) => b.t - a.t || b.k - a.k || b.seq - a.seq);
    items.forEach((x) => { x.at = x.t ? new Date(x.t) : null; });
    return items;
  }
  function storyList(no, limit) {
    const items = storyItems(no);
    if (!items) return '<div class="story-loading"><span class="sk"></span><span class="sk"></span><span class="sk short"></span></div>';
    if (!items.length) return '<div class="tile-empty">' + icon('clock', 22) + '<span>' + (canNote() ? 'No notes or changes yet. Add the first note above.' : 'No notes or changes yet.') + '</span></div>';
    const list = limit ? items.slice(0, limit) : items;
    return '<ol class="story">' + list.map((e) => '<li><div class="st-when">' + esc(stampText(e.at)) + '</div><span class="avatar' + (e.who === state.user ? '' : ' is-other') + '">' + esc(initials(e.who || '?')) + '</span><div class="st-body"><div><strong>' + esc(e.who || '—') + '</strong> ' + (e.note !== undefined ? 'added a note' : esc(e.what)) + '</div>' + (e.note !== undefined ? '<div class="st-note">' + esc(e.note) + '</div>' : '') + '</div></li>').join('') + '</ol>' +
      (limit && items.length > limit ? '<button type="button" class="tile-link" data-tab="story">See all ' + items.length + '</button>' : '');
  }
  function noteBox() {
    if (!canNote()) return '';
    return '<form class="note-box" data-act="note"><input type="text" id="noteInput" maxlength="1000" placeholder="' + (isSales() ? 'Add a note for Customer Service…' : 'Add a note for the team…') + '" aria-label="Add a note" autocomplete="off"><button type="submit" class="note-post">Post</button></form>';
  }
  function loadStory(no, force) {
    const k = String(no).toUpperCase();
    const st = state.stories.get(k);
    if (st && (st.loading || (!force && Date.now() - st.at < 60000))) return;
    state.stories.set(k, Object.assign({ data: null, at: 0 }, st || {}, { loading: true }));
    api.call('ethixJobStory', [no]).then((data) => {
      state.stories.set(k, { data, at: Date.now(), loading: false });
      if (state.route && state.route.name === 'job' && state.route.jobNo.toUpperCase() === k) rerender();
    }).catch((e) => {
      state.stories.set(k, { data: (st && st.data) || { notes: [], events: [] }, at: Date.now(), loading: false });
      if (e.kind !== 'auth' && !/not available/i.test(e.message)) toast('Could not load the notes: ' + e.message, { error: true });
      if (state.route && state.route.name === 'job') rerender();
    });
  }

  function allDetails(j) {
    const groups = [
      ['JOB', [['Job no.', j.jobNo], ['Type', j.type + ' · ' + j.typeName], ['Status', j.status || '—'], ['SL.', j.sl || '—'], ['Customer', j.customer], ['Line / vendor', j.vendor], ['Customer Service', j.cs], ['Sales', j.sales], ['Job opened', fmt(j.opened, true)]]],
      ['ROUTE & DATES', [['POL', j.pol], ['POD', j.pod], ['ETD', fmt(j.etd, true)], ['ETA', fmt(j.eta, true)], ['SI cutoff', fmt(j.siCut, true)], ['ED cutoff', fmt(j.edCut, true)], ['DG cutoff', fmt(j.dgCut, true)], ['Delivery date', j.raw.delivery || '—'], ['Line free time', j.lineFreeRaw || '—'], ['Port free time', j.portFreeRaw || '—']]],
      ['CARGO', [['20′', j.c20 || '—'], ['40′', j.c40 || '—'], ['DG / non-DG', j.dg || '—'], ['Line freight USD', j.freight || '—'], ['Against job no.', j.against || '—']]],
      ['DOCUMENTS', [[j.cat === 'IMPORT' ? 'DO status' : 'SI status', j.sido || '—'], [j.cat === 'IMPORT' ? 'Customs (ED)' : 'ED status', j.ed || '—'], [j.mode === 'air' ? 'AWB status' : 'BL status', j.bl || '—'], [j.cat === 'IMPORT' ? 'Discharge list' : 'Loadlist', j.loadlist || '—'], ['Original docs', j.docs || '—'], ['Costing', j.costing || '—']]]
    ];
    return '<div class="details-grid">' + groups.map((g) => '<section class="tile"><div class="tile-head"><h2 class="tile-title">' + g[0] + '</h2></div>' +
      g[1].map((r) => '<div class="kv"><span class="kv-k">' + esc(r[0]) + '</span><span class="kv-v">' + esc(r[1] || '—') + '</span></div>').join('') + '</section>').join('') +
      '<section class="tile details-remarks"><div class="tile-head"><h2 class="tile-title">REMARKS</h2>' + (canEdit() ? '<button type="button" class="tile-link" data-act="edit">Edit details</button>' : '') + '</div><p>' + esc(j.remarks || 'No remarks.') + '</p></section></div>';
  }

  function renderVoyage(no, first) {
    const j = findJob(no);
    const view = $('#view');
    if (!j) {
      view.innerHTML = '<div class="wrap voyage-page"><div class="crumbs"><button type="button" class="link-btn" data-href="#/jobs">' + icon('jobs', 14) + 'JOBS</button></div>' +
        '<section class="tile notfound">' + empty('search', 'Job ' + no + ' is not in the tracker. It may have been renamed or removed.') + '<button type="button" class="btn-ghost" data-href="#/jobs">Back to jobs</button></section></div>';
      return;
    }
    const t0 = today0();
    const jr = j.journey;
    loadStory(j.jobNo);
    const tab = state.voyageTab[j.jobNo] || 'overview';
    const [sw, tone] = statusWord(j);
    const anim = first ? ' reveal' : '';
    const n = jr.next;
    const storyCount = (storyItems(j.jobNo) || []).length;
    const nextBar = n && canEdit() ? '<div class="nextbar glass" role="region" aria-label="Next stop"><div class="nb-text"><div class="kicker">NEXT STOP</div><div class="nb-name">' + esc(n.name) + ' <span class="nb-sub">' + esc(n.sub) + '</span></div></div>' +
      '<button type="button" class="btn-brutal" data-stop="' + n.id + '" data-quick="1">' + (n.kind === 'field' ? 'MARK DONE' : n.kind === 'date' ? 'SET DATE' : n.kind === 'status' ? 'CLOSE JOB' : 'UPDATE') + '</button></div>' : '';
    view.innerHTML =
      '<div class="wrap voyage-page' + (jr.next && canEdit() ? ' has-nextbar' : '') + '">' +
      '<div class="crumbs' + anim + '"><button type="button" class="back-btn" data-act="back" aria-label="Back">' + icon('back', 18) + '</button><button type="button" class="link-btn" data-href="#/jobs">JOBS</button><span>/ ' + esc(j.jobNo) + '</span>' +
        (canEdit() ? '<button type="button" class="status-pill tone-' + tone + '" data-act="status" aria-label="Job status: ' + sw + '. Change">' + esc(sw) + icon('chevron', 14) + '</button>' : '<span class="status-pill tone-' + tone + '">' + esc(sw) + '</span>') + '</div>' +
      '<header class="vhead' + anim + '" style="--d:30ms">' +
        '<div class="vh-titles"><div class="vh-idrow"><h1 class="vh-job">' + esc(j.jobNo) + '</h1><span class="badge badge-lg">' + esc(j.type + ' · ' + j.typeName.toUpperCase()) + '</span>' + (j.cargo ? '<span class="vh-cargo">' + esc(j.cargo) + '</span>' : '') + '</div>' +
        '<div class="vh-cust">' + esc(j.customer || '—') + '</div></div>' +
        (canEdit() ? '<div class="vh-actions"><button type="button" class="btn-ghost" data-act="edit">' + icon('edit', 16) + '<span>Edit details</span></button><button type="button" class="btn-brutal" data-act="quick">UPDATE</button></div>'
          : '<div class="vh-actions is-ro"><span class="ro-chip">' + icon('lock', 14) + '<span>UPDATED BY ' + esc(j.cs || 'CUSTOMER SERVICE') + '</span></span>' + (canNote() ? '<button type="button" class="btn-brutal btn-icon" data-act="focus-note">' + icon('note', 16) + '<span>ADD A NOTE</span></button>' : '') + '</div>') +
      '</header>' +
      '<div class="ft-top">' + freeCard(j, t0) + '</div>' +
      '<div class="voyage-wrap' + anim + '" style="--d:60ms">' + (j.mode === 'misc' ? misCard(j, jr) : hero(j, jr, t0) + vcard(j, jr, t0)) + '</div>' +
      '<div class="vtabs" role="tablist" aria-label="Job sections">' +
        [['overview', 'Overview'], ['details', 'All details'], ['story', 'Notes & history' + (storyCount ? ' · ' + storyCount : '')]].map(([id, l]) => '<button type="button" role="tab" data-tab="' + id + '" aria-selected="' + (tab === id) + '">' + esc(l) + '</button>').join('') +
      '</div>' +
      (tab === 'details' ? allDetails(j)
        : tab === 'story' ? '<section class="tile story-card">' + noteBox() + storyList(j.jobNo) + '</section>'
        : '<div class="voverview">' +
            '<section class="tile story-card" aria-labelledby="storyTitle"><div class="tile-head"><h2 class="tile-title" id="storyTitle">THE STORY SO FAR</h2>' + (isSales() ? (j.cs ? '<span class="small">Shared with ' + esc(j.cs) + ' (Customer Service)</span>' : '') : j.sales ? '<span class="small">Shared with ' + esc(j.sales) + ' (sales)</span>' : '') + '</div>' + noteBox() + storyList(j.jobNo, 6) + '</section>' +
            '<div class="vside"><div class="ft-side">' + freeCard(j, t0) + '</div>' + keyDates(j, t0) + cargoCard(j) + peopleCard(j) + '</div>' +
          '</div>') +
      '</div>' + nextBar;
  }

  // ================================================================ SAVING
  // Your change shows at once; the save goes to Google in the background.
  // If someone else changed the same field first, nothing is overwritten.
  const DATE_KEYS = ['opened', 'etd', 'siCut', 'eta', 'edCut', 'dgCut', 'delivery'];
  const iso = (d) => d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : '';
  function asInput(key, raw) {
    raw = String(raw == null ? '' : raw).trim();
    if (DATE_KEYS.includes(key)) { if (!raw || raw.toUpperCase() === NA) return raw; const d = parseDate(raw); return d ? iso(d) : raw; }
    if (key === 'lineFree' || key === 'portFree') { if (/^\d+$/.test(raw) || !raw) return raw; const d = parseDate(raw); return d ? iso(d) : raw; }
    return raw;
  }
  function setSaving(delta) {
    state.savingCount = Math.max(0, state.savingCount + delta);
    const pill = $('#savePill'); if (pill) pill.hidden = state.savingCount === 0;
  }
  function clearPending(k, changes) {
    const p = state.pending.get(k); if (!p) return;
    Object.keys(changes).forEach((f) => { if (p[f] === changes[f]) delete p[f]; });
    if (!Object.keys(p).length) state.pending.delete(k);
  }
  function saveJob(no, changes, opts = {}) {
    const k = String(no).toUpperCase();
    const before = findJob(no);
    if (!before || !Object.keys(changes).length) return Promise.resolve(false);
    const prev = {};
    Object.keys(changes).forEach((f) => { prev[f] = asInput(f, before.raw[f]); });
    state.pending.set(k, Object.assign({}, state.pending.get(k) || {}, changes));
    rebuildJob(k); rerender(); refreshOverlay();
    setSaving(1);
    const run = () => {
      const server = state.rowMap.get(k) || [];
      const base = {};
      Object.keys(changes).forEach((f) => { const c = state.ix[f]; base[f] = c > -1 && server[c] != null ? String(server[c]) : ''; });
      return api.call('ethixUpdateJob', [before.jobNo, changes, base, '']).then((res) => {
        if (res && res.ok) {
          if (Array.isArray(res.row)) state.rowMap.set(k, res.row);
          clearPending(k, changes); rebuildJob(k); rerender(); refreshOverlay();
          if (opts.toast) toast(opts.toast, opts.undo === false ? {} : { action: { label: 'Undo', fn: () => saveJob(no, prev, { toast: 'Change undone', undo: false }) } });
          state.syncedAt = Date.now();
          return true;
        }
        if (res && res.conflict && Array.isArray(res.row)) state.rowMap.set(k, res.row);
        clearPending(k, changes); rebuildJob(k); rerender(); refreshOverlay();
        toast((res && res.error) || 'Could not save. Please try again.', { error: true });
        return false;
      }).catch((e) => {
        clearPending(k, changes); rebuildJob(k); rerender(); refreshOverlay();
        if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Saving needs the Phase 2 Code.gs update.' : 'Not saved: ' + e.message, { error: true, action: /not available/i.test(e.message) ? null : { label: 'Retry', fn: () => saveJob(no, changes, opts) } });
        return false;
      }).finally(() => setSaving(-1));
    };
    const chain = (state.saving.get(k) || Promise.resolve()).then(run, run);
    state.saving.set(k, chain);
    return chain;
  }

  // ================================================================ POPOVER
  // Laptops: a glass card next to what you tapped. Phones: a bottom sheet.
  const usePop = () => window.innerWidth >= 760;
  let popAnchor = null, popRender = null, popKey = null;
  // What the popover is attached to, so the same button can be found again after the page redraws.
  function anchorKey(el) {
    const attrs = ['data-stop', 'data-act', 'data-adm', 'data-user', 'data-list'].filter((a) => el.hasAttribute(a)).map((a) => '[' + a + '="' + String(el.getAttribute(a)).replace(/"/g, '\\"') + '"]').join('');
    const box = ['.vhero', '.vcard', '.miscard', '.nextbar', '.crumbs', '.vhead', '.users-list', '.page-head'].find((c) => el.closest(c));
    return attrs ? (box ? box + ' ' : '') + attrs : null;
  }
  function findAnchor() {
    if (popAnchor && document.body.contains(popAnchor)) return popAnchor;
    if (!popKey) return null;
    const found = $$(popKey).find((x) => x.offsetParent !== null);
    if (found) popAnchor = found;
    return found || null;
  }
  function openPop(anchor, kicker, build) {
    closeOverlays(true);
    popRender = build;
    if (!usePop()) { $('#drawerKicker').textContent = kicker; $('#drawerBody').innerHTML = build(); showDrawer(anchor); state.overlay = 'sheet'; focusFirst($('#drawerBody')); return; }
    const pop = $('#pop');
    pop.innerHTML = '<div class="pop-head"><div class="kicker">' + esc(kicker) + '</div><button type="button" class="icon-btn" data-act="pop-close" aria-label="Close">' + icon('close', 14) + '</button></div><div class="pop-body">' + build() + '</div>';
    pop.hidden = false;
    popAnchor = anchor;
    popKey = anchor ? anchorKey(anchor) : null;
    placePop();
    state.overlay = 'pop';
    focusFirst(pop);
  }
  function focusFirst(el) { const f = el.querySelector('[data-primary], .pop-body button, .drawer-body button, input, select'); if (f) f.focus({ preventScroll: true }); }
  function placePop() {
    const pop = $('#pop'); if (pop.hidden) return;
    const anchor = findAnchor(); if (!anchor) return;          // its button is gone: stay where it is
    const r = anchor.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const pw = pop.offsetWidth, ph = pop.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(12, Math.min(vw - pw - 12, left));
    let top = r.bottom + 12;
    let above = false;
    if (top + ph > vh - 12) { top = r.top - ph - 12; above = true; }
    if (top < 12) top = Math.max(12, Math.min(vh - ph - 12, r.bottom + 12));
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    pop.classList.toggle('is-above', above);
    pop.style.setProperty('--arrow', Math.max(18, Math.min(pw - 18, r.left + r.width / 2 - left)) + 'px');
  }
  function refreshOverlay() {
    if (!popRender) return;
    if (state.overlay === 'pop' && !$('#pop').hidden) { const b = $('#pop .pop-body'); if (b) { b.innerHTML = popRender(); placePop(); } }
    else if (state.overlay === 'sheet' || state.overlay === 'drawer' || state.overlay === 'quick') { if (!$('#drawer').hidden) $('#drawerBody').innerHTML = popRender(); }
  }
  function closeOverlays(silent) {
    const had = !$('#pop').hidden || !$('#drawer').hidden;
    $('#pop').hidden = true; popAnchor = null; popKey = null; popRender = null;
    if (!$('#drawer').hidden) hideDrawer(silent);
    state.overlay = null;
    if (had && state.dirty) { state.dirty = false; rerender(); }
  }

  // ---------- what tapping a stop shows ----------
  const SAVE_NOTE = '<div class="pop-note">SAVES INSTANTLY · SYNCS IN BACKGROUND</div>';
  function fieldLabel(j, f) {
    if (f === 'sido') return j.cat === 'IMPORT' ? 'DO status' : j.type === 'CRR' ? 'Documents' : 'SI status';
    if (f === 'ed') return j.cat === 'IMPORT' ? 'Customs (ED) status' : 'ED status';
    if (f === 'bl') return j.mode === 'air' ? 'AWB status' : j.type === 'CRR' ? 'Tracking / AWB status' : 'BL status';
    if (f === 'loadlist') return j.cat === 'IMPORT' ? 'Discharge list' : 'Loadlist';
    return { docs: 'Original docs', costing: 'Costing', status: 'Job status', etd: j.mode === 'courier' ? 'Pick-up date' : 'ETD', eta: j.mode === 'courier' ? 'Delivery date' : 'ETA', delivery: 'Delivery date', against: 'Against job no.' }[f] || f;
  }
  function stopEditor(no, id) {
    return () => {
      const j = findJob(no); if (!j) return '';
      const s = j.journey.all.find((x) => x.id === id); if (!s) return '';
      const d = s.def;
      const head = '<div class="pop-title">' + esc(s.name) + '</div><div class="pop-state is-' + s.state + '">' + stopDot(s) + '<span>' + esc(s.sub) + '</span></div>';
      if (s.kind === 'field') {
        const choices = d.choices || OPTS[d.field];
        const cur = j[d.field] || '';
        const lbl = fieldLabel(j, d.field);
        const chips = (lbl.toLowerCase() === s.name.toLowerCase() ? '' : '<div class="pop-label">' + esc(lbl) + '</div>') + '<div class="choice-row">' + choices.map((v) => '<button type="button" class="choice' + (v === cur ? ' is-on' : '') + (d.done.includes(v) ? ' is-good' : '') + '" data-set="' + esc(d.field) + '" data-val="' + esc(v) + '" aria-pressed="' + (v === cur) + '">' + esc(v === NA ? 'Not needed' : v) + '</button>').join('') + '</div>';
        const primary = s.state === 'done' ? '' : '<button type="button" class="btn-brutal pop-main" data-primary data-set="' + esc(d.field) + '" data-val="' + esc(d.primary) + '">MARK DONE · ' + esc(d.primary) + '</button>';
        return head + chips + primary + (s.optional && s.state !== 'skip' ? '<button type="button" class="btn-ghost pop-wide" data-set="' + esc(d.field) + '" data-val="' + NA + '">Not needed</button>' : '') + SAVE_NOTE;
      }
      if (s.kind === 'date') {
        const val = asInput(d.field, j.raw[d.field]);
        const lbl = { etd: j.mode === 'courier' ? 'Pick-up date' : 'ETD', eta: j.mode === 'courier' ? 'Delivery date' : 'ETA', delivery: 'Delivered on' }[d.field];
        const hint = d.manual ? 'Tick it by entering the delivery date.' : (d.field === 'etd' ? 'Ticks itself once the ETD has passed.' : 'Ticks itself once the ETA has passed.');
        return head + '<form class="pop-form" data-date="' + esc(d.field) + '"><label class="pop-label" for="popDate">' + esc(lbl) + '</label>' +
          '<div class="date-row"><input type="date" id="popDate" value="' + esc(/^\d{4}-\d{2}-\d{2}$/.test(val) ? val : '') + '"><button type="button" class="choice" data-day="0">Today</button><button type="button" class="choice" data-day="1">Tomorrow</button></div>' +
          '<button type="submit" class="btn-brutal pop-main" data-primary>SAVE DATE</button>' +
          (s.optional && s.state !== 'skip' ? '<button type="button" class="btn-ghost pop-wide" data-set="' + esc(d.field) + '" data-val="' + NA + '">Not needed</button>' : '') +
          (val ? '<button type="button" class="link-btn quiet pop-clear" data-set="' + esc(d.field) + '" data-val="">Clear date</button>' : '') +
          '<div class="pop-hint">' + esc(hint) + '</div></form>' + SAVE_NOTE;
      }
      if (s.kind === 'status') {
        if (j.status === 'COMPLETED') return head + '<p class="pop-text">This job is closed.</p><button type="button" class="btn-ghost pop-wide" data-set="status" data-val="ONGOING">Reopen job</button>' + SAVE_NOTE;
        const open = j.journey.all.filter((x) => x !== s && !x.optional && (x.state === 'todo' || x.state === 'late' || x.state === 'current') && x.kind !== 'auto');
        return head + (open.length ? '<p class="pop-text">Still open: ' + esc(open.map((x) => x.name).join(', ')) + '.</p>' : '<p class="pop-text">Every stop is done. Close the job?</p>') +
          '<button type="button" class="btn-brutal pop-main" data-primary data-set="status" data-val="COMPLETED">MARK COMPLETED</button>' + SAVE_NOTE;
      }
      if (s.kind === 'link') {
        return head + '<form class="pop-form" data-text="against"><label class="pop-label" for="popText">Against job no.</label><input type="text" id="popText" value="' + esc(j.against) + '" autocomplete="off" list="dlJobs"><button type="submit" class="btn-brutal pop-main" data-primary>SAVE</button></form>' + datalist('dlJobs', state.jobs.slice(-400).map((x) => x.jobNo)) + SAVE_NOTE;
      }
      if (s.kind === 'auto') {
        return head + '<div class="kv"><span class="kv-k">' + (j.mode === 'courier' ? 'Pick-up' : 'ETD') + '</span><span class="kv-v">' + esc(fmt(j.etd, true)) + '</span></div><div class="kv"><span class="kv-k">' + (j.mode === 'courier' ? 'Delivery' : 'ETA') + '</span><span class="kv-v">' + esc(fmt(j.eta, true)) + '</span></div><p class="pop-text">This follows the dates by itself.</p><button type="button" class="btn-ghost pop-wide" data-act="edit">Edit dates</button>';
      }
      return head + '<div class="kv"><span class="kv-k">Job opened</span><span class="kv-v">' + esc(fmt(j.opened, true)) + '</span></div><button type="button" class="btn-ghost pop-wide" data-act="edit">Edit details</button>';
    };
  }
  function stopInfo(no, id) {
    return () => {
      const j = findJob(no); if (!j) return '';
      const s = j.journey.all.find((x) => x.id === id); if (!s) return '';
      const d = s.def || {};
      const rows = [];
      if (s.kind === 'field') rows.push([fieldLabel(j, d.field), j[d.field] === NA ? 'NOT NEEDED' : j[d.field] || '—']);
      if (s.kind === 'date') rows.push([d.field === 'delivery' ? 'Delivered on' : fieldLabel(j, d.field), d.field === 'delivery' && j.raw.delivery === NA ? 'NOT NEEDED' : fmt(j[d.field], true)]);
      if (s.kind === 'auto') rows.push([j.mode === 'courier' ? 'Pick-up' : 'ETD', fmt(j.etd, true)], [j.mode === 'courier' ? 'Delivery' : 'ETA', fmt(j.eta, true)]);
      if (s.kind === 'status') rows.push(['Job status', j.status || '—']);
      if (s.kind === 'link') rows.push(['Against job no.', j.against || '—']);
      if (s.kind === 'info') rows.push(['Job opened', fmt(j.opened, true)]);
      return '<div class="pop-title">' + esc(s.name) + '</div><div class="pop-state is-' + s.state + '">' + stopDot(s) + '<span>' + esc(s.sub) + '</span></div>' +
        rows.map((r) => '<div class="kv"><span class="kv-k">' + esc(r[0]) + '</span><span class="kv-v">' + esc(r[1]) + '</span></div>').join('') +
        '<p class="pop-text">' + esc((j.cs ? nice(j.cs) : 'Customer Service') + ' (Customer Service) keeps this stop up to date.') + (canNote() ? ' Need something? Add a note below.' : '') + '</p>';
    };
  }
  function statusEditor(no) {
    return () => {
      const j = findJob(no); if (!j) return '';
      return '<div class="pop-title">Job status</div><div class="choice-row is-stack">' + OPTS.status.map((v) => '<button type="button" class="choice' + (j.status === v ? ' is-on' : '') + '" data-set="status" data-val="' + v + '" aria-pressed="' + (j.status === v) + '">' + ({ ONGOING: 'Ongoing', HOLD: 'On hold', COMPLETED: 'Completed', CANCELLED: 'Cancelled' }[v]) + '</button>').join('') + '</div>' +
        '<label class="pop-label" for="holdNote">Reason (optional — posted as a note)</label><input type="text" id="holdNote" maxlength="300" placeholder="e.g. customer asked to roll over" autocomplete="off">' + SAVE_NOTE;
    };
  }
  function quickEditor(no) {
    return () => {
      const j = findJob(no); if (!j) return '';
      const fields = FORM_STATUS[j.type] || ['sido', 'ed', 'bl', 'costing'];
      return '<h2 class="peek-job" id="drawerTitle">' + esc(j.jobNo) + '</h2><p class="pop-text">Tap a value to save it straight away.</p>' +
        ['status'].concat(fields.filter((f) => f !== 'delivery')).map((f) => '<div class="quick-row"><div class="pop-label">' + esc(fieldLabel(j, f)) + '</div><div class="choice-row">' + OPTS[f].map((v) => '<button type="button" class="choice' + ((j[f] || '') === v ? ' is-on' : '') + '" data-set="' + f + '" data-val="' + esc(v) + '" aria-pressed="' + ((j[f] || '') === v) + '">' + esc(v === NA ? 'N/A' : v) + '</button>').join('') + '</div></div>').join('') + SAVE_NOTE;
    };
  }

  function onSet(no, field, val) {
    if (!canEdit()) return;
    const j = findJob(no); if (!j) return;
    if ((j.raw[field] || '') === val && field !== 'status') { closeOverlays(); return; }
    const label = fieldLabel(j, field);
    const holdNote = $('#holdNote') ? $('#holdNote').value.trim() : '';
    if (state.overlay !== 'quick') closeOverlays();
    const shown = /^\d{4}-\d{2}-\d{2}$/.test(val) ? fmt(parseDate(val), true) : val === NA ? 'not needed' : val;
    saveJob(j.jobNo, { [field]: val }, { toast: (val === '' ? label + ' cleared' : label + ' → ' + shown) });
    if (field === 'status' && holdNote) postNote(j.jobNo, (val === 'HOLD' ? 'On hold: ' : 'Status ' + val.toLowerCase() + ': ') + holdNote);
  }

  async function postNote(no, text) {
    const k = String(no).toUpperCase();
    try {
      setSaving(1);
      const res = await api.call('ethixAddNote', [no, text, '']);
      if (res && res.ok) { state.stories.set(k, { data: res.story, at: Date.now(), loading: false }); rerender(); return true; }
      toast((res && res.error) || 'The note was not saved.', { error: true });
    } catch (e) { if (e.kind !== 'auth') toast('Note not saved: ' + e.message, { error: true }); }
    finally { setSaving(-1); }
    return false;
  }

  function initVoyage() {
    const view = $('#view');
    view.addEventListener('click', (e) => {
      const r = state.route; if (!r || r.name !== 'job') return;
      const no = r.jobNo;
      const st = e.target.closest('[data-stop]');
      if (st) {
        const j = findJob(no); if (!j) return;
        const s = j.journey.all.find((x) => x.id === st.dataset.stop);
        if (!canEdit()) { openPop(st, 'STOP', stopInfo(no, st.dataset.stop)); return; }
        if (st.dataset.quick && s && s.kind === 'field' && s.state !== 'done') { onSet(no, s.def.field, s.def.primary); return; }
        openPop(st, s && s.kind === 'info' ? 'JOB' : 'UPDATE STOP', stopEditor(no, st.dataset.stop));
        return;
      }
      if (e.target.closest('[data-act="focus-note"]')) {
        const k = findJob(no) ? findJob(no).jobNo : no;
        if (state.voyageTab[k] === 'details') { state.voyageTab[k] = 'overview'; rerender(); }
        const inp = $('#noteInput'); if (inp) { inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); inp.focus({ preventScroll: true }); }
        return;
      }
      if (!canEdit() && e.target.closest('[data-act="status"], [data-act="quick"], [data-act="edit"]')) return;
      if (e.target.closest('[data-act="status"]')) { openPop(e.target.closest('[data-act="status"]'), 'JOB STATUS', statusEditor(no)); return; }
      if (e.target.closest('[data-act="quick"]')) { openQuick(no, e.target.closest('[data-act="quick"]')); return; }
      if (e.target.closest('[data-act="edit"]')) { openEdit(no); return; }
      if (e.target.closest('[data-act="back"]')) { if (state.navDepth > 0) history.back(); else go('#/jobs'); return; }
      const t = e.target.closest('[data-tab]');
      if (t) { state.voyageTab[findJob(no) ? findJob(no).jobNo : no] = t.dataset.tab; rerender(); }
    });
    view.addEventListener('submit', (e) => {
      const f = e.target.closest('[data-act="note"]'); if (!f) return;
      e.preventDefault();
      const inp = $('#noteInput', f); const text = inp.value.trim(); if (!text) return;
      const r = state.route; if (!r || r.name !== 'job') return;
      inp.value = '';
      postNote(r.jobNo, text).then((ok) => { if (!ok) { const i2 = $('#noteInput'); if (i2 && !i2.value) i2.value = text; } });
    });
    // inside the popover / sheet
    const onOverlayClick = (e) => {
      const r = state.route; const no = r && r.jobNo;
      if (e.target.closest('[data-act="pop-close"]')) { closeOverlays(); return; }
      if (e.target.closest('[data-act="edit"]') && no) { closeOverlays(); openEdit(no); return; }
      const set = e.target.closest('[data-set]');
      if (set && no) { onSet(no, set.dataset.set, set.dataset.val); return; }
      const day = e.target.closest('[data-day]');
      if (day) { const inp = $('#popDate'); if (inp) inp.value = iso(addDays(today0(), +day.dataset.day)); }
    };
    const onOverlaySubmit = (e) => {
      const r = state.route; const no = r && r.jobNo; if (!no) return;
      const df = e.target.closest('[data-date]');
      if (df) { e.preventDefault(); const v = $('#popDate').value; if (!v) { toast('Pick a date first.', { error: true }); return; } onSet(no, df.dataset.date, v); return; }
      const tf = e.target.closest('[data-text]');
      if (tf) { e.preventDefault(); onSet(no, tf.dataset.text, $('#popText').value.trim().toUpperCase()); }
    };
    $('#pop').addEventListener('click', onOverlayClick);
    $('#pop').addEventListener('submit', onOverlaySubmit);
    $('#drawerBody').addEventListener('click', (e) => { if (state.overlay === 'sheet' || state.overlay === 'quick') onOverlayClick(e); });
    $('#drawerBody').addEventListener('submit', (e) => { if (state.overlay === 'sheet') onOverlaySubmit(e); });
    document.addEventListener('pointerdown', (e) => { if (state.overlay === 'pop' && !e.target.closest('#pop') && !e.target.closest('[data-stop], [data-act="status"]')) closeOverlays(); }, true);
    window.addEventListener('resize', placePop);
    view.addEventListener('scroll', () => { if (state.overlay === 'pop') placePop(); }, { passive: true });
  }
  function openQuick(no, opener) {
    closeOverlays(true);
    popRender = quickEditor(no);
    $('#drawerKicker').textContent = 'QUICK UPDATE';
    $('#drawerBody').innerHTML = popRender();
    showDrawer(opener);
    state.overlay = 'quick';
  }

  // ================================================================ FORMS
  const SALES_NAMES = ['VINEETH', 'PRAVEEN', 'RAKHI', 'ANUSANKAR', 'ROSHIN', 'SHYLA', 'SHAKIR', 'VISHNU', 'VARTHIKA', 'NANCY', 'SUHAIL', 'CHINCHU', 'DIYA', 'SATHYAJITH', 'ASHNA', 'ATHIRA', 'KEERTHI', 'KRISHNA', 'SINAN', 'MIDHUN', 'MANJIMA', 'NAJIYA', 'NAYEEM', 'SANOOB'];
  const TYPE_FIELDS = {
    SFEF: ['c20', 'c40', 'dg', 'pol', 'pod', 'etd', 'eta', 'siCut', 'edCut', 'dgCut', 'freight'],
    SFEL: ['dg', 'pol', 'pod', 'etd', 'eta', 'siCut', 'edCut', 'dgCut'],
    AFE: ['dg', 'pol', 'pod', 'etd', 'eta', 'siCut', 'edCut'],
    SFIF: ['c20', 'c40', 'dg', 'pol', 'pod', 'etd', 'eta', 'lineFree', 'portFree', 'freight'],
    SFIL: ['dg', 'pol', 'pod', 'etd', 'eta', 'lineFree', 'portFree'],
    AFI: ['dg', 'pol', 'pod', 'etd', 'eta'],
    CND: ['c20', 'c40', 'dg', 'pol', 'pod', 'eta', 'lineFree', 'portFree'],
    SFC: ['c20', 'c40', 'pol', 'pod', 'etd', 'eta', 'siCut'],
    AFC: ['pol', 'pod', 'etd', 'eta', 'siCut'],
    CRR: ['pol', 'pod', 'etd', 'eta'],
    MIS: ['against']
  };
  const FORM_STATUS = {
    SFEF: ['loadlist', 'sido', 'ed', 'bl', 'costing'], SFEL: ['loadlist', 'sido', 'ed', 'bl', 'costing'], AFE: ['sido', 'ed', 'bl', 'costing'],
    SFIF: ['loadlist', 'sido', 'ed', 'bl', 'docs', 'delivery', 'costing'], SFIL: ['loadlist', 'sido', 'ed', 'bl', 'docs', 'delivery', 'costing'],
    AFI: ['sido', 'ed', 'bl', 'delivery', 'costing'], CND: ['loadlist', 'sido', 'ed', 'bl', 'docs', 'delivery', 'costing'],
    SFC: ['sido', 'bl', 'costing'], AFC: ['sido', 'bl', 'costing'], CRR: ['sido', 'bl', 'costing'], MIS: ['costing']
  };
  const TYPE_GROUPS = [
    ['Sea export', [['SFEF', 'FCL'], ['SFEL', 'LCL']], 'ship'],
    ['Sea import', [['SFIF', 'FCL'], ['SFIL', 'LCL']], 'ship'],
    ['Air', [['AFE', 'Export'], ['AFI', 'Import']], 'plane'],
    ['Cross-trade', [['SFC', 'Sea'], ['AFC', 'Air']], 'globe'],
    ['Clearance & delivery', [['CND', 'CND']], 'truck'],
    ['Courier', [['CRR', 'CRR']], 'van'],
    ['Miscellaneous', [['MIS', 'Costing only']], 'costing']
  ];
  function datalist(id, values) {
    const seen = new Set(); const out = [];
    values.forEach((v) => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); out.push(v); } });
    return '<datalist id="' + id + '">' + out.slice(0, 600).map((v) => '<option value="' + esc(v) + '"></option>').join('') + '</datalist>';
  }
  function loadLists() {
    if (state.lists || state.listsLoading) return;
    state.listsLoading = true;
    api.call('getMasterLists').then((l) => { state.lists = l || { customers: [], vendors: [] }; }).catch(() => { state.lists = { customers: [], vendors: [] }; }).finally(() => { state.listsLoading = false; });
  }
  function fieldMeta(key, type) {
    const air = ['AFE', 'AFI', 'AFC'].includes(type), crr = type === 'CRR', imp = ['SFIF', 'SFIL', 'AFI', 'CND'].includes(type);
    const M = {
      jobNo: { label: 'Job no.', kind: 'text', req: true, upper: true, ph: 'e.g. 202600812' },
      customer: { label: 'Customer', kind: 'text', req: true, upper: true, list: 'dlCustomers' },
      vendor: { label: air ? 'Airline / vendor' : crr ? 'Courier company' : 'Line / vendor', kind: 'text', upper: true, list: 'dlVendors' },
      cs: { label: 'Customer Service (owns it)', kind: 'cs' },
      sales: { label: 'Sales person', kind: 'text', upper: true, list: 'dlSales' },
      opened: { label: 'Job opened', kind: 'date' },
      c20: { label: '20′ containers', kind: 'count' }, c40: { label: '40′ containers', kind: 'count' },
      dg: { label: 'Cargo', kind: 'select', opts: ['NON DG', 'DG'] },
      pol: { label: crr ? 'From' : 'POL — origin', kind: 'text', upper: true, list: 'dlPorts' },
      pod: { label: crr ? 'To' : 'POD — destination', kind: 'text', upper: true, list: 'dlPorts' },
      etd: { label: crr ? 'Pick-up date' : air ? 'ETD (flight)' : 'ETD', kind: 'date' },
      eta: { label: crr ? 'Delivery date' : 'ETA', kind: 'date' },
      siCut: { label: 'SI cutoff', kind: 'date' }, edCut: { label: 'ED cutoff', kind: 'date' }, dgCut: { label: 'DG cutoff', kind: 'date', dgOnly: true },
      lineFree: { label: 'Line free time (days)', kind: 'free' }, portFree: { label: 'Port free time (days)', kind: 'free' },
      delivery: { label: 'Delivered on', kind: 'date' },
      freight: { label: 'Line freight (USD)', kind: 'text', inputmode: 'decimal' },
      against: { label: 'Against job no.', kind: 'text', upper: true, list: 'dlJobs' },
      remarks: { label: 'Remarks', kind: 'area' },
      status: { label: 'Job status', kind: 'select', opts: OPTS.status },
      type: { label: 'Job type', kind: 'select', opts: OPTS.type },
      sido: { label: imp ? 'DO status' : crr ? 'Documents (SI)' : 'SI status', kind: 'select', opts: OPTS.sido, blank: true },
      ed: { label: imp ? 'Customs (ED) status' : 'ED status', kind: 'select', opts: OPTS.ed, blank: true },
      bl: { label: air ? 'AWB status' : crr ? 'Tracking / AWB status' : 'BL status', kind: 'select', opts: OPTS.bl, blank: true },
      loadlist: { label: imp ? 'Discharge list' : 'Loadlist', kind: 'select', opts: OPTS.loadlist, blank: true },
      docs: { label: 'Original docs', kind: 'select', opts: OPTS.docs, blank: true },
      costing: { label: 'Costing', kind: 'select', opts: OPTS.costing, blank: true }
    };
    return M[key];
  }
  function csOptions(current) {
    const names = new Set(state.users.map((u) => String((u && u.name) || '').toUpperCase().trim()).filter((n) => n && normRole((state.users.find((u) => String(u.name || '').toUpperCase().trim() === n) || {}).role, n) === 'CS'));
    if (current) names.add(current);
    names.delete('MASTER');
    return Array.from(names).filter(Boolean).sort();
  }
  function input(key, type, val, extra = {}) {
    const m = fieldMeta(key, type);
    const id = 'f_' + key;
    const req = m.req ? ' required' : '';
    let ctl;
    if (m.kind === 'select' || m.kind === 'cs') {
      const opts = m.kind === 'cs' ? csOptions(val) : m.opts.slice();
      if (val && !opts.includes(val)) opts.unshift(val);
      ctl = '<select id="' + id + '" name="' + key + '"' + req + '>' + (m.blank || m.kind === 'cs' ? '<option value=""' + (!val ? ' selected' : '') + '>—</option>' : '') + opts.map((o) => '<option value="' + esc(o) + '"' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
    } else if (m.kind === 'area') {
      ctl = '<textarea id="' + id + '" name="' + key + '" rows="3" maxlength="500">' + esc(val) + '</textarea>';
    } else if (m.kind === 'date') {
      const ok = !val || /^\d{4}-\d{2}-\d{2}$/.test(val);
      ctl = ok ? '<input type="date" id="' + id + '" name="' + key + '" value="' + esc(val) + '">' : '<input type="text" id="' + id + '" name="' + key + '" value="' + esc(val) + '" placeholder="yyyy-mm-dd">';
    } else if (m.kind === 'count') {
      ctl = '<input type="number" min="0" max="999" step="1" inputmode="numeric" id="' + id + '" name="' + key + '" value="' + esc(val) + '">';
    } else if (m.kind === 'free') {
      ctl = /^\d*$/.test(val) ? '<input type="number" min="0" max="365" step="1" inputmode="numeric" id="' + id + '" name="' + key + '" value="' + esc(val) + '" placeholder="days">' : '<input type="text" id="' + id + '" name="' + key + '" value="' + esc(val) + '" placeholder="days">';
    } else {
      ctl = '<input type="text" id="' + id + '" name="' + key + '" value="' + esc(val) + '"' + req + (m.list ? ' list="' + m.list + '"' : '') + (m.ph ? ' placeholder="' + esc(m.ph) + '"' : '') + (m.inputmode ? ' inputmode="' + m.inputmode + '"' : '') + (m.upper ? ' autocapitalize="characters" class="is-upper"' : '') + ' autocomplete="off" spellcheck="false">';
    }
    return '<div class="field' + (m.kind === 'area' ? ' is-wide' : '') + (m.dgOnly ? ' dg-only' : '') + (extra.cls ? ' ' + extra.cls : '') + '" data-field="' + key + '"><label for="' + id + '">' + esc(m.label) + (m.req ? ' <b aria-hidden="true">*</b>' : '') + '</label>' + ctl + '<div class="field-err" id="' + id + '_err"></div></div>';
  }
  function formLists() {
    const L = state.lists || { customers: [], vendors: [] };
    return datalist('dlCustomers', L.customers.concat(state.jobs.map((j) => j.customer))) + datalist('dlVendors', L.vendors.concat(state.jobs.map((j) => j.vendor))) +
      datalist('dlPorts', state.jobs.map((j) => j.pol).concat(state.jobs.map((j) => j.pod), ['JEBEL ALI', 'DUBAI', 'KHOR FAKKAN', 'SHARJAH', 'ABU DHABI'])) +
      datalist('dlSales', SALES_NAMES.concat(state.users.filter((u) => String(u.role || '').toUpperCase().trim() === 'SALES').map((u) => String(u.name || '').toUpperCase()), state.jobs.map((j) => j.sales))) + datalist('dlJobs', state.jobs.slice(-400).map((j) => j.jobNo));
  }
  function typeTiles(sel) {
    return '<div class="type-grid" role="radiogroup" aria-label="Job type">' + TYPE_GROUPS.map(([title, opts, ic]) =>
      '<div class="type-group"><div class="tg-title">' + (ic === 'ship' ? SHIP(26) : ic === 'plane' ? PLANE(20) : ic === 'van' ? VAN(20) : icon(ic === 'globe' ? 'globe' : ic === 'truck' ? 'truck' : 'costing', 18)) + '<span>' + esc(title) + '</span></div><div class="tg-opts">' +
      opts.map(([code, l]) => '<button type="button" class="type-opt" role="radio" data-type="' + code + '" aria-checked="' + (sel === code) + '"><span class="badge">' + code + '</span><span>' + esc(l) + '</span></button>').join('') + '</div></div>').join('') + '</div>';
  }

  // ---------- New job ----------
  function openNewJob(type) {
    if (!state.signedIn || !canEdit()) return;
    loadLists();
    closeOverlays(true);
    state.newJob = { type: type || '' };
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'NEW JOB';
    renderNewJob();
    showDrawer(document.activeElement);
    state.overlay = 'form';
  }
  function renderNewJob() {
    const t = state.newJob.type;
    if (!t) { $('#drawerBody').innerHTML = '<h2 class="peek-job form-title" id="drawerTitle">What kind of job?</h2>' + typeTiles(''); return; }
    const d = { cs: csOptions(state.user).includes(state.user) ? state.user : '', opened: iso(today0()), dg: 'NON DG' };
    if (['SFEF', 'SFEL'].includes(t)) d.pol = 'JEBEL ALI';
    if (t === 'AFE') d.pol = 'DUBAI';
    if (['SFIF', 'SFIL', 'CND'].includes(t)) d.pod = 'JEBEL ALI';
    if (t === 'AFI') d.pod = 'DUBAI';
    const tf = TYPE_FIELDS[t];
    $('#drawerBody').innerHTML = '<h2 class="peek-job form-title" id="drawerTitle"><span class="badge badge-lg">' + t + '</span> ' + esc(TYPE_NAMES[t]) + '</h2>' +
      '<button type="button" class="link-btn quiet form-back" data-act="nj-type">' + icon('back', 14) + 'Change type</button>' +
      '<form class="job-form" id="jobForm" novalidate>' +
        '<fieldset><legend>JOB</legend><div class="fgrid">' + ['jobNo', 'customer', 'vendor', 'cs', 'sales', 'opened'].map((k) => input(k, t, d[k] || '')).join('') + '</div></fieldset>' +
        (tf.length ? '<fieldset><legend>' + (t === 'MIS' ? 'LINK' : 'CARGO & ROUTE') + '</legend><div class="fgrid' + (d.dg === 'DG' ? ' has-dg' : '') + '">' + tf.map((k) => input(k, t, d[k] || '')).join('') + '</div></fieldset>' : '') +
        '<fieldset><legend>REMARKS</legend><div class="fgrid">' + input('remarks', t, '') + '</div></fieldset>' +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit">CREATE JOB</button></div>' +
      '</form>' + formLists();
    syncDg();
  }
  function syncDg() { const f = $('#jobForm'); if (!f) return; const dg = f.querySelector('[name="dg"]'); const g = f.querySelector('.dg-only'); if (g) g.hidden = !(dg && dg.value === 'DG'); }
  function readForm(form) {
    const out = {};
    $$('input, select, textarea', form).forEach((el) => { if (!el.name) return; let v = el.value.trim(); if (el.classList.contains('is-upper')) v = v.toUpperCase().replace(/\s+/g, ' '); out[el.name] = v; });
    return out;
  }
  function fieldError(key, msg) {
    const e = $('#f_' + key + '_err'); if (e) e.textContent = msg || '';
    const f = $('.field[data-field="' + key + '"]'); if (f) f.classList.toggle('has-error', !!msg);
  }
  async function submitNewJob(form) {
    const t = state.newJob.type;
    const v = readForm(form);
    $$('.field-err', form).forEach((e) => { e.textContent = ''; }); $$('.field.has-error', form).forEach((e) => e.classList.remove('has-error'));
    let bad = false;
    if (!/^[A-Z0-9][A-Z0-9\-\/]{2,29}$/.test(v.jobNo || '')) { fieldError('jobNo', 'Enter the job number (3–30 letters or numbers).'); bad = true; }
    else if (findJob(v.jobNo)) { fieldError('jobNo', 'Job ' + v.jobNo + ' already exists.'); bad = true; }
    if (!v.customer) { fieldError('customer', 'Customer is required.'); bad = true; }
    if (['SFEF', 'SFIF'].includes(t) && !(+v.c20 > 0) && !(+v.c40 > 0)) { fieldError('c20', 'Enter 20′ or 40′ containers.'); bad = true; }
    if (v.etd && v.eta && v.eta < v.etd) { fieldError('eta', 'ETA is before ETD.'); bad = true; }
    if (bad) { const first = $('.field.has-error input, .field.has-error select', form); if (first) first.focus(); return; }
    if (v.dg !== 'DG') delete v.dgCut;
    const payload = Object.assign({ type: t }, v);
    const btn = $('#formSubmit'); btn.disabled = true; btn.textContent = 'CREATING…';
    try {
      const res = await api.call('ethixAddJob', [payload, '']);
      if (res && res.ok && Array.isArray(res.row)) {
        const k = String(res.row[state.ix.jobNo] || v.jobNo).toUpperCase();
        state.rowMap.set(k, res.row);
        rebuildJob(k);
        closeOverlays();
        toast('Job ' + v.jobNo + ' created');
        openJob(v.jobNo);
        renderChrome(); updateNav();
        return;
      }
      if (res && res.duplicate) fieldError('jobNo', res.error);
      $('#formError').textContent = (res && res.error) || 'The job was not created.';
    } catch (e) {
      if (e.kind !== 'auth') $('#formError').textContent = /not available/i.test(e.message) ? 'Creating jobs needs the Phase 2 Code.gs update.' : e.message;
    }
    btn.disabled = false; btn.textContent = 'CREATE JOB';
  }

  // ---------- Edit details ----------
  function openEdit(no) {
    if (!canEdit()) return;
    const j = findJob(no); if (!j) return;
    loadLists();
    closeOverlays(true);
    const t = j.type;
    const keys = ['customer', 'vendor', 'cs', 'sales', 'opened'];
    const route = TYPE_FIELDS[t] || [];
    const docs = FORM_STATUS[t] || ['sido', 'ed', 'bl', 'costing'];
    const val = (k) => asInput(k, j.raw[k]);
    state.editing = { no: j.jobNo, initial: {} };
    const norm = (k, v) => (fieldMeta(k, t) && fieldMeta(k, t).upper ? String(v).toUpperCase().replace(/\s+/g, ' ') : v);
    ['type', 'status'].concat(keys, route, docs, ['remarks', 'dgCut']).forEach((k) => { state.editing.initial[k] = norm(k, val(k)); });
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'EDIT DETAILS';
    $('#drawerBody').innerHTML = '<h2 class="peek-job form-title" id="drawerTitle">' + esc(j.jobNo) + '</h2>' +
      '<form class="job-form" id="editForm" novalidate>' +
        '<fieldset><legend>JOB</legend><div class="fgrid">' + input('type', t, val('type')) + input('status', t, val('status')) + keys.map((k) => input(k, t, val(k))).join('') + '</div><div class="type-warn" id="typeWarn" hidden>Changing the type changes the voyage stops for this job.</div></fieldset>' +
        (route.length ? '<fieldset><legend>' + (t === 'MIS' ? 'LINK' : 'CARGO & ROUTE') + '</legend><div class="fgrid">' + route.map((k) => input(k, t, val(k))).join('') + '</div></fieldset>' : '') +
        '<fieldset><legend>DOCUMENTS</legend><div class="fgrid">' + docs.map((k) => input(k, t, val(k))).join('') + '</div></fieldset>' +
        '<fieldset><legend>REMARKS</legend><div class="fgrid">' + input('remarks', t, val('remarks')) + '</div></fieldset>' +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit">SAVE CHANGES</button></div>' +
      '</form>' + formLists();
    const f = $('#editForm'); const dg = f.querySelector('[name="dg"]'); const g = f.querySelector('.dg-only'); if (g) g.hidden = !(dg && dg.value === 'DG');
    showDrawer(document.activeElement);
    state.overlay = 'form';
  }
  function submitEdit(form) {
    const ed = state.editing; if (!ed) return;
    const v = readForm(form);
    $$('.field-err', form).forEach((e) => { e.textContent = ''; });
    if (!v.customer) { fieldError('customer', 'Customer is required.'); return; }
    if (v.etd && v.eta && /^\d{4}/.test(v.etd) && /^\d{4}/.test(v.eta) && v.eta < v.etd) { fieldError('eta', 'ETA is before ETD.'); return; }
    const changes = {};
    Object.keys(v).forEach((k) => { if (k in ed.initial && String(v[k]) !== String(ed.initial[k])) changes[k] = v[k]; });
    closeOverlays();
    if (!Object.keys(changes).length) { toast('No changes to save'); return; }
    saveJob(ed.no, changes, { toast: Object.keys(changes).length === 1 ? fieldMeta(Object.keys(changes)[0], findJob(ed.no).type).label + ' saved' : Object.keys(changes).length + ' changes saved' });
  }

  function initForms() {
    const body = $('#drawerBody');
    body.addEventListener('click', (e) => {
      if (state.overlay !== 'form') return;
      const tp = e.target.closest('[data-type]');
      if (tp) { state.newJob.type = tp.dataset.type; renderNewJob(); const f = $('#f_jobNo'); if (f) f.focus(); return; }
      if (e.target.closest('[data-act="nj-type"]')) { state.newJob.type = ''; renderNewJob(); return; }
      if (e.target.closest('[data-act="form-cancel"]')) closeOverlays();
    });
    body.addEventListener('change', (e) => {
      if (state.overlay !== 'form') return;
      if (e.target.name === 'dg') { const g = e.target.form && e.target.form.querySelector('.dg-only'); if (g) g.hidden = e.target.value !== 'DG'; }
      if (e.target.name === 'type' && e.target.form && e.target.form.id === 'editForm') $('#typeWarn').hidden = !state.editing || e.target.value === state.editing.initial.type;
    });
    body.addEventListener('submit', (e) => {
      if (state.overlay !== 'form') return;
      e.preventDefault();
      if (e.target.id === 'jobForm') submitNewJob(e.target);
      if (e.target.id === 'editForm') submitEdit(e.target);
    });
  }

  // ================================================================ PEOPLE (phase 3)
  const ago = (t) => {
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 6 * 3600) return Math.round(s / 3600) + ' h ago';
    const d = new Date(t), today = today0();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (d >= today) return 'Today ' + hm;
    if (d >= addDays(today, -1)) return 'Yesterday ' + hm;
    return fmt(d) + ' ' + hm;
  };

  // ---------- the bell ----------
  function notifUnread() { const n = state.notif || {}; return (n.items || []).filter((x) => x.t > (n.seen || 0)).length; }
  function drawBadges() {
    const n = notifUnread();
    $$('[data-act="notif"] .badge-dot').forEach((b) => { b.textContent = n > 9 ? '9+' : String(n); b.hidden = n === 0; });
    $$('[data-act="notif"]').forEach((b) => b.setAttribute('aria-label', n ? 'Notifications, ' + n + ' unread' : 'Notifications'));
  }
  function notifText(x) {
    if (x.kind === 'note') return '<strong>' + esc(x.from) + '</strong> added a note';
    if (x.kind === 'job') return '<strong>' + esc(x.from) + '</strong> opened a job for you';
    if (x.kind === 'enquiry') return '<strong>' + esc(x.from) + '</strong> sent an enquiry';
    return '<strong>' + esc(x.from) + '</strong> updated';
  }
  function notifPanel() {
    const n = state.notif || { items: [] };
    const seen = state.notifSeenShown || 0;
    return '<h2 class="peek-job list-title" id="drawerTitle">Notifications</h2>' +
      (n.items && n.items.length ? '<ol class="notif-list">' + n.items.map((x) => '<li><button type="button" class="notif' + (x.t > seen ? ' is-new' : '') + '" data-job="' + esc(x.job) + '">' +
        '<span class="avatar' + (x.kind === 'note' ? ' is-other' : '') + '">' + esc(initials(x.from)) + '</span>' +
        '<span class="nt-body"><span class="nt-head">' + notifText(x) + ' <span class="nt-job">' + esc(x.job) + '</span></span>' +
        '<span class="nt-text">' + esc(x.text) + '</span><span class="nt-when">' + esc(ago(x.t)) + '</span></span></button></li>').join('') + '</ol>'
        : '<div class="tile-empty">' + icon('bell', 22) + '<span>' + (state.role === 'SALES' ? 'Updates from Customer Service on your jobs will show here.' : 'Notes from sales on your jobs will show here.') + '</span></div>');
  }
  function openNotifications(opener) {
    closeOverlays(true);
    state.notifSeenShown = (state.notif && state.notif.seen) || 0;
    popRender = notifPanel;
    $('#drawerKicker').textContent = 'NOTIFICATIONS';
    $('#drawerBody').innerHTML = notifPanel();
    showDrawer(opener);
    state.overlay = 'drawer';
    if (state.notif && notifUnread()) {
      state.notif.seen = Math.max(state.notif.seen || 0, ...state.notif.items.map((x) => x.t));   // server time, not this device’s clock
      drawBadges();
      api.call('ethixNotifSeen').catch(() => {});
    }
  }

  // ---------- my account ----------
  function accountPanel() {
    return '<div class="acct"><span class="avatar">' + esc(initials(state.user)) + '</span><div><div class="acct-name" id="drawerTitle">' + esc(state.user === 'MASTER' ? 'ADMIN' : state.user) + '</div><div class="mono small">' + esc(ROLE_NAMES[state.role] || state.role) + '</div></div></div>' +
      '<form class="tile pw-form" id="pwForm" novalidate><h3 class="tile-title">CHANGE PASSWORD</h3>' +
        '<input type="text" name="username" autocomplete="username" value="' + esc(state.user) + '" class="sr-only" tabindex="-1" aria-hidden="true" readonly>' +
        '<label class="pop-label" for="pwCurrent">Current password</label><div class="pw-wrap is-plain"><input id="pwCurrent" type="password" autocomplete="current-password"><button type="button" class="pw-eye" data-eye="pwCurrent" aria-label="Show password">' + EYE + '</button></div>' +
        '<label class="pop-label" for="pwNew">New password</label><div class="pw-wrap is-plain"><input id="pwNew" type="password" autocomplete="new-password"><button type="button" class="pw-eye" data-eye="pwNew" aria-label="Show password">' + EYE + '</button></div>' +
        '<label class="pop-label" for="pwNew2">Type it again</label><div class="pw-wrap is-plain"><input id="pwNew2" type="password" autocomplete="new-password"></div>' +
        '<div class="pop-hint">8+ characters, letters and numbers, not your name. Your other devices will be signed out.</div>' +
        '<div class="pin-msg" id="pwMsg" role="alert"></div>' +
        '<button type="submit" class="btn-brutal" id="pwSave">CHANGE PASSWORD</button></form>' +
      '<button type="button" class="btn-ghost acct-logout" data-act="logout">' + icon('logout', 16) + 'Log out</button>' +
      (state.role !== 'ADMIN' ? '<div class="peek-card"><h3>COMING SOON</h3>' + (state.role === 'SALES' ? ['Enquiries — send a booking request', 'Delays on your jobs'] : ['Enquiries from sales', 'Morning follow-up round', 'Mark delay', 'Fleet timeline', 'Costing and analysis']).map((t) => '<div class="kv"><span class="kv-k">' + esc(t) + '</span><span class="kv-v">SOON</span></div>').join('') + '</div>' : '');
  }
  function openAccount(opener) {
    closeOverlays(true);
    $('#drawerKicker').textContent = 'MY ACCOUNT';
    $('#drawerBody').innerHTML = accountPanel();
    showDrawer(opener);
    state.overlay = 'account';
  }
  async function submitPwChange(form) {
    const cur = $('#pwCurrent', form).value, pw = $('#pwNew', form).value, pw2 = $('#pwNew2', form).value;
    const msg = $('#pwMsg', form);
    const problem = pwProblem(pw, state.user);
    if (!cur) { setLoginMsg(msg, 'Enter your current password.', 'error'); return; }
    if (problem) { setLoginMsg(msg, problem, 'error'); return; }
    if (pw !== pw2) { setLoginMsg(msg, 'The two new passwords don’t match.', 'error'); return; }
    const btn = $('#pwSave', form); btn.disabled = true; btn.textContent = 'SAVING…';
    try {
      const res = await api.call('ethixChangePassword', [cur, pw]);
      if (res && res.ok) { closeOverlays(); toast('Password changed. Your other devices were signed out.'); return; }
      setLoginMsg(msg, (res && res.error) || 'Not changed.', 'error');
    } catch (e) { if (e.kind !== 'auth') setLoginMsg(msg, /not available/i.test(e.message) ? 'Needs the Phase 3 Code.gs update.' : e.message, 'error'); }
    btn.disabled = false; btn.textContent = 'CHANGE PASSWORD';
  }

  // ================================================================ ADMIN
  const ROLE_CHIP = { CS: ['Customer Service', 'chip-teal'], SALES: ['Sales', 'chip-sales'], ADMIN: ['Admin', 'chip-hold'], ACCOUNTS: ['Accounts', 'chip-calm'] };
  const PW_TEXT = { SET: 'Password set', TEMPORARY: 'Temporary — must change at sign-in', 'PIN ONLY': 'Old PIN — sets a password at next sign-in', NONE: 'No password' };
  function tempPassword() {
    const a = new Uint32Array(4); window.crypto.getRandomValues(a);
    const L = 'abcdefghjkmnpqrstuvwxyz';                                // no i / l / o — easy to read out
    return 'Ethix-' + String(1000 + (a[0] % 9000)) + '-' + L[a[1] % L.length] + L[a[2] % L.length] + L[a[3] % L.length];
  }
  function adminData() { return state.admin || { users: [], suggestions: [] }; }
  function renderAdmin(first) {
    const t0 = today0();
    const A = adminData();
    const anim = first ? ' reveal' : '';
    const n = { all: A.users.length, online: A.users.filter((u) => u.online).length, locked: A.users.filter((u) => u.locked).length, waiting: A.users.filter((u) => u.password !== 'SET').length };
    $('#view').innerHTML =
      '<div class="wrap admin-page">' +
      '<header class="page-head' + anim + '">' +
        '<div class="head-main"><div class="meta-line"><span>ADMIN · ' + esc(fmtLong(t0)) + '</span><span class="sync" id="sync"><span class="sync-dot"></span><span id="syncText">' + syncText() + '</span></span></div><h1 class="greeting">People</h1></div>' +
        '<div class="head-actions">' +
          '<button type="button" class="btn-ghost" id="refreshBtn" data-act="refresh" aria-label="Refresh"><span class="spin">' + icon('refresh', 16) + '</span><span class="btn-label">Refresh</span></button>' +
          '<button type="button" class="btn-ghost" data-act="adm-out-all" aria-label="Sign out everyone">' + icon('logout', 16) + '<span class="btn-label">Sign out everyone</span></button>' +
          '<button type="button" class="btn-brutal btn-icon" data-act="adm-add">' + icon('plus', 16) + '<span>ADD USER</span></button>' +
        '</div>' +
      '</header>' +
      (!state.admin ? '<section class="tile">' + empty('admin', 'The admin tools need the Phase 3 Code.gs update.') + '</section>' :
      '<div class="admin-stats' + anim + '" style="--d:40ms"><span><b>' + n.all + '</b> users</span><span><i class="dot is-on"></i><b>' + n.online + '</b> online now</span><span' + (n.locked ? ' class="is-red"' : '') + '><b>' + n.locked + '</b> locked</span><span><b>' + n.waiting + '</b> still to set a password</span></div>' +
      '<section class="tile users-card' + anim + '" style="--d:80ms" aria-label="Users"><div class="users-headrow" aria-hidden="true"><span>NAME</span><span>ROLE</span><span>STATUS</span><span>PASSWORD</span><span></span></div>' +
        '<ul class="users-list">' + A.users.map((u) => {
          const rc = ROLE_CHIP[u.role] || ROLE_CHIP.CS;
          return '<li class="user-row">' +
            '<span class="ur-name"><span class="avatar' + (u.role === 'SALES' ? ' is-other' : '') + '">' + esc(initials(u.name)) + '</span><span><b>' + esc(u.name) + '</b>' + (u.name === state.user ? ' <span class="you">YOU</span>' : '') + '</span></span>' +
            '<span class="ur-role"><span class="chip ' + rc[1] + '">' + rc[0] + '</span></span>' +
            '<span class="ur-status">' + (u.locked ? '<span class="chip chip-urgent">' + icon('alert', 13) + 'Locked · ' + u.locked + ' min</span>' : u.online ? '<span class="online"><i class="dot is-on"></i>Online' + (u.sessions > 1 ? ' · ' + u.sessions + ' devices' : '') + '</span>' : '<span class="online"><i class="dot"></i>' + (u.sessions ? 'Signed in · idle' : 'Offline') + '</span>') + '</span>' +
            '<span class="ur-pw">' + esc(PW_TEXT[u.password] || u.password) + '</span>' +
            '<span class="ur-act">' + (u.locked ? '<button type="button" class="btn-ghost btn-sm" data-adm="unlock" data-user="' + esc(u.name) + '">Unlock</button>' : '') +
              (u.name !== state.user && !(u.name === 'MASTER' && state.user !== 'MASTER') ? '<button type="button" class="icon-btn" data-adm="menu" data-user="' + esc(u.name) + '" aria-label="Manage ' + esc(u.name) + '">' + icon('more', 18) + '</button>' : '') + '</span>' +
          '</li>';
        }).join('') + '</ul></section>' +
      (A.suggestions.length ? '<section class="tile sugg-card' + anim + '" style="--d:120ms"><div class="tile-head"><h2 class="tile-title">SALES PEOPLE WITHOUT AN ACCOUNT</h2><span class="small">From the tracker · tap to add</span></div><div class="sugg-row">' +
        A.suggestions.slice(0, 40).map((s) => '<button type="button" class="sugg" data-adm="add-sales" data-user="' + esc(s.name) + '"><span class="avatar is-other">' + esc(initials(s.name)) + '</span><span><b>' + esc(s.name) + '</b><small>' + s.jobs + (s.jobs === 1 ? ' job' : ' jobs') + '</small></span>' + icon('plus', 16) + '</button>').join('') + '</div></section>' : '')) +
      '</div>';
  }
  function peopleAction(a) {
    a = String(a || '');
    const M = [
      [/^LOGGED IN$/, () => 'signed in'], [/^LOGGED OUT$/, () => 'signed out'],
      [/^SET A NEW PASSWORD$/, () => 'set their own password'], [/^CHANGED PASSWORD$/, () => 'changed their password'],
      [/^CREATED USER (.+) \((.+)\)$/, (m) => 'created an account for ' + m[1] + ' · ' + nice(m[2])],
      [/^RESET PASSWORD FOR (.+)$/, (m) => 'reset the password of ' + m[1]],
      [/^CHANGED ROLE OF (.+) TO (.+)$/, (m) => 'made ' + m[1] + ' ' + nice(m[2])],
      [/^REMOVED USER (.+)$/, (m) => 'removed ' + m[1]], [/^UNLOCKED (.+)$/, (m) => 'unlocked ' + m[1]],
      [/^SIGNED OUT EVERYONE$/, () => 'signed everyone out'], [/^SIGNED OUT (.+)$/, (m) => 'signed out ' + m[1]],
      [/^(?:LOCKED|PIN LOCKOUT) — (\d+) WRONG (PASSWORDS|PINS)$/, (m) => 'was locked after ' + m[1] + ' wrong ' + m[2].toLowerCase()]
    ];
    for (const [re, f] of M) { const m = a.match(re); if (m) return f(m); }
    return friendly(a);
  }
  function renderActivity(first) {
    const q = (state.actQ || '').toUpperCase();
    const rows = (state.activity || []).filter((r) => !q || (r.join(' ').toUpperCase().includes(q)));
    const anim = first ? ' reveal' : '';
    $('#view').innerHTML = '<div class="wrap admin-page">' +
      '<header class="page-head act-head' + anim + '"><div class="head-main"><div class="meta-line"><span>ADMIN · LAST ' + (state.activity || []).length + ' ACTIONS</span></div><h1 class="greeting">Activity</h1></div>' +
        '<div class="head-actions"><label class="search">' + icon('search') + '<input id="actSearch" type="search" placeholder="Name, action, job no…" aria-label="Filter activity" autocomplete="off" value="' + esc(state.actQ || '') + '"></label>' +
        '<button type="button" class="btn-ghost" id="refreshBtn" data-act="refresh" aria-label="Refresh"><span class="spin">' + icon('refresh', 16) + '</span><span class="btn-label">Refresh</span></button></div></header>' +
      '<section class="tile' + anim + '" style="--d:40ms">' + (rows.length ? '<ol class="activity-list">' + rows.map((r) => '<li' + (/LOCK/.test(r[2]) && !/^UNLOCKED/.test(r[2]) ? ' class="is-alert"' : '') + '><span class="al-when">' + esc(r[0]) + '</span><span class="avatar' + (r[1] === state.user ? '' : ' is-other') + '">' + esc(initials(r[1])) + '</span><span class="al-text"><b>' + esc(r[1]) + '</b> ' + esc(peopleAction(r[2])) + (r[3] ? ' <span class="nt-job">' + esc(r[3]) + '</span>' : '') + '</span></li>').join('') + '</ol>' : empty('clock', 'Nothing matches.')) + '</section></div>';
  }

  // admin actions
  function adminMenu(name) {
    return () => {
      const u = adminData().users.find((x) => x.name === name); if (!u) return '';
      return '<div class="pop-title">' + esc(name) + '</div><div class="pop-label">Role</div><div class="choice-row is-stack">' +
        [['CS', 'Customer Service'], ['SALES', 'Sales'], ['ADMIN', 'Admin']].map(([v, l]) => '<button type="button" class="choice' + (u.role === v ? ' is-on' : '') + '" data-adm="role" data-role="' + v + '" data-user="' + esc(name) + '" aria-pressed="' + (u.role === v) + '">' + l + '</button>').join('') + '</div>' +
        '<button type="button" class="btn-ghost pop-wide" data-adm="reset" data-user="' + esc(name) + '">' + icon('refresh', 16) + 'Reset password</button>' +
        '<button type="button" class="btn-ghost pop-wide" data-adm="signout" data-user="' + esc(name) + '"' + (u.sessions ? '' : ' disabled') + '>' + icon('logout', 16) + 'Sign out ' + (u.sessions ? '(' + u.sessions + (u.sessions === 1 ? ' device' : ' devices') + ')' : '— not signed in') + '</button>' +
        (name !== 'MASTER' ? '<button type="button" class="btn-ghost pop-wide is-danger" data-adm="remove" data-user="' + esc(name) + '">Remove ' + esc(name) + '</button>' : '');
    };
  }
  function credentialsCard(name, pw, isNew) {
    return '<div class="cred-card"><div class="kicker">' + (isNew ? 'ACCOUNT READY' : 'PASSWORD RESET') + '</div>' +
      '<div class="kv"><span class="kv-k">Username</span><span class="kv-v">' + esc(name) + '</span></div>' +
      '<div class="kv"><span class="kv-k">Temporary password</span><span class="kv-v" id="credPw">' + esc(pw) + '</span></div>' +
      '<p class="pop-text">Send these to ' + esc(nice(name)) + ' privately (e.g. WhatsApp). At first sign-in they must choose their own password — you won’t know it.</p>' +
      '<div class="form-actions is-inline"><button type="button" class="btn-ghost" data-adm="copy" data-text="' + esc('Username: ' + name + '\nTemporary password: ' + pw) + '">' + icon('copy', 16) + 'Copy</button><button type="button" class="btn-brutal" data-act="form-done">DONE</button></div></div>';
  }
  function openAddUser(name, role) {
    closeOverlays(true);
    const A = adminData();
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'ADD USER';
    $('#drawerBody').innerHTML = '<h2 class="peek-job form-title" id="drawerTitle">New account</h2>' +
      '<form class="job-form" id="addUserForm" novalidate><div class="fgrid">' +
        '<div class="field is-wide"><label for="auName">Name (this is their username)</label><input id="auName" class="is-upper" list="dlSugg" autocomplete="off" spellcheck="false" value="' + esc(name || '') + '" placeholder="e.g. VINEETH"><div class="field-err" id="auName_err"></div></div>' +
        '<div class="field is-wide"><label>Role</label><div class="choice-row" role="radiogroup" aria-label="Role">' + [['CS', 'Customer Service'], ['SALES', 'Sales'], ['ADMIN', 'Admin']].map(([v, l]) => '<button type="button" class="choice' + ((role || 'CS') === v ? ' is-on' : '') + '" role="radio" data-pick-role="' + v + '" aria-checked="' + ((role || 'CS') === v) + '">' + l + '</button>').join('') + '</div><p class="pop-hint" id="auRoleHint"></p></div>' +
        '<div class="field is-wide"><label for="auPw">Temporary password</label><div class="date-row"><input id="auPw" value="' + esc(tempPassword()) + '" autocomplete="off" spellcheck="false"><button type="button" class="choice" data-adm="gen">New</button></div><div class="field-err" id="auPw_err"></div></div>' +
      '</div>' + datalist('dlSugg', A.suggestions.map((s) => s.name)) +
      '<div class="form-error" id="formError" role="alert"></div>' +
      '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit">CREATE ACCOUNT</button></div></form>';
    state.addRole = role || 'CS';
    roleHint();
    showDrawer(document.activeElement);
    state.overlay = 'admin';
    setTimeout(() => { const f = $('#auName'); if (f && !name) f.focus(); }, 30);
  }
  function roleHint() {
    const h = $('#auRoleHint'); if (!h) return;
    h.textContent = { CS: 'Sees and updates every job.', SALES: 'Sees only the jobs with their name as sales person, and can add notes.', ADMIN: 'Manages people only — no jobs.' }[state.addRole];
  }
  async function adminCall(fn, args, okText) {
    try {
      setSaving(1);
      const res = await api.call(fn, args);
      if (res && res.ok) { if (res.list) state.admin = res.list; rerender(); if (okText) toast(okText); return res; }
      toast((res && res.error) || 'Not done.', { error: true });
    } catch (e) { if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Needs the Phase 3 Code.gs update.' : e.message, { error: true }); }
    finally { setSaving(-1); }
    return null;
  }
  function confirmBox(title, text, yes, onYes) {
    const wrap = $('#confirmWrap');
    $('#confirmTitle').textContent = title; $('#confirmText').textContent = text; $('#confirmYes').textContent = yes;
    wrap.hidden = false; $('#confirmNo').focus();
    const close = () => { wrap.hidden = true; $('#confirmTitle').textContent = 'Log out?'; $('#confirmText').textContent = 'You’ll need your password to come back in.'; $('#confirmYes').textContent = 'Log out'; };
    $('#confirmNo').onclick = close;
    $('#confirmYes').onclick = () => { close(); onYes(); };
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
  }
  function initPeople() {
    const view = $('#view');
    view.addEventListener('click', (e) => {
      if (state.role !== 'ADMIN') return;
      const b = e.target.closest('[data-adm], [data-act="adm-out-all"]'); if (!b) return;
      const name = b.dataset.user;
      if (b.dataset.act === 'adm-out-all') { confirmBox('Sign out everyone?', 'Everyone except you is signed out on every device right away.', 'Sign out all', () => adminCall('ethixAdminSignOut', ['*'], 'Everyone else was signed out')); return; }
      if (b.dataset.adm === 'unlock') { adminCall('ethixAdminUnlock', [name], name + ' unlocked'); return; }
      if (b.dataset.adm === 'menu') { openPop(b, 'MANAGE', adminMenu(name)); return; }
      if (b.dataset.adm === 'add-sales') { openAddUser(name, 'SALES'); }
    });
    view.addEventListener('input', (e) => { if (e.target.id === 'actSearch') { state.actQ = e.target.value; rerender(); } });
    const onAdm = (e) => {
      if (state.role !== 'ADMIN') return;
      const b = e.target.closest('[data-adm], [data-pick-role], [data-act="form-done"]'); if (!b) return;
      const name = b.dataset.user;
      if (b.dataset.act === 'form-done') { closeOverlays(); return; }
      if (b.dataset.pickRole) { state.addRole = b.dataset.pickRole; $$('[data-pick-role]').forEach((x) => { const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-checked', String(on)); }); roleHint(); return; }
      if (b.dataset.adm === 'gen') { $('#auPw').value = tempPassword(); return; }
      if (b.dataset.adm === 'copy') { const t = b.dataset.text; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copied'), () => toast('Select and copy the text instead', { error: true })); return; }
      if (b.dataset.adm === 'role') { const r = b.dataset.role; closeOverlays(); adminCall('ethixAdminRole', [name, r], name + ' is now ' + (r === 'CS' ? 'Customer Service' : nice(r)) + ' (signed out to apply it)'); return; }
      if (b.dataset.adm === 'signout') { closeOverlays(); adminCall('ethixAdminSignOut', [name], name + ' was signed out'); return; }
      if (b.dataset.adm === 'remove') { closeOverlays(); confirmBox('Remove ' + name + '?', name + ' will no longer be able to sign in. Their name stays on jobs and in history.', 'Remove', () => adminCall('ethixAdminRemove', [name], name + ' removed')); return; }
      if (b.dataset.adm === 'reset') {
        closeOverlays(true);
        const pw = tempPassword();
        $('#drawer').classList.add('is-wide');
        $('#drawerKicker').textContent = 'RESET PASSWORD';
        $('#drawerBody').innerHTML = '<h2 class="peek-job form-title" id="drawerTitle">' + esc(name) + '</h2><form class="job-form" id="resetForm" data-user="' + esc(name) + '" novalidate><div class="field is-wide"><label for="auPw">New temporary password</label><div class="date-row"><input id="auPw" value="' + esc(pw) + '" autocomplete="off" spellcheck="false"><button type="button" class="choice" data-adm="gen">New</button></div><div class="field-err" id="auPw_err"></div></div><p class="pop-text">They are signed out everywhere and must choose a new password at their next sign-in.</p><div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit">RESET PASSWORD</button></div></form>';
        showDrawer(document.activeElement);
        state.overlay = 'admin';
      }
    };
    $('#pop').addEventListener('click', onAdm);
    $('#drawerBody').addEventListener('click', (e) => {
      if (state.role !== 'ADMIN' || (state.overlay !== 'admin' && state.overlay !== 'sheet')) return;
      if (e.target.closest('[data-act="form-cancel"]')) { closeOverlays(); return; }
      onAdm(e);
    });
    $('#drawerBody').addEventListener('submit', async (e) => {
      if (state.overlay === 'account' && e.target.id === 'pwForm') { e.preventDefault(); submitPwChange(e.target); return; }
      if (state.overlay !== 'admin') return;
      e.preventDefault();
      const f = e.target;
      const pw = $('#auPw', f).value.trim();
      const btn = $('#formSubmit', f);
      if (f.id === 'addUserForm') {
        const name = $('#auName', f).value.trim().toUpperCase().replace(/\s+/g, ' ');
        $('#auName_err').textContent = ''; $('#auPw_err').textContent = ''; $('#formError').textContent = '';
        if (!/^[A-Z][A-Z .'-]{1,29}$/.test(name)) { $('#auName_err').textContent = 'Letters only, 2–30 characters.'; return; }
        const p = pwProblem(pw, name); if (p) { $('#auPw_err').textContent = p; return; }
        btn.disabled = true; btn.textContent = 'CREATING…';
        const res = await adminCall('ethixAdminCreate', [name, state.addRole, pw], null);
        if (res) { $('#drawerBody').innerHTML = credentialsCard(name, pw, true); return; }
        btn.disabled = false; btn.textContent = 'CREATE ACCOUNT';
      }
      if (f.id === 'resetForm') {
        const name = f.dataset.user;
        const p = pwProblem(pw, name); if (p) { $('#auPw_err').textContent = p; return; }
        btn.disabled = true; btn.textContent = 'RESETTING…';
        const res = await adminCall('ethixAdminReset', [name, pw], null);
        if (res) { $('#drawerBody').innerHTML = credentialsCard(name, pw, false); return; }
        btn.disabled = false; btn.textContent = 'RESET PASSWORD';
      }
    });
  }

  // ------------------------------------------------------------ lists & menus
  function openList(kind, opener) {
    const m = lastMetrics; if (!m) return;
    const map = {
      active: ['ACTIVE JOBS', m.active], costing: ['COSTING DUE', m.costing], sied: ['SI / ED DUE', m.sied],
      free: ['FREE TIME ENDING ≤ 2 DAYS', m.freeJobs], atsea: ['AT SEA NOW', m.atSea], arriving: ['ARRIVING THIS WEEK', m.arriving],
      departing: ['DEPARTING THIS WEEK', m.departing], hold: ['ON HOLD', m.hold], watch: ['TODAY’S WATCH', m.watch.map((w) => w.j)]
    };
    const entry = map[kind]; if (!entry) return;
    const list = Array.from(new Set(entry[1]));
    closeOverlays(true);
    $('#drawerKicker').textContent = list.length + (list.length === 1 ? ' JOB' : ' JOBS');
    $('#drawerBody').innerHTML = '<h2 class="peek-job list-title" id="drawerTitle">' + esc(entry[0]) + '</h2>' +
      (list.length ? '<div>' + list.map((j) =>
        '<button type="button" class="list-row" data-job="' + esc(j.jobNo) + '"><span class="lr-main"><span class="li-job">' + esc(j.jobNo) + ' · ' + esc(j.type) + '</span>' +
        '<span class="lr-cust">' + esc(j.customer || '—') + '</span><span class="li-sub">' + esc(j.route) + '</span></span>' + toneChip(j.next) + '</button>'
      ).join('') + '</div>' : '<div class="tile-empty">Nothing here right now.</div>');
    showDrawer(opener);
    state.overlay = 'drawer';
  }

  let drawerOpener = null;
  function showDrawer(opener) {
    drawerOpener = opener || document.activeElement;
    $('#scrim').hidden = false; $('#drawer').hidden = false;
    $('#drawerBody').scrollTop = 0;
    $('#drawerClose').focus({ preventScroll: true });
  }
  function hideDrawer(silent) {
    $('#scrim').hidden = true; $('#drawer').hidden = true;
    $('#drawer').classList.remove('is-wide');
    popRender = null;
    if (!silent && drawerOpener && document.body.contains(drawerOpener)) drawerOpener.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ search
  let searchIndex = -1;
  function runSearch(q) {
    const box = $('#searchResults'); if (!box) return;
    q = q.trim().toUpperCase();
    if (!q) { box.hidden = true; return; }
    const hits = state.jobs.filter((j) => (j.jobNo + ' ' + j.customer + ' ' + j.pol + ' ' + j.pod + ' ' + j.cs + ' ' + j.sales + ' ' + j.type).toUpperCase().includes(q))
      .sort((a, b) => (b.active - a.active) || ((b.jobNo.toUpperCase().startsWith(q) ? 1 : 0) - (a.jobNo.toUpperCase().startsWith(q) ? 1 : 0)))
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
    const btn = $('#refreshBtn'), sync = $('#sync');
    if (btn) btn.classList.add('is-busy'); if (sync) sync.classList.add('is-busy');
    try {
      let boot;
      try { boot = await api.call('ethixBootstrap'); }
      catch (e) { if (e.kind === 'server' && /not available/i.test(e.message)) boot = await legacyBoot(state.user, state.role); else throw e; }
      const before = notifUnread(), newest = state.notif && state.notif.items[0] ? state.notif.items[0].t : 0;
      applyBoot(boot);
      if (state.overlay === 'form' || state.overlay === 'pop' || state.overlay === 'sheet' || state.overlay === 'admin') state.dirty = true;
      else { rerender(); refreshOverlay(); }
      updateNav();
      const fresh = state.notif ? state.notif.items.filter((x) => x.t > newest && x.t > (state.notif.seen || 0)) : [];
      state.nudged = fresh.length && notifUnread() > before && state.overlay !== 'drawer';
      if (state.nudged) toast(fresh.length === 1 ? nice(fresh[0].from) + ' · ' + fresh[0].job + ': ' + fresh[0].text : fresh.length + ' new notifications', { action: { label: 'View', fn: () => openNotifications() } });
      if (state.route && state.route.name === 'job') loadStory(state.route.jobNo, true);
      if (manual && !state.nudged) toast('Up to date');
    } catch (e) {
      if (e.kind !== 'auth') toast(e.message, { error: true });
    } finally {
      state.refreshing = false;
      const b2 = $('#refreshBtn'), s2 = $('#sync');
      if (b2) b2.classList.remove('is-busy'); if (s2) s2.classList.remove('is-busy');
    }
  }

  // ------------------------------------------------------------ session & timers
  let ending = false;
  function sessionLost(msg) {
    if (ending) return; ending = true; api.token = null;
    toast(msg || 'Your session has ended. Please sign in again.', { error: true });
    setTimeout(() => window.location.reload(), 1800);
  }
  function startTimers() {
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => { state.lastActive = Date.now(); }, { passive: true }));
    setInterval(() => { const el = $('#syncText'); if (el) el.textContent = syncText(); }, 30000);
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !api.token) return;
      if (Date.now() - state.lastActive < 10 * 60 * 1000) refresh(false);
      else api.call('ethixPing').catch(() => {});
    }, 3 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && api.token && Date.now() - state.syncedAt > 3 * 60 * 1000) refresh(false);
    });
  }

  function confirmLogout() {
    closeOverlays(true);
    $('#confirmTitle').textContent = 'Log out?'; $('#confirmText').textContent = 'You’ll need your password to come back in.'; $('#confirmYes').textContent = 'Log out';
    const wrap = $('#confirmWrap'); wrap.hidden = false; $('#confirmNo').focus();
    const close = () => { wrap.hidden = true; };
    $('#confirmNo').onclick = close;
    $('#confirmYes').onclick = () => { api.logout(); document.body.style.opacity = '0.6'; history.replaceState(null, '', location.pathname + location.search); setTimeout(() => window.location.reload(), 250); };
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
  }

  function toast(text, opts = {}) {
    if (typeof opts === 'boolean') opts = { error: opts };
    const t = document.createElement('div');
    t.className = 'toast' + (opts.error ? ' is-error' : '');
    const span = document.createElement('span'); span.textContent = text; t.appendChild(span);
    if (opts.action) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-btn'; b.textContent = opts.action.label;
      b.onclick = () => { t.remove(); opts.action.fn(); };
      t.appendChild(b);
    }
    const box = $('#toasts');
    while (box.children.length > 1) box.firstChild.remove();
    box.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, opts.action ? 6000 : opts.error ? 4200 : 2200);
  }

  function initApp() {
    const view = $('#view');
    view.addEventListener('click', (e) => {
      const r = state.route ? state.route.name : 'home';
      const jobBtn = e.target.closest('[data-job]');
      if (jobBtn && !e.target.closest('[data-stop]')) { const box = $('#searchResults'); if (box) box.hidden = true; openJob(jobBtn.dataset.job); return; }
      if (e.target.closest('[data-act="refresh"]')) { refresh(true); return; }
      if (r !== 'home') return;
      const listBtn = e.target.closest('[data-list]');
      if (listBtn) { openList(listBtn.dataset.list, listBtn); return; }
      const weekBtn = e.target.closest('[data-week]');
      if (weekBtn) { state.week = weekBtn.dataset.week; rerender(); return; }
      const scopeBtn = e.target.closest('[data-scope]');
      if (scopeBtn && canEdit()) { state.scope = scopeBtn.dataset.scope; store.set('ethix.v2.scope.' + state.user, state.scope); rerender(); }
    });
    view.addEventListener('scroll', (e) => { if (e.target.classList && e.target.classList.contains('tile-body')) markOverflow(); }, true);
    window.addEventListener('resize', () => { if (!$('#shell').hidden) markOverflow(); });
    view.addEventListener('input', (e) => { if (e.target.id === 'searchInput') runSearch(e.target.value); });
    view.addEventListener('keydown', (e) => {
      if (e.target.id !== 'searchInput') return;
      const box = $('#searchResults'); const items = box ? $$('.result', box) : [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!items.length) return;
        searchIndex = (searchIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((x, i) => x.classList.toggle('is-active', i === searchIndex));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = items[searchIndex >= 0 ? searchIndex : 0]; if (target) target.click();
      } else if (e.key === 'Escape') { e.target.value = ''; if (box) box.hidden = true; }
    });
    document.addEventListener('click', (e) => {
      const box = $('#searchResults'); if (box && !e.target.closest('.search-wrap')) box.hidden = true;
      if (!state.signedIn) return;
      const nav = e.target.closest('[data-href]');
      if (nav && !nav.disabled) { e.preventDefault(); closeOverlays(true); go(nav.dataset.href); return; }
      if (e.target.closest('[data-act="new-job"]')) { openNewJob(); return; }
      const nb = e.target.closest('[data-act="notif"]'); if (nb) { openNotifications(nb); return; }
      const ab = e.target.closest('[data-act="account"], [data-act="more"]'); if (ab) { openAccount(ab); return; }
      if (e.target.closest('[data-act="adm-add"]') && isAdmin()) openAddUser();
    });
    document.addEventListener('keydown', (e) => {
      if (!state.signedIn) return;
      if (e.key === 'Escape') {
        if (!$('#confirmWrap').hidden) { $('#confirmWrap').hidden = true; return; }
        if (state.overlay || !$('#drawer').hidden) { closeOverlays(); return; }
      }
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) { const s = $('#searchInput') || $('#jobsSearch'); if (s) { e.preventDefault(); s.focus(); } }
    });
    $('#drawerBody').addEventListener('click', (e) => {
      if (['form', 'sheet', 'quick', 'admin'].includes(state.overlay)) return;
      const jobBtn = e.target.closest('[data-job]'); if (jobBtn) { openJob(jobBtn.dataset.job); return; }
      if (e.target.closest('[data-act="logout"]')) { closeOverlays(true); confirmLogout(); }
    });
    $('#drawerClose').addEventListener('click', () => closeOverlays());
    $('#scrim').addEventListener('click', () => closeOverlays());
    $('#logoutBtn').addEventListener('click', confirmLogout);
    window.addEventListener('hashchange', () => { if (!state.signedIn) return; state.navDepth++; closeOverlays(true); render(false); });
  }

  // -------------------------------------------------------------------- start
  function start() {
    initSignin();
    initApp();
    initJobs();
    initVoyage();
    initForms();
    initPeople();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // exposed for automated tests only (no data, no token)
  window.__ethix = { parseDate, mapHeaders, buildJob, computeHome, today0, journeyFor, nextStep, voyage: () => ({ running: voyage.running, leg: voyage.leg, phase: voyage.phase }) };
})();
