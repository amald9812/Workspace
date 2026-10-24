/* =============================================================================
   ETHIX v2 — APP (sign-in, Home, Jobs, voyage, new job, people, notifications,
   enquiries, follow-ups, delays, close & archive, costing, reminders — v2.9.2)
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
    notif: null, lastNotes: {}, admin: null, activity: [], actQ: '',
    follow: { plan: {}, checks: {}, days: 35 }, followBusy: new Set(), followHist: {}, calOffset: {}, delays: {}, enquiries: [],
    closedJobs: new Map(), closedTry: {}, archive: { jobs: null, total: 0, loading: false, seq: 0 }, closeForm: null,
    costing: {}, rate: 3.685, cost: null, costUi: { tab: 'pending', q: '' }, resuming: false,
    enqTab: '', enqQ: '', roundQ: '', delayForm: null, newEnq: { type: '' }, enqSub: null, enqOpenId: null
  };

  // ---------------------------------------------------------- dates & parsing
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const MON_UP = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const DOW_UP = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // v2.9.2: Ethix works on Dubai time. dxb(moment) = a Date whose hours, minutes and day read as Dubai's (UTC+4, no summer time).
  function dxb(t) { const x = t === undefined ? Date.now() : +t; return new Date(x + (240 + new Date(x).getTimezoneOffset()) * 60000); }
  function today0() { const d = dxb(); d.setHours(0, 0, 0, 0); return d; }   // today in Dubai
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
    ['portFree', (h) => h.startsWith('PORT FREE'), 28], ['against', (h) => h.startsWith('AGAINST'), 29], ['freight', (h) => h.startsWith('LINE FREIGHT'), 30],
    ['dgpc', (h) => h.startsWith('DGPC'), -1]   // v2.9.2: added at the end of the tracker on first use
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
      loadlist: g('loadlist').toUpperCase(), sido: g('sido').toUpperCase(), ed: g('ed').toUpperCase(), bl: g('bl').toUpperCase(), dgpc: g('dgpc').toUpperCase(),
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
    dgpc: ['PENDING', 'SUBMITTED', 'APPROVED', NA],
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
    dgpc:       { name: 'DGPC submitted', kind: 'field', field: 'dgpc', done: ['SUBMITTED', 'APPROVED'], primary: 'SUBMITTED', cut: 'dgCut', label: 'DGPC status', next: 'DGPC to submit' },
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
    const origin = (key === 'SEA_EX' && j.dg === 'DG' ? J.o.slice(0, 3).concat('dgpc', J.o.slice(3)) : J.o).map((id) => make(id, 'o'));   // v2.9.2: DG → DGPC after ED
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
    polishStops(all);
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
    const watch = watchItems91(active, t0);   // v2.9.1: every open task before sailing, overdue after it, free time

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
        store.set(LAST_USER, user); keepSession(user, res && res.role);
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
        store.set(LAST_USER, user); keepSession(user, res && res.role);
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
    $('#newPwCancel').addEventListener('click', () => { api.logout(); dropSession(); $('#stepNewPw').hidden = true; $('#stepLogin').hidden = false; $('#loginPass').value = ''; $('#loginPass').focus(); });
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
    if (boot.follow) state.follow = { plan: boot.follow.plan || {}, checks: boot.follow.checks || {}, days: boot.follow.days || 35 };
    if (boot.delays) state.delays = boot.delays;
    if (Array.isArray(boot.enquiries)) state.enquiries = boot.enquiries;
    state.costing = boot.costing || {};
    applyBoot9(boot);   // v2.9: reminders, what changed, what you opened
    if (boot.rate) state.rate = boot.rate;
    state.followHist = {};
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
  function findJob(no) { const k = String(no || '').toUpperCase(), i = state.jobIndex.get(k); return i === undefined ? (state.closedJobs.get(k) || null) : state.jobs[i]; }

  function enterApp(boot, name, role) {
    state.user = (boot.me && boot.me.user) || name;
    state.role = normRole((boot.me && boot.me.role) || role, state.user);
    applyBoot(boot);
    state.scope = canEdit() ? 'mine' : 'all';   // v2.8: Customer Service sees their own jobs only
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
    const mc = h.match(/^#\/costing\/(.+)$/);
    let r = m ? { name: 'job', jobNo: m[1].trim() } : mc ? { name: 'costjob', jobNo: mc[1].trim() } : h === '#/costing' ? { name: 'costing' } : h === '#/jobs' ? { name: 'jobs' } : h === '#/admin' ? { name: 'admin' } : h === '#/activity' ? { name: 'activity' } : h === '#/enquiries' ? { name: 'enquiries' } : h === '#/follow-ups' || h === '#/round' ? { name: 'round' } : h === '#/notifications' ? { name: 'notif' } : { name: 'home' };
    if (isAdmin()) { if (r.name !== 'activity') r = { name: 'admin' }; }      // admin works with people, not jobs
    else if (r.name === 'admin' || r.name === 'activity' || (r.name === 'round' && !canEdit()) || (r.name === 'enquiries' && !canNote()) || ((r.name === 'costing' || r.name === 'costjob') && !canNote())) r = { name: 'home' };
    const want = r.name === 'admin' ? '#/admin' : r.name === 'activity' ? '#/activity' : r.name === 'home' && /^#\/(admin|activity|round|follow-ups|enquiries|costing)$/.test(h) ? '#/home' : r.name === 'round' && h === '#/round' ? '#/follow-ups' : null;
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
    else if (r.name === 'round') renderRound(changed || first);
    else if (r.name === 'enquiries') renderEnquiries(changed || first);
    else if (r.name === 'costing') renderCostList(changed || first);
    else if (r.name === 'costjob') renderCostJob(r.jobNo, changed || first);
    else if (r.name === 'notif') renderNotifPage(changed || first);
    else if (r.name === 'job') { if (changed || first) seenOpen9(r.jobNo); renderVoyage(r.jobNo, changed || first); fitNames(); }
    else { renderHome(changed || first); fitNames(); fitPorts91(); }
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
    const active = scoped().filter((j) => j.active).length;
    if (isAdmin()) return [
      { id: 'admin', label: 'People', icon: 'users', href: '#/admin', count: state.admin ? state.admin.users.length : 0 },
      { id: 'activity', label: 'Activity', icon: 'clock', href: '#/activity' }
    ];
    const items = [
      { id: 'home', label: 'Home', icon: 'home', href: '#/home' },
      { id: 'jobs', label: isSales() ? 'My jobs' : 'Jobs', icon: 'jobs', href: '#/jobs', count: active },
      { id: 'notif', label: 'Notifications', icon: 'bell', act: 'notif' }
    ];
    if (isSales()) items.push({ id: 'enquiries', label: 'My enquiries', icon: 'enq', href: '#/enquiries', count: enqOpen().length });
    else if (canEdit()) items.push(
      { id: 'round', label: 'Follow-ups', icon: 'check', href: '#/follow-ups', count: roundRows(today0()).due.length + remDueCount() },
      { id: 'enquiries', label: 'Enquiries', icon: 'enq', href: '#/enquiries', count: enqNew().length },
      { id: 'costing', label: 'Costing', icon: 'costing', href: '#/costing', count: costRows().open });
    if (isSales()) items.splice(items.length - 1, 0, { id: 'costing', label: 'Costing', icon: 'costing', href: '#/costing', count: costRows().open });
    return items;
  }
  function renderChrome() {
    $('#navList').innerHTML = navItems().map((n) =>
      '<button type="button" class="nav-item" data-nav="' + n.id + '"' + (n.soon ? ' disabled title="Coming soon"' : n.act ? ' data-act="' + n.act + '"' : ' data-href="' + n.href + '"') + ' aria-label="' + esc(n.label) + '">' +
      '<span class="nav-ic">' + icon(n.icon) + (n.act === 'notif' ? '<span class="badge-dot" hidden></span>' : '') + '</span><span class="nav-label">' + esc(n.label) + '</span>' +
      (n.soon ? '<span class="soon">SOON</span>' : n.count !== undefined ? '<span class="count' + (['round', 'enquiries', 'costing'].includes(n.id) ? ' is-pill' : '') + '"' + (n.count ? '' : ' hidden') + '>' + n.count + '</span>' : '') + '</button>'
    ).join('');
    $('#sideAvatar').textContent = initials(state.user);
    $('#sideName').textContent = state.user === 'MASTER' ? 'ADMIN' : state.user;
    $('#sideRole').textContent = ROLE_NAMES[state.role] || state.role;
    const tab = (nav, href, ic, label) => '<button type="button" class="tab" data-nav="' + nav + '" data-href="' + href + '">' + icon(ic, 22) + label + '</button>';
    const bell = '<button type="button" class="tab" data-act="notif" data-nav="notif" aria-label="Notifications"><span class="nav-ic">' + icon('bell', 22) + '<span class="badge-dot" hidden></span></span>Alerts</button>';
    const more = '<button type="button" class="tab" data-act="more">' + icon('more', 22) + 'More</button>';
    const plus = (act, label) => '<button type="button" class="tab-plus" data-act="' + act + '" aria-label="' + label + '">' + icon('plus', 22) + '</button>';
    $('#bottomBar').innerHTML = isAdmin() ? tab('admin', '#/admin', 'users', 'People') + tab('activity', '#/activity', 'clock', 'Activity') + plus('adm-add', 'Add user') + more
      : canEdit() ? tab('home', '#/home', 'home', 'Home') + tab('jobs', '#/jobs', 'jobs', 'Jobs') + plus('new-job', 'New job') + bell + more
      : isSales() ? tab('home', '#/home', 'home', 'Home') + tab('jobs', '#/jobs', 'jobs', 'My jobs') + plus('new-enq', 'New enquiry') + bell + more
      : tab('home', '#/home', 'home', 'Home') + tab('jobs', '#/jobs', 'jobs', 'Jobs') + bell + more;
    $('#bottomBar').classList.toggle('is-4', !canEdit() && !isSales());
    drawBadges();
  }
  function updateNav() {
    const r = state.route ? state.route.name : 'home';
    const cur = r === 'job' ? 'jobs' : r === 'costjob' ? 'costing' : r;
    $$('[data-nav]').forEach((b) => { if (b.dataset.nav === cur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    const c = $('#navList [data-nav="jobs"] .count'); if (c) c.textContent = scoped().filter((j) => j.active).length;   // v2.8: your own jobs
    const p = $('#navList [data-nav="admin"] .count'); if (p && state.admin) p.textContent = state.admin.users.length;
    const setCount = (id, n) => { const el = $('#navList [data-nav="' + id + '"] .count'); if (el) { el.textContent = n; el.hidden = !n; } };
    if (canEdit()) { setCount('round', roundRows(today0()).due.length + remDueCount()); setCount('enquiries', enqNew().length); }
    if (isSales()) setCount('enquiries', enqOpen().length);
    if (canNote()) setCount('costing', costRows().open);
    drawBadges();
  }

  function greeting() { const h = dxb().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
  function syncText() {
    const s = Math.round((Date.now() - state.syncedAt) / 1000);
    if (s < 60) return 'SYNCED JUST NOW';
    return 'SYNCED ' + Math.round(s / 60) + ' MIN AGO';
  }
  function scoped() { return scopedJobs8(); }   // v2.8: your own jobs (Customer Service); sales get their own from the server

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
    const chip = (w) => w.level === 'urgent' ? 'chip chip-urgent' : w.level === 'soon' ? 'chip chip-amber-dark' : 'chip chip-calm-dark';
    return '<section class="tile tile-ink t-watch' + anim + '" style="--d:60ms" aria-labelledby="watchTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="watchTitle">TODAY’S WATCH</h2><span class="watch-sub">' +
      (m.deadlines ? m.deadlines + (m.deadlines === 1 ? ' deadline' : ' deadlines') + ' · next 3 days' : 'Nothing urgent · next 3 days') + '</span></div>' +
      '<div class="tile-body">' +
      (m.watch.length ? m.watch.slice(0, LIST_MAX).map((w) =>
        '<button type="button" class="watch-item li" data-job="' + esc(w.j.jobNo) + '">' +
        '<span class="watch-job">' + changedDot(w.j) + esc(w.j.jobNo) + '</span>' +
        '<span class="watch-text"><span class="watch-what">' + esc(w.what) + '</span><span class="watch-cust">' + esc(w.j.customer || '—') + ' · ' + esc(nice(w.j.route)) + '</span></span>' +
        '<span class="' + chip(w) + '">' + (w.level === 'urgent' ? icon('alert', 13) : '') + esc(w.when) + '</span></button>'
      ).join('') : empty('check', 'No cutoffs, sailings or free-time deadlines in the next 3 days.')) +
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
        '<button type="button" class="sea-item li" data-job="' + esc(j.jobNo) + '"><span class="sea-job">' + changedDot(j) + esc(j.jobNo) + '</span><span class="sea-route">' + esc(j.route) + '</span>' + track(j, 30) +
        '<span class="sea-day">DAY ' + j.dayN + '/' + j.dayT + '</span></button>'
      ).join('') : empty('anchor', 'Nothing at sea or in the air right now.')) +
      '</div>' + seeAll('atsea', m.atSea.length) + '</section>';
  }

  function holdTile(m, anim) {
    return '<section class="tile t-hold' + anim + '" style="--d:250ms" aria-labelledby="holdTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="holdTitle">ON HOLD</h2><span class="chip chip-hold">' + m.hold.length + '</span></div>' +
      '<div class="tile-body">' +
      (m.hold.length ? m.hold.slice(0, LIST_MAX).map((j) =>
        '<button type="button" class="list-item li" data-job="' + esc(j.jobNo) + '"><span class="li-main"><span class="li-job">' + changedDot(j) + esc(j.jobNo) + ' · ' + esc(j.type) + '</span><span class="li-sub">' + esc(j.customer || '—') + ' · ' + esc(nice(j.route)) + '</span>' +
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
        '<span class="li-main"><span class="li-job">' + changedDot(j) + esc(j.jobNo) + '</span><span class="li-sub">' + esc(nice(j.route)) + (j.cargo ? ' · ' + esc(j.cargo) : '') + '</span></span></button>'
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
      '<div class="wrap home no-seg">' +
      '<header class="page-head' + anim + '" style="--d:0ms">' +
        '<div class="head-main"><div class="meta-line"><span>' + (isSales() ? 'SALES · ' : '') + esc(fmtLong(t0)) + '</span><span class="sync" id="sync"><span class="sync-dot"></span><span id="syncText">' + syncText() + '</span></span>' + homeChips() + '</div>' +
        '<h1 class="greeting">' + greeting() + ', ' + esc(state.user === 'MASTER' ? 'Admin' : nice(state.user)) + '</h1></div>' +
        '<div class="head-actions">' +
          '<div class="search-wrap"><label class="search">' + icon('search') + '<input id="searchInput" type="search" placeholder="Job no, customer, port…" aria-label="Search jobs" autocomplete="off" value="' + esc(searchVal) + '"><kbd>/</kbd></label><div class="search-results glass" id="searchResults" hidden></div></div>' +
          '<button type="button" class="btn-ghost" id="refreshBtn" data-act="refresh" aria-label="Refresh"><span class="spin">' + icon('refresh', 16) + '</span><span class="btn-label">Refresh</span></button>' +
        '</div>' +
      '</header>' + (canNote() ? portOffices(anim) : '') +
      '<div class="bento">' +
        kpiTiles91(m, anim) + watchTile91(m, anim) + weekTile91(m, anim) + (canNote() ? myDayTile(anim) : activityTile(anim)) +
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
  const inStatus = (j, s) => s === 'all' ? true : s === 'active' ? j.active : s === 'ready' ? isReady(j) : s === 'hold' ? j.hold : s === 'completed' ? j.status === 'COMPLETED' : s === 'cancelled' ? j.status === 'CANCELLED' : true;
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
    if (u.status === 'closed') return closedList();
    if (u.status === 'ready' && !canEdit()) u.status = 'active';
    const q = u.q.trim().toUpperCase();
    let list = (u.status === 'unassigned' ? unassigned8() : scoped().filter((j) => inStatus(j, u.status))).filter((j) => inCat(j, u.cat));
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
    return '<li><button type="button" class="job-row' + (isChanged(j) ? ' is-changed' : '') + '" data-job="' + esc(j.jobNo) + '">' +
      '<span class="jr-job">' + changedDot(j) + esc(j.jobNo) + '</span>' +
      '<span class="jr-type"><span class="badge">' + esc(j.type || '—') + '</span><span class="jr-typename">' + esc(j.typeName) + '</span></span>' +
      '<span class="jr-cust"><span class="jr-name">' + esc(j.customer || '—') + '</span><span class="jr-route">' + esc(j.mode === 'misc' ? (j.against ? 'AGAINST ' + j.against : 'COSTING ONLY') : j.route) + '</span></span>' +
      '<span class="jr-track">' + miniTrack(j, 26) + '</span>' +
      '<span class="jr-next">' + toneChip(rowNext(j)) + cutChips(j) + '</span>' +
      '<span class="jr-etd"><span class="jr-k">ETD</span>' + esc(j.etd ? fmt(j.etd) : '—') + '</span>' +
      '<span class="jr-eta"><span class="jr-k">ETA</span>' + esc(j.eta ? fmt(j.eta) : '—') + (delayInfo(j) ? '<span class="jr-delay" title="Delayed">+' + delayInfo(j).total + 'D</span>' : '') + '</span>' +
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
        '<div class="head-main"><div class="meta-line"><span>' + active.length + ' ACTIVE · ' + active.filter((j) => j.hold).length + ' ON HOLD · ' + active.filter((j) => j.atSea).length + ' AT SEA' + (unassigned8().length ? ' · ' + unassigned8().length + ' UNASSIGNED' : '') + '</span></div><h1 class="greeting">' + (isSales() || canEdit() ? 'My jobs' : 'Jobs') + '</h1></div>' +
        '<div class="head-actions">' +
          '<label class="search">' + icon('search') + '<input id="jobsSearch" type="search" placeholder="Job no, customer, port…" aria-label="Search jobs" autocomplete="off" value="' + esc(keepQ) + '"></label>' +
          '<button type="button" class="btn-ghost jobs-word" data-act="jobs-word" title="Your active jobs by sales person, as a Word file">' + icon('download', 16) + '<span class="btn-label">Word</span></button>' +
          (canEdit() ? '<button type="button" class="btn-brutal btn-icon" data-act="new-job">' + icon('plus', 16) + '<span>NEW JOB</span></button>' : '') +
        '</div>' +
      '</header>' +
      '<div class="jobs-filters' + anim + '" style="--d:40ms">' +
        '<div class="chips-row" role="group" aria-label="Job category">' + CATS.map(([id, label]) => '<button type="button" class="fchip" data-cat="' + id + '" aria-pressed="' + (u.cat === id) + '">' + label + '</button>').join('') + '</div>' +
        '<div class="filter-tools">' +
          '<label class="select-pill"><span>Show</span><select id="jobsStatus">' + [['active', 'Active']].concat(canEdit() ? [['ready', 'Ready to close']] : [], canEdit() && (unassigned8().length || u.status === 'unassigned') ? [['unassigned', 'Unassigned · ' + unassigned8().length]] : [], [['hold', 'On hold'], ['all', 'All in tracker'], ['closed', 'Closed jobs']]).map(([v, l]) => '<option value="' + v + '"' + (u.status === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
          '<label class="select-pill"><span>Sort</span><select id="jobsSort">' + [['urgent', 'Most urgent'], ['newest', 'Newest'], ['etd', 'ETD'], ['eta', 'ETA']].map(([v, l]) => '<option value="' + v + '"' + (u.sort === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
        '</div>' +
      '</div>' +
      (u.status === 'closed' ? closedNote() : '') +
      '<section class="jobs-card' + anim + '" style="--d:80ms" aria-label="Job list">' +
        '<div class="jobs-scroll">' +
          '<div class="jobs-headrow" aria-hidden="true"><span>JOB NO</span><span>TYPE</span><span>CUSTOMER · ROUTE</span><span>VOYAGE</span><span>NEXT STEP</span><span>ETD</span><span>ETA</span><span>CS / SALES</span></div>' +
          (shown.length ? '<ul class="jobs-list">' + shown.map(jobRow).join('') + '</ul>' +
            (list.length > shown.length ? '<div class="jobs-more"><button type="button" class="btn-ghost" data-act="jobs-more">Show ' + Math.min(120, list.length - shown.length) + ' more · ' + list.length + ' in total</button></div>' : '<div class="jobs-end">' + list.length + (list.length === 1 ? ' job' : ' jobs') + '</div>')
            : '<div class="tile-empty jobs-empty">' + icon('search', 22) + '<span>' + (u.status === 'closed' && state.archive.loading ? 'Looking through closed jobs…' : u.status === 'ready' ? 'Nothing is ready to close yet.' : 'No jobs match these filters.') + '</span><button type="button" class="btn-ghost" data-act="jobs-clear">Clear filters</button></div>') +
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
      if (e.target.closest('[data-act="jobs-more"]')) { state.jobsUi.limit += 120; rerender(); return; }
      if (e.target.closest('[data-act="jobs-clear"]')) { Object.assign(state.jobsUi, { cat: 'all', status: 'all', q: '', limit: 120 }); rerender(); }
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
      '<span class="stop-text"><span class="stop-name">' + esc(s.name) + '</span><span class="stop-sub' + (s.cutTone && s.cutTone !== 'calm' ? ' cut-' + s.cutTone : '') + '">' + esc(s.sub) + '</span></span></button>';
  }
  const stopList = (list, cls) => list.length ? '<ol class="stops">' + list.map((s) => '<li>' + stopBtn(s, cls) + '</li>').join('') + '</ol>' : '';

  function voyageText(j, t0) {
    const W = MODE_WORDS[j.mode] || MODE_WORDS.sea;
    const total = j.etd && j.eta ? Math.max(1, days(j.etd, j.eta)) : null;
    if (j.status === 'CANCELLED') return { kicker: 'CANCELLED', title: 'Not going ahead', sub: '—', bubble: 'CANCELLED' };
    if (j.hold) return { kicker: 'ON HOLD', title: 'Waiting', sub: j.remarks ? j.remarks.toUpperCase().slice(0, 48) : 'NEXT STEP TO BE CONFIRMED', bubble: '' };
    if (j.arrived) return { kicker: W[4] + ' COMPLETE', title: total ? total + ' of ' + total + ' days' : 'Arrived', sub: 'ARRIVED ' + fmt(j.eta, true), bubble: W[3] + ' ' + fmt(j.eta) };
    if (j.atSea) return { kicker: W[0], title: j.dayN + ' of ' + j.dayT + ' days', sub: days(t0, j.eta) + (days(t0, j.eta) === 1 ? ' DAY' : ' DAYS') + ' TO ARRIVAL', bubble: 'DAY ' + j.dayN + ' OF ' + j.dayT };
    const sub = j.cat === 'EXPORT' ? (j.mode === 'air' ? 'SI, ED AND AWB BEFORE ETD' : j.dg === 'DG' ? 'SI, ED, DGPC AND BL BEFORE ETD' : 'SI, ED AND BL BEFORE ETD') : j.etd ? W[2] + ' ' + fmt(j.etd, true) : 'DATES TO CONFIRM';
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
    const dgDone = j.mode === 'sea' && ['SUBMITTED', 'APPROVED'].includes(j.dgpc);   // v2.9.2
    const dg = j.dg === 'DG' && j.dgCut && j.cat === 'EXPORT' && !(j.etd && j.etd <= t0) ? '<div class="vh-dg' + (dgDone ? ' is-done' : '') + '">' + (dgDone ? 'DGPC ' + esc(j.dgpc) : 'DG CUTOFF ' + fmt(j.dgCut)) + '</div>' : '';
    return '<section class="vhero is-' + mode + (j.hold ? ' is-hold' : '') + (j.arrived ? ' is-arrived' : '') + (j.atSea ? ' is-moving' : '') + '" style="--o:' + w[0] + '%;--s:' + w[1] + '%;--d:' + w[2] + '%" aria-label="' + esc('Voyage for job ' + j.jobNo + ' from ' + (j.pol || 'origin') + ' to ' + (j.pod || 'destination') + ': ' + vt.kicker.toLowerCase()) + '">' +
      '<div class="vh-sky">' +
        '<div class="vh-port vh-pol"><div class="kicker">ORIGIN · POL</div><div class="vh-name">' + esc(j.pol || '—') + '</div><div class="vh-date">' + esc(portLine(j, 'o')) + '</div>' + portClock(j.pol, 'hero') + dg + '</div>' +
        '<div class="vh-mid"><div class="kicker">' + esc(vt.kicker) + '</div><div class="vh-name">' + esc(vt.title) + '</div><div class="vh-date">' + esc(vt.sub) + '</div></div>' +
        '<div class="vh-port vh-pod"><div class="kicker">DESTINATION · POD</div><div class="vh-name">' + esc(j.pod || '—') + '</div><div class="vh-date">' + esc(portLine(j, 'd')) + '</div>' + portClock(j.pod, 'hero') + '</div>' +
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
      '<div class="vc-port"><div class="kicker">ORIGIN · POL</div><div class="vc-row"><span class="vc-name">' + esc(j.pol || '—') + '</span><span class="vc-date">' + esc(portLine(j, 'o')) + '</span></div>' + portClock(j.pol, 'card') + '</div>' +
      rail(jr.origin) +
      '<div class="vc-sea" aria-hidden="false">' +
        '<div class="vc-progress" style="height:' + Math.round((j.hold ? 0 : j.arrived ? 1 : j.atSea ? j.pct : 0) * 100) + '%"></div>' +
        '<div class="vc-label"><span class="kicker">' + esc(vt.kicker) + '</span><span class="vc-title">' + esc(vt.title) + '</span><span class="vc-sub">' + esc(vt.sub) + '</span></div>' +
        (jr.transit.length ? '<div class="vchips">' + jr.transit.map((s) => stopBtn(s, 'vchip')).join('') + '</div>' : '') +
        '<div class="vc-mover is-' + mode + '">' + (mode === 'air' ? PLANE_BIG : mode === 'road' ? VAN_BIG : SHIP_BIG) + '</div>' +
      '</div>' +
      '<div class="vc-port is-dest"><div class="kicker">DESTINATION · POD</div><div class="vc-row"><span class="vc-name">' + esc(j.pod || '—') + '</span><span class="vc-date">' + esc(portLine(j, 'd')) + '</span></div>' + portClock(j.pod, 'card') + '</div>' +
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
    return '<section class="tile side-card" aria-labelledby="peopleTitle"><div class="tile-head"><h2 class="tile-title" id="peopleTitle">PEOPLE</h2>' + transferBtn(j) + '</div>' +
      person(j.cs, 'Customer Service', '') +
      (j.sales ? person(j.sales, 'Sales', 'background:var(--teal-tint);color:var(--teal-text)') : '') + '</section>';
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
    if (/^TRANSFERRED THE JOB /.test(a)) return transferText(a);
    if (/^CHANGED /.test(a)) return friendlyDates(a.slice(8));
    let m = a.match(/^SET (.+?) TO (.+)$/);
    if (m) return 'set ' + m[1].toLowerCase().replace(/\bsi\b/g, 'SI').replace(/\bdo\b/g, 'DO').replace(/\bed\b/g, 'ED').replace(/\bbl\b/g, 'BL').replace(/\bawb\b/g, 'AWB').replace(/\betd\b/g, 'ETD').replace(/\beta\b/g, 'ETA').replace(/\bpol\b/g, 'POL').replace(/\bpod\b/g, 'POD').replace(/\bdgpc\b/g, 'DGPC').replace(/\bdg\b/g, 'DG').replace(/\bcs\b/g, 'CS') + ' to ' + m[2];
    if (a === 'CREATED NEW JOB') return 'opened the job';
    if (a === 'CLOSED JOB') return 'closed the job';
    m = a.match(/^CLOSED JOB — (.+)$/);
    if (m) return 'closed the job (' + m[1].toLowerCase() + ')';
    if (a === 'REOPENED JOB') return 'reopened the job';
    m = a.match(/^MARKED DELAY \+(\d+) DAYS? — (.+?) \((.+)\)$/);
    if (m) return 'marked a delay: +' + m[1] + (m[1] === '1' ? ' day' : ' days') + ' · ' + m[2].toLowerCase() + ' · ' + m[3].toLowerCase();
    m = a.match(/^REMOVED DELAY \+(\d+) DAYS? — (.+)$/);
    if (m) return 'removed a delay (+' + m[1] + (m[1] === '1' ? ' day' : ' days') + ' · ' + m[2].toLowerCase() + ')';
    m = a.match(/^BOOKED ENQUIRY (\S+) AS JOB$/);
    if (m) return 'booked enquiry ' + m[1] + ' as this job';
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
    (st.data.events || []).forEach((e, i) => items.push({ t: e[4] || ms(e[0]), seq: e[5] != null ? e[5] : -i, k: 0, who: e[1], what: friendly(e[2]), raw: e[2] }));
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
      '<section class="tile details-remarks"><div class="tile-head"><h2 class="tile-title">REMARKS</h2>' + (canEditJob(j) ? '<button type="button" class="tile-link" data-act="edit">Edit details</button>' : '') + '</div><p>' + esc(j.remarks || 'No remarks.') + '</p></section></div>';
  }

  function renderVoyage(no, first) {
    const j = findJob(no);
    const view = $('#view');
    if (!j && loadClosed(no)) {
      view.innerHTML = '<div class="wrap voyage-page"><section class="tile notfound"><div class="story-loading"><span class="sk"></span><span class="sk"></span><span class="sk short"></span></div><p class="small">Looking in closed jobs…</p></section></div>';
      return;
    }
    if (!j) {
      view.innerHTML = '<div class="wrap voyage-page"><div class="crumbs"><button type="button" class="link-btn" data-href="#/jobs">' + icon('jobs', 14) + 'JOBS</button></div>' +
        '<section class="tile notfound">' + empty('search', 'Job ' + no + ' is not in the tracker or in closed jobs. It may have been renamed or removed.') + '<button type="button" class="btn-ghost" data-href="#/jobs">Back to jobs</button></section></div>';
      return;
    }
    const t0 = today0();
    const jr = j.journey;
    loadStory(j.jobNo);
    const tab = ((t) => (t === 'story' ? 'notes' : t))(state.voyageTab[j.jobNo] || 'overview');
    const [sw, tone] = statusWord(j);
    const anim = first ? ' reveal' : '';
    const n = jr.next;
    const sp7 = storySplit(j.jobNo) || { notes: [], hist: [] };
    const nextBar = n && canEditJob(j) ? '<div class="nextbar glass" role="region" aria-label="Next stop"><div class="nb-text"><div class="kicker">NEXT STOP</div><div class="nb-name">' + esc(n.name) + ' <span class="nb-sub">' + esc(n.sub) + '</span></div></div>' +
      '<button type="button" class="btn-brutal" data-stop="' + n.id + '" data-quick="1">' + (n.id === 'costing' ? 'OPEN COSTING' : n.kind === 'field' ? 'MARK DONE' : n.kind === 'date' ? 'SET DATE' : n.kind === 'status' ? 'CLOSE JOB' : 'UPDATE') + '</button></div>' : '';
    view.innerHTML =
      '<div class="wrap voyage-page' + (jr.next && canEditJob(j) ? ' has-nextbar' : '') + '">' +
      '<div class="crumbs' + anim + '"><button type="button" class="back-btn" data-act="back" aria-label="Back">' + icon('back', 18) + '</button><button type="button" class="link-btn" data-href="#/jobs">JOBS</button><span>/ ' + esc(j.jobNo) + '</span>' + changedChip9(j) +
        (canEditJob(j) ? '<button type="button" class="status-pill tone-' + tone + '" data-act="status" aria-label="Job status: ' + sw + '. Change">' + esc(sw) + icon('chevron', 14) + '</button>' : '<span class="status-pill tone-' + tone + '">' + esc(sw) + '</span>') + '</div>' +
      '<header class="vhead' + anim + '" style="--d:30ms">' +
        '<div class="vh-titles"><div class="vh-idrow"><h1 class="vh-job">' + esc(j.jobNo) + '</h1><span class="badge badge-lg">' + esc(j.type + ' · ' + j.typeName.toUpperCase()) + '</span>' + (j.cargo ? '<span class="vh-cargo">' + esc(j.cargo) + '</span>' : '') + delayChip(j) + readyChip(j) + '</div>' +
        '<div class="vh-cust">' + esc(j.customer || '—') + '</div>' + (j.closed && j.closed.reason ? '<div class="vh-why">' + esc(j.closed.reason) + '</div>' : '') + '</div>' +
        (j.closed ? closedActions(j) : canEdit() ? '<div class="vh-actions"><button type="button" class="btn-ghost" data-act="delay" title="Mark delay" aria-label="Mark delay">' + icon('clock', 16) + '<span class="bl-full">Mark delay</span><span class="bl-short">Delay</span></button><button type="button" class="btn-ghost" data-act="duplicate" title="Duplicate job" aria-label="Duplicate job">' + icon('copy', 16) + '<span>Duplicate</span></button><button type="button" class="btn-ghost" data-act="edit" title="Edit details" aria-label="Edit details">' + icon('edit', 16) + '<span class="bl-full">Edit details</span><span class="bl-short">Edit</span></button><button type="button" class="btn-brutal" data-act="quick">UPDATE</button></div>'
          : '<div class="vh-actions is-ro"><span class="ro-chip">' + icon('lock', 14) + '<span>UPDATED BY ' + esc(j.cs || 'CUSTOMER SERVICE') + '</span></span>' + (canNote() ? '<button type="button" class="btn-brutal btn-icon" data-act="focus-note">' + icon('note', 16) + '<span>ADD A NOTE</span></button>' : '') + '</div>') +
      '</header>' +
      '<div class="ft-top">' + freeCard(j, t0) + '</div>' +
      '<div class="voyage-wrap' + anim + '" style="--d:60ms">' + (j.mode === 'misc' ? misCard(j, jr) : hero(j, jr, t0) + vcard(j, jr, t0)) + '</div>' +
      '<div class="vtabs" role="tablist" aria-label="Job sections">' +
        [['overview', 'Overview'], ['details', 'All details'], ['notes', 'Notes' + (sp7.notes.length ? ' · ' + sp7.notes.length : '')], ['history', 'History' + (sp7.hist.length ? ' · ' + sp7.hist.length : '')]].map(([id, l]) => '<button type="button" role="tab" data-tab="' + id + '" aria-selected="' + (tab === id) + '">' + esc(l) + '</button>').join('') +
      '</div>' +
      (tab === 'details' ? allDetails(j)
        : tab === 'notes' ? notesWidget(j, 0)
        : tab === 'history' ? historyWidget(j, 0)
        : jobWidgets(j, t0)) +
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
    if (!opts.datesOk) { const g8 = saveDateGate8(before, changes); if (g8) return g8.then((ok) => (ok === true ? saveJob(no, changes, Object.assign({}, opts, { datesOk: true })) : false)); }   // v2.8
    const prev = {};
    Object.keys(changes).forEach((f) => { prev[f] = asInput(f, before.raw[f]); });
    if ('dgpc' in changes && !(state.ix.dgpc > -1)) state.ix.dgpc = state.header.length;   // v2.9.2: DGPC STATUS lands after the last column
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
          if (Array.isArray(res.header) && res.header.length) { state.header = res.header; state.ix = mapHeaders(res.header); clearPending(k, changes); rebuildJobs(); }   // v2.9.2
          clearPending(k, changes); rebuildJob(k); rerender(); refreshOverlay();
          if (state.stories.has(k)) loadStory(no, true);
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
    else if (['sheet', 'drawer', 'quick', 'enq', 'delay'].includes(state.overlay) && !$('#drawer').hidden) {
      const body = $('#drawerBody'), keep = {}, f = document.activeElement && document.activeElement.id, y = body.scrollTop;
      $$('input[id], textarea[id]', body).forEach((i) => { keep[i.id] = i.value; });
      body.innerHTML = popRender();
      Object.keys(keep).forEach((id) => { const el = document.getElementById(id); if (el && keep[id] && !el.value) el.value = keep[id]; });
      body.scrollTop = y;
      if (f) { const el = document.getElementById(f); if (el) el.focus({ preventScroll: true }); }
    }
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
    return { docs: 'Original docs', dgpc: 'DGPC status', costing: 'Costing', status: 'Job status', etd: j.mode === 'courier' ? 'Pick-up date' : 'ETD', eta: j.mode === 'courier' ? 'Delivery date' : 'ETA', delivery: 'Delivery date', against: 'Against job no.' }[f] || f;
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
        '<label class="pop-label" for="holdNote">Reason (optional — posted as a note)</label><input type="text" id="holdNote" maxlength="300" placeholder="Type the reason" autocomplete="off">' + SAVE_NOTE;
    };
  }
  function quickEditor(no) {
    return () => {
      const j = findJob(no); if (!j) return '';
      const fields = FORM_STATUS[j.type] || ['sido', 'ed', 'bl'];
      return '<h2 class="peek-job" id="drawerTitle">' + esc(j.jobNo) + '</h2><p class="pop-text">Tap a value to save it straight away.</p>' +
        ['status'].concat(fields.filter((f) => f !== 'delivery' && (f !== 'dgpc' || j.dg === 'DG'))).map((f) => '<div class="quick-row"><div class="pop-label">' + esc(fieldLabel(j, f)) + '</div><div class="choice-row">' + OPTS[f].map((v) => '<button type="button" class="choice' + ((j[f] || '') === v ? ' is-on' : '') + '" data-set="' + f + '" data-val="' + esc(v) + '" aria-pressed="' + ((j[f] || '') === v) + '">' + esc(v === NA ? 'N/A' : v) + '</button>').join('') + '</div></div>').join('') + SAVE_NOTE;
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
        if (!canEditJob(j)) { openPop(st, 'STOP', stopInfo(no, st.dataset.stop)); return; }
        if (st.dataset.quick && s && s.kind === 'field' && s.state !== 'done') { onSet(no, s.def.field, s.def.primary); return; }
        openPop(st, s && s.kind === 'info' ? 'JOB' : 'UPDATE STOP', stopEditor(no, st.dataset.stop));
        return;
      }
      if (e.target.closest('[data-act="focus-note"]')) {
        const k = findJob(no) ? findJob(no).jobNo : no;
        if (['details', 'history'].includes(state.voyageTab[k])) { state.voyageTab[k] = 'overview'; rerender(); }
        const inp = $('#noteInput'); if (inp) { inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); inp.focus({ preventScroll: true }); }
        return;
      }
      if (!canEditJob(findJob(no)) && e.target.closest('[data-act="status"], [data-act="quick"], [data-act="edit"], [data-act="delay"]')) return;
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
    SFEF: ['loadlist', 'sido', 'ed', 'bl', 'dgpc'], SFEL: ['loadlist', 'sido', 'ed', 'bl', 'dgpc'], AFE: ['sido', 'ed', 'bl'],
    SFIF: ['loadlist', 'sido', 'ed', 'bl', 'docs', 'delivery'], SFIL: ['loadlist', 'sido', 'ed', 'bl', 'docs', 'delivery'],
    AFI: ['sido', 'ed', 'bl', 'delivery'], CND: ['loadlist', 'sido', 'ed', 'bl', 'docs', 'delivery'],
    SFC: ['sido', 'bl'], AFC: ['sido', 'bl'], CRR: ['sido', 'bl'], MIS: []
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
    loadLists6();
  }
  function fieldMeta(key, type) {
    const air = ['AFE', 'AFI', 'AFC'].includes(type), crr = type === 'CRR', imp = ['SFIF', 'SFIL', 'AFI', 'CND'].includes(type);
    const M = {
      jobNo: { label: 'Job no.', kind: 'text', req: true, upper: true, ph: 'Enter job number' },
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
      dgpc: { label: 'DGPC status', kind: 'select', opts: OPTS.dgpc, blank: true, dgOnly: true },
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
    void L;
    return datalist('dlCustomers', listSrc('dlCustomers')) + datalist('dlVendors', listSrc('dlVendors')) + datalist('dlPorts', listSrc('dlPorts')) +
      datalist('dlSales', listSrc('dlSales')) + datalist('dlJobs', state.jobs.slice(-400).map((j) => j.jobNo));
  }
  function typeTiles(sel, noMis) {
    return '<div class="type-grid" role="radiogroup" aria-label="Job type">' + TYPE_GROUPS.filter((g) => !noMis || g[2] !== 'costing').map(([title, opts, ic]) =>
      '<div class="type-group"><div class="tg-title">' + (ic === 'ship' ? SHIP(26) : ic === 'plane' ? PLANE(20) : ic === 'van' ? VAN(20) : icon(ic === 'globe' ? 'globe' : ic === 'truck' ? 'truck' : 'costing', 18)) + '<span>' + esc(title) + '</span></div><div class="tg-opts">' +
      opts.map(([code, l]) => '<button type="button" class="type-opt" role="radio" data-type="' + code + '" aria-checked="' + (sel === code) + '"><span class="badge">' + code + '</span><span>' + esc(l) + '</span></button>').join('') + '</div></div>').join('') + '</div>';
  }

  // ---------- New job ----------
  function openNewJob(type, opts) {
    if (!state.signedIn || !canEdit()) return;
    loadLists();
    closeOverlays(true);
    state.newJob = Object.assign({ type: type || '' }, opts || {});
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = state.newJob.enq ? 'BOOK ENQUIRY AS JOB' : state.newJob.dup ? 'DUPLICATE JOB' : 'NEW JOB';
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
    Object.keys(state.newJob.prefill || {}).forEach((k) => { if (state.newJob.prefill[k]) d[k] = state.newJob.prefill[k]; });
    const tf = TYPE_FIELDS[t];
    $('#drawerBody').innerHTML = '<h2 class="peek-job form-title" id="drawerTitle"><span class="badge badge-lg">' + t + '</span> ' + esc(TYPE_NAMES[t]) + (state.newJob.enq ? ' <span class="chip chip-teal">FROM ' + esc(state.newJob.enq) + '</span>' : '') + (state.newJob.dup ? ' <span class="chip chip-teal">COPY OF ' + esc(state.newJob.dup) + '</span>' : '') + '</h2>' +
      '<button type="button" class="link-btn quiet form-back" data-act="nj-type">' + icon('back', 14) + 'Change type</button>' +
      (state.newJob.dup ? '<p class="dup-note">' + icon('copy', 14) + '<span>Copied from ' + esc(state.newJob.dup) + ': customer, line, route, sales person, containers and cargo. Enter the new job number — dates, statuses, notes and costing start fresh.</span></p>' : '') +
      '<form class="job-form" id="jobForm" novalidate>' +
        '<fieldset><legend>JOB</legend><div class="fgrid">' + ['jobNo', 'customer', 'vendor', 'cs', 'sales', 'opened'].map((k) => input(k, t, d[k] || '')).join('') + '</div></fieldset>' +
        (tf.length ? '<fieldset><legend>' + (t === 'MIS' ? 'LINK' : 'CARGO & ROUTE') + '</legend><div class="fgrid' + (d.dg === 'DG' ? ' has-dg' : '') + '">' + tf.map((k) => input(k, t, d[k] || '')).join('') + '</div></fieldset>' : '') +
        '<fieldset><legend>REMARKS</legend><div class="fgrid">' + input('remarks', t, d.remarks || '') + '</div></fieldset>' +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit">' + (state.newJob.enq ? 'BOOK AS JOB' : 'CREATE JOB') + '</button></div>' +
      '</form>' + formLists();
    syncDg();
  }
  function syncDg() { const f = $('#jobForm'); if (!f) return; const dg = f.querySelector('[name="dg"]'); f.querySelectorAll('.dg-only').forEach((g) => { g.hidden = !(dg && dg.value === 'DG'); }); }
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
    if (!bad) { const fd8 = formDateCheck8((k) => v[k], DATE_RULE_KEYS.filter((k) => v[k]), t === 'CRR' ? 'courier' : 'sea', state.newJob); if (fd8 === 'bad') bad = true; else if (fd8 === 'ask') return; }   // v2.8: strict dates
    if (bad) { const first = $('.field.has-error input, .field.has-error select', form); if (first) first.focus(); return; }
    if (v.dg !== 'DG') delete v.dgCut;
    const payload = Object.assign({ type: t }, v);
    const btn = $('#formSubmit'); btn.disabled = true; btn.textContent = state.newJob.enq ? 'BOOKING…' : 'CREATING…';
    try {
      const enqId = state.newJob.enq;
      const res = enqId ? await api.call('ethixEnquiryBook', [enqId, payload]) : await api.call('ethixAddJob', [payload, '']);
      if (res && res.ok && Array.isArray(res.row)) {
        const k = String(res.row[state.ix.jobNo] || v.jobNo).toUpperCase();
        state.rowMap.set(k, res.row);
        rebuildJob(k);
        if (res.enquiry) putEnq(res.enquiry);
        learnLocal('customers', [v.customer]); learnLocal('vendors', [v.vendor]); learnLocal('ports', [v.pol, v.pod]);
        closeOverlays();
        toast(enqId ? 'Booked as job ' + v.jobNo + ' — ' + nice(res.enquiry ? res.enquiry.sales : 'sales') + ' was told' : 'Job ' + v.jobNo + ' created');
        openJob(v.jobNo);
        renderChrome(); updateNav();
        return;
      }
      if (res && res.duplicate) fieldError('jobNo', res.error);
      $('#formError').textContent = (res && res.error) || 'The job was not created.';
    } catch (e) {
      if (e.kind !== 'auth') $('#formError').textContent = /not available/i.test(e.message) ? 'Creating jobs needs the Phase 2 Code.gs update.' : e.message;
    }
    btn.disabled = false; btn.textContent = state.newJob.enq ? 'BOOK AS JOB' : 'CREATE JOB';
  }

  // ---------- Edit details ----------
  function openEdit(no) {
    if (!canEdit()) return;
    const j = findJob(no); if (!j) return;
    loadLists();
    closeOverlays(true);
    const t = j.type;
    const keys = ['customer', 'vendor', 'sales', 'opened'];   // v2.8: Customer Service moves by Transfer (People card)
    const route = TYPE_FIELDS[t] || [];
    const docs = FORM_STATUS[t] || ['sido', 'ed', 'bl'];
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
        (docs.length ? '<fieldset><legend>DOCUMENTS</legend><div class="fgrid">' + docs.map((k) => input(k, t, val(k))).join('') + '</div></fieldset>' : '') +
        '<fieldset><legend>REMARKS</legend><div class="fgrid">' + input('remarks', t, val('remarks')) + '</div></fieldset>' +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit">SAVE CHANGES</button></div>' +
      '</form>' + formLists();
    const f = $('#editForm'); const dg = f.querySelector('[name="dg"]'); f.querySelectorAll('.dg-only').forEach((g) => { g.hidden = !(dg && dg.value === 'DG'); });
    showDrawer(document.activeElement);
    state.overlay = 'form';
  }
  function submitEdit(form) {
    const ed = state.editing; if (!ed) return;
    const v = readForm(form);
    $$('.field-err', form).forEach((e) => { e.textContent = ''; });
    if (!v.customer) { fieldError('customer', 'Customer is required.'); return; }
    { const j8 = findJob(ed.no), touched = DATE_RULE_KEYS.filter((k) => k in v && String(v[k]) !== String(ed.initial[k] == null ? '' : ed.initial[k]));
      if (formDateCheck8((k) => (k in v ? v[k] : j8 ? j8.raw[k] : ''), touched, j8 ? j8.mode : 'sea', ed) !== 'ok') return; }   // v2.8: strict dates
    const changes = {};
    Object.keys(v).forEach((k) => { if (k in ed.initial && String(v[k]) !== String(ed.initial[k])) changes[k] = v[k]; });
    closeOverlays();
    if (!Object.keys(changes).length) { toast('No changes to save'); return; }
    learnLocal('customers', [changes.customer]); learnLocal('vendors', [changes.vendor]); learnLocal('ports', [changes.pol, changes.pod]);
    saveJob(ed.no, changes, { datesOk: true, toast: Object.keys(changes).length === 1 ? fieldMeta(Object.keys(changes)[0], findJob(ed.no).type).label + ' saved' : Object.keys(changes).length + ' changes saved' });
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
      if (e.target.name === 'dg' && e.target.form) e.target.form.querySelectorAll('.dg-only').forEach((g) => { g.hidden = e.target.value !== 'DG'; });
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
    const d = dxb(t), today = today0();
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
    if (x.kind === 'enq-update') return '<strong>' + esc(x.from) + '</strong> on enquiry';
    if (x.kind === 'delay') return '<strong>' + esc(x.from) + '</strong> marked a delay on';
    if (x.kind === 'costing') return '<strong>' + esc(x.from) + '</strong> on the costing of';
    if (x.kind === 'transfer') return '<strong>' + esc(x.from) + '</strong> transferred';
    return '<strong>' + esc(x.from) + '</strong> updated';
  }
  function notifPanel() {
    const n = state.notif || { items: [] };
    const seen = state.notifSeenShown || 0;
    return '<h2 class="peek-job list-title" id="drawerTitle">Notifications</h2>' +
      (n.items && n.items.length ? '<ol class="notif-list">' + n.items.map((x) => '<li><button type="button" class="notif' + (x.t > seen ? ' is-new' : '') + (x.kind === 'delay' ? ' is-delay' : '') + '" ' + (/^EQ-/.test(x.job) ? 'data-enq' : x.kind === 'costing' ? 'data-cost' : 'data-job') + '="' + esc(x.job) + '">' +
        '<span class="avatar' + (x.kind === 'note' ? ' is-other' : '') + '">' + esc(initials(x.from)) + '</span>' +
        '<span class="nt-body"><span class="nt-head">' + notifText(x) + ' <span class="nt-job">' + esc(x.job) + '</span></span>' +
        '<span class="nt-text">' + esc(x.text) + '</span><span class="nt-when">' + esc(ago(x.t)) + '</span></span></button></li>').join('') + '</ol>'
        : '<div class="tile-empty">' + icon('bell', 22) + '<span>' + (state.role === 'SALES' ? 'Updates, delays and enquiry replies from Customer Service show here.' : 'Notes and enquiries from sales show here.') + '</span></div>');
  }
  function openNotifications() {               // v2.7: notifications are a page of their own
    closeOverlays(true);
    go('#/notifications');
  }

  // ---------- my account ----------
  function accountPanel() {
    const go2 = (href, ic, label, n) => '<button type="button" class="acct-go" data-href="' + href + '">' + icon(ic, 18) + '<span>' + label + '</span>' + (n ? '<b>' + n + '</b>' : '') + '</button>';
    const shortcuts = canEdit() ? go2('#/follow-ups', 'check', 'Follow-ups', roundRows(today0()).due.length + remDueCount()) + go2('#/enquiries', 'enq', 'Enquiries', enqNew().length) + go2('#/costing', 'costing', 'Costing', costRows().open)
      : isSales() ? go2('#/enquiries', 'enq', 'My enquiries', enqOpen().length) + go2('#/costing', 'costing', 'Costing', costRows().open) : '';
    return (shortcuts ? '<div class="acct-shortcuts">' + shortcuts + '</div>' : '') + '<div class="acct"><span class="avatar">' + esc(initials(state.user)) + '</span><div><div class="acct-name" id="drawerTitle">' + esc(state.user === 'MASTER' ? 'ADMIN' : state.user) + '</div><div class="mono small">' + esc(ROLE_NAMES[state.role] || state.role) + '</div></div></div>' +
      '<form class="tile pw-form" id="pwForm" novalidate><h3 class="tile-title">CHANGE PASSWORD</h3>' +
        '<input type="text" name="username" autocomplete="username" value="' + esc(state.user) + '" class="sr-only" tabindex="-1" aria-hidden="true" readonly>' +
        '<label class="pop-label" for="pwCurrent">Current password</label><div class="pw-wrap is-plain"><input id="pwCurrent" type="password" autocomplete="current-password"><button type="button" class="pw-eye" data-eye="pwCurrent" aria-label="Show password">' + EYE + '</button></div>' +
        '<label class="pop-label" for="pwNew">New password</label><div class="pw-wrap is-plain"><input id="pwNew" type="password" autocomplete="new-password"><button type="button" class="pw-eye" data-eye="pwNew" aria-label="Show password">' + EYE + '</button></div>' +
        '<label class="pop-label" for="pwNew2">Type it again</label><div class="pw-wrap is-plain"><input id="pwNew2" type="password" autocomplete="new-password"></div>' +
        '<div class="pop-hint">8+ characters, letters and numbers, not your name. Your other devices will be signed out.</div>' +
        '<div class="pin-msg" id="pwMsg" role="alert"></div>' +
        '<button type="submit" class="btn-brutal" id="pwSave">CHANGE PASSWORD</button></form>' +
      '<button type="button" class="btn-ghost acct-logout" data-act="logout">' + icon('logout', 16) + 'Log out</button>';
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
      [/^(?:LOCKED|PIN LOCKOUT) — (\d+) WRONG (PASSWORDS|PINS)$/, (m) => 'was locked after ' + m[1] + ' wrong ' + m[2].toLowerCase()],
      [/^NEW ENQUIRY (\S+) — (.+)$/, (m) => 'raised enquiry ' + m[1] + ' · ' + m[2]], [/^TOOK ENQUIRY (\S+)$/, (m) => 'took enquiry ' + m[1]],
      [/^DECLINED ENQUIRY (\S+)$/, (m) => 'declined enquiry ' + m[1]], [/^CANCELLED ENQUIRY (\S+)$/, (m) => 'cancelled enquiry ' + m[1]],
      [/^REOPENED ENQUIRY (\S+)$/, (m) => 'reopened enquiry ' + m[1]]
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
      '<p class="pop-text">Send these to ' + esc(nice(name)) + ' privately. At first sign-in they must choose their own password — you won’t know it.</p>' +
      '<div class="form-actions is-inline"><button type="button" class="btn-ghost" data-adm="copy" data-text="' + esc('Username: ' + name + '\nTemporary password: ' + pw) + '">' + icon('copy', 16) + 'Copy</button><button type="button" class="btn-brutal" data-act="form-done">DONE</button></div></div>';
  }
  function openAddUser(name, role) {
    closeOverlays(true);
    const A = adminData();
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'ADD USER';
    $('#drawerBody').innerHTML = '<h2 class="peek-job form-title" id="drawerTitle">New account</h2>' +
      '<form class="job-form" id="addUserForm" novalidate><div class="fgrid">' +
        '<div class="field is-wide"><label for="auName">Name (this is their username)</label><input id="auName" class="is-upper" list="dlSugg" autocomplete="off" spellcheck="false" value="' + esc(name || '') + '" placeholder="Enter username"><div class="field-err" id="auName_err"></div></div>' +
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

  // ================================================================ PHASE 4
  // Follow-ups (the daily check of every job), delays and enquiries.
  const EVERY_N = { DAILY: 1, '2 DAYS': 2, WEEKLY: 7, PAUSED: 0 };
  const EVERY_LABEL = { DAILY: 'Daily', '2 DAYS': 'Every 2 days', WEEKLY: 'Weekly', PAUSED: 'Paused' };
  const dayOf = (t) => { const d = typeof t === 'number' ? dxb(t) : new Date(t); d.setHours(0, 0, 0, 0); return d; };   // a moment → its Dubai day; a sheet date stays itself
  const hm = (t) => { const d = dxb(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const keyOf = (j) => String(j.jobNo || j).toUpperCase();

  // ---------- follow-ups ----------
  function planFor(j) { const p = state.follow.plan[keyOf(j)]; return EVERY_N[p] !== undefined ? p : j.hold ? 'WEEKLY' : 'DAILY'; }
  function checksFor(j) { return state.follow.checks[keyOf(j)] || []; }
  function followState(j, t0) {
    const every = planFor(j), checks = checksFor(j), last = checks[0] || null;
    const since = last ? days(dayOf(last[0]), t0) : null;
    const today = since === 0;
    const mineToday = checks.find((c) => days(dayOf(c[0]), t0) === 0 && c[1] === state.user) || null;
    const n = EVERY_N[every];
    const due = every !== 'PAUSED' && !today && (since === null || since >= n);
    const nextIn = every === 'PAUSED' ? null : today ? n : since === null ? 0 : Math.max(0, n - since);
    return { every, checks, last, since, today, mineToday, due, nextIn };
  }
  function roundRows(t0, list) {
    const rows = (list || mineJobs().filter((j) => j.active)).map((j) => ({ j, f: followState(j, t0) }));
    return {
      due: rows.filter((x) => x.f.due).sort(dueSort8(t0)),   // v2.8: urgent first, then by office hours at the port that matters now
      done: rows.filter((x) => x.f.today).sort((a, b) => b.f.last[0] - a.f.last[0]),
      later: rows.filter((x) => !x.f.due && !x.f.today && x.f.every !== 'PAUSED').sort((a, b) => a.f.nextIn - b.f.nextIn),
      paused: rows.filter((x) => x.f.every === 'PAUSED' && !x.f.today),
      all: rows
    };
  }
  const lastCheckText = (f, t0) => {
    if (!f.last) return 'Not checked yet';
    const d = days(dayOf(f.last[0]), t0);
    return (d === 0 ? 'Today ' + hm(f.last[0]) : d === 1 ? 'Yesterday' : d + ' days ago') + ' · ' + f.last[1];
  };
  function dotStrip(j, t0, n) {
    const by = {};
    checksFor(j).forEach((c) => { const k = days(dayOf(c[0]), t0); (by[k] = by[k] || []).push(c); });
    let out = '';
    for (let i = n - 1; i >= 0; i--) {
      const c = by[-i], d = addDays(t0, -i);
      out += '<i class="' + (c ? 'on' : '') + (i === 0 ? ' is-today' : '') + '" title="' + esc(fmt(d) + (c ? ' · ' + c.map((x) => x[1] + ' ' + hm(x[0])).join(', ') : ' · not checked')) + '"></i>';
    }
    return '<span class="dots" aria-hidden="true">' + out + '</span>';
  }
  // A tap = checked today (once). A remark fills today's check, or is added as one more line with its own time (v2.7).
  async function followCheck(no, remark) {
    const j = findJob(no); if (!j || !canEdit()) return;
    const K = keyOf(j);
    if (state.followBusy.has(K)) return;
    const prev = (state.follow.checks[K] || []).slice();
    const t0 = today0();
    const mineAll = prev.filter((c) => days(dayOf(c[0]), t0) === 0 && c[1] === state.user);
    const had = mineAll[0] || null, text = String(remark || '').trim();
    if (had && !text) return;
    const blank = had && mineAll.find((c) => !c[2]);
    const entry = blank ? [blank[0], state.user, text] : [Date.now(), state.user, text];
    state.follow.checks[K] = blank ? prev.map((c) => (c === blank ? entry : c)) : [entry].concat(prev);
    state.followBusy.add(K);
    if (!had) state.justChecked = K;
    rerender(); state.justChecked = null; refreshOverlay(); updateNav();
    setSaving(1);
    try {
      const res = await api.call('ethixFollowCheck', [j.jobNo, text]);
      if (!res || !res.ok) throw new Error((res && res.error) || 'Not saved.');
      if (res.t) entry[0] = res.t;
      if (!had && !text) toast(j.jobNo + ' checked', { action: { label: 'Undo', fn: () => followUndo(j.jobNo) } });
      else toast(had ? 'Remark added' : j.jobNo + ' checked · remark saved');
    } catch (e) {
      state.follow.checks[K] = prev;
      if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Follow-ups need the Phase 4 Code.gs update.' : 'Not saved: ' + e.message, { error: true });
    } finally { state.followBusy.delete(K); setSaving(-1); rerender(); refreshOverlay(); updateNav(); }
  }
  async function followUndo(no) {
    const j = findJob(no); if (!j) return;
    const K = keyOf(j), prev = (state.follow.checks[K] || []).slice(), t0 = today0();
    state.follow.checks[K] = prev.filter((c) => !(days(dayOf(c[0]), t0) === 0 && c[1] === state.user));
    closeOverlays(); rerender(); updateNav();
    setSaving(1);
    try { const res = await api.call('ethixFollowUndo', [j.jobNo]); if (!res || !res.ok) throw new Error((res && res.error) || 'Not undone.'); toast('Check undone'); }
    catch (e) { state.follow.checks[K] = prev; rerender(); updateNav(); if (e.kind !== 'auth') toast(e.message, { error: true }); }
    finally { setSaving(-1); }
  }
  async function followPlan(no, every) {
    const j = findJob(no); if (!j || !canEdit()) return;
    const K = keyOf(j), prev = state.follow.plan[K];
    state.follow.plan[K] = every;
    closeOverlays(); rerender(); updateNav();
    setSaving(1);
    try { const res = await api.call('ethixFollowPlan', [j.jobNo, every]); if (!res || !res.ok) throw new Error((res && res.error) || 'Not saved.'); toast(j.jobNo + ': ' + EVERY_LABEL[every].toLowerCase()); }
    catch (e) { if (prev === undefined) delete state.follow.plan[K]; else state.follow.plan[K] = prev; rerender(); updateNav(); if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Follow-ups need the Phase 4 Code.gs update.' : e.message, { error: true }); }
    finally { setSaving(-1); }
  }
  const everyMenu = (no) => () => {
    const j = findJob(no); if (!j) return '';
    const cur = planFor(j);
    return '<div class="pop-title">How often?</div><p class="pop-text">' + esc(j.jobNo) + ' · ' + esc(j.customer || '') + '</p><div class="choice-row is-stack">' +
      Object.keys(EVERY_N).map((k) => '<button type="button" class="choice' + (k === cur ? ' is-on' : '') + '" data-set-every="' + esc(k) + '" data-no="' + esc(j.jobNo) + '" aria-pressed="' + (k === cur) + '">' + EVERY_LABEL[k] + '</button>').join('') + '</div>' +
      '<div class="pop-hint">Paused jobs leave Follow-ups until you change it back.</div>';
  };
  const checkedMenu = (no) => () => {
    const j = findJob(no); if (!j) return '';
    const f = followState(j, today0());
    const mine = f.mineToday;
    const today = remarksToday(f, today0());
    return '<div class="pop-title">' + (mine ? 'Checked today ' + hm(mine[0]) : 'Check ' + esc(j.jobNo)) + '</div><p class="pop-text">' + esc(j.jobNo) + ' · ' + esc(j.customer || '') + '</p>' +
      (today.length ? remarkList(today) : '') +
      '<form class="pop-form" data-remark="' + esc(j.jobNo) + '"><label class="pop-label" for="remarkInput">' + (today.length ? 'Add another remark' : mine ? 'Add a remark' : 'Remark (optional)') + '</label><input type="text" id="remarkInput" maxlength="200" value="" placeholder="Type a remark" autocomplete="off">' +
      '<button type="submit" class="btn-brutal pop-main" data-primary>' + (mine ? 'ADD REMARK' : 'CHECK WITH REMARK') + '</button></form>' +
      (mine ? '<button type="button" class="btn-ghost pop-wide" data-undo-check="' + esc(j.jobNo) + '">' + (today.some((c) => c[1] === state.user) ? 'Undo today’s check and your remarks' : 'Undo today’s check') + '</button>' : '');
  };
  // the month calendar of checked days (older months load when you go back)
  function followCalendar(j) {
    const K = keyOf(j), t0 = today0();
    const off = state.calOffset[K] || 0;
    const first = new Date(t0.getFullYear(), t0.getMonth() + off, 1);
    const hist = state.followHist[K];
    const windowStart = addDays(t0, -(state.follow.days || 35));
    if (!hist && first < windowStart) loadFollowHistory(j);
    const all = hist ? hist.filter((c) => dayOf(c[0]) < windowStart).concat(checksFor(j)) : checksFor(j);   // v2.8
    const by = {};
    all.forEach((c) => { const d = dayOf(c[0]); const k = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); (by[k] = by[k] || []).push(c); });
    const lead = (first.getDay() + 6) % 7;                         // Monday first
    const n = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span></span>';
    let count = 0;
    for (let d = 1; d <= n; d++) {
      const day = new Date(first.getFullYear(), first.getMonth(), d);
      const c = by[day.getFullYear() + '-' + day.getMonth() + '-' + d];
      if (c) count++;
      const tip = fmt(day) + (c ? ' · ' + c.map((x) => x[1] + ' ' + hm(x[0]) + (x[2] ? ' — ' + x[2] : '')).join(' · ') : '');
      cells += '<span class="cal-d' + (c ? ' is-on' : '') + (+day === +t0 ? ' is-today' : '') + (day > t0 ? ' is-future' : '') + '" title="' + esc(tip) + '">' + d + '</span>';
    }
    const MONTH = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
    return '<div class="cal"><div class="cal-head"><button type="button" class="icon-btn cal-nav" data-cal="-1" data-cal-job="' + esc(j.jobNo) + '" aria-label="Previous month">' + icon('back', 14) + '</button>' +
      '<span class="cal-title">' + MONTH[first.getMonth()] + ' ' + first.getFullYear() + '<small>' + count + (count === 1 ? ' day checked' : ' days checked') + '</small></span>' +
      '<button type="button" class="icon-btn cal-nav is-next" data-cal="1" data-cal-job="' + esc(j.jobNo) + '" aria-label="Next month"' + (off >= 0 ? ' disabled' : '') + '>' + icon('back', 14) + '</button></div>' +
      '<div class="cal-grid" role="img" aria-label="Days this job was checked"><b>M</b><b>T</b><b>W</b><b>T</b><b>F</b><b>S</b><b>S</b>' + cells + '</div>' +
      (state.followHist[K] === null ? '<div class="pop-hint">Loading older checks…</div>' : '') + '</div>';
  }
  function loadFollowHistory(j) {
    const K = keyOf(j);
    if (state.followHist[K] !== undefined) return;
    state.followHist[K] = null;
    api.call('ethixFollowHistory', [j.jobNo]).then((rows) => { state.followHist[K] = Array.isArray(rows) ? rows : []; rerender(); })
      .catch(() => { state.followHist[K] = checksFor(j); rerender(); });
  }
  function followCard(j) {
    if (!j.active && !checksFor(j).length) return '';
    const t0 = today0(), f = followState(j, t0);
    const status = f.today ? '<span class="fu-ok">' + icon('check', 16) + 'Checked today ' + hm(f.last[0]) + ' · ' + esc(f.last[1]) + '</span>'
      : f.every === 'PAUSED' ? '<span class="fu-muted">Paused — not in Follow-ups</span>'
      : f.due ? '<span class="fu-due">Due today' + (f.last ? ' · last ' + esc(lastCheckText(f, t0)) : '') + '</span>'
      : '<span class="fu-muted">Next check in ' + f.nextIn + (f.nextIn === 1 ? ' day' : ' days') + ' · last ' + esc(lastCheckText(f, t0)) + '</span>';
    const rt = remarksToday(f, t0), lr = lastRemark(f);
    const remark = rt.length ? remarkList(rt, 3) : lr ? '<p class="fu-remark">“' + esc(lr.text) + '”</p>' : '';
    return '<section class="tile side-card fu-card" aria-labelledby="fuTitle"><div class="tile-head"><h2 class="tile-title" id="fuTitle">FOLLOW-UP</h2>' +
      (canEditJob(j) ? '<button type="button" class="every-pill" data-every="' + esc(j.jobNo) + '">' + EVERY_LABEL[f.every] + icon('chevron', 13) + '</button>' : '<span class="every-pill is-ro">' + EVERY_LABEL[f.every] + '</span>') + '</div>' +
      '<div class="fu-status">' + status + '</div>' + remark +
      (canEditJob(j) && j.active ? (f.mineToday ? '<button type="button" class="btn-ghost fu-btn" data-check-menu="' + esc(j.jobNo) + '">' + icon('edit', 15) + 'Add remark or undo</button>'
        : '<button type="button" class="btn-brutal fu-btn" data-check="' + esc(j.jobNo) + '">' + icon('check', 16) + 'CHECKED TODAY</button>') : '') +
      jobReminders(j) + followCalendar(j) + '</section>';
  }

  // ---------- the Follow-ups page ----------
  const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="tick" d="M6.5 12.5l3.6 3.6L17.5 8.5"/></svg>';
  function checkCircle(j, f) {
    const mine = f.mineToday, other = f.today && !mine ? f.last : null;
    if (mine) return '<button type="button" class="rr-check is-on' + (state.justChecked === keyOf(j) ? ' is-new' : '') + '" data-check-menu="' + esc(j.jobNo) + '" aria-label="' + esc(j.jobNo + ' checked at ' + hm(mine[0]) + '. Add a remark or undo') + '" title="Checked ' + hm(mine[0]) + ' — remark or undo">' + TICK + '</button><span class="rr-time">' + hm(mine[0]) + '</span>';
    return '<button type="button" class="rr-check' + (other ? ' is-other' : '') + '" data-check="' + esc(j.jobNo) + '" aria-label="' + esc(other ? nice(other[1]) + ' checked ' + j.jobNo + ' at ' + hm(other[0]) + '. Add your check' : 'Mark ' + j.jobNo + ' as checked today') + '" title="' + esc(other ? nice(other[1]) + ' checked at ' + hm(other[0]) + ' — tap to add yours' : 'Mark as checked today') + '">' + TICK + '</button>';
  }
  function roundRow(x, t0) {
    const j = x.j, f = x.f;
    return '<li class="rr' + (f.today ? ' is-done' : '') + (f.mineToday ? ' is-mine' : '') + (f.due ? ' is-due' : '') + '">' +
      '<button type="button" class="rr-main" data-job="' + esc(j.jobNo) + '"><span class="rr-job">' + changedDot(j) + esc(j.jobNo) + '<span class="badge">' + esc(j.type) + '</span></span>' +
        '<span class="rr-cust">' + esc(j.customer || '—') + '</span><span class="rr-route">' + esc(j.mode === 'misc' ? 'COSTING ONLY' : j.route) + '</span></button>' +
      '<span class="rr-next">' + toneChip(rowNext(j)) + cutChips(j) + rowClock(j, t0) + '</span>' +
      '<span class="rr-last"><span>' + esc(lastCheckText(f, t0)) + '</span>' + ((lr) => (lr ? '<span class="rr-remark">“' + esc(lr.text) + '”' + (lr.n > 1 ? ' <b>+' + (lr.n - 1) + '</b>' : '') + '</span>' : ''))(lastRemark(f)) + '</span>' +
      '<span class="rr-strip">' + dotStrip(j, t0, 14) + '</span>' +
      '<span class="rr-every"><button type="button" class="every-pill" data-every="' + esc(j.jobNo) + '">' + EVERY_LABEL[f.every] + icon('chevron', 13) + '</button></span>' +
      '<span class="rr-act">' + checkCircle(j, f) + '</span>' +
    '</li>';
  }
  function renderRound(first) {
    const t0 = today0();
    const anim = first ? ' reveal' : '';
    const q = (state.roundQ || '').trim().toUpperCase();
    const R = roundRows(t0);
    const match = (x) => !q || (x.j.jobNo + ' ' + x.j.customer + ' ' + x.j.route + ' ' + x.j.cs + ' ' + x.j.sales).toUpperCase().includes(q);
    const total = R.due.length + R.done.length;
    const pct = total ? Math.round((R.done.length / total) * 100) : 100;
    // Jobs you check stay in place while you work down the list (nothing jumps under the mouse).
    // They regroup when you come back to the page, switch My jobs / Everyone, or press Refresh.
    if (first || !state.roundSnap) state.roundSnap = R.due.map((x) => keyOf(x.j));
    const inSnap = new Set(state.roundSnap), byKey = new Map(R.all.map((x) => [keyOf(x.j), x]));
    const dueRows = state.roundSnap.map((k) => byKey.get(k)).filter((x) => x && (x.f.due || x.f.today)).concat(R.due.filter((x) => !inSnap.has(keyOf(x.j))));
    const doneRows = R.done.filter((x) => !inSnap.has(keyOf(x.j)));
    const section = (id, title, rows, sub, n) => rows.length ? '<section class="round-sec' + anim + '" aria-labelledby="rs-' + id + '"><div class="tile-head"><h2 class="tile-title" id="rs-' + id + '">' + title + ' <span class="tile-count">' + (n === undefined ? rows.length : n) + '</span></h2>' + (sub ? '<span class="small">' + sub + '</span>' : '') + '</div><ul class="round-list">' + rows.map((x) => roundRow(x, t0)).join('') + '</ul></section>' : '';
    const keepQ = $('#roundSearch') ? $('#roundSearch').value : state.roundQ || '';
    $('#view').innerHTML = '<div class="wrap round-page no-seg">' +
      '<header class="page-head' + anim + '"><div class="head-main"><div class="meta-line"><span>FOLLOW-UPS · YOUR JOBS · ' + esc(fmtLong(t0)) + '</span><span class="sync" id="sync"><span class="sync-dot"></span><span id="syncText">' + syncText() + '</span></span></div><h1 class="greeting">Follow-ups</h1></div>' +
        '<div class="head-actions">' +
          '<label class="search">' + icon('search') + '<input id="roundSearch" type="search" placeholder="Job no, customer, port…" aria-label="Filter follow-ups" autocomplete="off" value="' + esc(keepQ) + '"></label>' +
          '<button type="button" class="btn-ghost" id="refreshBtn" data-act="refresh" aria-label="Refresh"><span class="spin">' + icon('refresh', 16) + '</span><span class="btn-label">Refresh</span></button>' +
        '</div></header>' +
      '<section class="round-progress tile tile-ink' + anim + '" style="--d:40ms" aria-label="Progress">' +
        '<div class="rp-num"><b>' + R.done.length + '</b><span>/ ' + total + '</span></div>' +
        '<div class="rp-main"><div class="rp-label">' + (total && R.due.length === 0 ? 'All followed up — every job due today is checked.' : 'checked today · ' + R.due.length + ' still due') + '</div>' +
          '<div class="rp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div>' +
          '<div class="rp-chips"><span>' + R.later.length + ' not due today</span><span>' + R.paused.length + ' paused</span><span>Tap the circle once you’ve followed a job up · set how often per job</span></div></div>' +
      '</section>' +
      remSection(anim) +
      section('due', 'DUE NOW', dueRows.filter(match), '', dueRows.filter((x) => x.f.due && match(x)).length) +
      section('done', 'CHECKED TODAY', doneRows.filter(match)) +
      section('later', 'NOT DUE TODAY', R.later.filter(match), 'By their own pace') +
      section('paused', 'PAUSED', R.paused.filter(match)) +
      (!R.all.length ? '<section class="tile">' + empty('check', 'No active jobs in this view.') + '</section>' : '') +
      '</div>';
    if (keepQ && state.roundFocus) { const s = $('#roundSearch'); s.focus(); s.setSelectionRange(keepQ.length, keepQ.length); }
  }

  // ---------- delays ----------
  const DELAY_WHERE = {
    sea: ['ORIGIN PORT', 'TRANSSHIPMENT', 'AT SEA', 'DESTINATION PORT', 'CUSTOMS', 'DELIVERY'],
    air: ['ORIGIN AIRPORT', 'TRANSIT', 'IN FLIGHT', 'DESTINATION AIRPORT', 'CUSTOMS', 'DELIVERY'],
    courier: ['PICK-UP', 'IN TRANSIT', 'CUSTOMS', 'DELIVERY'],
    misc: ['CUSTOMS', 'DELIVERY']
  };
  const DELAY_REASONS = ['Vessel delayed', 'Port congestion', 'Weather', 'Rolled over', 'Missed cutoff', 'Documents', 'Customs hold', 'Customer request'];
  const movesDates = (where) => ['ORIGIN PORT', 'ORIGIN AIRPORT', 'PICK-UP'].includes(where) ? { etd: true, eta: true } : ['CUSTOMS', 'DELIVERY'].includes(where) ? { etd: false, eta: false } : { etd: false, eta: true };
  function delayInfo(j) {
    const list = (state.delays[keyOf(j)] || []).slice().sort((a, b) => a.t - b.t);
    if (!list.length) return null;
    const total = list.reduce((a, d) => a + (d.days || 0), 0);
    const firstEtd = list.map((d) => parseDate(d.etdBefore)).find(Boolean), firstEta = list.map((d) => parseDate(d.etaBefore)).find(Boolean);
    return {
      list, total,
      etd: firstEtd && j.etd && +firstEtd !== +j.etd ? { from: firstEtd, to: j.etd, d: days(firstEtd, j.etd) } : null,
      eta: firstEta && j.eta && +firstEta !== +j.eta ? { from: firstEta, to: j.eta, d: days(firstEta, j.eta) } : null,
      plan: firstEtd && firstEta ? days(firstEtd, firstEta) : null, now: j.etd && j.eta ? days(j.etd, j.eta) : null
    };
  }
  const delayChip = (j) => { const d = delayInfo(j); return d && d.total ? '<button type="button" class="delay-chip" data-act="delays">' + icon('clock', 13) + 'DELAYED +' + d.total + (d.total === 1 ? ' DAY' : ' DAYS') + '</button>' : ''; };
  function delayCard(j) {
    const d = delayInfo(j); if (!d) return '';
    const sign = (n) => (n > 0 ? '+' : '') + n;
    return '<section class="tile side-card delay-card" id="delayCard" aria-labelledby="dlTitle"><div class="tile-head"><h2 class="tile-title" id="dlTitle">DELAYS</h2>' + (canEditJob(j) ? '<button type="button" class="tile-link" data-act="delay">+ Mark another</button>' : '') + '</div>' +
      '<div class="dl-total"><b>+' + d.total + '</b><span>' + (d.total === 1 ? 'day' : 'days') + ' delayed in all · ' + d.list.length + (d.list.length === 1 ? ' delay' : ' delays') + '</span></div>' +
      (d.etd ? '<div class="kv"><span class="kv-k">' + (j.mode === 'air' ? 'Departure' : j.mode === 'courier' ? 'Pick-up' : 'Sailing') + '</span><span class="kv-v">' + fmt(d.etd.from) + ' → ' + fmt(d.etd.to) + ' · ' + sign(d.etd.d) + 'D</span></div>' : '') +
      (d.eta ? '<div class="kv"><span class="kv-k">Arrival</span><span class="kv-v">' + fmt(d.eta.from) + ' → ' + fmt(d.eta.to) + ' · ' + sign(d.eta.d) + 'D</span></div>' : '') +
      (d.plan !== null && d.now !== null && d.plan !== d.now ? '<div class="kv"><span class="kv-k">Transit</span><span class="kv-v">planned ' + d.plan + ' days · now ' + d.now + '</span></div>' : '') +
      '<ol class="dl-list">' + d.list.slice().reverse().map((x) => '<li><span class="dl-days">+' + x.days + 'D</span><span class="dl-body"><b>' + esc(nice(x.where)) + '</b> · ' + esc(x.reason) + (x.note ? '<span class="dl-note">' + esc(x.note) + '</span>' : '') +
        '<span class="dl-meta">' + esc(x.by) + ' · ' + esc(ago(x.t)) + '</span></span>' + (canEditJob(j) ? '<button type="button" class="icon-btn dl-rm" data-delay-rm="' + esc(x.id) + '" aria-label="Remove this delay">' + icon('close', 13) + '</button>' : '') + '</li>').join('') + '</ol></section>';
  }
  function openDelay(no) {
    const j = findJob(no); if (!j || !canEdit()) return;
    closeOverlays(true);
    const where = (DELAY_WHERE[j.mode] || DELAY_WHERE.sea);
    const start = j.atSea || j.arrived ? (j.arrived ? where[where.length - 3] || where[0] : where[2] || where[0]) : where[0];
    state.delayForm = { no: j.jobNo, days: 2, where: start, reason: '', other: '', note: '', move: movesDates(start) };
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'MARK DELAY';
    popRender = delayForm;
    $('#drawerBody').innerHTML = delayForm();
    showDrawer(document.activeElement);
    state.overlay = 'delay';
  }
  function delayForm() {
    const F = state.delayForm; const j = findJob(F.no); if (!j) return '';
    const where = DELAY_WHERE[j.mode] || DELAY_WHERE.sea;
    const shift = (d) => (d ? fmt(addDays(d, F.days)) : '—');
    const reasonOk = F.reason && (F.reason !== 'Other' || F.other.trim());
    return '<h2 class="peek-job form-title" id="drawerTitle">' + esc(j.jobNo) + ' <span class="small">' + esc(j.customer || '') + '</span></h2>' +
      '<form class="job-form delay-form" id="delayForm" novalidate>' +
        '<fieldset><legend>HOW MANY DAYS?</legend><div class="dl-stepper"><button type="button" class="icon-btn" data-dl-step="-1" aria-label="One day less">−</button><output id="dlDays" aria-live="polite">' + F.days + '<small>' + (F.days === 1 ? 'day' : 'days') + '</small></output><button type="button" class="icon-btn" data-dl-step="1" aria-label="One day more">+</button></div>' +
          '<div class="choice-row">' + [1, 2, 3, 5, 7, 10, 14].map((n) => '<button type="button" class="choice' + (F.days === n ? ' is-on' : '') + '" data-dl-days="' + n + '">' + n + 'D</button>').join('') + '</div></fieldset>' +
        '<fieldset><legend>WHERE?</legend><div class="choice-row">' + where.map((w) => '<button type="button" class="choice' + (F.where === w ? ' is-on' : '') + '" data-dl-where="' + w + '" aria-pressed="' + (F.where === w) + '">' + esc(nice(w)) + '</button>').join('') + '</div></fieldset>' +
        '<fieldset><legend>WHY?</legend><div class="choice-row">' + DELAY_REASONS.concat(['Other']).map((r) => '<button type="button" class="choice' + (F.reason === r ? ' is-on' : '') + '" data-dl-reason="' + esc(r) + '" aria-pressed="' + (F.reason === r) + '">' + esc(r) + '</button>').join('') + '</div>' +
          (F.reason === 'Other' ? '<div class="field is-wide"><label for="dlOther">Reason</label><input id="dlOther" maxlength="60" value="' + esc(F.other) + '" autocomplete="off"></div>' : '') +
          '<div class="field is-wide"><label for="dlNote">Note (optional — the sales person sees it)</label><input id="dlNote" maxlength="300" value="' + esc(F.note) + '" placeholder="Type a note for the sales person" autocomplete="off"></div></fieldset>' +
        '<fieldset><legend>MOVE THE DATES TOO?</legend>' +
          (j.etd ? '<button type="button" class="toggle dl-move" data-dl-move="etd" aria-pressed="' + F.move.etd + '"><span class="toggle-track"><span class="toggle-thumb"></span></span>' + (j.mode === 'courier' ? 'Pick-up' : 'ETD') + ' ' + fmt(j.etd) + ' → <b>' + shift(j.etd) + '</b></button>' : '') +
          (j.eta ? '<button type="button" class="toggle dl-move" data-dl-move="eta" aria-pressed="' + F.move.eta + '"><span class="toggle-track"><span class="toggle-thumb"></span></span>' + (j.mode === 'courier' ? 'Delivery' : 'ETA') + ' ' + fmt(j.eta) + ' → <b>' + shift(j.eta) + '</b></button>' : '') +
          (!j.etd && !j.eta ? '<p class="pop-hint">This job has no ETD / ETA yet.</p>' : '<p class="pop-hint">Editing ETD or ETA by hand never counts as a delay — only this does.</p>') + '</fieldset>' +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit"' + (reasonOk ? '' : ' disabled') + '>MARK DELAY +' + F.days + 'D</button></div>' +
      '</form>';
  }
  async function submitDelay() {
    const F = state.delayForm; const j = findJob(F.no); if (!j) return;
    const reason = F.reason === 'Other' ? F.other.trim() : F.reason;
    if (!reason) { $('#formError').textContent = 'Choose a reason.'; return; }
    const btn = $('#formSubmit'); btn.disabled = true; btn.textContent = 'SAVING…';
    try {
      const res = await api.call('ethixDelayAdd', [j.jobNo, { days: F.days, where: F.where, reason, note: F.note.trim(), moveEtd: !!(F.move.etd && j.etd), moveEta: !!(F.move.eta && j.eta) }]);
      if (res && res.ok) {
        const K = keyOf(j);
        if (Array.isArray(res.row)) { state.rowMap.set(K, res.row); rebuildJob(K); }
        state.delays[K] = res.delays || [];
        closeOverlays(); rerender();
        toast('Delay +' + F.days + (F.days === 1 ? ' day' : ' days') + ' marked', { action: { label: 'Undo', fn: () => removeDelay(res.id, true) } });
        state.syncedAt = Date.now();
        return;
      }
      $('#formError').textContent = (res && res.error) || 'Not saved.';
    } catch (e) { if (e.kind !== 'auth') $('#formError').textContent = /not available/i.test(e.message) ? 'Mark delay needs the Phase 4 Code.gs update.' : e.message; }
    btn.disabled = false; btn.textContent = 'MARK DELAY +' + F.days + 'D';
  }
  async function removeDelay(id, quiet) {
    setSaving(1);
    try {
      const res = await api.call('ethixDelayRemove', [id]);
      if (res && res.ok) {
        const K = String(res.jobNo || '').toUpperCase();
        if (Array.isArray(res.row)) { state.rowMap.set(K, res.row); rebuildJob(K); }
        state.delays[K] = res.delays || [];
        rerender();
        toast(quiet ? 'Delay undone' : 'Delay removed' + (res.restored && res.restored.length ? ' — dates put back' : ''));
        return;
      }
      toast((res && res.error) || 'Not removed.', { error: true });
    } catch (e) { if (e.kind !== 'auth') toast(e.message, { error: true }); }
    finally { setSaving(-1); }
  }

  // ---------- enquiries ----------
  const ENQ_TABS_CS = [['new', 'New'], ['progress', 'In progress'], ['booked', 'Booked'], ['closed', 'Closed']];
  const ENQ_TABS_SALES = [['open', 'Open'], ['booked', 'Booked'], ['closed', 'Closed']];
  const enqBucket = (e) => (e.status === 'NEW' ? 'new' : e.status === 'IN PROGRESS' ? 'progress' : e.status === 'BOOKED' ? 'booked' : 'closed');
  const enqInTab = (e, tab) => (tab === 'open' ? ['new', 'progress'].includes(enqBucket(e)) : enqBucket(e) === tab);
  const enqOpen = () => state.enquiries.filter((e) => ['NEW', 'IN PROGRESS'].includes(e.status));
  const enqNew = () => state.enquiries.filter((e) => e.status === 'NEW');
  const ENQ_CHIP = { NEW: 'chip-teal', 'IN PROGRESS': 'chip-done', BOOKED: 'chip-hold', DECLINED: 'chip-calm', CANCELLED: 'chip-calm' };
  function findEnq(id) { return state.enquiries.find((e) => e.id === id) || null; }
  function putEnq(e) { const i = state.enquiries.findIndex((x) => x.id === e.id); if (i > -1) state.enquiries[i] = e; else state.enquiries.unshift(e); }
  function enqRoute(e) { return (e.pol || '—') + ' → ' + (e.pod || '—'); }
  function enqCard(e) {
    const urgent = e.priority === 'URGENT' && ['NEW', 'IN PROGRESS'].includes(e.status);
    const notes = e.thread.filter((x) => x.txt && !x.ev).length;
    return '<button type="button" class="enq-card' + (urgent ? ' is-urgent' : '') + '" data-enq="' + esc(e.id) + '">' +
      '<span class="ec-top"><span class="ec-id">' + esc(e.id) + '</span><span class="chip ' + (ENQ_CHIP[e.status] || 'chip-calm') + '">' + esc(e.status === 'IN PROGRESS' ? 'IN PROGRESS' : e.status) + '</span></span>' +
      '<span class="ec-cust">' + esc(e.customer) + '</span>' +
      '<span class="ec-route"><span class="badge">' + esc(e.type) + '</span>' + esc(enqRoute(e)) + '</span>' +
      '<span class="ec-cargo">' + esc([e.cargo, e.commodity].filter(Boolean).join(' · ') || TYPE_NAMES[e.type] || '') + (e.ready ? ' · ready ' + fmt(parseDate(e.ready)) : '') + '</span>' +
      '<span class="ec-foot"><span class="ec-who"><span class="avatar is-other">' + esc(initials(e.sales)) + '</span>' + esc(isSales() ? (e.cs ? e.cs + ' on it' : 'Waiting for Customer Service') : e.sales + (e.cs ? ' · ' + e.cs + ' on it' : '')) + '</span>' +
        '<span class="ec-when">' + (urgent ? '<span class="chip chip-urgent">' + icon('alert', 12) + 'URGENT</span>' : '') + (notes ? '<span class="ec-notes">' + icon('note', 13) + notes + '</span>' : '') + esc(ago(e.t)) + '</span></span>' +
      (e.status === 'BOOKED' ? '<span class="ec-booked">' + icon('check', 14) + 'Job ' + esc(e.job) + '</span>' : e.reason && ['DECLINED', 'CANCELLED'].includes(e.status) ? '<span class="ec-reason">' + esc(e.reason) + '</span>' : '') +
    '</button>';
  }
  function renderEnquiries(first) {
    const anim = first ? ' reveal' : '';
    const tabs = isSales() ? ENQ_TABS_SALES : ENQ_TABS_CS;
    if (!tabs.some((t) => t[0] === state.enqTab)) state.enqTab = tabs[0][0];
    const q = (state.enqQ || '').trim().toUpperCase();
    const list = state.enquiries.filter((e) => enqInTab(e, state.enqTab) && (!q || (e.id + ' ' + e.customer + ' ' + e.pol + ' ' + e.pod + ' ' + e.sales + ' ' + e.cs + ' ' + e.commodity).toUpperCase().includes(q)));
    const keepQ = $('#enqSearch') ? $('#enqSearch').value : state.enqQ || '';
    $('#view').innerHTML = '<div class="wrap enq-page">' +
      '<header class="page-head' + anim + '"><div class="head-main"><div class="meta-line"><span>ENQUIRIES · ' + enqOpen().length + ' OPEN</span><span class="sync" id="sync"><span class="sync-dot"></span><span id="syncText">' + syncText() + '</span></span></div><h1 class="greeting">' + (isSales() ? 'My enquiries' : 'Enquiries') + '</h1></div>' +
        '<div class="head-actions"><label class="search">' + icon('search') + '<input id="enqSearch" type="search" placeholder="Customer, port, EQ no…" aria-label="Search enquiries" autocomplete="off" value="' + esc(keepQ) + '"></label>' +
        '<button type="button" class="btn-ghost" id="refreshBtn" data-act="refresh" aria-label="Refresh"><span class="spin">' + icon('refresh', 16) + '</span><span class="btn-label">Refresh</span></button>' +
        (canNote() ? '<button type="button" class="btn-brutal btn-icon" data-act="new-enq">' + icon('plus', 16) + '<span>NEW ENQUIRY</span></button>' : '') + '</div></header>' +
      '<div class="chips-row enq-tabs' + anim + '" role="tablist" aria-label="Enquiry status" style="--d:40ms">' + tabs.map(([id, l]) => {
        const n = state.enquiries.filter((e) => enqInTab(e, id)).length;
        return '<button type="button" class="fchip" role="tab" data-enq-tab="' + id + '" aria-pressed="' + (state.enqTab === id) + '" aria-selected="' + (state.enqTab === id) + '">' + l + ' <span class="tab-n">' + n + '</span></button>';
      }).join('') + '</div>' +
      (list.length ? '<div class="enq-grid' + anim + '" style="--d:80ms">' + list.map(enqCard).join('') + '</div>'
        : '<section class="tile' + anim + '" style="--d:80ms">' + empty('enq', state.enqTab === 'new' ? 'No new enquiries. New ones from sales land here and ring the bell.' : isSales() && state.enqTab === 'open' ? 'No open enquiries. Tap NEW ENQUIRY to send one to Customer Service.' : 'Nothing here.') + '</section>') +
      '</div>';
    if (keepQ && state.enqFocus) { const s = $('#enqSearch'); s.focus(); s.setSelectionRange(keepQ.length, keepQ.length); }
  }
  const DECLINE_REASONS = ['No space', 'Rate not competitive', 'Not our trade lane', 'Customer cancelled'];
  function enqPanel(id) {
    return () => {
      const e = findEnq(id); if (!e) return '<div class="tile-empty">This enquiry is no longer in the list.</div>';
      const open = ['NEW', 'IN PROGRESS'].includes(e.status);
      const sub = state.enqSub && state.enqSub.id === id ? state.enqSub.kind : '';
      const kv = (k, v) => v ? '<div class="kv"><span class="kv-k">' + esc(k) + '</span><span class="kv-v">' + esc(v) + '</span></div>' : '';
      const ev = (x) => x.ev === 'CREATED' ? 'sent the enquiry' : x.ev === 'TAKEN' ? 'is working on it' : x.ev === 'BOOKED' ? 'booked it as job ' + (x.txt || '') : x.ev === 'DECLINED' ? 'declined it' : x.ev === 'CANCELLED' ? 'cancelled it' : x.ev === 'REOPENED' ? 'reopened it' : 'added a note';
      const thread = e.thread.slice().sort((a, b) => b.t - a.t);
      let actions = '';
      if (canEdit() && open) {
        actions = (e.cs !== state.user ? '<button type="button" class="btn-ghost" data-enq-act="take">' + icon('check', 16) + (e.cs ? 'Take over from ' + esc(e.cs) : 'Take it') + '</button>' : '') +
          '<button type="button" class="btn-ghost" data-enq-sub="decline">Decline</button><button type="button" class="btn-brutal" data-enq-book>BOOK AS JOB</button>';
      } else if (isSales() && open) actions = '<button type="button" class="btn-ghost is-danger" data-enq-sub="cancel">Cancel enquiry</button>';
      else if (canNote() && ['DECLINED', 'CANCELLED'].includes(e.status)) actions = '<button type="button" class="btn-ghost" data-enq-act="reopen">Reopen</button>';
      if (e.status === 'BOOKED' && e.job) actions = '<button type="button" class="btn-brutal" data-job="' + esc(e.job) + '">OPEN JOB ' + esc(e.job) + '</button>';
      const subForm = sub === 'decline' ? '<form class="enq-sub" data-enq-form="decline"><div class="pop-label">Why decline?</div><div class="choice-row">' + DECLINE_REASONS.map((r) => '<button type="button" class="choice" data-enq-reason="' + esc(r) + '">' + esc(r) + '</button>').join('') + '</div><input type="text" id="enqReason" maxlength="200" placeholder="Reason (the sales person sees it)" autocomplete="off"><div class="form-actions is-inline"><button type="button" class="btn-ghost" data-enq-sub="">Back</button><button type="submit" class="btn-brutal">DECLINE</button></div></form>'
        : sub === 'cancel' ? '<form class="enq-sub" data-enq-form="cancel"><div class="pop-label">Cancel this enquiry?</div><input type="text" id="enqReason" maxlength="200" placeholder="Reason (optional)" autocomplete="off"><div class="form-actions is-inline"><button type="button" class="btn-ghost" data-enq-sub="">Keep it</button><button type="submit" class="btn-brutal">CANCEL ENQUIRY</button></div></form>' : '';
      return '<h2 class="peek-job form-title" id="drawerTitle">' + esc(e.id) + ' <span class="chip ' + (ENQ_CHIP[e.status] || 'chip-calm') + '">' + esc(e.status) + '</span>' + (e.priority === 'URGENT' && open ? '<span class="chip chip-urgent">' + icon('alert', 12) + 'URGENT</span>' : '') + '</h2>' +
        '<div class="enq-cust">' + esc(e.customer) + '</div><div class="ec-route"><span class="badge">' + esc(e.type) + '</span>' + esc(TYPE_NAMES[e.type] || '') + ' · ' + esc(enqRoute(e)) + '</div>' +
        '<div class="peek-card">' + kv('Cargo', e.cargo) + kv('Commodity', e.commodity) + kv('Cargo ready', e.ready ? fmt(parseDate(e.ready), true) : '') + kv('Sales', e.sales) + kv('Customer Service', e.cs || 'Not taken yet') + kv('Sent', ago(e.t)) + kv('Job', e.job) + (/^Cancelled by (.+)$/.test(e.reason || '') ? kv('Cancelled by', e.reason.slice(13)) : kv('Reason', ['DECLINED', 'CANCELLED'].includes(e.status) ? e.reason : '')) + '</div>' +
        (e.details ? '<p class="enq-details">' + esc(e.details) + '</p>' : '') +
        (actions ? '<div class="enq-actions">' + actions + '</div>' : '') + subForm +
        '<section class="enq-thread"><h3 class="tile-title">CONVERSATION</h3>' +
          (canNote() ? '<form class="note-box" data-enq-form="note"><input type="text" id="enqNote" maxlength="1000" placeholder="' + (isSales() ? 'Message Customer Service…' : 'Message ' + esc(nice(e.sales)) + '…') + '" aria-label="Add a message" autocomplete="off"><button type="submit" class="note-post">Post</button></form>' : '') +
          '<ol class="story">' + thread.map((x) => '<li><div class="st-when">' + esc(ago(x.t)) + '</div><span class="avatar' + (x.by === state.user ? '' : ' is-other') + '">' + esc(initials(x.by)) + '</span><div class="st-body"><div><strong>' + esc(x.by) + '</strong> ' + esc(x.ev ? ev(x) : 'wrote') + '</div>' + (x.txt && x.ev !== 'BOOKED' ? '<div class="st-note">' + esc(x.txt) + '</div>' : '') + '</div></li>').join('') + '</ol></section>';
    };
  }
  function openEnquiry(id, opener) {
    if (!findEnq(id)) { toast('That enquiry is not in your list any more.'); return; }
    closeOverlays(true);
    state.enqSub = null;
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'ENQUIRY';
    popRender = enqPanel(id);
    state.enqOpenId = id;
    $('#drawerBody').innerHTML = popRender();
    showDrawer(opener);
    state.overlay = 'enq';
  }
  async function enqAct(id, action, data) {
    setSaving(1);
    try {
      const res = await api.call('ethixEnquiryAct', [id, action, data || {}]);
      if (res && res.ok && res.enquiry) {
        putEnq(res.enquiry); state.enqSub = null;
        refreshOverlay(); rerender(); updateNav();
        toast({ take: 'You’re on it — ' + nice(res.enquiry.sales) + ' was told', note: 'Message sent', decline: 'Declined — ' + nice(res.enquiry.sales) + ' was told', cancel: 'Enquiry cancelled', reopen: 'Reopened' }[action] || 'Saved');
        return true;
      }
      if (res && res.enquiry) { putEnq(res.enquiry); refreshOverlay(); }
      toast((res && res.error) || 'Not saved.', { error: true });
    } catch (e) { if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Enquiries need the Phase 4 Code.gs update.' : e.message, { error: true }); }
    finally { setSaving(-1); }
    return false;
  }
  function cargoCounts(text) { const t = String(text || ''); const a = t.match(/(\d+)\s*[×x]\s*20/i), b = t.match(/(\d+)\s*[×x]\s*40/i); return { c20: a ? a[1] : '', c40: b ? b[1] : '' }; }
  function bookEnquiry(id) {
    const e = findEnq(id); if (!e || !canEdit()) return;
    const cc = cargoCounts(e.cargo);
    openNewJob(e.type, { enq: e.id, prefill: { customer: e.customer, pol: e.pol, pod: e.pod, sales: e.sales, c20: cc.c20, c40: cc.c40, dg: /\bDG\b/.test(e.cargo) && !/NON DG/.test(e.cargo) ? 'DG' : 'NON DG', remarks: [e.commodity, e.details].filter(Boolean).join(' — ').slice(0, 480) } });
  }
  // New enquiry form (sales, and Customer Service on someone's behalf)
  const FCL = ['SFEF', 'SFIF', 'CND', 'SFC'];
  function openNewEnquiry() {
    if (!canNote()) return;
    if (canEdit()) loadLists();
    closeOverlays(true);
    state.newEnq = { type: '' };
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'NEW ENQUIRY';
    renderNewEnquiry();
    showDrawer(document.activeElement);
    state.overlay = 'enqform';
  }
  function renderNewEnquiry() {
    const t = state.newEnq.type;
    if (!t) { $('#drawerBody').innerHTML = '<h2 class="peek-job form-title" id="drawerTitle">What does the customer need?</h2>' + typeTiles('', true); return; }
    const crr = t === 'CRR';
    const f = (id, label, ctl, wide) => '<div class="field' + (wide ? ' is-wide' : '') + '"><label for="' + id + '">' + label + '</label>' + ctl + '<div class="field-err" id="' + id + '_err"></div></div>';
    const txt = (id, ph, list, upper) => '<input type="text" id="' + id + '"' + (list ? ' list="' + list + '"' : '') + (ph ? ' placeholder="' + esc(ph) + '"' : '') + (upper ? ' class="is-upper" autocapitalize="characters"' : '') + ' autocomplete="off" spellcheck="false">';
    const pol0 = ['SFEF', 'SFEL'].includes(t) ? 'JEBEL ALI' : t === 'AFE' ? 'DUBAI' : '', pod0 = ['SFIF', 'SFIL', 'CND'].includes(t) ? 'JEBEL ALI' : t === 'AFI' ? 'DUBAI' : '';
    $('#drawerBody').innerHTML = '<h2 class="peek-job form-title" id="drawerTitle"><span class="badge badge-lg">' + t + '</span> ' + esc(TYPE_NAMES[t]) + '</h2>' +
      '<button type="button" class="link-btn quiet form-back" data-act="ne-type">' + icon('back', 14) + 'Change type</button>' +
      '<form class="job-form" id="enqForm" novalidate>' +
        '<fieldset><legend>CUSTOMER</legend><div class="fgrid">' + f('eqCustomer', 'Customer <b aria-hidden="true">*</b>', txt('eqCustomer', '', 'dlCustomers', true), true) +
          (canEdit() ? f('eqSales', 'Sales person <b aria-hidden="true">*</b>', txt('eqSales', '', 'dlSales', true)) : '') + '</div></fieldset>' +
        '<fieldset><legend>ROUTE & CARGO</legend><div class="fgrid">' +
          f('eqPol', crr ? 'From' : 'POL — origin', txt('eqPol', '', 'dlPorts', true).replace('autocomplete', 'value="' + pol0 + '" autocomplete')) +
          f('eqPod', crr ? 'To' : 'POD — destination', txt('eqPod', '', 'dlPorts', true).replace('autocomplete', 'value="' + pod0 + '" autocomplete')) +
          (FCL.includes(t) ? f('eqC20', '20′ containers', '<input type="number" id="eqC20" min="0" max="999" inputmode="numeric">') + f('eqC40', '40′ containers', '<input type="number" id="eqC40" min="0" max="999" inputmode="numeric">')
            : f('eqCargo', 'Cargo details', txt('eqCargo', 'Enter packages, weight and volume'), true)) +
          f('eqCommodity', 'Commodity', txt('eqCommodity', 'Enter the commodity')) +
          f('eqDg', 'Cargo', '<select id="eqDg"><option>NON DG</option><option>DG</option></select>') +
          f('eqReady', 'Cargo ready', '<input type="date" id="eqReady">') +
          '<div class="field"><label>Priority</label><div class="choice-row" role="radiogroup" aria-label="Priority"><button type="button" class="choice is-on" role="radio" data-eq-pri="NORMAL" aria-checked="true">Normal</button><button type="button" class="choice" role="radio" data-eq-pri="URGENT" aria-checked="false">Urgent</button></div></div>' +
        '</div></fieldset>' +
        '<fieldset><legend>FOR CUSTOMER SERVICE</legend><div class="fgrid">' + f('eqDetails', 'Anything they should know', '<textarea id="eqDetails" rows="3" maxlength="1000" placeholder="Type anything Customer Service should know"></textarea>', true) + '</div></fieldset>' +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit">SEND ENQUIRY</button></div>' +
      '</form>' + formLists();
    state.newEnq.priority = 'NORMAL';
    setTimeout(() => { const c = $('#eqCustomer'), a = document.activeElement; if (c && !(a && a.closest && a.closest('#enqForm'))) c.focus(); }, 30);   // never steal focus from a field already in use
  }
  async function submitNewEnquiry(form) {
    const t = state.newEnq.type;
    const val = (id) => { const el = $('#' + id, form); return el ? el.value.trim() : ''; };
    const up = (s) => s.toUpperCase().replace(/\s+/g, ' ');
    $$('.field-err', form).forEach((x) => { x.textContent = ''; });
    const customer = up(val('eqCustomer'));
    if (!customer) { $('#eqCustomer_err').textContent = 'Customer is required.'; $('#eqCustomer').focus(); return; }
    const sales = canEdit() ? up(val('eqSales')) : state.user;
    if (!sales) { $('#eqSales_err').textContent = 'Which sales person?'; $('#eqSales').focus(); return; }
    const c20 = +val('eqC20') || 0, c40 = +val('eqC40') || 0;
    const dg = val('eqDg');
    const cargo = (FCL.includes(t) ? [c20 ? c20 + '×20′' : '', c40 ? c40 + '×40′' : ''].filter(Boolean).join(' + ') : val('eqCargo')) + (dg === 'DG' ? ' · DG' : '');
    const payload = { type: t, customer, sales, pol: up(val('eqPol')), pod: up(val('eqPod')), cargo, commodity: val('eqCommodity'), ready: val('eqReady'), priority: state.newEnq.priority, details: val('eqDetails') };
    const btn = $('#formSubmit'); btn.disabled = true; btn.textContent = 'SENDING…';
    try {
      const res = await api.call('ethixEnquiryAdd', [payload]);
      if (res && res.ok && res.enquiry) {
        putEnq(res.enquiry);
        closeOverlays();
        state.enqTab = isSales() ? 'open' : 'new';
        toast('Enquiry ' + res.enquiry.id + ' sent to Customer Service');
        go('#/enquiries'); rerender(); updateNav();
        return;
      }
      $('#formError').textContent = (res && res.error) || 'Not sent.';
    } catch (e) { if (e.kind !== 'auth') $('#formError').textContent = /not available/i.test(e.message) ? 'Enquiries need the Phase 4 Code.gs update.' : e.message; }
    btn.disabled = false; btn.textContent = 'SEND ENQUIRY';
  }

  // ---------- home: follow-ups and enquiries at a glance ----------
  function homeChips() {
    const t0 = today0();
    if (canEdit()) {
      const R = roundRows(t0);
      const total = R.due.length + R.done.length;
      const n = enqNew().length;
      return '<button type="button" class="meta-chip' + (R.due.length ? '' : ' is-done') + '" data-href="#/follow-ups">' + icon('check', 12) + 'FOLLOW-UPS <b>' + R.done.length + '/' + total + '</b></button>' +
        (n ? '<button type="button" class="meta-chip is-teal" data-href="#/enquiries"><b>' + n + '</b> NEW ' + (n === 1 ? 'ENQUIRY' : 'ENQUIRIES') + '</button>' : '') +
        ((rc) => rc ? '<button type="button" class="meta-chip is-ready" data-act="ready-list"><b>' + rc + '</b> READY TO CLOSE</button>' : '')(scoped().filter(isReady).length);
    }
    if (isSales()) {
      const R = roundRows(t0, state.jobs.filter((j) => j.active));
      const ok = R.all.length - R.due.length;
      const n = enqOpen().length;
      return '<button type="button" class="meta-chip' + (R.due.length ? '' : ' is-done') + '" data-list="behind">' + icon('check', 12) + 'FOLLOW-UPS <b>' + ok + '/' + R.all.length + '</b> UP TO DATE</button>' +
        (n ? '<button type="button" class="meta-chip is-teal" data-href="#/enquiries"><b>' + n + '</b> OPEN ' + (n === 1 ? 'ENQUIRY' : 'ENQUIRIES') + '</button>' : '');
    }
    return '';
  }
  function behindList() { const R = roundRows(today0(), state.jobs.filter((j) => j.active)); return R.due.map((x) => x.j); }

  // ---------- wiring ----------
  function initPhase4() {
    const view = $('#view');
    view.addEventListener('click', (e) => {
      const r = state.route ? state.route.name : '';
      const b = e.target.closest('[data-check], [data-check-menu], [data-every], [data-cal], [data-enq], [data-enq-tab], [data-act="delay"], [data-act="delays"], [data-delay-rm]');
      if (!b) return;
      if (b.dataset.check && canEdit()) { followCheck(b.dataset.check); return; }
      if (b.dataset.checkMenu && canEdit()) { openPop(b, 'FOLLOW-UP', checkedMenu(b.dataset.checkMenu)); return; }
      if (b.dataset.every && canEdit()) { openPop(b, 'FOLLOW-UP', everyMenu(b.dataset.every)); return; }
      if (b.dataset.cal) { const K = String(b.dataset.calJob).toUpperCase(); state.calOffset[K] = Math.min(0, (state.calOffset[K] || 0) + +b.dataset.cal); rerender(); return; }
      if (b.dataset.enq) { openEnquiry(b.dataset.enq, b); return; }
      if (b.dataset.enqTab) { state.enqTab = b.dataset.enqTab; rerender(); return; }
      if (b.dataset.act === 'delay' && r === 'job') { openDelay(state.route.jobNo); return; }
      if (b.dataset.act === 'delays') { const k = findJob(state.route.jobNo); if (!$('#delayCard') && k) { state.voyageTab[k.jobNo] = 'overview'; rerender(); } const c = $('#delayCard'); if (c) { c.scrollIntoView({ block: 'center', behavior: 'smooth' }); c.classList.remove('is-flash'); void c.offsetWidth; c.classList.add('is-flash'); } return; }
      if (b.dataset.delayRm && canEdit()) {
        const id = b.dataset.delayRm;
        confirmBox('Remove this delay?', 'If the delay moved ETD/ETA and nobody changed them since, they go back too.', 'Remove', () => removeDelay(id));
      }
    });
    view.addEventListener('input', (e) => {
      if (e.target.id === 'roundSearch') { state.roundQ = e.target.value; clearTimeout(state.roundTimer); state.roundTimer = setTimeout(() => { state.roundFocus = true; rerender(); state.roundFocus = false; }, 140); }
      if (e.target.id === 'enqSearch') { state.enqQ = e.target.value; clearTimeout(state.enqTimer); state.enqTimer = setTimeout(() => { state.enqFocus = true; rerender(); state.enqFocus = false; }, 140); }
    });
    view.addEventListener('click', (e) => {          // Mine / Everyone on the round page
      const s = e.target.closest('[data-scope]');
      if (s && state.route && state.route.name === 'round' && canEdit()) { state.scope = s.dataset.scope; store.set('ethix.v2.scope.' + state.user, state.scope); state.roundSnap = null; rerender(); updateNav(); }
      if (e.target.closest('[data-act="refresh"]') && state.route && state.route.name === 'round') state.roundSnap = null;
    });
    // popover / sheet: frequency, remark, undo
    const onPop = (e) => {
      const ev = e.target.closest('[data-set-every]'); if (ev) { followPlan(ev.dataset.no, ev.dataset.setEvery); return; }
      const un = e.target.closest('[data-undo-check]'); if (un) { followUndo(un.dataset.undoCheck); }
    };
    const onPopSubmit = (e) => {
      const f = e.target.closest('[data-remark]'); if (!f) return;
      e.preventDefault();
      const no = f.dataset.remark, text = $('#remarkInput').value.trim();
      closeOverlays();
      followCheck(no, text);
    };
    $('#pop').addEventListener('click', onPop);
    $('#pop').addEventListener('submit', onPopSubmit);
    const body = $('#drawerBody');
    body.addEventListener('click', (e) => {
      if (state.overlay === 'sheet') { onPop(e); return; }
      if (state.overlay === 'drawer') {                              // a notification about an enquiry
        const q = e.target.closest('[data-enq]');
        if (q) { const id = q.dataset.enq; closeOverlays(true); go('#/enquiries'); setTimeout(() => openEnquiry(id), 40); }
        return;
      }
      if (state.overlay === 'delay') {
        const F = state.delayForm; if (!F) return;
        const t = e.target.closest('[data-dl-step], [data-dl-days], [data-dl-where], [data-dl-reason], [data-dl-move], [data-act="form-cancel"]'); if (!t) return;
        if (t.dataset.act === 'form-cancel') { closeOverlays(); return; }
        const other = $('#dlOther'); if (other) F.other = other.value; F.note = $('#dlNote').value;
        if (t.dataset.dlStep) F.days = Math.max(1, Math.min(90, F.days + +t.dataset.dlStep));
        if (t.dataset.dlDays) F.days = +t.dataset.dlDays;
        if (t.dataset.dlWhere) { F.where = t.dataset.dlWhere; F.move = movesDates(F.where); }
        if (t.dataset.dlReason) F.reason = t.dataset.dlReason;
        if (t.dataset.dlMove) F.move[t.dataset.dlMove] = !F.move[t.dataset.dlMove];
        const y = body.scrollTop; body.innerHTML = delayForm(); body.scrollTop = y;
        if (t.dataset.dlReason === 'Other') { const o = $('#dlOther'); if (o) o.focus(); }
        return;
      }
      if (state.overlay === 'enq') {
        const id = state.enqOpenId;
        const t = e.target.closest('[data-enq-act], [data-enq-sub], [data-enq-book], [data-enq-reason]'); if (!t) return;
        if (t.dataset.enqAct) { enqAct(id, t.dataset.enqAct, t.dataset.enqAct === 'take' ? { force: true } : {}); return; }
        if (t.dataset.enqSub !== undefined) { state.enqSub = t.dataset.enqSub ? { id, kind: t.dataset.enqSub } : null; refreshOverlay(); const r = $('#enqReason'); if (r) r.focus(); return; }
        if (t.dataset.enqBook !== undefined) { bookEnquiry(id); return; }
        if (t.dataset.enqReason) { const r = $('#enqReason'); if (r) { r.value = t.dataset.enqReason; r.focus(); } }
        return;
      }
      if (state.overlay === 'enqform') {
        const tp = e.target.closest('[data-type]');
        if (tp) { state.newEnq.type = tp.dataset.type; renderNewEnquiry(); return; }
        if (e.target.closest('[data-act="ne-type"]')) { state.newEnq.type = ''; renderNewEnquiry(); return; }
        const pr = e.target.closest('[data-eq-pri]');
        if (pr) { state.newEnq.priority = pr.dataset.eqPri; $$('[data-eq-pri]').forEach((x) => { const on = x === pr; x.classList.toggle('is-on', on); x.setAttribute('aria-checked', String(on)); }); return; }
        if (e.target.closest('[data-act="form-cancel"]')) closeOverlays();
      }
    });
    body.addEventListener('input', (e) => {
      if (state.overlay === 'form' && /^f_/.test(e.target.id || '')) {          // typing in a field clears its old error
        const k = e.target.id.slice(2), er = $('#f_' + k + '_err');
        if (er && er.textContent) fieldError(k, '');
      }
      if (state.overlay === 'delay' && state.delayForm) {
        if (e.target.id === 'dlOther') { state.delayForm.other = e.target.value; const s = $('#formSubmit'); if (s) s.disabled = !e.target.value.trim(); }
        if (e.target.id === 'dlNote') state.delayForm.note = e.target.value;
      }
    });
    body.addEventListener('submit', (e) => {
      if (state.overlay === 'sheet') { onPopSubmit(e); return; }
      if (state.overlay === 'delay') { e.preventDefault(); submitDelay(); return; }
      if (state.overlay === 'enqform') { e.preventDefault(); submitNewEnquiry(e.target); return; }
      if (state.overlay === 'enq') {
        const f = e.target.closest('[data-enq-form]'); if (!f) return;
        e.preventDefault();
        const id = state.enqOpenId, kind = f.dataset.enqForm;
        if (kind === 'note') { const inp = $('#enqNote'); const txt = inp.value.trim(); if (!txt) return; inp.value = ''; enqAct(id, 'note', { text: txt }).then((ok) => { if (!ok) { const i2 = $('#enqNote'); if (i2 && !i2.value) i2.value = txt; } }); return; }
        const reason = ($('#enqReason') || {}).value || '';
        if (kind === 'decline' && !reason.trim()) { toast('Give a reason — the sales person sees it.', { error: true }); return; }
        enqAct(id, kind, { reason: reason.trim() });
      }
    });
  }

  // Long port names (DAR ES SALAAM, PORT KLANG…) step down in size to fit the voyage header instead of being cut off.
  function fitNames() {
    $$('.home .greeting').forEach((el) => {
      el.style.fontSize = '';
      let fs = parseFloat(getComputedStyle(el).fontSize);
      while (el.scrollWidth > el.clientWidth + 1 && fs > 20) { fs -= 1; el.style.fontSize = fs + 'px'; }
      el.title = el.scrollWidth > el.clientWidth + 1 ? el.textContent : '';
    });
    $$('.vh-port .vh-name').forEach((el) => {
      el.style.fontSize = '';
      let fs = parseFloat(getComputedStyle(el).fontSize);
      while (el.scrollWidth > el.clientWidth + 1 && fs > 15) { fs -= 1; el.style.fontSize = fs + 'px'; }
      el.title = el.scrollWidth > el.clientWidth + 1 ? el.textContent : '';
    });
  }
  // ================================================================ v2.5
  // Close job → Closed jobs (archive). Ready-to-close rule, close dialog, reopen, closed job pages.
  const CLOSE_AT = { SEA_EX: 'arrived', AFE: 'arrived', SFC: 'arrived', AFC: 'arrived', SEA_IM: 'delivered', AFI: 'delivered', CND: 'deliveredOpt', CRR: 'deliveredEta', MIS: '' };
  const CLOSE_REASONS = ['Cancelled', 'Moved to another forwarder', 'Duplicate job', 'Other'];
  // Ready to close = costing done + arrived (exports, cross-trade) / delivered (imports, clearance, courier). Misc: costing only.
  function closeCheck(j) {
    const all = (j.journey && j.journey.all) || [];
    const st = (id) => all.find((x) => x.id === id);
    const c = st('costing');
    const need = [{ name: 'Costing done', ok: !!c && c.state === 'done', sub: c ? c.sub : '' }];
    let id = CLOSE_AT[journeyKey(j.type)];
    if (id === 'deliveredOpt') { const dv = st('deliveredOpt'), cu = st('customsOpt'); id = dv && dv.state !== 'skip' ? 'deliveredOpt' : cu && cu.state !== 'skip' ? 'customsOpt' : 'arrived'; }
    const a = id ? st(id) : null;
    if (a) need.push({ name: a.name, ok: a.state === 'done', sub: a.sub });
    return { ready: need.every((x) => x.ok), need };
  }
  const isReady = (j) => j.active && !j.closed && closeCheck(j).ready;
  const readyChip = (j) => canEdit() && isReady(j) ? '<button type="button" class="ready-chip" data-act="close-job">' + icon('check', 13) + 'READY TO CLOSE</button>' : '';
  const canEditJob = (j) => canEdit() && !(j && j.closed);
  function closedActions(j) {
    const c = j.closed || {};
    return '<div class="vh-actions is-ro is-closed"><span class="ro-chip closed-chip">' + icon('lock', 14) + '<span>CLOSED' + (c.at ? ' ' + esc(c.at) : '') + (c.by ? ' · ' + esc(c.by) : '') + '</span></span>' +
      (canEdit() ? '<button type="button" class="btn-brutal" data-act="reopen">REOPEN JOB</button>' : '') + '</div>';
  }
  function buildClosed(ix, row, closed) {
    const j = buildJob(row, ix, today0());
    j.closed = closed || { at: '', by: '', reason: '' };
    j.active = false;
    return j;
  }
  function removeJob(K) {
    state.order = state.order.filter((k) => k !== K);
    state.rowMap.delete(K);
    rebuildJobs();
  }
  const nowText = () => { const d = dxb(); return String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // a closed job opened by link, notification or search: fetch it once
  function loadClosed(no) {
    const K = String(no || '').toUpperCase();
    const t = state.closedTry[K];
    if (t === 'done') return false;
    if (t === 'busy') return true;
    state.closedTry[K] = 'busy';
    api.call('ethixArchivedJob', [no]).then((res) => {
      if (res && res.ok && Array.isArray(res.row)) {
        state.closedJobs.set(K, buildClosed(mapHeaders(res.head), res.row, res.closed));
        if (Array.isArray(res.delays) && res.delays.length) state.delays[K] = res.delays;
        if (Array.isArray(res.costing)) state.costing[K] = res.costing;
      }
    }).catch(() => {}).finally(() => { state.closedTry[K] = 'done'; if (state.route && (state.route.name === 'job' || state.route.name === 'costjob')) rerender(); });
    return true;
  }

  // ---------- close dialog ----------
  function openClose(no, opts) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;
    closeOverlays(true);
    state.closeForm = { no: j.jobNo, reason: (opts && opts.reason) || '', other: '', note: '' };
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'CLOSE JOB';
    popRender = closeForm;
    $('#drawerBody').innerHTML = closeForm();
    showDrawer(document.activeElement);
    state.overlay = 'close';
  }
  function closeForm() {
    const F = state.closeForm; const j = findJob(F.no); if (!j) return '';
    const c = closeCheck(j);
    const reasonOk = c.ready || (F.reason && (F.reason !== 'Other' || F.other.trim()));
    return '<h2 class="peek-job form-title" id="drawerTitle">' + esc(j.jobNo) + ' <span class="small">' + esc(j.customer || '') + '</span></h2>' +
      '<form class="job-form close-form" id="closeForm" novalidate>' +
        '<ul class="close-checks">' + c.need.map((x) => '<li class="' + (x.ok ? 'is-ok' : 'is-no') + '"><span class="cc-ic">' + icon(x.ok ? 'check' : 'clock', 15) + '</span><span class="cc-name">' + esc(x.name) + '</span><span class="cc-sub">' + esc(x.ok ? (x.sub || 'DONE') : 'NOT YET') + '</span></li>').join('') + '</ul>' +
        (c.ready ? '<p class="close-lead">Everything’s done. The job moves to <b>Closed jobs</b> and leaves Home, Jobs and Follow-ups. You can reopen it any time.</p>'
          : '<fieldset><legend>NOT READY YET — WHY CLOSE IT NOW?</legend><div class="choice-row">' + CLOSE_REASONS.map((r) => '<button type="button" class="choice' + (F.reason === r ? ' is-on' : '') + '" data-cl-reason="' + esc(r) + '" aria-pressed="' + (F.reason === r) + '">' + esc(r) + '</button>').join('') + '</div>' +
            (F.reason === 'Other' ? '<div class="field is-wide"><label for="clOther">Reason</label><input id="clOther" maxlength="80" value="' + esc(F.other) + '" autocomplete="off"></div>' : '') + '</fieldset>') +
        '<div class="field is-wide"><label for="clNote">Note (optional — goes into the job’s story)</label><input id="clNote" maxlength="300" value="' + esc(F.note) + '" placeholder="Type a note" autocomplete="off"></div>' +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit"' + (reasonOk ? '' : ' disabled') + '>CLOSE JOB</button></div>' +
      '</form>';
  }
  async function submitClose() {
    const F = state.closeForm; const j = findJob(F.no); if (!j) return;
    const c = closeCheck(j);
    const reason = c.ready ? '' : (F.reason === 'Other' ? F.other.trim() : F.reason);
    const note = F.note.trim();
    if (!c.ready && !reason) { $('#formError').textContent = 'Choose why you are closing it now.'; return; }
    const btn = $('#formSubmit'); btn.disabled = true; btn.textContent = 'CLOSING…';
    try {
      const res = await api.call('ethixJobClose', [j.jobNo, { ready: c.ready, reason, note }]);
      if (res && res.ok) {
        const K = keyOf(j);
        const row = (state.rowMap.get(K) || []).slice();
        if (state.ix.status !== undefined && state.ix.status > -1) row[state.ix.status] = /^cancel/i.test(reason) ? 'CANCELLED' : 'COMPLETED';
        state.closedJobs.set(K, buildClosed(state.ix, row, { at: nowText(), by: state.user, reason: [reason, note].filter(Boolean).join(' — ') }));
        state.closedTry[K] = 'done';
        removeJob(K);
        state.recent = state.recent.filter((x) => String(x[3] || '').trim().toUpperCase() !== K);
        state.stories.delete(K);
        if (state.notif && state.notif.items) state.notif.items = state.notif.items.filter((x) => String(x.job || '').toUpperCase() !== K || /closed/i.test(x.text));
        state.archive.jobs = null;
        closeOverlays();
        go('#/jobs'); rerender(); updateNav();
        toast('Job ' + j.jobNo + ' closed', { action: { label: 'Undo', fn: () => reopenJob(j.jobNo, true) } });
        return;
      }
      $('#formError').textContent = (res && res.error) || 'The job was not closed.';
    } catch (e) { if (e.kind !== 'auth') $('#formError').textContent = /not available/i.test(e.message) ? 'Close job needs the v2.5 Code.gs update.' : e.message; }
    btn.disabled = false; btn.textContent = 'CLOSE JOB';
  }
  async function reopenJob(no, undo) {
    setSaving(1);
    try {
      const res = await api.call('ethixJobReopen', [no]);
      if (res && res.ok && Array.isArray(res.row)) {
        const K = String(res.jobNo || no).toUpperCase();
        state.rowMap.set(K, res.row); rebuildJob(K);
        state.closedJobs.delete(K); delete state.closedTry[K]; state.stories.delete(K);
        if (state.archive.jobs) state.archive.jobs = state.archive.jobs.filter((x) => keyOf(x) !== K);
        rerender(); updateNav();
        if (Array.isArray(res.costing)) state.costing[K] = res.costing;
        if (state.cost && state.cost.no === K) state.cost = null;
        toast(undo ? 'Close undone — ' + no + ' is open again' : 'Job ' + no + ' reopened');
        setTimeout(() => refresh(false), 300);
        return;
      }
      toast((res && res.error) || 'Not reopened.', { error: true });
    } catch (e) { if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Reopen needs the v2.5 Code.gs update.' : e.message, { error: true }); }
    finally { setSaving(-1); }
  }

  // ---------- Jobs → Show: Closed jobs (loads only when asked) ----------
  function closedList() {
    const A = state.archive, u = state.jobsUi;
    if (!A.jobs && !A.loading) setTimeout(loadArchive, 0);
    const q = u.q.trim().toUpperCase();
    return (A.jobs || []).filter((j) => inCat(j, u.cat) && (!canEdit() || j.cs === state.user) &&
      (!q || (j.jobNo + ' ' + j.customer + ' ' + j.vendor + ' ' + j.pol + ' ' + j.pod + ' ' + j.cs + ' ' + j.sales + ' ' + j.type + ' ' + j.remarks + ' ' + j.against).toUpperCase().includes(q)));
  }
  function loadArchive() {
    const A = state.archive, seq = ++A.seq, q = state.jobsUi.q.trim();
    A.loading = true;
    if (state.route && state.route.name === 'jobs') rerender();
    api.call('ethixArchiveSearch', [q]).then((res) => {
      if (seq !== A.seq) return;
      const ix = mapHeaders(res.head || []);
      A.jobs = (res.rows || []).map((row, i) => { const j = buildClosed(ix, row, res.closed[i]); const K = keyOf(j); state.closedJobs.set(K, j); state.closedTry[K] = 'done'; return j; });
      A.total = res.total || 0; A.loading = false;
      if (state.route && state.route.name === 'jobs') rerender();
    }).catch((e) => {
      if (seq !== A.seq) return;
      A.loading = false; A.jobs = A.jobs || []; A.total = A.jobs.length;
      if (state.route && state.route.name === 'jobs') rerender();
      if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Closed jobs need the v2.5 Code.gs update.' : e.message, { error: true });
    });
  }
  function closedNote() {
    const A = state.archive;
    if (!A.jobs) return '<div class="closed-note">' + icon('lock', 14) + '<span>Looking through closed jobs…</span></div>';
    return '<div class="closed-note">' + icon('lock', 14) + '<span><b>Closed jobs</b> · newest closed first · ' + A.total + (A.total === 1 ? ' found' : ' found') +
      (A.total > A.jobs.length ? ' · showing the newest ' + A.jobs.length + ' — search to narrow it down' : '') + (A.loading ? ' · searching…' : '') + '</span></div>';
  }

  function initV25() {
    const view = $('#view');
    // before the voyage's own handlers: the "Completed" stop and its CLOSE JOB button open the close dialog
    view.addEventListener('click', (e) => {
      const r = state.route;
      if (!r || r.name !== 'job' || !canEdit()) return;
      const st = e.target.closest('[data-stop="completed"]');
      const j = findJob(r.jobNo);
      if (st && j && !j.closed && j.status !== 'COMPLETED' && j.status !== 'CANCELLED') { e.stopImmediatePropagation(); openClose(r.jobNo); }
    }, true);
    view.addEventListener('click', (e) => {
      const r = state.route;
      if (e.target.closest('[data-act="ready-list"]')) { state.jobsUi.status = 'ready'; state.jobsUi.limit = 120; go('#/jobs'); return; }
      if (!r || r.name !== 'job') return;
      if (e.target.closest('[data-act="close-job"]') && canEdit()) { openClose(r.jobNo); return; }
      if (e.target.closest('[data-act="reopen"]') && canEdit()) { reopenJob(r.jobNo); }
    });
    // choosing Completed / Cancelled anywhere (status card, quick update) goes through Close job
    const intercept = (e) => {
      const b = e.target.closest('[data-set="status"]');
      if (!b || !['COMPLETED', 'CANCELLED'].includes(b.dataset.val)) return;
      const r = state.route; if (!r || r.name !== 'job' || !canEdit()) return;
      const j = findJob(r.jobNo); if (!j || j.closed) return;
      e.stopImmediatePropagation(); e.preventDefault();
      openClose(r.jobNo, { reason: b.dataset.val === 'CANCELLED' ? 'Cancelled' : '' });
    };
    $('#pop').addEventListener('click', intercept, true);
    $('#drawerBody').addEventListener('click', intercept, true);
    // the close dialog
    const body = $('#drawerBody');
    body.addEventListener('click', (e) => {
      if (state.overlay !== 'close' || !state.closeForm) return;
      const F = state.closeForm;
      if (e.target.closest('[data-act="form-cancel"]')) { closeOverlays(); return; }
      const t = e.target.closest('[data-cl-reason]'); if (!t) return;
      F.note = ($('#clNote') || {}).value || F.note; const o = $('#clOther'); if (o) F.other = o.value;
      F.reason = t.dataset.clReason;
      const y = body.scrollTop; body.innerHTML = closeForm(); body.scrollTop = y;
      if (F.reason === 'Other') { const x = $('#clOther'); if (x) x.focus(); }
    });
    body.addEventListener('input', (e) => {
      if (state.overlay !== 'close' || !state.closeForm) return;
      if (e.target.id === 'clNote') state.closeForm.note = e.target.value;
      if (e.target.id === 'clOther') { state.closeForm.other = e.target.value; const s = $('#formSubmit'); if (s) s.disabled = !e.target.value.trim(); }
    });
    body.addEventListener('submit', (e) => { if (state.overlay === 'close') { e.preventDefault(); submitClose(); } });
    // Jobs → Closed jobs: load when chosen, search on the server as you type
    view.addEventListener('change', (e) => { if (e.target.id === 'jobsStatus' && e.target.value === 'closed') loadArchive(); });
    view.addEventListener('input', (e) => {
      if (e.target.id !== 'jobsSearch' || state.jobsUi.status !== 'closed') return;
      clearTimeout(state.archiveTimer); state.archiveTimer = setTimeout(loadArchive, 380);
    });
  }

  // ================================================================ v2.6 · v2.7
  // Costing (a full page per job + the Costing menu), Excel made in the browser,
  // remembered lists, duplicate job, stay signed in after a refresh.
  // v2.7: every USD amount has its own rate, charges that fill themselves. v2.8: all-in only, one line per
  // charge on laptops, per-box figures in the bar, the statement-style Excel. v2.9: reminders and "changed since you
  // looked". v2.9.1: POD office hours, Home counters that open the side panel, Today's watch for every open task,
  // This week as an agenda; Fleet removed. v2.9.2: Dubai time everywhere, offices 09:00–17:00 (Ethix till 18:00),
  // DGPC for DG sea exports, pick a day in This week (at the end of this module).
  const BASIS = [['SHIP', 'Per shipment'], ['BOX', 'Per box'], ['B20', 'Per 20′'], ['B40', 'Per 40′'], ['DOC', 'Per document'], ['UNIT', 'Per unit']];
  const BASIS_SHORT = { SHIP: 'Per shipment', BOX: 'Per box', B20: 'Per 20′', B40: 'Per 40′', DOC: 'Per document', UNIT: 'Per unit' };
  const ABBR = new Set(['THC', 'OTHC', 'DPC', 'ISPS', 'VGM', 'BL', 'DG', 'DO', 'ED', 'TLUC', 'ITT', 'FOB', 'VAT', 'MECRC', 'IMCO', 'AWB', 'LCL', 'FCL']);
  const chipName = (q) => String(q).split(' ').map((w) => (ABBR.has(w) ? w : nice(w))).join(' ');
  const QUICK = {
    sea: ['OCEAN FREIGHT', 'THC', 'TLUC', 'BILL OF LADING', 'SEAL CHARGES', 'DPC', 'ED / BILL OF ENTRY', 'EXIT SUBMISSION', 'ISPS', 'TOKEN', 'TRANSPORTATION', 'DOCUMENTATION CHARGES'],
    cnd: ['THC', 'TLUC', 'DPC', 'ED / BILL OF ENTRY', 'CUSTOMS CHARGES', 'TOKEN', 'TRANSPORTATION', 'PORT STORAGE', 'DOCUMENTATION CHARGES'],
    air: ['AIR FREIGHT', 'HANDLING CHARGES', 'CUSTOMS CHARGES', 'TRANSPORTATION', 'DOCUMENTATION CHARGES'],
    courier: ['COURIER CHARGES', 'CUSTOMS CHARGES', 'HANDLING CHARGES', 'TRANSPORTATION'],
    misc: ['HANDLING CHARGES', 'DOCUMENTATION CHARGES', 'OTHER CHARGES']
  };
  const CHARGES0 = ['OCEAN FREIGHT', 'DG SURCHARGE', 'IMCO SURCHARGE', 'ISPS', 'BILL OF LADING', 'ADDITIONAL BL', 'LATE BL CONFIRMATION', 'OTHC', 'THC', 'TLUC', 'DPC',
    'ED / BILL OF ENTRY', 'EXIT SUBMISSION', 'SEAL CHARGES', 'TRANSPORTATION', 'TOKEN', 'TOKEN CANCELLATION', 'VGM', 'GATEPASS', 'WEIGHMENT CHARGES', 'FLEXI CHARGES / FITTING',
    'SURRENDER CHARGES', 'PORT STORAGE', 'HOLD CHARGES', 'CUSTOMS CHARGES', 'MECRC', 'ITT CHARGES', 'HANDLING CHARGES', 'DOCUMENTATION CHARGES', 'DG DOC FEE', 'FOB CHARGES',
    'REHANDLING CHARGES', 'BL AMENDMENT', 'CONTAINER REPAIR', 'WAITING CHARGES', 'VAT / INSPECTION', 'CHEMICAL PERMITS', 'REBATE', 'OTHER CHARGES'];
  const PORTS0 = ['JEBEL ALI', 'DUBAI', 'KHOR FAKKAN', 'SHARJAH', 'ABU DHABI'];
  I.download = '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>';
  const num6 = (v) => { const s = String(v == null ? '' : v).replace(/,/g, '').trim(); if (!s) return 0; const n = Number(s); return isFinite(n) ? n : NaN; };
  const money = (n) => { const v = Math.round((Number(n) || 0) * 100) / 100; const p = Math.abs(v).toFixed(2).split('.'); return (v < 0 ? '−' : '') + p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + p[1]; };
  const pctTxt = (v) => (isFinite(v) ? (Math.round(v * 1000) / 10).toFixed(1) + '%' : '—');
  const numTxt = (n) => (n === 0 || n === '' || n == null ? '' : String(Math.round(Number(n) * 10000) / 10000));
  const fxTxt = (n) => (Number(n) ? String(Math.round(Number(n) * 100000) / 100000) : '');
  const amtOf = (qty, rate, cur, fx) => { const q = num6(qty), r = num6(rate); return (isNaN(q) ? 0 : q) * (isNaN(r) ? 0 : r) * (cur === 'USD' ? fx : 1); };
  // ---------- USD rates: each USD amount has its own; the shipping line decides where the buying side starts ----------
  const COMPANY_FX = () => Number(state.rate) || 3.685;
  const LINE_FX = [[/HAPAG/, 3.7], [/\bCMA\b|CMA[\s\-]*CGM/, 3.6725], [/MAERSK/, 3.70922]];
  const upq = (v) => String(v || '').toUpperCase().replace(/\s+/g, ' ').trim();
  function vendorFx(v) { const s = upq(v); for (let i = 0; i < LINE_FX.length; i++) if (LINE_FX[i][0].test(s)) return LINE_FX[i][1]; return COMPANY_FX(); }
  const isDPW = (v) => /^DPW\b|\bDPW\b|DP ?WORLD/.test(upq(v));
  const fxOk = (v) => { const n = num6(v); return n >= 3 && n <= 4.5; };
  const fxIs = (v) => (fxOk(v) ? num6(v) : COMPANY_FX());          // a rate box left empty → the company rate
  const lineAmt = (l, k) => amtOf(l.qty, l[k + 'r'], l[k + 'c'], fxIs(l[k + 'x']));
  const allIn = () => true;                                         // v2.8: costing is all-in only
  const sellsNothing = (l) => !num6(l.sr);
  const newLineId = () => (Math.random().toString(36).slice(2, 10) + 'k0x9').slice(0, 8);
  const boxesOf = (j) => (j.c20 || 0) + (j.c40 || 0);
  const canCostSee = (j) => !!j && (canEdit() || (isSales() && j.sales === state.user));
  const onCostPage = (K) => !!state.route && state.route.name === 'costjob' && String(state.route.jobNo).toUpperCase() === K;

  // ---------- what every list knows about a job's costing ----------
  function costState(j) {   // pending · draft · done · none (a draft with no amounts at all is still pending)
    const s = state.costing[keyOf(j)];
    if (s) return s[0] === 'LOCKED' ? 'done' : (Number(s[1]) || Number(s[2])) ? 'draft' : 'pending';
    if (['COSTING DONE', 'COMPLETED'].includes(j.costing)) return 'done';
    if (j.costing === 'CANCELLED') return 'none';
    return 'pending';
  }
  const costSum = (j) => state.costing[keyOf(j)] || null;
  function costTotals(lines) {
    let sell = 0, buy = 0;
    lines.forEach((l) => { buy += lineAmt(l, 'b'); sell += lineAmt(l, 's'); });
    return { sell, buy, profit: sell - buy };
  }

  // ================================================================ STAY SIGNED IN
  // The session pass is kept on this device, so a refresh (or Ctrl+F5) comes straight back.
  // It still ends after 4 hours unused or 16 hours in all, on Log out, or when the password changes.
  const SESSION = 'ethix.v2.session';
  function keepSession(user, role) { if (api.token) store.set(SESSION, { t: api.token, u: user, r: role || '' }); }
  function dropSession() { try { localStorage.removeItem(SESSION); } catch (e) { /* private mode */ } }
  function savedSession() { const s = store.get(SESSION, null); return s && typeof s.t === 'string' && /^[a-f0-9]{64}$/.test(s.t) && s.u ? s : null; }
  async function resumeSession() {
    const s = savedSession();
    if (!s || !api.connected) { document.body.classList.remove('is-resuming'); return false; }
    state.resuming = true;
    api.token = s.t;
    try {
      const boot = await api.call('ethixBootstrap', [], { timeout: 40000 });
      state.resuming = false;
      document.body.classList.remove('is-resuming');
      state.resumedNow = true;
      try { enterApp(boot, s.u, s.r); } finally { state.resumedNow = false; }
      return true;
    } catch (e) {
      state.resuming = false;
      api.token = null;
      document.body.classList.remove('is-resuming');
      if (e.kind === 'auth' || /new password/i.test(e.message)) dropSession();
      else { const n = $('#cardNote'); if (n) { n.hidden = false; n.textContent = 'Could not reach ETHIX just now — reload to try again, or sign in.'; } }
      return false;
    }
  }

  // ================================================================ REMEMBERED LISTS
  function loadLists6() {
    if (state.lists || state.listsLoading) return;
    state.listsLoading = true;
    api.call('ethixLists')
      .catch((e) => (/not available/i.test(e.message) ? api.call('getMasterLists') : Promise.reject(e)))
      .then((l) => { state.lists = Object.assign({ customers: [], vendors: [], ports: [], charges: [] }, l || {}); })
      .catch(() => { state.lists = state.lists || { customers: [], vendors: [], ports: [], charges: [] }; })
      .finally(() => { state.listsLoading = false; });
  }
  function learnLocal(kind, values) {
    if (!state.lists) state.lists = { customers: [], vendors: [], ports: [], charges: [] };
    const L = state.lists[kind] = state.lists[kind] || [];
    const have = new Set(L.map((v) => String(v).toUpperCase()));
    values.forEach((v) => { v = String(v || '').toUpperCase().replace(/\s+/g, ' ').trim(); if (v.length >= 2 && !have.has(v)) { have.add(v); L.push(v); } });
  }
  function listSrc(id) {
    const L = state.lists || {}, J = state.jobs;
    if (id === 'dlCustomers') return (L.customers || []).concat(J.map((j) => j.customer));
    if (id === 'dlVendors') return (L.vendors || []).concat(J.map((j) => j.vendor));
    if (id === 'dlPorts') return (L.ports || []).concat(J.map((j) => j.pol), J.map((j) => j.pod), PORTS0);
    if (id === 'dlCharges') return (L.charges || []).concat(CHARGES0);
    if (id === 'dlSales') return SALES_NAMES.concat(state.users.filter((u) => String(u.role || '').toUpperCase().trim() === 'SALES').map((u) => String(u.name || '').toUpperCase()), J.map((j) => j.sales));
    return null;
  }
  // The suggestions under a box follow what is typed: names that start with it first, then names that contain it.
  function fillList(input) {
    const id = input.getAttribute('list'), src = listSrc(id), dl = id && document.getElementById(id);
    if (!src || !dl) return;
    const q = input.value.trim().toUpperCase();
    if (dl.dataset.q === q && dl.dataset.n === String(src.length)) return;
    const seen = new Set(), starts = [], has = [];
    for (let i = 0; i < src.length && starts.length < 60; i++) {
      const v = String(src[i] || '').replace(/\s+/g, ' ').trim(), k = v.toUpperCase();
      if (!v || seen.has(k)) continue;
      seen.add(k);
      const at = q ? k.indexOf(q) : 0;
      if (at === 0) starts.push(v); else if (at > 0 && has.length < 60) has.push(v);
    }
    dl.innerHTML = starts.concat(has).slice(0, 60).map((v) => '<option value="' + esc(v) + '"></option>').join('');
    dl.dataset.q = q; dl.dataset.n = String(src.length);
  }

  // ================================================================ DUPLICATE JOB
  function duplicateJob(no) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;
    const p = { customer: j.customer, vendor: j.vendor, pol: j.pol, pod: j.pod, sales: j.sales, dg: j.dg };
    if (j.c20) p.c20 = String(j.c20);
    if (j.c40) p.c40 = String(j.c40);
    openNewJob(j.type, { prefill: p, dup: j.jobNo });
    setTimeout(() => { const f = $('#f_jobNo'); if (f) f.focus(); }, 80);
  }

  // ================================================================ COSTING — the page of one job
  function costFor(no) { const C = state.cost; return C && C.no === String(no).toUpperCase() ? C : null; }
  function setCostData(C, data, keepNotes) {
    C.data = data; C.err = '';
    const fx0 = Number(data.rate) || COMPANY_FX();                 // lines saved by v2.6 used the costing's rate
    C.draft = {
      rate: data.rate, mode: 'ALLIN',
      lines: (data.lines || []).map((l) => {
        const bc = l.bc || 'AED', sc = l.sc || 'AED';
        const bx = bc === 'USD' ? fxTxt(l.bx || fx0) : '', sx = sc === 'USD' ? fxTxt(l.sx || fx0) : '';
        return { id: l.id, charge: l.charge, vendor: l.vendor || '', basis: l.basis || 'SHIP', qty: l.qty === 0 ? '0' : numTxt(l.qty) || '1', bc, br: numTxt(l.br), bx, sc, sr: numTxt(l.sr), sx,
          bxAuto: !bx || num6(bx) === vendorFx(l.vendor) };
      }),
      notes: keepNotes && C.draft ? C.draft.notes : []
    };
    C.dirty = false; C.err = '';
    if (data.status !== 'NEW' && !data.legacy) state.costing[C.no] = [data.status, data.sell, data.buy, data.profit, data.version, data.at, data.by, data.lockedBy];
  }
  function loadCost(no, force) {
    const K = String(no).toUpperCase();
    let C = costFor(K);
    if (C && (C.loading || (C.data && !force))) return C;
    if (!C) C = state.cost = { no: K, data: null, draft: null, dirty: false, loading: false, err: '', busy: '', showLog: false };
    C.loading = true;
    api.call('ethixCosting', [no]).then((res) => {
      if (state.cost !== C) return;
      C.loading = false;
      if (res && res.ok) { if (!C.dirty) setCostData(C, res.costing); else C.data = Object.assign({}, res.costing); }
      else C.err = (res && res.error) || 'Could not open the costing.';
      if (onCostPage(K)) rerender();
    }).catch((e) => {
      if (state.cost !== C) return;
      C.loading = false;
      C.err = e.kind === 'auth' ? 'Please sign in again.' : /not available/i.test(e.message) ? 'The costing needs the v2.6 Code.gs update.' : e.message;
      if (onCostPage(K)) rerender();
    });
    return C;
  }
  const costCanEdit = (j, D) => !!D && !D.closed && D.status !== 'LOCKED' && (canEdit() || (isSales() && j.sales === state.user && D.sales === state.user));
  const costCanUnlock = (D) => !!D && canEdit() && !D.closed && D.status === 'LOCKED';
  function costQtyFor(j, basis, cur) {
    if (basis === 'SHIP') return '1';
    if (basis === 'BOX') return String(boxesOf(j) || 1);
    if (basis === 'B20') return String(j.c20 || 0);
    if (basis === 'B40') return String(j.c40 || 0);
    if (basis === 'DOC') return '1';
    return cur || '1';
  }
  function costStatusPill(D, dirty) {
    if (!D) return '';
    if (D.closed) return '<span class="status-pill tone-calm">CLOSED JOB · READ-ONLY</span>';
    if (D.status === 'LOCKED') return '<span class="status-pill tone-ink">' + icon('lock', 13) + 'COSTING DONE</span>';
    if (D.status === 'NEW') return '<span class="status-pill tone-calm">' + (dirty ? 'NEW · UNSAVED' : 'NOT STARTED') + '</span>';
    return '<span class="status-pill tone-done">DRAFT · V' + D.version + (dirty ? ' · UNSAVED' : '') + '</span>';
  }
  function costHead(j, D, C) {
    const edit = costCanEdit(j, D);
    const saveBtn = edit ? '<button type="button" class="btn-ghost cost-save' + (C && C.dirty ? ' is-dirty' : '') + '" data-act="cost-save"' + (C && (C.busy || !C.dirty) ? ' disabled' : '') + '>' + icon('check', 16) + '<span id="costSaveLbl">' + (C && C.busy === 'save' ? 'Saving…' : C && C.dirty ? 'Save' : 'Saved') + '</span></button>' : '';
    const doneBtn = edit && D.status !== 'NEW' || (edit && C && C.dirty) ? '<button type="button" class="btn-brutal" data-act="cost-done"' + (C && C.busy ? ' disabled' : '') + '>' + (C && C.busy === 'lock' ? 'LOCKING…' : 'COSTING DONE') + '</button>' : '';
    const unlockBtn = costCanUnlock(D) ? '<button type="button" class="btn-ghost" data-act="cost-unlock">' + icon('lock', 16) + '<span>Unlock</span></button>' : '';
    const xlsBtn = D && (D.lines.length || (C && C.draft && C.draft.lines.length)) ? '<button type="button" class="btn-ghost" data-act="cost-xlsx" title="Download Excel">' + icon('download', 16) + '<span>Excel</span></button>' : '';
    return '<header class="cost-head">' +
      '<div class="ch-main"><div class="vh-idrow"><h1 class="vh-job">' + esc(j.jobNo) + '</h1><span class="badge badge-lg">' + esc(j.type + ' · ' + j.typeName.toUpperCase()) + '</span>' + (j.cargo ? '<span class="vh-cargo">' + esc(j.cargo) + '</span>' : '') + '</div>' +
        '<div class="vh-cust">' + esc(j.customer || '—') + '</div>' +
        '<div class="ch-meta"><span>' + esc(j.mode === 'misc' ? (j.against ? 'AGAINST ' + j.against : 'COSTING ONLY') : j.route) + '</span><span>CS · ' + esc(j.cs || '—') + '</span>' + (j.sales ? '<span>SALES · ' + esc(j.sales) + '</span>' : '') +
        '<button type="button" class="link-btn" data-job="' + esc(j.jobNo) + '">Open job →</button></div></div>' +
      '<div class="ch-actions">' + xlsBtn + unlockBtn + saveBtn + doneBtn + '</div>' +
    '</header>';
  }
  function costBanner(j, D) {
    if (!D) return '';
    if (D.closed) return '<div class="cost-banner">' + icon('lock', 15) + '<span>This job is closed, so its costing is read-only. ' + (canEdit() ? 'Reopen the job to change it.' : '') + '</span></div>';
    if (D.status === 'LOCKED') return '<div class="cost-banner is-locked">' + icon('lock', 15) + '<span><b>Costing done</b>' + (D.lockedBy ? ' · locked by ' + esc(nice(D.lockedBy)) : '') + (D.lockedAt ? ' · ' + esc(ago(D.lockedAt)) : '') + (D.legacy ? ' · marked done before costing sheets (no lines)' : '') + '. ' + (canEdit() ? 'Unlock it to make changes.' : 'Ask Customer Service if something needs to change.') + '</span></div>';
    if (!costCanEdit(j, D)) return '<div class="cost-banner">' + icon('lock', 15) + '<span>Read-only.</span></div>';
    return '';
  }
  // The glass summary in one row: selling, buying, profit (AED, with USD under), margin and mark-up,
  // and per box — profit in AED, cost and selling in USD (USD at the company rate; each line keeps its own).
  function costBar(j, D, C) {
    const fx = COMPANY_FX();
    const t = costTotals(C.draft.lines), bx = boxesOf(j);
    const cell = (id, label, value, sub, cls) => '<div class="cb-cell' + (cls ? ' ' + cls : '') + '"><span class="cb-k">' + label + '</span><span class="cb-v" id="' + id + '">' + value + '</span>' + (sub !== undefined ? '<span class="cb-s" id="' + id + 'S">' + sub + '</span>' : '') + '</div>';
    const mini = (id, k, v) => '<span class="cb-m"><span class="cb-mk">' + k + '</span><b id="' + id + '">' + v + '</b></span>';
    return '<section class="cost-bar glass' + (bx ? ' has-box' : '') + '" aria-label="Costing summary" id="costBar">' +
      cell('cbSell', 'SELLING · AED', money(t.sell), 'USD ' + money(t.sell / fx)) +
      cell('cbBuy', 'BUYING · AED', money(t.buy), 'USD ' + money(t.buy / fx)) +
      cell('cbProfit', 'PROFIT · AED', money(t.profit), 'USD ' + money(t.profit / fx), 'is-profit' + (t.profit < 0 ? ' is-loss' : '')) +
      '<div class="cb-cell cb-pair">' + mini('cbMargin', 'MARGIN', pctTxt(t.sell ? t.profit / t.sell : NaN)) + mini('cbMarkup', 'MARK-UP', pctTxt(t.buy ? t.profit / t.buy : NaN)) + '</div>' +
      (bx ? '<div class="cb-cell cb-box' + (t.profit < 0 ? ' is-loss' : '') + '"><span class="cb-k">PER BOX · ×' + bx + '</span>' +
        mini('cbBox', 'PROFIT AED', money(t.profit / bx)) + mini('cbBoxCost', 'COST USD', money(t.buy / bx / fx)) + mini('cbBoxSell', 'SELL USD', money(t.sell / bx / fx)) + '</div>' : '') +
    '</section>';
  }
  // The same figures in one slim line that takes over once the glass bar scrolls away (laptops).
  function costSlim(j, D, C) {
    const t = costTotals(C.draft.lines), bx = boxesOf(j), edit = costCanEdit(j, D);
    const it = (id, k, v, cls) => '<span class="csl-it' + (cls ? ' ' + cls : '') + '"><span class="csl-k">' + k + '</span><b id="' + id + '">' + v + '</b></span>';
    return '<div class="cost-slim" aria-hidden="true"><div class="csl-in glass" id="costSlim">' +
      it('cslSell', 'SELLING', money(t.sell)) + it('cslBuy', 'BUYING', money(t.buy)) + it('cslProfit', 'PROFIT', money(t.profit), 'is-profit' + (t.profit < 0 ? ' is-loss' : '')) +
      it('cslMargin', 'MARGIN', pctTxt(t.sell ? t.profit / t.sell : NaN)) +
      (bx ? it('cslBox', 'PER BOX', money(t.profit / bx), 'csl-box' + (t.profit < 0 ? ' is-loss' : '')) : '') +
      '<span class="csl-k csl-aed">AED</span>' +
      (edit ? '<button type="button" class="btn-ghost csl-save" data-act="cost-save" tabindex="-1"' + (C.busy || !C.dirty ? ' disabled' : '') + '>' + icon('check', 15) + '<span id="cslSaveLbl">' + (C.dirty ? 'Save' : 'Saved') + '</span></button>' : '') +
    '</div></div>';
  }
  const BASIS_PICK = { SHIP: 'Shipment', BOX: 'Box', B20: '20′ box', B40: '40′ box', DOC: 'Document', UNIT: 'Unit' };   // short, so the line stays one line
  function basisSelect(j, l, dis) {
    const bx = boxesOf(j);
    return '<select class="ct-in" id="cl_' + l.id + '_basis" data-f="basis" aria-label="Basis"' + dis + '>' + BASIS.filter(([k]) => bx || !['BOX', 'B20', 'B40'].includes(k) || l.basis === k).map(([k, label]) => '<option value="' + k + '"' + (l.basis === k ? ' selected' : '') + ' title="' + label + '">' + (BASIS_PICK[k] || label) + '</option>').join('') + '</select>';
  }
  // One charge, one line (laptops): charge · vendor · basis and qty · buying (currency, rate, @ USD rate) and its
  // AED · selling and its AED. All-in: a line with no selling reads "incl." — the profit is the total.
  function costRow(j, l, edit, i) {
    const b = lineAmt(l, 'b'), s = lineAmt(l, 's'), incl = sellsNothing(l);
    const out = (k, v, cls) => '<div class="ct-c ct-amt ct-' + k + 'o"><span class="ct-out' + (cls ? ' ' + cls : '') + '" data-o="' + k + '">' + v + '</span></div>';
    if (!edit) {
      const ro = (k) => (k === 's' && incl ? '<span class="ct-ro-rate is-incl">incl.</span>'
        : '<span class="ct-ro-rate"><i>' + esc(l[k + 'c']) + '</i> ' + (l[k + 'r'] ? money(num6(l[k + 'r'])) : '—') + (l[k + 'c'] === 'USD' ? '<span class="ct-ro-fx">@ ' + esc(fxTxt(fxIs(l[k + 'x']))) + '</span>' : '') + '</span>');
      return '<div class="ct-row is-ro" data-line="' + esc(l.id) + '" role="row">' +
        '<div class="ct-c ct-what"><span class="ct-name">' + esc(l.charge) + '</span></div>' +
        '<div class="ct-c ct-vend"><span class="ct-sub">' + esc(l.vendor || '—') + '</span></div>' +
        '<div class="ct-c ct-basis"><span class="ct-sub">' + esc(BASIS_SHORT[l.basis] || l.basis) + ' × ' + esc(l.qty || '0') + '</span></div>' +
        '<div class="ct-c ct-money ct-b">' + ro('b') + '</div>' + out('b', money(b)) +
        '<div class="ct-c ct-money ct-s">' + ro('s') + '</div>' + out('s', incl ? '' : money(s), incl ? 'is-incl' : '') +
        '<span class="ct-c"></span></div>';
    }
    const id = (f) => 'cl_' + l.id + '_' + f;
    const money3 = (k) => {
      const usd = l[k + 'c'] === 'USD', who = k === 'b' ? 'Buying' : 'Selling';
      return '<div class="ct-c ct-money ct-' + k + '"><button type="button" class="cur' + (usd ? ' is-usd' : '') + '" data-cur="' + k + 'c" aria-label="' + who + ' currency: ' + l[k + 'c'] + '. Change">' + l[k + 'c'] + '</button>' +
        '<input class="ct-in r" id="' + id(k + 'r') + '" data-f="' + k + 'r" inputmode="decimal" autocomplete="off" value="' + esc(l[k + 'r']) + '" placeholder="' + (k === 's' ? 'incl.' : 'Rate') + '" aria-label="' + who + ' rate">' +
        (usd ? '<label class="ct-fx" title="AED for 1 USD on this ' + who.toLowerCase() + ' amount"><span>@</span><input class="ct-in fx" id="' + id(k + 'x') + '" data-f="' + k + 'x" inputmode="decimal" autocomplete="off" value="' + esc(l[k + 'x']) + '" aria-label="' + who + ' USD rate"></label>' : '<span class="ct-fx is-none" aria-hidden="true"></span>') + '</div>';
    };
    return '<div class="ct-row" data-line="' + esc(l.id) + '" role="row">' +
      '<div class="ct-c ct-what"><input class="ct-in ct-charge" id="' + id('charge') + '" data-f="charge" list="dlCharges" autocomplete="off" spellcheck="false" value="' + esc(l.charge) + '" placeholder="Choose or type a charge" aria-label="Charge ' + (i + 1) + '"></div>' +
      '<div class="ct-c ct-vend"><input class="ct-in ct-vendor" id="' + id('vendor') + '" data-f="vendor" list="dlVendors" autocomplete="off" spellcheck="false" value="' + esc(l.vendor) + '" placeholder="Vendor" aria-label="Vendor"></div>' +
      '<div class="ct-c ct-basis">' + basisSelect(j, l, '') + '<label class="ct-qty"><span>QTY</span><input class="ct-in r" id="' + id('qty') + '" data-f="qty" inputmode="decimal" autocomplete="off" value="' + esc(l.qty) + '" aria-label="Quantity"></label></div>' +
      money3('b') + out('b', money(b)) + money3('s') + out('s', incl ? '' : money(s), incl ? 'is-incl' : '') +
      '<button type="button" class="icon-btn ct-del" data-del="' + esc(l.id) + '" aria-label="Remove this line">' + icon('close', 14) + '</button></div>';
  }
  function costTable(j, D, C) {
    const edit = costCanEdit(j, D), lines = C.draft.lines;
    const t = costTotals(lines);
    const quick = (QUICK[j.type === 'CND' ? 'cnd' : j.mode] || QUICK.sea);
    return '<section class="cost-card" aria-label="Charges">' +
      '<div class="ct-bar"><div class="ct-bar-t"><h2 class="tile-title">CHARGES</h2><span class="tile-count">' + lines.length + '</span></div>' +
        '<span class="ct-mode-hint">All-in: a line without selling is included in the price</span></div>' +
      '<div class="ct' + (edit ? '' : ' is-ro') + '" role="table">' +
        '<div class="ct-head" role="row"><span>CHARGE</span><span>VENDOR</span><span>BASIS · QTY</span><span class="ct-hb">BUYING</span><span class="r ct-hb">AED</span><span class="ct-hs">SELLING</span><span class="r ct-hs">AED</span><span></span></div>' +
        '<div id="ctBody">' + (lines.length ? lines.map((l, i) => costRow(j, l, edit, i)).join('') : '<div class="ct-empty">' + icon('costing', 22) + '<span>' + (edit ? 'No charges yet. Pick one below — buying and selling sit side by side on one line.' : 'No charges in this costing.') + '</span></div>') + '</div>' +
        '<div class="ct-total" role="row"><span class="ct-tl"><span>TOTAL · AED</span><span class="ct-tp">PROFIT <b id="ctP"' + (t.profit < 0 ? ' class="is-loss"' : '') + '>' + money(t.profit) + '</b><i id="ctM">' + (t.sell ? pctTxt(t.profit / t.sell) + ' margin' : '') + '</i></span></span>' +
          '<span class="ct-c ct-bo"><span class="ct-tk">BUYING</span><span class="ct-out" id="ctB">' + money(t.buy) + '</span></span>' +
          '<span class="ct-c ct-so"><span class="ct-tk">SELLING</span><span class="ct-out" id="ctS">' + money(t.sell) + '</span></span></div>' +
      '</div>' +
      (edit ? '<div class="ct-add"><button type="button" class="btn-ghost" data-act="cost-add">' + icon('plus', 16) + '<span>Add charge</span></button><div class="ct-quick" aria-label="Quick add">' +
        quick.map((q) => '<button type="button" class="choice" data-quick-charge="' + esc(q) + '">' + esc(chipName(q)) + '</button>').join('') + '</div></div>' : '') +
    '</section>';
  }
  function costNotes(j, D, C) {
    const edit = costCanEdit(j, D);
    const saved = (D.notes || []).slice().reverse(), pend = C.draft.notes;
    return '<section class="tile cost-notes" aria-labelledby="cnTitle"><div class="tile-head"><h2 class="tile-title" id="cnTitle">COSTING NOTES</h2><span class="tile-count">' + (saved.length + pend.length) + '</span></div>' +
      (edit ? '<form class="note-box" data-act="cost-note"><input type="text" id="costNote" maxlength="500" placeholder="Add a note to this costing" aria-label="Add a costing note" autocomplete="off"><button type="submit" class="note-post">Add</button></form>' : '') +
      (pend.length || saved.length ? '<ol class="story">' +
        pend.map((t, i) => '<li class="is-pending"><div class="st-when">NOT SAVED YET</div><span class="avatar">' + esc(initials(state.user)) + '</span><div class="st-body"><div><strong>' + esc(state.user) + '</strong> <button type="button" class="link-btn quiet" data-unnote="' + i + '">remove</button></div><div class="st-note">' + esc(t) + '</div></div></li>').join('') +
        saved.map((n) => '<li><div class="st-when">' + esc(stampText(n.t ? dxb(n.t) : null)) + '</div><span class="avatar' + (n.by === state.user ? '' : ' is-other') + '">' + esc(initials(n.by)) + '</span><div class="st-body"><div><strong>' + esc(n.by) + '</strong></div><div class="st-note">' + esc(n.txt) + '</div></div></li>').join('') + '</ol>'
        : '<div class="tile-empty">' + icon('note', 22) + '<span>' + (edit ? 'Notes are saved with the costing — quote numbers, why a rate changed.' : 'No notes.') + '</span></div>') +
    '</section>';
  }
  const LOG_WORD = { SAVED: 'saved', LOCKED: 'marked costing done', UNLOCKED: 'unlocked' };
  function costLog(D, C) {
    const log = D.log || [];
    const list = C.showLog ? log : log.slice(0, 6);
    return '<section class="tile cost-log" aria-labelledby="clTitle"><div class="tile-head"><h2 class="tile-title" id="clTitle">VERSION HISTORY</h2><span class="tile-count">' + log.length + '</span></div>' +
      (log.length ? '<ol class="vlog">' + list.map((x) => '<li class="is-' + esc(x.action.toLowerCase()) + '"><span class="vl-v">V' + x.ver + '</span><div class="vl-body"><div class="vl-head"><strong>' + esc(x.by) + '</strong> ' + esc(LOG_WORD[x.action] || x.action.toLowerCase()) + ' <span class="vl-when">' + esc(stampText(x.t ? new Date(x.t) : null)) + '</span></div>' +
        (x.changes && x.action === 'SAVED' ? '<div class="vl-ch">' + esc(x.changes) + '</div>' : x.changes && x.action === 'UNLOCKED' ? '<div class="vl-ch">' + esc(x.changes) + '</div>' : '') +
        '<div class="vl-tot">Sell ' + money(x.sell) + ' · Buy ' + money(x.buy) + ' · Profit ' + money(x.profit) + '</div></div></li>').join('') + '</ol>' +
        (log.length > 6 ? '<button type="button" class="tile-link" data-act="cost-log">' + (C.showLog ? 'Show fewer' : 'Show all ' + log.length) + '</button>' : '')
        : '<div class="tile-empty">' + icon('clock', 22) + '<span>Every save, lock and unlock shows here — who, when, and what changed.</span></div>') +
    '</section>';
  }
  function renderCostJob(no, first) {
    const view = $('#view');
    const j = findJob(no);
    const K = String(no).toUpperCase();
    const crumbs = (pill) => '<div class="crumbs' + (first ? ' reveal' : '') + '"><button type="button" class="back-btn" data-act="back" aria-label="Back">' + icon('back', 18) + '</button><button type="button" class="link-btn" data-href="#/costing">COSTING</button><span>/ ' + esc(j ? j.jobNo : no) + '</span>' + (pill || '') + '</div>';
    if (!j && loadClosed(no)) { view.innerHTML = '<div class="wrap cost-page">' + crumbs() + '<section class="tile"><div class="story-loading"><span class="sk"></span><span class="sk"></span><span class="sk short"></span></div></section></div>'; return; }
    if (!j || !canCostSee(j)) {
      view.innerHTML = '<div class="wrap cost-page">' + crumbs() + '<section class="tile notfound">' + empty('search', j ? 'Only Customer Service and the job’s own sales person can open this costing.' : 'Job ' + no + ' is not in the tracker or in closed jobs.') + '<button type="button" class="btn-ghost" data-href="#/costing">Back to costing</button></section></div>';
      return;
    }
    const C = loadCost(j.jobNo);
    if (!C.data) {
      view.innerHTML = '<div class="wrap cost-page">' + crumbs() + costHead(j, null, null) + (C.err ? '<section class="tile notfound">' + empty('alert', C.err) + '<button type="button" class="btn-ghost" data-act="cost-retry">Try again</button></section>'
        : '<section class="cost-bar glass is-loading"><span class="sk"></span><span class="sk"></span><span class="sk"></span></section><section class="cost-card"><div class="story-loading"><span class="sk"></span><span class="sk"></span><span class="sk short"></span></div></section>') + '</div>';
      return;
    }
    const D = C.data, T = costTotals(C.draft.lines);
    view.innerHTML = '<div class="wrap cost-page' + (costCanEdit(j, D) ? ' is-edit' : '') + '">' + crumbs(costStatusPill(D, C.dirty)) + costHead(j, D, C) + costBanner(j, D) + costBar(j, D, C) + costSlim(j, D, C) + costTable(j, D, C) +
      '<div class="cost-side">' + costNotes(j, D, C) + costLog(D, C) + '</div>' +
      (costCanEdit(j, D) ? '<div class="cost-dock glass"><span class="cd-state"><b id="cdProfit"' + (T.profit < 0 ? ' class="is-loss"' : '') + '>PROFIT AED ' + money(T.profit) + '</b><span id="costDockState">' + (T.sell ? pctTxt(T.profit / T.sell) + ' margin · ' : '') + (C.dirty ? 'unsaved' : 'all saved') + '</span></span><button type="button" class="btn-ghost" data-act="cost-save"' + (C.busy || !C.dirty ? ' disabled' : '') + '>Save</button><button type="button" class="btn-brutal" data-act="cost-done"' + (C.busy ? ' disabled' : '') + '>DONE</button></div>' : '') +
      datalist('dlCharges', listSrc('dlCharges')) + datalist('dlVendors', listSrc('dlVendors')) +
    '</div>';
    costSlimSync();
  }
  // The slim line shows once the glass bar has scrolled out of sight.
  function costSlimSync() {
    const bar = $('#costBar'), slim = $('#costSlim'), view = $('#view');
    if (!bar || !slim || !view) return;
    const on = bar.getBoundingClientRect().bottom < view.getBoundingClientRect().top + 12;
    slim.classList.toggle('is-on', on);
    slim.parentNode.setAttribute('aria-hidden', on ? 'false' : 'true');
    const sv = slim.querySelector('.csl-save'); if (sv) sv.tabIndex = on ? 0 : -1;
  }
  // Repaints only the numbers (no re-render while typing).
  function costPaint(j) {
    const C = state.cost; if (!C || !C.draft || !j) return;
    const fx = COMPANY_FX(), bx = boxesOf(j);
    const t = costTotals(C.draft.lines);
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    const loss = (id, on) => { const el = document.getElementById(id); if (el) (el.closest('.cb-cell, .csl-it') || el).classList.toggle('is-loss', on); };
    set('cbSell', money(t.sell)); set('cbSellS', 'USD ' + money(t.sell / fx));
    set('cbBuy', money(t.buy)); set('cbBuyS', 'USD ' + money(t.buy / fx));
    set('cbProfit', money(t.profit)); set('cbProfitS', 'USD ' + money(t.profit / fx));
    loss('cbProfit', t.profit < 0); loss('cslProfit', t.profit < 0); loss('cbBox', t.profit < 0); loss('cslBox', t.profit < 0);
    set('cbMargin', pctTxt(t.sell ? t.profit / t.sell : NaN)); set('cbMarkup', pctTxt(t.buy ? t.profit / t.buy : NaN));
    if (bx) { set('cbBox', money(t.profit / bx)); set('cbBoxCost', money(t.buy / bx / fx)); set('cbBoxSell', money(t.sell / bx / fx)); }
    set('cslSell', money(t.sell)); set('cslBuy', money(t.buy)); set('cslProfit', money(t.profit));
    set('cslMargin', pctTxt(t.sell ? t.profit / t.sell : NaN));
    if (bx) set('cslBox', money(t.profit / bx));
    set('cdProfit', 'PROFIT AED ' + money(t.profit));
    set('costDockState', (t.sell ? pctTxt(t.profit / t.sell) + ' margin · ' : '') + (C.dirty ? 'unsaved' : 'all saved'));
    const dp = $('#cdProfit'); if (dp) dp.classList.toggle('is-loss', t.profit < 0);
    set('ctB', money(t.buy)); set('ctS', money(t.sell)); set('ctP', money(t.profit)); set('ctM', t.sell ? pctTxt(t.profit / t.sell) + ' margin' : '');
    const tp = $('#ctP'); if (tp) tp.classList.toggle('is-loss', t.profit < 0);
    C.draft.lines.forEach((l) => {
      const row = document.querySelector('.ct-row[data-line="' + l.id + '"]'); if (!row) return;
      const b = lineAmt(l, 'b'), s = lineAmt(l, 's'), incl = sellsNothing(l);
      const o = (k) => row.querySelector('[data-o="' + k + '"]');
      if (o('b')) o('b').textContent = money(b);
      if (o('s')) { o('s').textContent = incl ? '' : money(s); o('s').classList.toggle('is-incl', incl); }
    });
    $$('[data-act="cost-save"]').forEach((b) => { b.disabled = !!C.busy || !C.dirty; b.classList.toggle('is-dirty', C.dirty); });
    $$('[data-act="cost-done"]').forEach((b) => { b.disabled = !!C.busy; });
    set('costSaveLbl', C.busy === 'save' ? 'Saving…' : C.dirty ? 'Save' : 'Saved');
    set('cslSaveLbl', C.busy === 'save' ? 'Saving…' : C.dirty ? 'Save' : 'Saved');
    const pill = $('.cost-page .crumbs .status-pill'); if (pill && C.data && C.data.status === 'DRAFT') pill.textContent = 'DRAFT · V' + C.data.version + (C.dirty ? ' · UNSAVED' : ''); if (pill && C.data && C.data.status === 'NEW') pill.textContent = C.dirty ? 'NEW · UNSAVED' : 'NOT STARTED';
  }
  function costDirty(j) { const C = state.cost; if (!C) return; C.dirty = true; costPaint(j); }
  function applyRow6(row) {
    if (!Array.isArray(row) || !state.ix || !(state.ix.jobNo > -1)) return;
    const k = String(row[state.ix.jobNo] || '').toUpperCase(); if (!k || !state.rowMap.has(k)) return;
    state.rowMap.set(k, row); rebuildJob(k);
  }
  // A small question box (the same glass card as Log out). Resolves true / false — or the typed text.
  function ask(o) {
    return new Promise((resolve) => {
      closeOverlays(true);
      const wrap = $('#confirmWrap'); if (!wrap) { resolve(false); return; }
      $('#confirmTitle').textContent = o.title; $('#confirmText').textContent = o.text || ''; $('#confirmYes').textContent = o.yes || 'OK'; $('#confirmNo').textContent = o.no || 'Cancel';
      const old = $('#askInput'); if (old) old.remove();
      let inp = null;
      if (o.input !== undefined) {
        inp = document.createElement('input'); inp.id = 'askInput'; inp.className = 'ask-input'; inp.type = 'text'; inp.maxLength = o.max || 120; inp.value = o.value || ''; inp.placeholder = o.input; inp.autocomplete = 'off';
        if (o.inputmode) inp.inputMode = o.inputmode;
        $('#confirmText').after(inp);
      }
      wrap.hidden = false;
      (inp || $('#confirmNo')).focus();
      const done = (v) => { wrap.hidden = true; if (inp) inp.remove(); $('#confirmNo').textContent = 'Stay'; wrap.onclick = null; $('#confirmYes').onclick = null; $('#confirmNo').onclick = null; resolve(v); };
      $('#confirmNo').onclick = () => done(false);
      $('#confirmYes').onclick = () => done(inp ? inp.value.trim() : true);
      if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value.trim()); } };
      wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    });
  }
  function readLines(C) {      // the lines as numbers, or the first problem
    const out = [];
    for (let i = 0; i < C.draft.lines.length; i++) {
      const l = C.draft.lines[i];
      const q = l.qty === '' ? 0 : num6(l.qty), br = num6(l.br), sr = num6(l.sr);
      const charge = String(l.charge || '').toUpperCase().replace(/\s+/g, ' ').trim(), vendor = String(l.vendor || '').toUpperCase().replace(/\s+/g, ' ').trim();
      if (!charge && !vendor && !br && !sr) continue;
      if (!charge) return { bad: l.id, f: 'charge', msg: 'Line ' + (i + 1) + ': choose or type a charge.' };
      if (isNaN(q) || q < 0) return { bad: l.id, f: 'qty', msg: charge + ': quantity should be a number.' };
      if (isNaN(br)) return { bad: l.id, f: 'br', msg: charge + ': the buying rate should be a number.' };
      if (isNaN(sr)) return { bad: l.id, f: 'sr', msg: charge + ': the selling rate should be a number.' };
      if (l.bc === 'USD' && String(l.bx).trim() && !fxOk(l.bx)) return { bad: l.id, f: 'bx', msg: charge + ': the buying USD rate should be between 3 and 4.5.' };
      if (l.sc === 'USD' && String(l.sx).trim() && !fxOk(l.sx)) return { bad: l.id, f: 'sx', msg: charge + ': the selling USD rate should be between 3 and 4.5.' };
      out.push({ id: l.id, charge, vendor, basis: l.basis, qty: q, bc: l.bc, br, bx: l.bc === 'USD' ? fxIs(l.bx) : 0, sc: l.sc, sr, sx: l.sc === 'USD' ? fxIs(l.sx) : 0 });
    }
    return { lines: out };
  }
  async function saveCost(j, opts = {}) {
    const C = costFor(j.jobNo); if (!C || !C.data || C.busy) return false;
    const read = readLines(C);
    if (read.bad) {
      toast(read.msg, { error: true });
      const el = document.getElementById('cl_' + read.bad + '_' + read.f); if (el) { el.focus(); el.classList.add('is-bad'); setTimeout(() => el.classList.remove('is-bad'), 2400); }
      return false;
    }
    const payload = { lines: read.lines, addNotes: C.draft.notes.slice(), mode: 'ALLIN' };
    C.busy = 'save'; costPaint(j);
    setSaving(1);
    try {
      const res = await api.call('ethixCostingSave', [j.jobNo, payload, opts.base !== undefined ? opts.base : C.data.version]);
      C.busy = '';
      if (res && res.ok) {
        setCostData(C, res.costing);
        applyRow6(res.row);
        learnLocal('charges', read.lines.map((l) => l.charge)); learnLocal('vendors', read.lines.map((l) => l.vendor));
        rerender(); updateNav();
        if (!opts.quiet) toast(res.same ? 'No changes to save' : 'Costing saved · version ' + res.costing.version);
        return true;
      }
      if (res && res.conflict && res.costing) return costConflict(j, C, res.costing);
      if (res && res.locked && res.costing) { setCostData(C, res.costing); rerender(); }
      toast((res && res.error) || 'The costing was not saved.', { error: true });
      costPaint(j);
      return false;
    } catch (e) {
      C.busy = ''; costPaint(j);
      if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Saving the costing needs the v2.6 Code.gs update.' : 'Not saved: ' + e.message, { error: true, action: /not available/i.test(e.message) ? null : { label: 'Retry', fn: () => saveCost(j, opts) } });
      return false;
    } finally { setSaving(-1); }
  }
  async function costConflict(j, C, theirs) {
    const keep = await ask({ title: 'Someone saved first', text: nice(theirs.by || 'Someone') + ' saved version ' + theirs.version + ' while you were editing. Keep your changes and save over it, or load their version?', yes: 'Keep mine & save', no: 'Load theirs' });
    if (keep) { C.data = Object.assign({}, C.data, { version: theirs.version, rate: C.data.rate }); return saveCost(j, { base: theirs.version }); }
    setCostData(C, theirs); rerender();
    toast('Loaded version ' + theirs.version + ' by ' + nice(theirs.by));
    return false;
  }
  async function costDone(j) {
    const C = costFor(j.jobNo); if (!C || !C.data || C.busy) return;
    if (C.dirty || C.data.status === 'NEW') { const ok = await saveCost(j, { quiet: true }); if (!ok) return; }
    const D = C.data;
    if (!D.lines.length) { toast('Add the charges first.', { error: true }); return; }
    const loss = D.profit < 0;
    const yes = await ask({ title: 'Mark costing done?', text: 'Profit AED ' + money(D.profit) + (D.sell ? ' · margin ' + pctTxt(D.profit / D.sell) : '') + '. This locks the costing for everyone' + (canEdit() ? '; Customer Service can unlock it later.' : '; only Customer Service can unlock it.') + (loss ? ' ⚠ This job shows a loss.' : ''), yes: 'Costing done', no: 'Not yet' });
    if (!yes) return;
    C.busy = 'lock'; costPaint(j); setSaving(1);
    try {
      const res = await api.call('ethixCostingLock', [j.jobNo, D.version]);
      C.busy = '';
      if (res && res.ok) { setCostData(C, res.costing); applyRow6(res.row); rerender(); updateNav(); toast(res.already ? 'Already done' : 'Costing done — locked'); return; }
      if (res && res.conflict && res.costing) { setCostData(C, res.costing); rerender(); }
      toast((res && res.error) || 'Not locked.', { error: true }); costPaint(j);
    } catch (e) { C.busy = ''; costPaint(j); if (e.kind !== 'auth') toast('Not locked: ' + e.message, { error: true }); }
    finally { setSaving(-1); }
  }
  async function costUnlock(j) {
    const C = costFor(j.jobNo); if (!C || !C.data) return;
    const reason = await ask({ title: 'Unlock the costing?', text: (j.sales ? nice(j.sales) + ' (sales) is told. ' : '') + 'Say why — optional, it goes into the history.', yes: 'Unlock', no: 'Cancel', input: 'Reason (optional)' });
    if (reason === false) return;
    setSaving(1);
    try {
      const res = await api.call('ethixCostingUnlock', [j.jobNo, reason]);
      if (res && res.ok) { setCostData(C, res.costing); applyRow6(res.row); rerender(); updateNav(); toast('Costing unlocked'); return; }
      toast((res && res.error) || 'Not unlocked.', { error: true });
    } catch (e) { if (e.kind !== 'auth') toast(e.message, { error: true }); }
    finally { setSaving(-1); }
  }
  function blankLine(charge) { return { id: newLineId(), charge: charge || '', vendor: '', basis: 'SHIP', qty: '1', bc: 'AED', br: '', bx: '', sc: 'AED', sr: '', sx: '', bxAuto: true }; }
  function addCostLine(j, charge) {
    const C = state.cost; if (!C || !C.draft) return;
    const l = blankLine(charge);
    C.draft.lines.push(l);
    const extra = charge ? chargeRule(j, l) : null;
    if (extra) C.draft.lines.push(extra);
    C.dirty = true;
    rerender();
    const f = document.getElementById('cl_' + l.id + '_' + (charge ? 'br' : 'charge'));
    if (f) { f.focus(); if (f.scrollIntoView) f.scrollIntoView({ block: 'nearest' }); }
  }
  // A USD side gets its rate the moment it turns USD: buying from the shipping line, selling at the company rate.
  function setCur(l, k, cur) {
    l[k + 'c'] = cur;
    if (cur !== 'USD') return;
    if (!fxOk(l[k + 'x'])) { l[k + 'x'] = fxTxt(k === 'b' ? vendorFx(l.vendor) : COMPANY_FX()); if (k === 'b') l.bxAuto = true; }
  }
  // Picking a vendor: the buying rate follows its shipping line (unless you typed one); DPW bills in AED.
  function vendorRule(l) {
    if (isDPW(l.vendor) && l.bc === 'USD' && !num6(l.br)) { l.bc = 'AED'; return true; }
    if (l.bc === 'USD' && l.bxAuto !== false) { const v = fxTxt(vendorFx(l.vendor)); if (v !== l.bx) { l.bx = v; l.bxAuto = true; return true; } }
    return false;
  }
  // The usual set-up of the common charges, filled once on a fresh line (nothing typed in the rates yet):
  // ocean freight and THC per container type (two lines when the job has 20′ and 40′), TLUC and seal per
  // container, bill of lading / bill of entry / DPC / exit submission per document. Returns a second line or null.
  function chargeRule(j, l) {
    if (num6(l.br) || num6(l.sr)) return null;
    const c = upq(l.charge), line = upq(j.vendor), dg = j.dg === 'DG';
    const c20 = j.c20 || 0, c40 = j.c40 || 0, boxes = c20 + c40;
    const fill = (o) => { Object.keys(o).forEach((k) => { if (k === 'vendor') { if (!l.vendor && o.vendor) l.vendor = o.vendor; } else l[k] = o[k]; }); };
    const twin = (o) => { const x = blankLine(l.charge); x.vendor = l.vendor; Object.keys(o).forEach((k) => { x[k] = o[k]; }); return x; };
    const byType = (make) => {                        // [20′ set-up, 40′ set-up] for this job
      if (c20 && c40) return [make('B20', c20), make('B40', c40)];
      if (c20) return [make('B20', c20)];
      if (c40) return [make('B40', c40)];
      return [make('SHIP', 1)];
    };
    let sets = null;
    if (/OCEAN FREIGHT|SEA FREIGHT/.test(c)) {
      sets = byType((b, q) => ({ basis: b, qty: String(q), vendor: line, bc: 'USD', sc: 'USD' }));
    } else if (/^THC\b|TERMINAL HANDLING/.test(c)) {
      const r = (b) => (b === 'B20' ? 700 + (dg ? 350 : 0) : b === 'B40' ? 1100 + (dg ? 550 : 0) : '');
      sets = byType((b, q) => ({ basis: b, qty: String(q), bc: 'AED', br: String(r(b)) }));
    } else if (/^TLUC\b|^TLC\b/.test(c)) {
      sets = [{ basis: boxes ? 'BOX' : 'SHIP', qty: String(boxes || 1), bc: 'AED', br: '314' }];
    } else if (/^SEAL/.test(c)) {
      sets = [{ basis: boxes ? 'BOX' : 'SHIP', qty: String(boxes || 1), vendor: line }];
    } else if (c === 'BILL OF LADING') {
      sets = [{ basis: 'DOC', qty: '1', vendor: line }];
    } else if (/BILL OF ENTRY/.test(c) || c === 'DPC' || /^EXIT SUBMISSION/.test(c)) {
      sets = [{ basis: 'DOC', qty: '1', vendor: 'DPW', bc: 'AED' }];
    } else if (/AIR FREIGHT/.test(c)) {
      sets = [{ bc: 'USD', sc: 'USD' }];
    }
    if (!sets) return null;
    fill(sets[0]);
    ['b', 's'].forEach((k) => { if (l[k + 'c'] === 'USD') setCur(l, k, 'USD'); });
    vendorRule(l);
    if (!sets[1]) return null;
    const x = twin(sets[1]);
    ['b', 's'].forEach((k) => { if (x[k + 'c'] === 'USD') { x[k + 'x'] = ''; setCur(x, k, 'USD'); } });
    vendorRule(x);
    return x;
  }

  // ================================================================ COSTING — the menu page
  function costRows() {
    const t0 = today0();
    const base = mineJobs().filter((j) => j.active);                // your own jobs only (Customer Service: the jobs you own)
    const all = base.map((j) => ({ j, st: costState(j), s: costSum(j) })).filter((x) => x.st !== 'none');
    const due = (j) => costDue91(j, t0);
    const pending = all.filter((x) => x.st === 'pending').sort((a, b) => (due(b.j) - due(a.j)) || ((a.j.etd ? +a.j.etd : 9e15) - (b.j.etd ? +b.j.etd : 9e15)) || (a.j.jobNo < b.j.jobNo ? -1 : 1));
    const draft = all.filter((x) => x.st === 'draft').sort((a, b) => ((b.s && b.s[5]) || 0) - ((a.s && a.s[5]) || 0));
    const done = all.filter((x) => x.st === 'done').sort((a, b) => ((b.s && b.s[5]) || 0) - ((a.s && a.s[5]) || 0));
    return { all, pending, draft, done, dueN: pending.filter((x) => due(x.j)).length, open: pending.length + draft.length };
  }
  // costing is due once an export has sailed, and once an import (or a clearance job) has arrived
  const costByArrival91 = (j) => j.cat === 'IMPORT' || j.type === 'CND';
  const costDue91 = (j, t0) => (costByArrival91(j) ? !!j.arrived : !!((j.etd && j.etd < t0) || j.arrived));
  function costListRow(x, t0) {
    const j = x.j, s = x.s;
    const when = x.st === 'pending'
      ? (costDue91(j, t0) ? '<span class="chip chip-soon">' + (j.arrived ? 'ARRIVED' : (j.mode === 'air' ? 'DEPARTED ' : j.mode === 'courier' ? 'PICKED UP ' : 'SAILED ') + fmt(j.etd)) + '</span>'
        : '<span class="chip chip-calm">' + (costByArrival91(j) && j.eta ? 'ETA ' + fmt(j.eta) : j.etd ? (j.mode === 'courier' ? 'PICK-UP ' : 'ETD ') + fmt(j.etd) : j.mode === 'misc' ? 'COSTING ONLY' : 'DATES TO CONFIRM') + '</span>')
      : x.st === 'draft' ? '<span class="chip chip-done">DRAFT · V' + (s ? s[4] : 1) + '</span>' : '<span class="chip chip-hold">' + icon('lock', 12) + 'DONE</span>';
    const who = s ? (x.st === 'done' && s[7] ? 'Locked by ' + nice(s[7]) : s[6] ? nice(s[6]) + ' · ' + ago(s[5]) : '') : '';
    const fig = (k, v, cls) => '<span class="cl-fig' + (cls ? ' ' + cls : '') + '"><span class="cl-k">' + k + '</span><b>' + money(v) + '</b></span>';
    const nums = s && x.st === 'pending' ? '<span class="cl-sub">Started · no amounts yet</span>' : s ? '<span class="cl-figs">' + fig('SELLING', s[1]) + fig('BUYING', s[2]) + fig('PROFIT', s[3], 'is-profit' + (s[3] < 0 ? ' is-loss' : '')) + '</span><span class="cl-sub">AED · ' + (s[1] ? pctTxt(s[3] / s[1]) + ' margin' : 'no selling yet') + '</span>'
      : x.st === 'done' ? '<span class="cl-sub">Marked done (no sheet)</span>' : '<span class="cl-sub">Not started</span>';
    return '<li class="cr-row"><button type="button" class="cr-open" data-cost="' + esc(j.jobNo) + '" aria-label="Open costing of ' + esc(j.jobNo) + '">' +
      '<span class="rr-main"><span class="rr-job">' + esc(j.jobNo) + ' <span class="badge">' + esc(j.type) + '</span></span><span class="rr-cust">' + esc(j.customer || '—') + '</span><span class="rr-route">' + esc(j.mode === 'misc' ? 'COSTING ONLY' : j.route) + '</span></span>' +
      '<span class="cr-when">' + when + (who ? '<span class="cl-sub">' + esc(who) + '</span>' : '') + '</span>' +
      '<span class="cr-people"><span>CS · ' + esc(j.cs || '—') + '</span>' + (j.sales ? '<span>SALES · ' + esc(j.sales) + '</span>' : '') + '</span>' +
      '<span class="cr-nums">' + nums + '</span><span class="cr-go">' + icon('chevron', 16) + '</span></button></li>';
  }
  function renderCostList(first) {
    const t0 = today0(), anim = first ? ' reveal' : '';
    const U = state.costUi, R = costRows();
    const q = (U.q || '').trim().toUpperCase();
    const match = (x) => !q || (x.j.jobNo + ' ' + x.j.customer + ' ' + x.j.route + ' ' + x.j.cs + ' ' + x.j.sales + ' ' + x.j.type).toUpperCase().includes(q);
    const tab = ['pending', 'draft', 'done'].includes(U.tab) ? U.tab : 'pending';
    const rows = R[tab].filter(match);
    const keepQ = $('#costSearch') ? $('#costSearch').value : U.q || '';
    const big = (id, label, n, sub) => '<button type="button" class="cs-big' + (tab === id ? ' is-on' : '') + '" data-cost-tab="' + id + '" aria-pressed="' + (tab === id) + '"><span class="cs-k">' + label + '</span><span class="cs-n">' + n + '</span><span class="cs-s">' + sub + '</span></button>';
    $('#view').innerHTML = '<div class="wrap round-page cost-list no-seg">' +
      '<header class="page-head' + anim + '"><div class="head-main"><div class="meta-line"><span>COSTING · YOUR JOBS · ' + esc(fmtLong(t0)) + '</span><span class="sync" id="sync"><span class="sync-dot"></span><span id="syncText">' + syncText() + '</span></span></div><h1 class="greeting">Costing</h1></div>' +
        '<div class="head-actions">' +
          '<label class="search">' + icon('search') + '<input id="costSearch" type="search" placeholder="Job no, customer, port" aria-label="Search costings" autocomplete="off" value="' + esc(keepQ) + '"></label>' +
          '<button type="button" class="btn-ghost" id="refreshBtn" data-act="refresh" aria-label="Refresh"><span class="spin">' + icon('refresh', 16) + '</span><span class="btn-label">Refresh</span></button>' +
        '</div></header>' +
      '<section class="cost-sum tile tile-ink' + anim + '" style="--d:40ms" aria-label="Costing at a glance">' +
        big('pending', 'PENDING', R.pending.length, R.dueN ? R.dueN + ' sailed or arrived' : 'nothing overdue') +
        big('draft', 'DRAFT', R.draft.length, R.draft.length ? 'being worked on' : 'none open') +
        big('done', 'DONE', R.done.length, R.done.length ? 'locked' : 'none yet') +
      '</section>' +
      '<section class="round-sec cost-sec' + anim + '" style="--d:80ms" aria-labelledby="cs-title"><div class="tile-head"><h2 class="tile-title" id="cs-title">' + { pending: 'COSTING PENDING', draft: 'DRAFTS', done: 'COSTING DONE' }[tab] + ' <span class="tile-count">' + rows.length + '</span></h2><span class="small">' + { pending: 'Sailed or arrived first', draft: 'Last changed first', done: 'Last changed first' }[tab] + '</span></div>' +
        (rows.length ? '<ul class="round-list cost-rows">' + rows.slice(0, 300).map((x) => costListRow(x, t0)).join('') + '</ul>' : '<div class="tile-empty">' + icon('check', 22) + '<span>' + (q ? 'Nothing matches “' + esc(U.q) + '”.' : { pending: 'Every active job has a costing.', draft: 'No drafts open.', done: 'No costing marked done yet.' }[tab]) + '</span></div>') +
      '</section></div>';
    if (keepQ && state.costFocus) { const s = $('#costSearch'); s.focus(); s.setSelectionRange(keepQ.length, keepQ.length); }
  }

  // ---------- the costing card on the job page ----------
  function costCard(j) {
    if (!canCostSee(j)) return '';
    const st = costState(j), s = costSum(j);
    if (st === 'none') return '';
    const chip = st === 'done' ? '<span class="chip chip-hold">' + icon('lock', 12) + 'DONE</span>' : st === 'draft' ? '<span class="chip chip-done">DRAFT</span>' : '<span class="chip chip-calm">NOT STARTED</span>';
    const sv = st === 'pending' ? null : s;
    const editable = !j.closed && st !== 'done' && (canEdit() || isSales());
    return '<section class="tile side-card cost-mini" aria-labelledby="cmTitle"><div class="tile-head"><h2 class="tile-title" id="cmTitle">COSTING</h2>' + chip + '</div>' +
      (sv ? '<div class="kv"><span class="kv-k">Selling</span><span class="kv-v">AED ' + money(sv[1]) + '</span></div><div class="kv"><span class="kv-k">Buying</span><span class="kv-v">AED ' + money(sv[2]) + '</span></div>' +
        '<div class="kv cm-profit' + (sv[3] < 0 ? ' is-loss' : '') + '"><span class="kv-k">Profit</span><span class="kv-v">AED ' + money(sv[3]) + (sv[1] ? ' · ' + pctTxt(sv[3] / sv[1]) : '') + '</span></div>' +
        (boxesOf(j) ? '<div class="kv"><span class="kv-k">Profit / box</span><span class="kv-v">AED ' + money(sv[3] / boxesOf(j)) + '</span></div>' : '')
        : '<p class="pop-text">' + (st === 'done' ? 'Marked done before costing sheets.' : s ? 'Started — no amounts yet.' : 'No costing yet.') + '</p>') +
      '<button type="button" class="btn-ghost pop-wide" data-cost="' + esc(j.jobNo) + '">' + icon('costing', 16) + '<span>' + (s ? 'Open costing' : editable ? 'Start costing' : 'Open costing') + '</span></button></section>';
  }

  // ================================================================ EXCEL (made here, no download needed)
  // A real .xlsx: logo, header band, summary, one table with live formulas, A4 one page wide,
  // header rows repeated on every printed page; notes under the table.
  const XL = (() => {
    const T = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
    const crc = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const enc = new TextEncoder();
    const X = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const N = (v) => { const n = Math.round(Number(v) * 1e8) / 1e8; return isFinite(n) ? String(n) : '0'; };
    function zip(files, type) {
      const parts = [], central = []; let off = 0;
      const d = dxb();
      const dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
      files.forEach((f) => {
        const nm = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, c = crc(data);
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, dt, true); h.setUint16(12, dd, true);
        h.setUint32(14, c, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
        parts.push(new Uint8Array(h.buffer), nm, data);
        const cd = new DataView(new ArrayBuffer(46));
        cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true); cd.setUint16(12, dt, true); cd.setUint16(14, dd, true);
        cd.setUint32(16, c, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true); cd.setUint16(28, nm.length, true); cd.setUint32(42, off, true);
        central.push(new Uint8Array(cd.buffer), nm);
        off += 30 + nm.length + data.length;
      });
      const size = central.reduce((a, b) => a + b.length, 0);
      const e = new DataView(new ArrayBuffer(22));
      e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
      return new Blob(parts.concat(central, [new Uint8Array(e.buffer)]), { type: type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }
    const col = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    function Styles() {
      const fonts = ['<font><sz val="10"/><name val="Arial"/><family val="2"/></font>'];
      const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
      const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
      const fmts = [], xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'], seen = new Map();
      const idx = (arr, x) => { let i = arr.indexOf(x); if (i < 0) { arr.push(x); i = arr.length - 1; } return i; };
      function s(o) {
        o = o || {};
        const key = JSON.stringify(o); if (seen.has(key)) return seen.get(key);
        const f = o.font || {};
        const fontId = idx(fonts, '<font>' + (f.b ? '<b/>' : '') + (f.i ? '<i/>' : '') + '<sz val="' + (f.sz || 10) + '"/>' + (f.color ? '<color rgb="FF' + f.color + '"/>' : '') + '<name val="Arial"/><family val="2"/></font>');
        const fillId = o.fill ? idx(fills, '<fill><patternFill patternType="solid"><fgColor rgb="FF' + o.fill + '"/><bgColor indexed="64"/></patternFill></fill>') : 0;
        const b = o.border || {};
        const side = (k) => (b[k] ? '<' + k + ' style="' + b[k][0] + '"><color rgb="FF' + b[k][1] + '"/></' + k + '>' : '<' + k + '/>');
        const borderId = o.border ? idx(borders, '<border>' + side('left') + side('right') + side('top') + side('bottom') + '<diagonal/></border>') : 0;
        let numFmtId = 0;
        if (o.fmt) { const builtin = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10 }[o.fmt]; numFmtId = builtin !== undefined ? builtin : 164 + idx(fmts, o.fmt); }
        const a = o.align || {};
        const al = a.h || a.v || a.wrap || a.indent ? '<alignment' + (a.h ? ' horizontal="' + a.h + '"' : '') + (a.v ? ' vertical="' + a.v + '"' : '') + (a.wrap ? ' wrapText="1"' : '') + (a.indent ? ' indent="' + a.indent + '"' : '') + '/>' : '';
        const xf = '<xf numFmtId="' + numFmtId + '" fontId="' + fontId + '" fillId="' + fillId + '" borderId="' + borderId + '" xfId="0"' + (numFmtId ? ' applyNumberFormat="1"' : '') + (fontId ? ' applyFont="1"' : '') + (fillId ? ' applyFill="1"' : '') + (borderId ? ' applyBorder="1"' : '') + (al ? ' applyAlignment="1">' + al + '</xf>' : '/>');
        const id = idx(xfs, xf); seen.set(key, id); return id;
      }
      s.xml = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        (fmts.length ? '<numFmts count="' + fmts.length + '">' + fmts.map((f, i) => '<numFmt numFmtId="' + (164 + i) + '" formatCode="' + X(f) + '"/>').join('') + '</numFmts>' : '') +
        '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts><fills count="' + fills.length + '">' + fills.join('') + '</fills><borders count="' + borders.length + '">' + borders.join('') + '</borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>';
      return s;
    }
    // sheet: { cols: [width], rows: { n: { h, c: { colIndex: { v, f, s } } } }, merges: [], tab, tabColor, landscape, titles, footer, drawing }
    function sheetXml(o) {
      const rn = Object.keys(o.rows).map(Number).sort((a, b) => a - b);
      const last = rn.length ? rn[rn.length - 1] : 1;
      const data = rn.map((r) => {
        const R = o.rows[r];
        const cells = Object.keys(R.c).map(Number).sort((a, b) => a - b).map((ci) => {
          const x = R.c[ci], ref = col(ci) + r, st = x.s ? ' s="' + x.s + '"' : '';
          if (x.f) { const str = typeof x.v === 'string'; return '<c r="' + ref + '"' + st + (str ? ' t="str"' : '') + '><f>' + X(x.f) + '</f>' + (x.v === undefined || x.v === null || o.noCache ? '' : '<v>' + (str ? X(x.v) : N(x.v)) + '</v>') + '</c>'; }
          if (x.v === undefined || x.v === null || x.v === '') return '<c r="' + ref + '"' + st + '/>';
          if (typeof x.v === 'number') return '<c r="' + ref + '"' + st + '><v>' + N(x.v) + '</v></c>';
          return '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + X(x.v) + '</t></is></c>';
        }).join('');
        return '<row r="' + r + '"' + (R.h ? ' ht="' + R.h + '" customHeight="1"' : '') + '>' + cells + '</row>';
      }).join('');
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheetPr>' + (o.tabColor ? '<tabColor rgb="FF' + o.tabColor + '"/>' : '') + '<pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:' + col(o.cols.length - 1) + last + '"/>' +
        '<sheetViews><sheetView showGridLines="0" ' + (o.tab ? 'tabSelected="1" ' : '') + 'workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>' +
        '<cols>' + o.cols.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' +
        '<sheetData>' + data + '</sheetData>' +
        (o.merges.length ? '<mergeCells count="' + o.merges.length + '">' + o.merges.map((m) => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '') +
        '<printOptions horizontalCentered="1"/><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.25" footer="0.3"/>' +
        '<pageSetup paperSize="9" orientation="' + (o.landscape ? 'landscape' : 'portrait') + '" fitToWidth="1" fitToHeight="' + (o.fitH || 0) + '"/>' +
        (o.footer ? '<headerFooter><oddFooter>' + X(o.footer) + '</oddFooter></headerFooter>' : '') +
        (o.drawing ? '<drawing r:id="rId1"/>' : '') + '</worksheet>';
    }
    function pngSize(b) { return b && b.length > 24 && b[1] === 0x50 ? [((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0] : null; }
    function book(o) {          // o: { sheets: [{ name, xml }], titles: 'Costing!$12:$12', logo: Uint8Array, logoH, title, user }
      const files = [];
      const sz = o.logo ? pngSize(o.logo) : null;
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      files.push({ name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + (sz ? '<Default Extension="png" ContentType="image/png"/>' : '') +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + o.sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + (sz ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '') +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' });
      files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' });
      files.push({ name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + X(o.title) + '</dc:title><dc:creator>' + X(o.user) + '</dc:creator><cp:lastModifiedBy>' + X(o.user) + '</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>' });
      files.push({ name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>ETHIX</Application></Properties>' });
      files.push({ name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000" activeTab="0"/></bookViews><sheets>' +
        o.sheets.map((s, i) => '<sheet name="' + X(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' +
        (o.titles ? '<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">' + X(o.titles) + '</definedName></definedNames>' : '') + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>' });
      files.push({ name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + o.sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
        '<Relationship Id="rId' + (o.sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' });
      files.push({ name: 'xl/styles.xml', data: o.styles });
      o.sheets.forEach((s, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: s.xml(!!(sz && i === 0)) }));
      if (sz) {
        const h = o.logoH || 44, w = Math.round(h * sz[0] / sz[1]), E = 9525;
        files.push({ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>' });
        files.push({ name: 'xl/drawings/drawing1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>' + (4 * E) + '</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>' + (6 * E) + '</xdr:rowOff></xdr:from><xdr:ext cx="' + w * E + '" cy="' + h * E + '"/>' +
          '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="ETHIX logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
          '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + w * E + '" cy="' + h * E + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>' });
        files.push({ name: 'xl/drawings/_rels/drawing1.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>' });
        files.push({ name: 'xl/media/image1.png', data: o.logo });
      }
      return zip(files);
    }
    return { Styles, sheetXml, book, col, zip, X, pngSize };
  })();

  // The costing workbook (v2.8). info: { job, customer, route, type, cargo, boxes, carrier, carrierLabel, dates, datesLabel,
  // sales, cs, status, statusLine, lines, notes, user, unsaved, at }
  // One sheet, read top to bottom like a statement: the job · the result (selling, buying, profit, margin, mark-up) ·
  // per box · the charges with BUYING and SELLING side by side · the result in one line · notes.
  // Columns A–J. Every USD amount converts at its own rate (the @ column, USD lines only); everything is a live formula.
  function costWorkbook(info, logo, opts = {}) {
    const S = XL.Styles(), C = XL.col;
    const INK = '0B1B2B', NAVY = '1C5179', GREY = '5A6878', MUTE = '7D8B9A', LINE = 'D5DDE5', HAIR = 'E8EDF2', TEAL = '0E7C7B', ZEBRA = 'F7F9FB', RED = 'B42318';
    const AED = '#,##0.00;[Red]-#,##0.00', AEDL = '#,##0.00;[Red]-#,##0.00;"–"', FX = '0.000##', PCT = '0.0%;[Red]-0.0%', USD2 = '#,##0.00;[Red]-#,##0.00';
    const RATEF = { USD: '"USD "#,##0.00##', AED: '"AED "#,##0.00##' };
    const CO = 3.685;                                              // per-box USD figures use the company rate
    const W = [28, 22, 14, 6.5, 16.5, 8.5, 16, 16.5, 8.5, 16];   // A–J (generous: nothing may clip in Excel — not even AED 1,234,567.89)
    const LAST = W.length - 1;
    // Arial character widths (1/1000 em) — so wrapped cells get exactly the height they need in Excel
    const AW = { U: [667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611], UB: [722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611],
      L: [556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500], LB: [556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500] };
    const cw = (ch, b) => { const u = ch.charCodeAt(0); if (u >= 65 && u <= 90) return AW[b ? 'UB' : 'U'][u - 65]; if (u >= 97 && u <= 122) return AW[b ? 'LB' : 'L'][u - 97]; if (u >= 48 && u <= 57) return 556; return ' .,:;\'′|!il'.includes(ch) ? 278 : '-()[]/'.includes(ch) ? 333 : '—→€@%&W'.includes(ch) ? 1000 : 600; };
    const tw = (t, pt, b) => { let w = 0; for (const ch of String(t)) w += cw(ch, b); return w / 1000 * pt * 4 / 3; };
    const span = (c1, c2) => { let w = 0; for (let c = c1; c <= c2; c++) w += W[c] * 7 + 5; return w; };
    const linesOf = (t, pt, b, c1, c2) => {                      // word-wrap the way Excel does, with a 12 % margin
      const room = span(c1, c2) - 16;
      return String(t || '').split('\n').reduce((n, part) => {
        let lines = 1, cur = '';
        part.split(' ').forEach((wd) => { const tr = cur ? cur + ' ' + wd : wd; if (cur && tw(tr, pt, b) * 1.12 > room) { lines++; cur = wd; } else cur = tr; });
        return n + lines;
      }, 0);
    };
    const rows = {}, merges = [];
    const put = (r, c, v, s, f) => { (rows[r] = rows[r] || { c: {} }).c[c] = { v, s, f }; };
    const height = (r, h) => { (rows[r] = rows[r] || { c: {} }).h = h; };
    const cell = (r, c1, c2, v, s, f) => { put(r, c1, v, s, f); for (let c = c1 + 1; c <= c2; c++) put(r, c, '', s); if (c2 > c1) merges.push(C(c1) + r + ':' + C(c2) + r); };
    const st = {
      title: S({ font: { sz: 18, b: true, color: INK }, align: { h: 'right', v: 'center' } }),
      job: S({ font: { sz: 11, b: true, color: NAVY }, align: { h: 'right', v: 'center' } }),
      state: S({ font: { sz: 9, b: true, color: info.status === 'LOCKED' ? TEAL : NAVY }, align: { h: 'right', v: 'center' } }),
      rule: S({ border: { bottom: ['thin', INK] } }),
      lab: S({ font: { sz: 7.5, b: true, color: MUTE }, align: { v: 'bottom', indent: 1 } }),
      val: S({ font: { sz: 10, b: true, color: INK }, border: { bottom: ['thin', LINE] }, align: { v: 'top', indent: 1, wrap: true } }),
      chg: S({ font: { sz: 8, b: true, color: INK }, border: { bottom: ['thin', INK] }, align: { v: 'center', indent: 1 } }),
      grpB: S({ font: { sz: 8.5, b: true, color: NAVY }, border: { bottom: ['medium', NAVY] }, align: { h: 'center', v: 'center' } }),
      grpS: S({ font: { sz: 8.5, b: true, color: TEAL }, border: { bottom: ['medium', TEAL], left: ['thin', LINE] }, align: { h: 'center', v: 'center' } }),
      foot: S({ font: { sz: 7.5, color: MUTE }, align: { v: 'top', indent: 1, wrap: true } })
    };
    // KPI tiles: a thin rule on top, a hairline between tiles (left edge), label then value
    const tileLab = (first, color) => S({ font: { sz: 7.5, b: true, color: color || MUTE }, border: Object.assign({ top: ['thin', LINE] }, first ? {} : { left: ['thin', LINE] }), align: { v: 'bottom', indent: 1 } });
    const tileVal = (first, sz, color, fmt, bottom) => S({ font: { sz, b: true, color: color || INK }, fmt, border: Object.assign(first ? {} : { left: ['thin', LINE] }, bottom ? { bottom: ['thin', LINE] } : {}), align: { h: 'left', v: 'center', indent: 1 } });
    // table cells: z = zebra row; side '' | 'b' | 's'; the selling side opens with a hairline (the divider)
    const td = (z, kind, side, fmt) => {
      const o = { border: Object.assign({ bottom: ['thin', HAIR] }, side === 's' && (kind === 'rate' || kind === 'incl') ? { left: ['thin', LINE] } : {}), fill: z ? ZEBRA : undefined };
      const tone = side === 'b' ? NAVY : side === 's' ? TEAL : INK;
      if (kind === 'chg') o.font = { sz: 9, b: true, color: INK }, o.align = { v: 'center', indent: 1, wrap: true };
      else if (kind === 'txt') o.font = { sz: 9, color: GREY }, o.align = { v: 'center', indent: 1, wrap: true };
      else if (kind === 'basis') o.font = { sz: 9, color: GREY }, o.align = { v: 'center', indent: 1 };
      else if (kind === 'qty') o.font = { sz: 9, color: INK }, o.fmt = 'General', o.align = { h: 'right', v: 'center', indent: 1 };
      else if (kind === 'rate') o.font = { sz: 9, color: INK }, o.fmt = fmt, o.align = { h: 'right', v: 'center', indent: 1 };
      else if (kind === 'fx') o.font = { sz: 8, color: MUTE }, o.fmt = FX, o.align = { h: 'right', v: 'center' };
      else if (kind === 'incl') o.font = { sz: 8, i: true, color: MUTE }, o.align = { h: 'right', v: 'center', indent: 1 };
      else o.font = { sz: 9, b: true, color: tone }, o.fmt = AEDL, o.align = { h: 'right', v: 'center', indent: 1 };
      return S(o);
    };
    const th = (side, right) => S({ font: { sz: 7.5, b: true, color: side === 'b' ? NAVY : side === 's' ? TEAL : MUTE }, border: Object.assign({ bottom: ['thin', LINE] }, side === 's' && right === 'first' ? { left: ['thin', LINE] } : {}), align: { h: right ? 'right' : 'left', v: 'center', indent: 1 } });

    // ---- header: logo left, title right
    height(1, 28); height(2, 17); height(3, 14); height(4, 6);
    cell(1, 4, LAST, 'COST SHEET', st.title);
    cell(2, 4, LAST, 'JOB ' + info.job, st.job);
    cell(3, 4, LAST, info.statusLine, st.state);
    for (let c = 0; c <= LAST; c++) put(4, c, '', st.rule);
    // ---- the job (two rows of four)
    const BLOCKS = [[0, 0], [1, 3], [4, 6], [7, LAST]];
    const facts = (r, items) => {
      let n = 1;
      items.forEach(([label, value], i) => { const [c1, c2] = BLOCKS[i]; cell(r, c1, c2, label, st.lab); cell(r + 1, c1, c2, value || '—', st.val); n = Math.max(n, linesOf(value || '—', 10, true, c1, c2)); });
      height(r, 14); height(r + 1, 13 * n + 4);
    };
    facts(5, [['JOB NO.', info.job], ['CUSTOMER', info.customer], ['ROUTE', info.route], ['TYPE', info.type]]);
    facts(7, [['CONTAINERS', info.cargo], [info.carrierLabel, info.carrier], [info.datesLabel, info.dates], ['SALES · CUSTOMER SERVICE', (info.sales || '—') + ' · ' + (info.cs || '—')]]);
    height(9, 10);
    // ---- the table first (the summary refers to its totals)
    const G = 15, H = 16, first = 17, lines = info.lines, last = first + lines.length - 1, T = first + lines.length;
    cell(G, 0, 3, 'CHARGES · ' + lines.length, st.chg);
    cell(G, 4, 6, 'BUYING', st.grpB);
    cell(G, 7, LAST, 'SELLING', st.grpS);
    height(G, 18);
    [[0, 'CHARGE', th('')], [1, 'VENDOR', th('')], [2, 'BASIS', th('')], [3, 'QTY', th('', 1)],
      [4, 'RATE', th('b', 1)], [5, '@ USD', th('b', 1)], [6, 'AED', th('b', 1)],
      [7, 'RATE', th('s', 'first')], [8, '@ USD', th('s', 1)], [9, 'AED', th('s', 1)]].forEach(([c, t, s]) => put(H, c, t, s));
    height(H, 17);
    let sb = 0, ss = 0;
    lines.forEach((l, i) => {
      const r = first + i, z = i % 2 === 1, q = Number(l.qty) || 0;
      const side = (k) => {
        const usd = l[k + 'c'] === 'USD', rate = Number(l[k + 'r']) || 0, fx = usd ? (Number(l[k + 'x']) || CO) : 0;
        return { usd, rate, fx, aed: q * rate * (usd ? fx : 1) };
      };
      const B = side('b'), Sd = side('s'), incl = !Sd.rate;
      sb += B.aed; ss += Sd.aed;
      put(r, 0, l.charge, td(z, 'chg')); put(r, 1, l.vendor || '', td(z, 'txt')); put(r, 2, BASIS_SHORT[l.basis] || l.basis, td(z, 'basis'));
      put(r, 3, q, td(z, 'qty'));
      put(r, 4, B.rate || '', td(z, 'rate', 'b', RATEF[B.usd ? 'USD' : 'AED'])); put(r, 5, B.usd ? B.fx : '', td(z, 'fx', 'b'));
      put(r, 6, B.aed, td(z, 'aed', 'b'), 'D' + r + '*N(E' + r + ')*IF(ISNUMBER(F' + r + '),F' + r + ',1)');
      put(r, 7, incl ? 'incl.' : Sd.rate, incl ? td(z, 'incl', 's') : td(z, 'rate', 's', RATEF[Sd.usd ? 'USD' : 'AED']));
      put(r, 8, !incl && Sd.usd ? Sd.fx : '', td(z, 'fx', 's'));
      put(r, 9, Sd.aed, td(z, 'aed', 's'), 'D' + r + '*N(H' + r + ')*IF(ISNUMBER(I' + r + '),I' + r + ',1)');
      const n = Math.max(linesOf(l.charge, 9, true, 0, 0), linesOf(l.vendor, 9, false, 1, 1));
      height(r, n > 1 ? 11.6 * n + 5 : 17);
    });
    // totals
    const tl = S({ font: { sz: 9.5, b: true, color: INK }, border: { top: ['thin', INK] }, align: { v: 'center', indent: 1 } });
    const te = (left) => S({ border: Object.assign({ top: ['thin', INK] }, left ? { left: ['thin', LINE] } : {}) });
    const tn = (color) => S({ font: { sz: 10, b: true, color }, fmt: AED, border: { top: ['thin', INK], bottom: ['double', INK] }, align: { h: 'right', v: 'center', indent: 1 } });
    const sum = (L) => (lines.length ? 'SUM(' + L + first + ':' + L + last + ')' : null);
    put(T, 0, 'TOTAL · AED', tl); for (let c = 1; c <= LAST; c++) put(T, c, '', te(c === 7));
    put(T, 6, sb, tn(NAVY), sum('G')); put(T, 9, ss, tn(TEAL), sum('J'));
    height(T, 19);
    const p = ss - sb, bx = info.boxes, gT = 'G' + T, jT = 'J' + T;
    const money2 = (v) => (Math.round(v * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const resTxt = 'Selling ' + money2(ss) + '  −  Buying ' + money2(sb) + '  =  Profit ' + money2(p) + (ss ? '  ·  ' + (Math.round(p / ss * 1000) / 10).toFixed(1) + '% margin' : '');
    const resF = '"Selling "&TEXT(' + jT + ',"#,##0.00")&"  −  Buying "&TEXT(' + gT + ',"#,##0.00")&"  =  Profit "&TEXT(' + jT + '-' + gT + ',"#,##0.00")&IF(' + jT + '=0,"","  ·  "&TEXT((' + jT + '-' + gT + ')/' + jT + ',"0.0%")&" margin")';
    cell(T + 1, 0, LAST, resTxt, S({ font: { sz: 10.5, b: true, color: p < 0 ? RED : TEAL }, align: { h: 'right', v: 'center', indent: 1 } }), lines.length ? resF : null);
    height(T + 1, 20);
    // ---- the result (rows 10–11) and per box (rows 12–13)
    const TILES = [[0, 0], [1, 1], [2, 3], [4, 6], [7, LAST]];        // the same columns as the table below
    const tiles = (rl, items, sz, bottom) => {
      items.forEach(([label, value, fmt, f, color, lcolor], i) => {
        const [c1, c2] = TILES[i];
        cell(rl, c1, c2, label, tileLab(i === 0, lcolor));
        cell(rl + 1, c1, c2, value, tileVal(i === 0, sz, color, fmt, bottom), f);
      });
    };
    height(10, 14); height(11, 25);
    tiles(10, [
      ['PROFIT · AED', p, AED, jT + '-' + gT, p < 0 ? RED : TEAL, TEAL],
      ['MARGIN', ss ? p / ss : 0, PCT, 'IF(' + jT + '=0,0,(' + jT + '-' + gT + ')/' + jT + ')'],
      ['MARK-UP', sb ? p / sb : 0, PCT, 'IF(' + gT + '=0,0,(' + jT + '-' + gT + ')/' + gT + ')'],
      ['BUYING · AED', sb, AED, gT, INK, NAVY],
      ['SELLING · AED', ss, AED, jT, INK, TEAL]
    ], 15, false);
    height(12, 14); height(13, 21);
    tiles(12, bx ? [
      ['PROFIT / BOX · AED', p / bx, AED, '(' + jT + '-' + gT + ')/' + bx, p < 0 ? RED : TEAL],
      ['BOXES', bx + ' · ' + info.cargo, null, null, INK],
      ['USD RATE · PER BOX', CO, FX, null, INK],
      ['COST / BOX · USD', sb / bx / CO, USD2, gT + '/' + bx + '/' + CO, NAVY],
      ['SELL / BOX · USD', ss / bx / CO, USD2, jT + '/' + bx + '/' + CO, TEAL]
    ] : [
      ['PROFIT / BOX · AED', '—', null, null, MUTE], ['BOXES', info.cargo || '—', null, null, INK], ['USD RATE · PER BOX', CO, FX, null, INK],
      ['COST / BOX · USD', '—', null, null, MUTE], ['SELL / BOX · USD', '—', null, null, MUTE]
    ], 12, true);
    height(14, 12);
    // ---- under the table: notes, then where it came from
    let r = T + 3;
    if (info.notes.length) {
      for (let c = 0; c <= LAST; c++) put(r, c, c ? '' : 'NOTES · ' + info.notes.length, st.chg);
      height(r, 17); r++;
      const nW = S({ font: { sz: 8, color: MUTE }, border: { bottom: ['thin', HAIR] }, align: { v: 'top', indent: 1 } });
      const nC = S({ font: { sz: 9, color: INK }, border: { bottom: ['thin', HAIR] }, align: { v: 'top', indent: 1, wrap: true } });
      info.notes.forEach((n) => {
        put(r, 0, n.when + ' · ' + n.by, nW); cell(r, 1, LAST, n.txt, nC);
        height(r, Math.max(16, 11.6 * linesOf(n.txt, 9, false, 1, LAST) + 5)); r++;
      });
      r++;
    }
    const fine = 'Generated ' + info.at + ' by ' + info.user + ' from ETHIX.';
    cell(r, 0, LAST, fine, st.foot);
    height(r, Math.max(14, 10 * linesOf(fine, 7.5, false, 0, LAST) + 4));
    if (info.unsaved) { r++; cell(r, 0, LAST, 'DRAFT — this export includes changes that were not saved yet.', S({ font: { sz: 9, b: true, color: RED }, align: { indent: 1 } })); height(r, 16); }
    let tall = 0; for (let k = 1; k <= r; k++) tall += (rows[k] && rows[k].h) || 15;
    const sheet1 = { cols: W, rows, merges, tab: true, tabColor: '48BEBF', landscape: true, fitH: tall <= 700 ? 1 : 0, footer: '&L&8ETHIX · Costing · Job ' + info.job + '&R&8Page &P of &N', noCache: !!opts.noCache };
    return XL.book({
      title: 'ETHIX costing ' + info.job, user: info.user, logo, logoH: 40, titles: 'Costing!$' + G + ':$' + H,
      sheets: [{ name: 'Costing', xml: (d) => XL.sheetXml(Object.assign({}, sheet1, { drawing: d })) }],
      styles: S.xml()
    });
  }
  let logoBytes = null;
  // The logo built into the page (always there, no download); the assets file is only a fallback.
  async function costLogo() {
    if (logoBytes) return logoBytes;
    try {
      const el = document.createElement('span'); el.className = 'brand-logo'; el.style.position = 'absolute'; el.style.visibility = 'hidden'; document.body.appendChild(el);
      const m = String(getComputedStyle(el).backgroundImage || '').match(/data:image\/png;base64,([A-Za-z0-9+\/=]+)/); el.remove();
      if (m) { const bin = atob(m[1]); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); logoBytes = u; return logoBytes; }
    } catch (e) { /* try the file */ }
    try { const r = await fetch('assets/ethix-logo-color.png', { cache: 'force-cache' }); if (r.ok) logoBytes = new Uint8Array(await r.arrayBuffer()); } catch (e) { /* no logo then */ }
    return logoBytes;
  }
  function costInfo(j, C) {
    const D = C.data;
    const read = readLines(C);
    const lines = read.lines || D.lines;
    const stamp = (t) => (t ? stampText(dxb(t)) : '');
    const statusLine = D.status === 'LOCKED' ? 'COSTING DONE · LOCKED' + (D.lockedBy ? ' · ' + D.lockedBy : '') + (D.lockedAt ? ' · ' + stamp(D.lockedAt) : '')
      : C.dirty || D.status === 'NEW' ? 'DRAFT · NOT SAVED' : 'DRAFT' + (D.by ? ' · SAVED BY ' + D.by : '') + (D.at ? ' · ' + stamp(D.at) : '');
    return {
      job: j.jobNo, customer: j.customer, route: j.mode === 'misc' ? (j.against ? 'AGAINST ' + j.against : 'COSTING ONLY') : (j.pol || '—') + ' → ' + (j.pod || '—'), type: j.type + ' · ' + j.typeName, cargo: j.cargo || (j.mode === 'air' ? 'AIR' : j.mode === 'courier' ? 'COURIER' : ''), boxes: boxesOf(j),
      carrier: j.vendor || '—', carrierLabel: { sea: 'SHIPPING LINE', air: 'AIRLINE', courier: 'COURIER' }[j.mode] || 'VENDOR',
      datesLabel: j.mode === 'courier' ? 'PICK-UP · DELIVERY' : 'ETD · ETA', dates: (j.etd || j.eta) ? fmt(j.etd, true) + '  →  ' + fmt(j.eta, true) : '—',
      sales: j.sales, cs: j.cs, status: D.status === 'LOCKED' ? 'LOCKED' : 'DRAFT', statusLine, lines, unsaved: C.dirty || D.status === 'NEW', user: state.user, at: fmt(dxb(Date.now()), true) + ' ' + stampText(dxb(Date.now())).slice(-5),
      notes: C.draft.notes.map((t) => ({ when: 'not saved yet', by: state.user, txt: t })).concat((D.notes || []).slice().reverse().map((n) => ({ when: stamp(n.t), by: n.by, txt: n.txt })))
    };
  }
  async function exportCost(j) {
    const C = costFor(j.jobNo); if (!C || !C.data) return;
    const read = readLines(C);
    if (read.bad) { toast(read.msg, { error: true }); return; }
    try {
      const blob = costWorkbook(costInfo(j, C), await costLogo());
      const name = 'ETHIX_Costing_' + String(j.jobNo).replace(/[^A-Za-z0-9\-]+/g, '_') + '.xlsx';
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      toast('Excel ready · ' + name);
    } catch (e) { toast('The Excel file could not be made: ' + e.message, { error: true }); }
  }

  // ================================================================ v2.7 — whose jobs
  // Follow-ups and Costing are always your own jobs; Home and Jobs start on "My jobs" at every sign-in.
  function mineJobs() { return canEdit() ? state.jobs.filter((j) => j.cs === state.user) : state.jobs; }

  // ================================================================ v2.7 — cutoffs, every open one, coloured
  // red: passed, today or tomorrow (inside 24 h) · amber: in 2–3 days · calm: later
  const cutTone = (d) => (d <= 1 ? 'red' : d <= 3 ? 'amber' : 'calm');
  const cutWhen = (d, date) => (d < 0 ? 'PASSED' : d === 0 ? 'TODAY' : d === 1 ? 'TOMORROW' : fmt(date));
  function cutsFor(j, t0) {
    if (!j.active || j.hold || (j.etd && j.etd <= t0)) return [];
    const out = [], open = (v) => !v || v === 'PENDING';
    const add = (k, label, date, pending) => { if (date && pending) { const d = days(t0, date); out.push({ k, label, d, date, tone: cutTone(d) }); } };
    if (['EXPORT', 'CROSS'].includes(j.cat) && j.type !== 'CRR') add('SI', 'SI cutoff', j.siCut, open(j.sido));
    if (j.cat === 'EXPORT') add('ED', 'ED cutoff', j.edCut, open(j.ed));
    if (j.cat === 'EXPORT' && j.dg === 'DG') add('DG', 'DG cutoff', j.dgCut, j.mode === 'sea' ? open(j.dgpc) : true);   // v2.9.2: until DGPC is submitted
    return out;
  }
  function cutChips(j) {
    const list = cutsFor(j, today0());
    return list.length ? '<span class="cut-chips">' + list.map((c) => '<span class="cut-chip is-' + c.tone + '" title="' + esc(c.label + ' ' + fmt(c.date, true)) + '"><b>' + c.k + '</b>' + esc(cutWhen(c.d, c.date)) + '</span>').join('') + '</span>' : '';
  }
  // The "next step" chip of a row: when the cutoff chips already say how close it is, it just names the step.
  function rowNext(j) {
    const n = j.next;
    if (!n || !/cutoff/i.test(n.text) || !cutsFor(j, today0()).length) return n;
    const st = j.journey.all.filter((s) => s.cutDays !== undefined && s.state !== 'done' && s.state !== 'skip').sort((a, b) => a.cutDays - b.cutDays)[0];
    return { text: st ? st.def.next : n.text.replace(/\s*·?\s*cutoff.*$/i, ''), tone: 'calm', rank: n.rank };
  }
  // Step names say what is still to happen, until it has happened: "SI submission" → "SI submitted".
  const PEND_NAME = { si: 'SI submission', docsReady: 'Docs to prepare', ed: 'ED pending', dgpc: 'DGPC pending', blConf: 'BL confirmation pending', blReceived: 'BL to receive', blIss: 'BL issue pending',
    awbConf: 'AWB confirmation pending', awbIss: 'AWB issue pending', tracking: 'Tracking no. pending', costing: 'Costing pending', discharge: 'Discharge list pending',
    doRel: 'DO release pending', customs: 'Customs clearance', sailed: 'Sailing', departed: 'Departing', pickedUp: 'Pick-up', arrived: 'ETA', deliveredEta: 'Delivery',
    delivered: 'Delivery', deliveredOpt: 'Delivery', linked: 'Link to a job' };
  function polishStops(all) {
    all.forEach((s) => {
      if (s.state === 'done' || s.state === 'skip') return;
      if (PEND_NAME[s.id]) s.name = PEND_NAME[s.id];
      if (s.kind === 'date' && s.def.tag && s.sub === s.def.tag + ' TO CONFIRM') s.sub = 'TO CONFIRM';
      if (s.cutDays !== undefined) s.cutTone = cutTone(s.cutDays);
    });
  }

  // ================================================================ v2.7 — notifications, a page of their own
  // The whole page scrolls (no box inside a box); grouped by day; older alerts load as you reach the end.
  let notifObs = null;
  const notifKey = (x) => x.t + '|' + x.job + '|' + x.kind + '|' + x.from;
  function notifAll() {
    const n = state.notif || { items: [] }, have = new Set((n.items || []).map(notifKey));
    return (n.items || []).concat((state.notifOld || []).filter((x) => !have.has(notifKey(x))));
  }
  function notifDay(t, t0) { const d = dayOf(t), n = days(d, t0); return n === 0 ? 'TODAY' : n === 1 ? 'YESTERDAY' : n < 7 ? DOW_UP[d.getDay()] + ' · ' + fmt(d) : fmt(d, true); }
  function markNotifSeen() {
    const n = state.notif; if (!n || !notifUnread()) return;
    n.seen = Math.max(n.seen || 0, ...n.items.map((x) => x.t));         // server time, not this device's clock
    drawBadges();
    api.call('ethixNotifSeen').catch(() => {});
  }
  function notifRow(x, seen) {
    return '<li><button type="button" class="notif' + (x.t > seen ? ' is-new' : '') + (x.kind === 'delay' ? ' is-delay' : '') + '" ' + (/^EQ-/.test(x.job) ? 'data-enq' : x.kind === 'costing' ? 'data-cost' : 'data-job') + '="' + esc(x.job) + '">' +
      '<span class="avatar' + (x.kind === 'note' ? ' is-other' : '') + '">' + esc(initials(x.from)) + '</span>' +
      '<span class="nt-body"><span class="nt-head">' + notifText(x) + ' <span class="nt-job">' + esc(x.job) + '</span></span><span class="nt-text">' + esc(x.text) + '</span></span>' +
      '<span class="nt-time">' + esc(hm(x.t)) + '</span></button></li>';
  }
  function renderNotifPage(first) {
    const t0 = today0(), anim = first ? ' reveal' : '';
    if (first) state.notifSeenShown = (state.notif && state.notif.seen) || 0;
    markNotifSeen();
    const items = notifAll(), seen = state.notifSeenShown || 0;
    const groups = [];
    items.forEach((x) => { const k = notifDay(x.t, t0), g = groups[groups.length - 1]; if (g && g.k === k) g.list.push(x); else groups.push({ k, list: [x] }); });
    const more = state.notifMore === undefined ? !!(state.notif && state.notif.more) : state.notifMore;
    const fresh = items.filter((x) => x.t > seen).length;
    $('#view').innerHTML = '<div class="wrap notif-page no-seg">' +
      '<header class="page-head' + anim + '"><div class="head-main"><div class="meta-line"><span>NOTIFICATIONS · ' + esc(fmtLong(t0)) + '</span><span class="sync" id="sync"><span class="sync-dot"></span><span id="syncText">' + syncText() + '</span></span>' + (fresh ? '<span class="meta-chip is-ready"><b>' + fresh + '</b> NEW</span>' : '') + '</div><h1 class="greeting">Notifications</h1></div>' +
        '<div class="head-actions"><button type="button" class="btn-ghost" id="refreshBtn" data-act="refresh" aria-label="Refresh"><span class="spin">' + icon('refresh', 16) + '</span><span class="btn-label">Refresh</span></button></div></header>' +
      (items.length ? groups.map((g, i) => '<section class="notif-sec' + anim + '" style="--d:' + Math.min(40 + i * 30, 220) + 'ms" aria-label="' + esc(g.k) + '"><div class="tile-head"><h2 class="tile-title">' + esc(g.k) + ' <span class="tile-count">' + g.list.length + '</span></h2></div><ol class="notif-list">' + g.list.map((x) => notifRow(x, seen)).join('') + '</ol></section>').join('') +
          (more ? '<div class="notif-more"><button type="button" class="btn-ghost" data-act="notif-more"' + (state.notifLoading ? ' disabled' : '') + '>' + (state.notifLoading ? 'Loading older…' : 'Show older') + '</button></div>' : '<div class="jobs-end">THAT’S EVERYTHING</div>')
        : '<section class="tile">' + empty('bell', isSales() ? 'Updates, delays and enquiry replies from Customer Service show here.' : 'Notes, costing news and enquiries from sales show here.') + '</section>') +
      '</div>';
    notifWatch();
  }
  function notifOlder() {
    if (state.notifLoading) return;
    const all = notifAll(); if (!all.length) return;
    state.notifLoading = true; rerender();
    api.call('ethixNotifMore', [all[all.length - 1].t]).then((res) => {
      state.notifOld = (state.notifOld || []).concat((res && res.items) || []);
      state.notifMore = !!(res && res.more);
    }).catch((e) => { if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Older notifications need the v2.7 Code.gs update.' : e.message, { error: true }); state.notifMore = false; })
      .finally(() => { state.notifLoading = false; if (state.route && state.route.name === 'notif') rerender(); });
  }
  function notifWatch() {
    if (notifObs) { notifObs.disconnect(); notifObs = null; }
    const b = $('[data-act="notif-more"]'); if (!b || !('IntersectionObserver' in window)) return;
    notifObs = new IntersectionObserver((en) => { if (en.some((x) => x.isIntersecting)) notifOlder(); }, { root: $('#view'), rootMargin: '0px 0px 240px 0px' });
    notifObs.observe(b);
  }

  // ================================================================ v2.7 — the job page as widgets
  // Facts on top (key dates · cargo · people), then notes and follow-up, then history and costing.
  // Every row is solid — the cards in a row share one height; the phone stacks them in this order.
  const DATE_LABEL = { 'ETD POL': 'ETD', 'ETA POD': 'ETA', 'SI CUTOFF': 'SI cutoff', 'ED CUTOFF': 'ED cutoff', 'DG CUTOFF': 'DG cutoff' };
  function isDateAction(a) {
    a = String(a || '');
    if (/^CHANGED /.test(a) || /^(MARKED|REMOVED) DELAY/.test(a)) return true;
    if (/^SET (ETD POL|ETA POD|SI CUTOFF|ED CUTOFF|DG CUTOFF) TO /.test(a)) return true;
    const m = a.match(/^UPDATED (.+)$/);
    return !!(m && m[1].split(', ').every((x) => DATE_LABEL[x]));
  }
  function friendlyDates(text) {
    const day = (v) => { if (!v || v === '(BLANK)') return '—'; const d = parseDate(v); return d ? fmt(d) : v; };
    return 'changed ' + String(text).split('; ').map((p) => { const m = p.match(/^(.+?) (\S+) → (\S+)$/); return m ? (DATE_LABEL[m[1]] || nice(m[1])) + ' ' + day(m[2]) + ' → ' + day(m[3]) : p.toLowerCase(); }).join(' · ');
  }
  function storySplit(no) {
    const items = storyItems(no);
    if (!items) return null;
    const notes = [], hist = [];
    items.forEach((x) => { if (x.note !== undefined || isDateAction(x.raw)) notes.push(x); else hist.push(x); });
    return { notes, hist };
  }
  function storyLi(e) {
    const date = e.note === undefined && isDateAction(e.raw);
    return '<li' + (date ? ' class="is-date"' : '') + '><div class="st-when">' + esc(stampText(e.at)) + '</div><span class="avatar' + (e.who === state.user ? '' : ' is-other') + '">' + esc(initials(e.who || '?')) + '</span><div class="st-body"><div><strong>' + esc(e.who || '—') + '</strong> ' +
      (e.note !== undefined ? 'added a note' : (date ? icon('calendar', 13) : '') + esc(e.what)) + '</div>' + (e.note !== undefined ? '<div class="st-note">' + esc(e.note) + '</div>' : '') + '</div></li>';
  }
  function storyBlock(list, limit, tab, emptyText) {
    if (!list) return '<div class="story-loading"><span class="sk"></span><span class="sk"></span><span class="sk short"></span></div>';
    if (!list.length) return '<div class="tile-empty">' + icon('clock', 22) + '<span>' + esc(emptyText) + '</span></div>';
    return '<ol class="story">' + (limit ? list.slice(0, limit) : list).map(storyLi).join('') + '</ol>' +
      (limit && list.length > limit ? '<button type="button" class="tile-link wg-more" data-tab="' + tab + '">See all ' + list.length + '</button>' : '');
  }
  function notesWidget(j, limit) {
    const sp = storySplit(j.jobNo);
    const share = isSales() ? (j.cs ? 'Shared with ' + j.cs + ' (Customer Service)' : '') : j.sales ? 'Shared with ' + j.sales + ' (sales)' : '';
    return '<section class="tile story-card wg-notes" aria-labelledby="notesTitle"><div class="tile-head"><h2 class="tile-title" id="notesTitle">NOTES</h2>' + (share ? '<span class="small">' + esc(share) + '</span>' : '') + '</div>' +
      noteBox() + storyBlock(sp && sp.notes, limit, 'notes', canNote() ? 'No notes yet. Notes you add, and every ETD, ETA and cutoff change, show here.' : 'No notes yet.') + '</section>';
  }
  function historyWidget(j, limit) {
    const sp = storySplit(j.jobNo);
    return '<section class="tile story-card wg-history" aria-labelledby="histTitle"><div class="tile-head"><h2 class="tile-title" id="histTitle">HISTORY</h2>' + (sp && sp.hist.length ? '<span class="tile-count">' + sp.hist.length + '</span>' : '') + '</div>' +
      storyBlock(sp && sp.hist, limit, 'history', 'Every update to this job shows here.') + '</section>';
  }
  function keyDatesW(j, t0) {
    const met = (f) => j[f] && ['SUBMITTED', 'APPROVED', 'PASSED/PAID', 'PASSED'].includes(j[f]);
    const cut = (d, f) => {
      if (!d) return { v: '—' };
      if (f && met(f)) return { v: fmt(d) + ' · MET', tone: 'met' };
      const n = days(t0, d), sailed = j.etd && j.etd <= t0;
      return { v: fmt(d) + (n < 0 ? ' · PASSED' : n === 0 ? ' · TODAY' : n === 1 ? ' · TOMORROW' : ''), tone: sailed ? '' : cutTone(n) };
    };
    const rows = [['Job opened', { v: fmt(j.opened, true) }]];
    if (['EXPORT', 'CROSS'].includes(j.cat) && j.type !== 'CRR') rows.push(['SI cutoff', cut(j.siCut, 'sido')]);
    if (j.cat === 'EXPORT') rows.push(['ED cutoff', cut(j.edCut, 'ed')]);
    if (j.dg === 'DG' && j.cat === 'EXPORT') rows.push(['DG cutoff', cut(j.dgCut, null)]);
    if (j.mode !== 'misc') {
      rows.push([(j.mode === 'courier' ? 'Pick-up' : 'ETD') + (j.pol ? ' ' + nice(j.pol) : ''), { v: fmt(j.etd, true) }]);
      rows.push([(j.mode === 'courier' ? 'Delivery' : 'ETA') + (j.pod ? ' ' + nice(j.pod) : ''), { v: fmt(j.eta, true) }]);
    }
    if (j.cat === 'IMPORT') {
      rows.push(['Delivered', { v: j.raw.delivery === NA ? 'NOT NEEDED' : fmt(j.delivery, true) }]);
      if (j.lineFreeRaw) rows.push(['Line free time', { v: /^\d+$/.test(j.lineFreeRaw) ? j.lineFreeRaw + ' DAYS' : j.lineFreeRaw }]);
      if (j.portFreeRaw) rows.push(['Port free time', { v: /^\d+$/.test(j.portFreeRaw) ? j.portFreeRaw + ' DAYS' : j.portFreeRaw }]);
      if (j.type !== 'AFI') rows.push(['Original docs', { v: j.docs || '—' }]);
    }
    return '<section class="tile side-card" aria-labelledby="datesTitle"><div class="tile-head"><h2 class="tile-title" id="datesTitle">KEY DATES</h2></div>' +
      rows.map((r) => '<div class="kv"><span class="kv-k">' + esc(r[0]) + '</span><span class="kv-v' + (r[1].tone && r[1].tone !== 'calm' ? ' kd-' + r[1].tone : '') + '">' + esc(r[1].v) + '</span></div>').join('') + '</section>';
  }
  function jobWidgets(j, t0) {
    const rows = [
      [keyDatesW(j, t0), cargoCard(j), peopleCard(j)],
      [freeCard(j, t0) ? '<div class="ft-side wg-free">' + freeCard(j, t0) + '</div>' : '', delayCard(j)],
      [notesWidget(j, 5), followCard(j)],
      [historyWidget(j, 5), costCard(j)]
    ];
    return '<div class="wgrid">' + rows.map((r) => {
      r = r.filter(Boolean);
      return r.map((h, i) => '<div class="wg wg-' + (r.length === 3 ? 1 : r.length === 2 ? (i === 0 ? 2 : 1) : 3) + (/^<div class="ft-side/.test(h) ? ' wg-ft' : '') + '">' + h + '</div>').join('');
    }).join('') + '</div>';
  }

  // ================================================================ v2.7 — follow-up remarks (several a day)
  function remarksToday(f, t0) { return f.checks.filter((c) => c[2] && days(dayOf(c[0]), t0) === 0); }
  function remarkList(list, max) {
    const show = max ? list.slice(0, max) : list;
    return '<ol class="fu-remarks">' + show.map((c) => '<li><span class="fr-when">' + esc(hm(c[0])) + (c[1] !== state.user ? ' · ' + esc(nice(c[1])) : '') + '</span><span class="fr-text">' + esc(c[2]) + '</span></li>').join('') + '</ol>' +
      (max && list.length > max ? '<span class="fr-more">+' + (list.length - max) + ' more today</span>' : '');
  }
  // The newest remark of the day the job was last checked (and how many that day).
  function lastRemark(f) {
    if (!f.last) return null;
    const d0 = +dayOf(f.last[0]);
    const list = f.checks.filter((c) => c[2] && +dayOf(c[0]) === d0).sort((a, b) => b[0] - a[0]);
    return list.length ? { text: list[0][2], n: list.length } : null;
  }

  // ================================================================ v2.7 — cutoffs worked out from ETD
  // Same job types as the old ERP (SFEF, SFEL, AFE): ED cutoff = ETD − 2 · SI cutoff = ETD − 4 (DG: ETD − 5)
  // · DG cutoff = ETD − 5. A cutoff you typed yourself is kept; one that still matches the old ETD moves.
  // Sea import FCL, non-DG: port free time starts at 9 days when ETA is entered (as the old ERP did).
  const CUT_TYPES = ['SFEF', 'SFEL', 'AFE'];
  function cutPlan(etd, dg) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(etd || '')); if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return { edCut: iso(addDays(d, -2)), siCut: iso(addDays(d, dg ? -5 : -4)), dgCut: dg ? iso(addDays(d, -5)) : '' };
  }
  function formType(form) { return form.id === 'jobForm' ? (state.newJob && state.newJob.type) || '' : ((form.querySelector('[name="type"]') || {}).value || ''); }
  function flashField(el) { el.classList.remove('is-auto'); void el.offsetWidth; el.classList.add('is-auto'); setTimeout(() => el.classList.remove('is-auto'), 1600); }
  function autoCuts(form) {
    if (!CUT_TYPES.includes(formType(form))) return;
    const field = (k) => form.querySelector('[name="' + k + '"]');
    const dg = (field('dg') || {}).value === 'DG';
    if (!form._cut) form._cut = form.id === 'editForm' && state.editing ? (cutPlan(state.editing.initial.etd, state.editing.initial.dg === 'DG') || {}) : {};
    const was = form._cut, plan = cutPlan((field('etd') || {}).value, dg);
    if (!plan) return;
    const moved = [], kept = [];
    ['edCut', 'siCut', 'dgCut'].forEach((k) => {
      const el = field(k); if (!el || el.type !== 'date') return;
      if (k === 'dgCut' && !dg) { if (el.value && el.value === was.dgCut) el.value = ''; return; }
      if (!el.value || el.value === was[k]) { if (el.value !== plan[k]) { el.value = plan[k]; flashField(el); moved.push(k); } }
      else if (el.value !== plan[k]) kept.push(k);
    });
    showCutHint(form, plan, kept, dg);
  }
  function showCutHint(form, plan, kept, dg) {
    const field = (k) => form.querySelector('[name="' + k + '"]');
    form._cut = plan;
    const grid = field('etd') && field('etd').closest('.fgrid'); if (!grid) return;
    let hint = form.querySelector('.cut-hint');
    if (!hint) { hint = document.createElement('p'); hint.className = 'cut-hint'; grid.after(hint); }
    const name = { edCut: 'ED cutoff', siCut: 'SI cutoff', dgCut: 'DG cutoff' };
    const day = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); return m ? fmt(new Date(+m[1], +m[2] - 1, +m[3])) : v; };
    hint.innerHTML = icon('clock', 14) + '<span>Cutoffs worked out from ETD: ED − 2 days, SI − ' + (dg ? 5 : 4) + ' days' + (dg ? ', DG − 5 days' : '') + '. ' +
      (kept.length ? kept.map((k) => 'Kept the ' + name[k] + ' you typed — <button type="button" class="link-btn" data-cut-use="' + k + '" data-v="' + plan[k] + '">use ' + day(plan[k]) + '</button>.').join(' ') + ' '
        : 'Change any date if the line’s cutoff differs.') + '</span>';
  }
  function autoPortFree(form) {
    if (formType(form) !== 'SFIF') return;
    const dg = form.querySelector('[name="dg"]'), eta = form.querySelector('[name="eta"]'), pf = form.querySelector('[name="portFree"]');
    if (!pf || !eta || !eta.value || (dg && dg.value === 'DG') || pf.value) return;
    pf.value = '9'; flashField(pf);
  }

  // ================================================================ v2.7 — wiring
  let slimRaf = 0;
  function initV27() {
    const view = $('#view');
    view.addEventListener('scroll', () => { if (state.route && state.route.name === 'costjob' && !slimRaf) slimRaf = requestAnimationFrame(() => { slimRaf = 0; costSlimSync(); }); }, { passive: true });
    view.addEventListener('click', (e) => {
      const r = state.route; if (!r || r.name !== 'notif') return;
      if (e.target.closest('[data-act="notif-more"]')) { notifOlder(); return; }
      const q = e.target.closest('[data-enq]'); if (q) { const id = q.dataset.enq; go('#/enquiries'); setTimeout(() => openEnquiry(id), 40); }
    });
    $('#drawerBody').addEventListener('click', (e) => {
      const u = e.target.closest('[data-cut-use]'); if (!u || state.overlay !== 'form') return;
      const f = u.closest('form'), el = f && f.querySelector('[name="' + u.dataset.cutUse + '"]'); if (!el) return;
      el.value = u.dataset.v; flashField(el);
      const dg = (f.querySelector('[name="dg"]') || {}).value === 'DG', plan = f._cut || {};
      const kept = ['edCut', 'siCut', 'dgCut'].filter((k) => { const x = f.querySelector('[name="' + k + '"]'); return x && x.value && plan[k] && x.value !== plan[k] && (k !== 'dgCut' || dg); });
      showCutHint(f, plan, kept, dg);
    });
    $('#drawerBody').addEventListener('change', (e) => {
      if (state.overlay !== 'form') return;
      const f = e.target.form; if (!f || (f.id !== 'jobForm' && f.id !== 'editForm')) return;
      if (['etd', 'dg', 'type'].includes(e.target.name)) autoCuts(f);
      if (['eta', 'dg'].includes(e.target.name)) autoPortFree(f);
    });
  }

  // ================================================================ wiring
  // Leaving a costing with unsaved changes asks first.
  function leaveGuard() {
    const C = state.cost, r = state.route;
    if (!C || !C.dirty || !r || r.name !== 'costjob' || String(r.jobNo).toUpperCase() !== C.no) return false;
    const target = location.hash, here = '#/costing/' + encodeURIComponent(r.jobNo);
    if (decodeURIComponent(target) === decodeURIComponent(here)) return false;
    history.replaceState(null, '', here);
    ask({ title: 'Leave without saving?', text: 'Your changes to this costing are not saved yet.', yes: 'Leave', no: 'Stay' }).then((leave) => {
      if (!leave) return;
      state.cost = null;
      location.hash = target;
    });
    return true;
  }
  function initV26() {
    const view = $('#view');
    // costing stop, its MARK DONE, the Home "COSTING DUE" tile → the costing page
    view.addEventListener('click', (e) => {
      const r = state.route;
      const st = e.target.closest('[data-stop="costing"]');
      if (st && r && r.name === 'job') { const j = findJob(r.jobNo); if (j && canCostSee(j)) { e.stopImmediatePropagation(); go('#/costing/' + encodeURIComponent(j.jobNo)); } }
    }, true);
    document.addEventListener('click', (e) => {
      const c = e.target.closest('[data-cost]');
      if (c && state.signedIn) { e.preventDefault(); closeOverlays(true); go('#/costing/' + encodeURIComponent(c.dataset.cost)); }
    });
    view.addEventListener('click', (e) => {
      const r = state.route; if (!r) return;
      if (r.name === 'job' && e.target.closest('[data-act="duplicate"]')) { duplicateJob(r.jobNo); return; }
      if (r.name === 'costing') {
        const tb = e.target.closest('[data-cost-tab]'); if (tb) { state.costUi.tab = tb.dataset.costTab; rerender(); return; }
        return;
      }
      if (r.name !== 'costjob') return;
      const j = findJob(r.jobNo); const C = j && costFor(j.jobNo);
      if (e.target.closest('[data-act="back"]')) { if (state.navDepth > 0) history.back(); else go('#/costing'); return; }
      if (!j) return;
      if (e.target.closest('[data-act="cost-retry"]')) { state.cost = null; rerender(); return; }
      if (!C || !C.draft) return;
      if (e.target.closest('[data-act="cost-save"]')) { saveCost(j); return; }
      if (e.target.closest('[data-act="cost-done"]')) { costDone(j); return; }
      if (e.target.closest('[data-act="cost-unlock"]')) { costUnlock(j); return; }
      if (e.target.closest('[data-act="cost-xlsx"]')) { exportCost(j); return; }
      if (e.target.closest('[data-act="cost-log"]')) { C.showLog = !C.showLog; rerender(); return; }
      if (e.target.closest('[data-act="cost-add"]')) { addCostLine(j, ''); return; }
      const qc = e.target.closest('[data-quick-charge]'); if (qc) { addCostLine(j, qc.dataset.quickCharge); return; }
      const un = e.target.closest('[data-unnote]'); if (un) { C.draft.notes.splice(+un.dataset.unnote, 1); C.dirty = C.dirty || true; rerender(); return; }
      if (!costCanEdit(j, C.data)) return;
      const cur = e.target.closest('[data-cur]');
      if (cur) {
        const row = cur.closest('[data-line]'); const l = C.draft.lines.find((x) => x.id === row.dataset.line); if (!l) return;
        const k = cur.dataset.cur.charAt(0);
        setCur(l, k, l[k + 'c'] === 'USD' ? 'AED' : 'USD');
        C.dirty = true; rerender();
        const r = document.getElementById('cl_' + l.id + '_' + k + (l[k + 'c'] === 'USD' ? 'x' : 'r')); if (r) r.focus();
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        const i = C.draft.lines.findIndex((x) => x.id === del.dataset.del); if (i < 0) return;
        const gone = C.draft.lines.splice(i, 1)[0]; C.dirty = true; rerender();
        if (gone.charge || gone.br || gone.sr) toast('Removed ' + (gone.charge || 'the line'), { action: { label: 'Undo', fn: () => { const C2 = costFor(j.jobNo); if (!C2) return; C2.draft.lines.splice(Math.min(i, C2.draft.lines.length), 0, gone); C2.dirty = true; rerender(); } } });
      }
    });
    view.addEventListener('input', (e) => {
      const r = state.route; if (!r) return;
      if (r.name === 'costing' && e.target.id === 'costSearch') { state.costUi.q = e.target.value; state.costFocus = true; rerender(); state.costFocus = false; return; }
      if (r.name !== 'costjob') return;
      const f = e.target.dataset && e.target.dataset.f; if (!f) return;
      const row = e.target.closest('[data-line]'); const j = findJob(r.jobNo); const C = j && costFor(j.jobNo); if (!row || !C || !C.draft) return;
      const l = C.draft.lines.find((x) => x.id === row.dataset.line); if (!l) return;
      if (f === 'basis') return;
      l[f] = e.target.value;
      if (['qty', 'br', 'sr'].includes(f)) e.target.classList.toggle('is-bad', isNaN(num6(e.target.value)));
      if (f === 'bx' || f === 'sx') { e.target.classList.toggle('is-bad', !!e.target.value.trim() && !fxOk(e.target.value)); if (f === 'bx') l.bxAuto = false; }
      costDirty(j);
    });
    view.addEventListener('change', (e) => {
      const r = state.route; if (!r || r.name !== 'costjob') return;
      const f = e.target.dataset && e.target.dataset.f; if (!f) return;
      const row = e.target.closest('[data-line]'); const j = findJob(r.jobNo); const C = j && costFor(j.jobNo); if (!row || !C || !C.draft) return;
      const l = C.draft.lines.find((x) => x.id === row.dataset.line); if (!l) return;
      if (f === 'basis') { l.basis = e.target.value; l.qty = costQtyFor(j, l.basis, l.qty); const q = document.getElementById('cl_' + l.id + '_qty'); if (q) q.value = l.qty; costDirty(j); return; }
      if (f === 'charge') {
        const was = l.charge;
        l.charge = upq(e.target.value); e.target.value = l.charge;
        if (l.charge && l.charge !== was) {
          const before = JSON.stringify(l), extra = chargeRule(j, l);
          if (extra) C.draft.lines.splice(C.draft.lines.indexOf(l) + 1, 0, extra);
          if (extra || JSON.stringify(l) !== before) { C.dirty = true; rerender(); const r = document.getElementById('cl_' + l.id + '_br'); if (r) r.focus(); }
        }
      }
      if (f === 'vendor') { l.vendor = upq(e.target.value); e.target.value = l.vendor; if (vendorRule(l)) { C.dirty = true; rerender(); } }
    });
    view.addEventListener('submit', (e) => {
      const fm = e.target.closest('[data-act="cost-note"]'); if (!fm) return;
      e.preventDefault();
      const r = state.route; const j = r && findJob(r.jobNo); const C = j && costFor(j.jobNo); if (!C || !C.draft) return;
      const inp = $('#costNote'); const t = inp.value.trim(); if (!t) return;
      C.draft.notes.unshift(t.slice(0, 500)); C.dirty = true; inp.value = ''; rerender();
      toast('Note added — it is saved with the costing');
    });
    view.addEventListener('keydown', (e) => {
      const r = state.route; if (!r || r.name !== 'costjob') return;
      if (e.key === 'Enter' && e.target.dataset && e.target.dataset.f === 'sr') {
        const j = findJob(r.jobNo), C = j && costFor(j.jobNo); if (!C) return;
        const row = e.target.closest('[data-line]'); const lines = C.draft.lines;
        if (row && lines.length && lines[lines.length - 1].id === row.dataset.line) { e.preventDefault(); addCostLine(j, ''); }
      }
    });
    document.addEventListener('keydown', (e) => {
      if (!state.signedIn || !(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 's') return;
      const r = state.route; if (!r || r.name !== 'costjob') return;
      e.preventDefault();
      const j = findJob(r.jobNo); if (j) saveCost(j);
    });
    // the suggestions under list boxes follow what is typed
    const LISTS = ['dlCustomers', 'dlVendors', 'dlPorts', 'dlCharges', 'dlSales'];
    const onList = (e) => { const t = e.target; if (t && t.tagName === 'INPUT' && LISTS.includes(t.getAttribute('list'))) fillList(t); };
    document.addEventListener('input', onList, true);
    document.addEventListener('focusin', onList, true);
    window.addEventListener('beforeunload', (e) => { if (state.cost && state.cost.dirty) { e.preventDefault(); e.returnValue = ''; } });
    initV27();
    initV28();
    initV291();
  }

  // ================================================================ v2.8 — port clocks (office hours where the port is)
  // [pattern, time zone, country]. Port names come from the tracker as typed (and the remembered PORTS list).
  const PORT_TZ = [
    [/KHALIFA BIN SALMAN|BAHRAIN|MANAMA|\bBAH\b/, 'Asia/Bahrain', 'BH'],
    [/JEBEL ALI|\bJEA\b|DUBAI|\bDXB\b|\bDWC\b|ABU DHABI|\bAUH\b|KHALIFA|MINA ZAYED|KHOR ?FAKKAN|SHARJAH|\bSHJ\b|AJMAN|FUJAIRAH|RAS AL KHAIMAH|\bRAK\b|SAQR|HAMRIYAH|U\.?A\.?E\b|EMIRATES/, 'Asia/Dubai', 'AE'],
    [/SOHAR|SALALAH|MUSCAT|\bMCT\b|DUQM|SULTAN QABOOS|\bOMAN\b/, 'Asia/Muscat', 'OM'],
    [/JEDDAH|\bJED\b|DAMMAM|\bDMM\b|RIYADH|\bRUH\b|JUBAIL|KING ABDULLAH|YANBU|SAUDI|\bKSA\b/, 'Asia/Riyadh', 'SA'],
    [/HAMAD|DOHA|\bDOH\b|QATAR/, 'Asia/Qatar', 'QA'],
    [/SHUWAIKH|SHUAIBA|KUWAIT|\bKWI\b/, 'Asia/Kuwait', 'KW'],
    [/UMM QASR|BASRA|BAGHDAD|IRAQ|ERBIL/, 'Asia/Baghdad', 'IQ'],
    [/BANDAR ABBAS|BUSHEHR|IRAN/, 'Asia/Tehran', 'IR'],
    [/AQABA|AMMAN|JORDAN/, 'Asia/Amman', 'JO'],
    [/SOKHNA|PORT SAID|ALEXANDRIA|DAMIETTA|CAIRO|EGYPT/, 'Africa/Cairo', 'EG'],
    [/\bADEN\b|HODEIDAH|YEMEN/, 'Asia/Aden', 'YE'],
    [/HAIFA|ASHDOD|ISRAEL/, 'Asia/Jerusalem', 'IL'],
    [/BEIRUT|LEBANON/, 'Asia/Beirut', 'LB'],
    [/LIMASSOL|CYPRUS/, 'Asia/Nicosia', 'CY'],
    [/KARACHI|\bKHI\b|QASIM|LAHORE|\bLHE\b|ISLAMABAD|SIALKOT|FAISALABAD|PAKISTAN/, 'Asia/Karachi', 'PK'],
    [/NHAVA ?SHEVA|JNPT|MUNDRA|HAZIRA|COCHIN|KOCHI|\bCOK\b|CHENNAI|MADRAS|\bMAA\b|TUTICORIN|VIZAG|VISAKHAPATNAM|KOLKATA|CALCUTTA|\bCCU\b|HALDIA|MUMBAI|BOMBAY|\bBOM\b|PIPAVAV|KANDLA|MANGALORE|DELHI|\bDEL\b|\bICD\b|BANGALORE|BENGALURU|\bBLR\b|HYDERABAD|\bHYD\b|AHMEDABAD|\bAMD\b|PUNE|KATTUPALLI|ENNORE|KRISHNAPATNAM|LUDHIANA|TIRUPUR|INDIA/, 'Asia/Kolkata', 'IN'],
    [/COLOMBO|\bCMB\b|SRI LANKA/, 'Asia/Colombo', 'LK'],
    [/CHITTAGONG|CHATTOGRAM|DHAKA|\bDAC\b|BANGLADESH/, 'Asia/Dhaka', 'BD'],
    [/\bMALE\b|MALDIVES/, 'Indian/Maldives', 'MV'],
    [/HONG ?KONG|\bHKG\b/, 'Asia/Hong_Kong', 'HK'],
    [/KAOHSIUNG|KEELUNG|TAIPEI|TAICHUNG|TAIWAN/, 'Asia/Taipei', 'TW'],
    [/SHANGHAI|\bPVG\b|NINGBO|SHENZHEN|\bSZX\b|SHEKOU|SHOKOU|YANTIAN|CHIWAN|QINGDAO|\bTAO\b|DALIAN|TIANJIN|XINGANG|XIAMEN|GUANGZHOU|\bCAN\b|NANSHA|HUANGPU|WUHAN|CHONGQING|FUZHOU|LIANYUNGANG|NANJING|TAICANG|ZHUHAI|BEIJING|\bPEK\b|SHANTOU|JIANGMEN|FOSHAN|ZHONGSHAN|DONGGUAN|CHINA/, 'Asia/Shanghai', 'CN'],
    [/BUSAN|PUSAN|INCHEON|\bICN\b|GWANGYANG|KOREA/, 'Asia/Seoul', 'KR'],
    [/TOKYO|\bNRT\b|\bHND\b|YOKOHAMA|KOBE|OSAKA|NAGOYA|HAKATA|JAPAN/, 'Asia/Tokyo', 'JP'],
    [/SINGAPORE|\bSIN\b/, 'Asia/Singapore', 'SG'],
    [/PORT ?KELANG|PORT ?KLANG|\bKELANG\b|PASIR ?GUDANG|TANJUNG PELEPAS|PENANG|KUALA LUMPUR|\bKUL\b|MALAYSIA/, 'Asia/Kuala_Lumpur', 'MY'],
    [/LAEM CHABANG|BANGKOK|\bBKK\b|LAT KRABANG|THAILAND/, 'Asia/Bangkok', 'TH'],
    [/HO CHI MINH|HAIPHONG|HAI PHONG|CAT LAI|DA NANG|CAI MEP|VIETNAM/, 'Asia/Ho_Chi_Minh', 'VN'],
    [/JAKARTA|TANJUNG PRIOK|SURABAYA|SEMARANG|INDONESIA/, 'Asia/Jakarta', 'ID'],
    [/MANILA|CEBU|PHILIPPINES/, 'Asia/Manila', 'PH'],
    [/SYDNEY|NEWCASTLE AU/, 'Australia/Sydney', 'AU'], [/MELBOURNE/, 'Australia/Melbourne', 'AU'], [/BRISBANE/, 'Australia/Brisbane', 'AU'], [/FREMANTLE|PERTH/, 'Australia/Perth', 'AU'], [/ADELAIDE/, 'Australia/Adelaide', 'AU'],
    [/AUCKLAND|TAURANGA|NEW ZEALAND/, 'Pacific/Auckland', 'NZ'],
    [/DAR ES SALAAM|TANZANIA|ZANZIBAR/, 'Africa/Dar_es_Salaam', 'TZ'],
    [/MOMBASA|NAIROBI|KENYA/, 'Africa/Nairobi', 'KE'],
    [/DJIBOUTI/, 'Africa/Djibouti', 'DJ'], [/BERBERA|MOGADISHU|SOMALI/, 'Africa/Mogadishu', 'SO'], [/PORT SUDAN|KHARTOUM|SUDAN/, 'Africa/Khartoum', 'SD'],
    [/DOUALA|KRIBI|CAMEROON/, 'Africa/Douala', 'CM'], [/\bLOME\b|TOGO/, 'Africa/Lome', 'TG'], [/TIN ?CAN|APAPA|LAGOS|\bONNE\b|NIGERIA/, 'Africa/Lagos', 'NG'],
    [/\bTEMA\b|TAKORADI|GHANA/, 'Africa/Accra', 'GH'], [/ABIDJAN|IVORY|COTE D/, 'Africa/Abidjan', 'CI'], [/COTONOU|BENIN/, 'Africa/Porto-Novo', 'BJ'],
    [/DURBAN|CAPE TOWN|JOHANNESBURG|SOUTH AFRICA/, 'Africa/Johannesburg', 'ZA'], [/MAPUTO|BEIRA|MOZAMBIQUE/, 'Africa/Maputo', 'MZ'], [/LUANDA|ANGOLA/, 'Africa/Luanda', 'AO'],
    [/MISRATA|MISURATA|MISRATAH|TRIPOLI|BENGHAZI|KHOMS|LIBYA/, 'Africa/Tripoli', 'LY'], [/CASABLANCA|TANGER|MOROCCO/, 'Africa/Casablanca', 'MA'], [/ALGIERS|ORAN|ALGERIA/, 'Africa/Algiers', 'DZ'], [/TUNIS|RADES/, 'Africa/Tunis', 'TN'],
    [/ROTTERDAM|AMSTERDAM|\bAMS\b|NETHERLANDS|HOLLAND/, 'Europe/Amsterdam', 'NL'], [/ANTWERP|ZEEBRUGGE|BELGIUM/, 'Europe/Brussels', 'BE'],
    [/HAMBURG|BREMERHAVEN|FRANKFURT|\bFRA\b|GERMANY/, 'Europe/Berlin', 'DE'], [/LONDON|FELIXSTOWE|SOUTHAMPTON|TILBURY|LIVERPOOL|\bLHR\b|IMMINGHAM|\bUK\b|UNITED KINGDOM|ENGLAND/, 'Europe/London', 'GB'],
    [/LE HAVRE|\bFOS\b|MARSEILLE|PARIS|\bCDG\b|FRANCE/, 'Europe/Paris', 'FR'], [/GENOVA|GENOA|LA SPEZIA|LIVORNO|NAPLES|NAPOLI|GIOIA TAURO|TRIESTE|VENICE|MILAN|SALERNO|RAVENNA|ITALY/, 'Europe/Rome', 'IT'],
    [/VALENCIA|BARCELONA|ALGECIRAS|MADRID|BILBAO|SPAIN/, 'Europe/Madrid', 'ES'], [/PIRAEUS|THESSALONIKI|GREECE/, 'Europe/Athens', 'GR'], [/LISBON|SINES|LEIXOES|PORTUGAL/, 'Europe/Lisbon', 'PT'],
    [/ISTANBUL|\bIST\b|AMBARLI|MERSIN|IZMIR|GEMLIK|KOCAELI|TURKEY|TURKIYE/, 'Europe/Istanbul', 'TR'], [/CONSTANTA|CONSTANTZA|ROMANIA/, 'Europe/Bucharest', 'RO'], [/VARNA|BURGAS|BULGARIA/, 'Europe/Sofia', 'BG'],
    [/NOVOROSSIYSK|\bNOVO\b|ST\.? PETERSBURG|SAINT PETERSBURG|MOSCOW|VLADIVOSTOK|RUSSIA/, 'Europe/Moscow', 'RU'], [/ODESSA|ODESA|UKRAINE/, 'Europe/Kyiv', 'UA'], [/POTI|BATUMI|GEORGIA/, 'Asia/Tbilisi', 'GE'],
    [/HELSINGBORG|GOTHENBURG|GOTEBORG|STOCKHOLM|MALMO|SWEDEN/, 'Europe/Stockholm', 'SE'], [/AARHUS|COPENHAGEN|DENMARK/, 'Europe/Copenhagen', 'DK'], [/\bOSLO\b|NORWAY/, 'Europe/Oslo', 'NO'],
    [/HELSINKI|KOTKA|FINLAND/, 'Europe/Helsinki', 'FI'], [/GDANSK|GDYNIA|POLAND/, 'Europe/Warsaw', 'PL'], [/KOPER|SLOVENIA/, 'Europe/Ljubljana', 'SI'], [/RIJEKA|CROATIA/, 'Europe/Zagreb', 'HR'],
    [/\bRIGA\b|LATVIA/, 'Europe/Riga', 'LV'], [/KLAIPEDA|LITHUANIA/, 'Europe/Vilnius', 'LT'], [/TALLINN|MUUGA|ESTONIA/, 'Europe/Tallinn', 'EE'], [/MALTA|MARSAXLOKK|VALLETTA/, 'Europe/Malta', 'MT'],
    [/NEW YORK|NEWARK|NEW JERSEY|\bJFK\b|\bEWR\b|BALTIMORE|PHILADELPHIA|NORFOLK|CHARLESTON|SAVANNAH|MIAMI|\bMIA\b|JACKSONVILLE|BOSTON|ATLANTA|\bATL\b|WILMINGTON/, 'America/New_York', 'US'],
    [/HOUSTON|\bIAH\b|NEW ORLEANS|DALLAS|CHICAGO|\bORD\b|MOBILE|MEMPHIS/, 'America/Chicago', 'US'], [/LOS ANGELES|\bLAX\b|LONG BEACH|OAKLAND|SEATTLE|TACOMA|SAN FRANCISCO|PORTLAND/, 'America/Los_Angeles', 'US'],
    [/HALIFAX/, 'America/Halifax', 'CA'], [/MONTREAL|TORONTO|\bYYZ\b/, 'America/Toronto', 'CA'], [/VANCOUVER|PRINCE RUPERT/, 'America/Vancouver', 'CA'],
    [/ENSENADA|\bMXESE\b|TIJUANA|\bMXTIJ\b|MEXICALI|BAJA CALIFORNIA(?! SUR)/, 'America/Tijuana', 'MX'], [/MAZATLAN|LA PAZ MX|BAJA CALIFORNIA SUR|CABO SAN LUCAS|TOPOLOBAMPO/, 'America/Mazatlan', 'MX'], [/GUAYMAS|HERMOSILLO|SONORA/, 'America/Hermosillo', 'MX'],
    [/MANZANILLO|VERACRUZ|LAZARO CARDENAS|ALTAMIRA|TAMPICO|PROGRESO|COATZACOALCOS|MONTERREY|GUADALAJARA|MEXICO/, 'America/Mexico_City', 'MX'], [/SANTOS|RIO DE JANEIRO|PARANAGUA|SAO PAULO|ITAJAI|BRAZIL/, 'America/Sao_Paulo', 'BR'],
    [/BUENOS AIRES|ARGENTINA/, 'America/Argentina/Buenos_Aires', 'AR'], [/CALLAO|\bLIMA\b|PERU/, 'America/Lima', 'PE'], [/CARTAGENA|BUENAVENTURA|COLOMBIA/, 'America/Bogota', 'CO'],
    [/SAN ANTONIO CL|VALPARAISO|CHILE/, 'America/Santiago', 'CL'], [/\bCOLON\b|BALBOA|PANAMA/, 'America/Panama', 'PA'], [/GUAYAQUIL|ECUADOR/, 'America/Guayaquil', 'EC'], [/KINGSTON|JAMAICA/, 'America/Jamaica', 'JM'],
    // v2.9.2: more ports
    [/HONOLULU|HAWAII/, 'Pacific/Honolulu', 'US'], [/ANCHORAGE|ALASKA/, 'America/Anchorage', 'US'], [/DENVER|SALT LAKE/, 'America/Denver', 'US'], [/PHOENIX/, 'America/Phoenix', 'US'],
    [/SAN DIEGO|LAS VEGAS/, 'America/Los_Angeles', 'US'], [/TAMPA|PORT EVERGLADES|ORLANDO|DETROIT|CLEVELAND|PITTSBURGH|WASHINGTON|\bIAD\b|CHARLOTTE/, 'America/New_York', 'US'], [/KANSAS CITY|MINNEAPOLIS|ST\.? LOUIS|GALVESTON|CORPUS CHRISTI|FREEPORT TX/, 'America/Chicago', 'US'],
    [/CALGARY|EDMONTON/, 'America/Edmonton', 'CA'], [/WINNIPEG/, 'America/Winnipeg', 'CA'], [/SAINT JOHN|\bST\.? JOHN NB/, 'America/Moncton', 'CA'],
    [/PUERTO CORTES|SAN PEDRO SULA|TEGUCIGALPA|HONDURAS/, 'America/Tegucigalpa', 'HN'], [/SANTO TOMAS|PUERTO QUETZAL|PUERTO BARRIOS|GUATEMALA/, 'America/Guatemala', 'GT'], [/PUERTO LIMON|\bMOIN\b|CALDERA|SAN JOSE CR|COSTA RICA/, 'America/Costa_Rica', 'CR'],
    [/ACAJUTLA|SAN SALVADOR|EL SALVADOR/, 'America/El_Salvador', 'SV'], [/CORINTO|MANAGUA|NICARAGUA/, 'America/Managua', 'NI'], [/BELIZE/, 'America/Belize', 'BZ'],
    [/CAUCEDO|RIO HAINA|SANTO DOMINGO|DOMINICAN/, 'America/Santo_Domingo', 'DO'], [/PORT OF SPAIN|POINT LISAS|TRINIDAD/, 'America/Port_of_Spain', 'TT'], [/SAN JUAN|PUERTO RICO/, 'America/Puerto_Rico', 'PR'],
    [/BRIDGETOWN|BARBADOS/, 'America/Barbados', 'BB'], [/NASSAU|FREEPORT|BAHAMAS/, 'America/Nassau', 'BS'], [/HAVANA|MARIEL|CUBA/, 'America/Havana', 'CU'], [/PORT.AU.PRINCE|HAITI/, 'America/Port-au-Prince', 'HT'],
    [/WILLEMSTAD|CURACAO/, 'America/Curacao', 'CW'], [/ORANJESTAD|ARUBA/, 'America/Aruba', 'AW'], [/POINTE.A.PITRE|GUADELOUPE/, 'America/Guadeloupe', 'GP'], [/FORT.DE.FRANCE|MARTINIQUE/, 'America/Martinique', 'MQ'],
    [/MONTEVIDEO|URUGUAY/, 'America/Montevideo', 'UY'], [/ASUNCION|PARAGUAY/, 'America/Asuncion', 'PY'], [/LA GUAIRA|PUERTO CABELLO|CARACAS|VENEZUELA/, 'America/Caracas', 'VE'],
    [/GEORGETOWN GY|GUYANA/, 'America/Guyana', 'GY'], [/PARAMARIBO|SURINAME/, 'America/Paramaribo', 'SR'], [/\bARICA\b|IQUIQUE|ANTOFAGASTA|SAN ANTONIO|SANTIAGO CL/, 'America/Santiago', 'CL'],
    [/MANAUS/, 'America/Manaus', 'BR'], [/RIO GRANDE|NAVEGANTES|PECEM|SUAPE|SALVADOR BR|VITORIA|FORTALEZA|RECIFE|ITAPOA|SAO FRANCISCO DO SUL/, 'America/Sao_Paulo', 'BR'], [/PAITA/, 'America/Lima', 'PE'], [/BARRANQUILLA|SANTA MARTA|BOGOTA/, 'America/Bogota', 'CO'],
    [/DAKAR|SENEGAL/, 'Africa/Dakar', 'SN'], [/CONAKRY/, 'Africa/Conakry', 'GN'], [/FREETOWN|SIERRA LEONE/, 'Africa/Freetown', 'SL'], [/MONROVIA|LIBERIA/, 'Africa/Monrovia', 'LR'], [/BANJUL|GAMBIA/, 'Africa/Banjul', 'GM'],
    [/NOUAKCHOTT|NOUADHIBOU|MAURITANIA/, 'Africa/Nouakchott', 'MR'], [/BISSAU/, 'Africa/Bissau', 'GW'], [/PRAIA|CAPE VERDE|CABO VERDE/, 'Atlantic/Cape_Verde', 'CV'], [/SAN PEDRO CI/, 'Africa/Abidjan', 'CI'],
    [/LOBITO|NAMIBE/, 'Africa/Luanda', 'AO'], [/POINTE.NOIRE|BRAZZAVILLE|CONGO REP/, 'Africa/Brazzaville', 'CG'], [/MATADI|KINSHASA|\bBOMA\b|\bDRC\b|CONGO/, 'Africa/Kinshasa', 'CD'], [/LUBUMBASHI/, 'Africa/Lubumbashi', 'CD'],
    [/LIBREVILLE|OWENDO|GABON/, 'Africa/Libreville', 'GA'], [/MALABO|\bBATA\b|EQUATORIAL GUINEA/, 'Africa/Malabo', 'GQ'], [/PORT LOUIS|MAURITIUS/, 'Indian/Mauritius', 'MU'], [/TOAMASINA|TAMATAVE|ANTANANARIVO|MADAGASCAR/, 'Indian/Antananarivo', 'MG'],
    [/WALVIS BAY|WINDHOEK|NAMIBIA/, 'Africa/Windhoek', 'NA'], [/NACALA/, 'Africa/Maputo', 'MZ'], [/PORT ELIZABETH|NGQURA|GQEBERHA|EAST LONDON|RICHARDS BAY/, 'Africa/Johannesburg', 'ZA'],
    [/KAMPALA|UGANDA/, 'Africa/Kampala', 'UG'], [/KIGALI|RWANDA/, 'Africa/Kigali', 'RW'], [/ADDIS ABABA|ETHIOPIA/, 'Africa/Addis_Ababa', 'ET'], [/MASSAWA|ASMARA|ERITREA/, 'Africa/Asmara', 'ER'],
    [/LUSAKA|ZAMBIA/, 'Africa/Lusaka', 'ZM'], [/HARARE|ZIMBABWE/, 'Africa/Harare', 'ZW'], [/LILONGWE|BLANTYRE|MALAWI/, 'Africa/Blantyre', 'MW'], [/\bMAHE\b|SEYCHELLES/, 'Indian/Mahe', 'SC'], [/MORONI|COMOROS/, 'Indian/Comoro', 'KM'],
    [/LATAKIA|TARTUS|DAMASCUS|SYRIA/, 'Asia/Damascus', 'SY'], [/CHABAHAR|BANDAR IMAM/, 'Asia/Tehran', 'IR'], [/KABUL|AFGHANISTAN/, 'Asia/Kabul', 'AF'],
    [/TASHKENT|UZBEKISTAN/, 'Asia/Tashkent', 'UZ'], [/ALMATY|ASTANA|AKTAU|KAZAKHSTAN/, 'Asia/Almaty', 'KZ'], [/\bBAKU\b|\bALAT\b|AZERBAIJAN/, 'Asia/Baku', 'AZ'], [/TURKMENBASHI|ASHGABAT|TURKMENISTAN/, 'Asia/Ashgabat', 'TM'], [/YEREVAN|ARMENIA/, 'Asia/Yerevan', 'AM'], [/BISHKEK|KYRGYZ/, 'Asia/Bishkek', 'KG'], [/DUSHANBE|TAJIKISTAN/, 'Asia/Dushanbe', 'TJ'],
    [/KATHMANDU|BIRGUNJ|NEPAL/, 'Asia/Kathmandu', 'NP'], [/THIMPHU|BHUTAN/, 'Asia/Thimphu', 'BT'], [/YANGON|RANGOON|MYANMAR/, 'Asia/Yangon', 'MM'], [/SIHANOUKVILLE|PHNOM PENH|CAMBODIA/, 'Asia/Phnom_Penh', 'KH'], [/VIENTIANE|\bLAOS\b/, 'Asia/Vientiane', 'LA'],
    [/MUARA|BRUNEI/, 'Asia/Brunei', 'BN'], [/\bDILI\b|TIMOR/, 'Asia/Dili', 'TL'], [/KUCHING|BINTULU|KOTA KINABALU|SABAH|SARAWAK/, 'Asia/Kuching', 'MY'], [/MAKASSAR|BALIKPAPAN|\bBALI\b|DENPASAR/, 'Asia/Makassar', 'ID'], [/BELAWAN|MEDAN|BATAM|PALEMBANG/, 'Asia/Jakarta', 'ID'],
    [/DAVAO|SUBIC|BATANGAS/, 'Asia/Manila', 'PH'], [/SONGKHLA/, 'Asia/Bangkok', 'TH'], [/QUY NHON|VUNG TAU/, 'Asia/Ho_Chi_Minh', 'VN'], [/ULSAN|PYEONGTAEK/, 'Asia/Seoul', 'KR'], [/MOJI|SHIMIZU|SENDAI|HIROSHIMA/, 'Asia/Tokyo', 'JP'], [/TAOYUAN|TAIPEI/, 'Asia/Taipei', 'TW'],
    [/QINZHOU|BEIHAI|FANGCHENG|YINGKOU|RIZHAO|YANTAI|WEIHAI|ZHANGJIAGANG|JIANGYIN|NANTONG|WENZHOU|TAIZHOU|ZHAPU|KUNMING|CHENGDU|XIAN|ZHENGZHOU|HEFEI|CHANGSHA/, 'Asia/Shanghai', 'CN'], [/MACAU|MACAO/, 'Asia/Macau', 'MO'],
    [/DARWIN/, 'Australia/Darwin', 'AU'], [/TOWNSVILLE|GLADSTONE/, 'Australia/Brisbane', 'AU'], [/HOBART|BELL BAY|TASMANIA/, 'Australia/Hobart', 'AU'], [/LYTTELTON|CHRISTCHURCH|NAPIER|WELLINGTON|PORT CHALMERS/, 'Pacific/Auckland', 'NZ'],
    [/PORT MORESBY|\bLAE\b|PAPUA/, 'Pacific/Port_Moresby', 'PG'], [/\bSUVA\b|LAUTOKA|FIJI/, 'Pacific/Fiji', 'FJ'], [/NOUMEA|NEW CALEDONIA/, 'Pacific/Noumea', 'NC'], [/PAPEETE|TAHITI/, 'Pacific/Tahiti', 'PF'], [/\bAPIA\b|SAMOA/, 'Pacific/Apia', 'WS'], [/GUAM/, 'Pacific/Guam', 'GU'],
    [/DUBLIN|\bCORK\b|IRELAND/, 'Europe/Dublin', 'IE'], [/BELFAST|GRANGEMOUTH|GLASGOW|EDINBURGH|BRISTOL|PORTSMOUTH|MANCHESTER|BIRMINGHAM|LONDON GATEWAY|HULL/, 'Europe/London', 'GB'], [/REYKJAVIK|ICELAND/, 'Atlantic/Reykjavik', 'IS'],
    [/ZURICH|BASEL|GENEVA|SWITZERLAND/, 'Europe/Zurich', 'CH'], [/VIENNA|LINZ|AUSTRIA/, 'Europe/Vienna', 'AT'], [/PRAGUE|CZECH/, 'Europe/Prague', 'CZ'], [/BUDAPEST|HUNGARY/, 'Europe/Budapest', 'HU'], [/BRATISLAVA|SLOVAKIA/, 'Europe/Bratislava', 'SK'],
    [/BELGRADE|SERBIA/, 'Europe/Belgrade', 'RS'], [/\bBAR\b|MONTENEGRO/, 'Europe/Podgorica', 'ME'], [/DURRES|TIRANA|ALBANIA/, 'Europe/Tirane', 'AL'], [/LUXEMBOURG/, 'Europe/Luxembourg', 'LU'], [/MINSK|BELARUS/, 'Europe/Minsk', 'BY'],
    [/DUISBURG|DUSSELDORF|COLOGNE|MUNICH|STUTTGART|LEIPZIG|BERLIN/, 'Europe/Berlin', 'DE'], [/DUNKIRK|DUNKERQUE|LYON/, 'Europe/Paris', 'FR'], [/TARRAGONA|LAS PALMAS|CANARY|SEVILLE|MALAGA/, 'Europe/Madrid', 'ES'], [/MOERDIJK|VLISSINGEN/, 'Europe/Amsterdam', 'NL'],
    [/\bUSA\b|UNITED STATES/, 'America/New_York', 'US'], [/CANADA/, 'America/Toronto', 'CA'], [/AUSTRALIA/, 'Australia/Sydney', 'AU']
  ];
  // UN/LOCODE country → zone, for ports typed as codes ("AEJEA", "JEBEL ALI (AEJEA)")
  const CC_TZ = { AE: 'Asia/Dubai', OM: 'Asia/Muscat', SA: 'Asia/Riyadh', QA: 'Asia/Qatar', KW: 'Asia/Kuwait', BH: 'Asia/Bahrain', IQ: 'Asia/Baghdad', IR: 'Asia/Tehran', JO: 'Asia/Amman', EG: 'Africa/Cairo', YE: 'Asia/Aden',
    PK: 'Asia/Karachi', IN: 'Asia/Kolkata', LK: 'Asia/Colombo', BD: 'Asia/Dhaka', MV: 'Indian/Maldives', CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', TW: 'Asia/Taipei', KR: 'Asia/Seoul', JP: 'Asia/Tokyo', SG: 'Asia/Singapore',
    MY: 'Asia/Kuala_Lumpur', TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', ID: 'Asia/Jakarta', PH: 'Asia/Manila', TZ: 'Africa/Dar_es_Salaam', KE: 'Africa/Nairobi', NG: 'Africa/Lagos', GH: 'Africa/Accra', CM: 'Africa/Douala',
    TG: 'Africa/Lome', ZA: 'Africa/Johannesburg', LY: 'Africa/Tripoli', MA: 'Africa/Casablanca', DZ: 'Africa/Algiers', DJ: 'Africa/Djibouti', SD: 'Africa/Khartoum', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', DE: 'Europe/Berlin',
    GB: 'Europe/London', FR: 'Europe/Paris', IT: 'Europe/Rome', ES: 'Europe/Madrid', GR: 'Europe/Athens', PT: 'Europe/Lisbon', TR: 'Europe/Istanbul', RO: 'Europe/Bucharest', BG: 'Europe/Sofia', RU: 'Europe/Moscow',
    UA: 'Europe/Kyiv', SE: 'Europe/Stockholm', DK: 'Europe/Copenhagen', NO: 'Europe/Oslo', FI: 'Europe/Helsinki', PL: 'Europe/Warsaw', US: 'America/New_York', CA: 'America/Toronto', MX: 'America/Mexico_City',
    BR: 'America/Sao_Paulo', AR: 'America/Argentina/Buenos_Aires', PE: 'America/Lima', CO: 'America/Bogota', CL: 'America/Santiago', PA: 'America/Panama', AU: 'Australia/Sydney', NZ: 'Pacific/Auckland', IL: 'Asia/Jerusalem', LB: 'Asia/Beirut',
    CY: 'Asia/Nicosia', CI: 'Africa/Abidjan', BJ: 'Africa/Porto-Novo', MZ: 'Africa/Maputo', AO: 'Africa/Luanda', SO: 'Africa/Mogadishu', TN: 'Africa/Tunis', HR: 'Europe/Zagreb', SI: 'Europe/Ljubljana', LV: 'Europe/Riga', LT: 'Europe/Vilnius',
    EE: 'Europe/Tallinn', MT: 'Europe/Malta', GE: 'Asia/Tbilisi', JM: 'America/Jamaica', EC: 'America/Guayaquil', HN: 'America/Tegucigalpa', GT: 'America/Guatemala', CR: 'America/Costa_Rica', SV: 'America/El_Salvador', NI: 'America/Managua',
    BZ: 'America/Belize', DO: 'America/Santo_Domingo', TT: 'America/Port_of_Spain', PR: 'America/Puerto_Rico', BB: 'America/Barbados', BS: 'America/Nassau', CU: 'America/Havana', HT: 'America/Port-au-Prince', CW: 'America/Curacao',
    AW: 'America/Aruba', UY: 'America/Montevideo', PY: 'America/Asuncion', VE: 'America/Caracas', GY: 'America/Guyana', SR: 'America/Paramaribo', SN: 'Africa/Dakar', GN: 'Africa/Conakry', SL: 'Africa/Freetown', LR: 'Africa/Monrovia',
    GM: 'Africa/Banjul', MR: 'Africa/Nouakchott', CV: 'Atlantic/Cape_Verde', CG: 'Africa/Brazzaville', CD: 'Africa/Kinshasa', GA: 'Africa/Libreville', GQ: 'Africa/Malabo', MU: 'Indian/Mauritius', MG: 'Indian/Antananarivo',
    NA: 'Africa/Windhoek', UG: 'Africa/Kampala', RW: 'Africa/Kigali', ET: 'Africa/Addis_Ababa', ER: 'Africa/Asmara', ZM: 'Africa/Lusaka', ZW: 'Africa/Harare', MW: 'Africa/Blantyre', SC: 'Indian/Mahe', KM: 'Indian/Comoro',
    SY: 'Asia/Damascus', AF: 'Asia/Kabul', UZ: 'Asia/Tashkent', KZ: 'Asia/Almaty', AZ: 'Asia/Baku', TM: 'Asia/Ashgabat', AM: 'Asia/Yerevan', KG: 'Asia/Bishkek', TJ: 'Asia/Dushanbe', NP: 'Asia/Kathmandu', BT: 'Asia/Thimphu',
    MM: 'Asia/Yangon', KH: 'Asia/Phnom_Penh', LA: 'Asia/Vientiane', BN: 'Asia/Brunei', TL: 'Asia/Dili', MO: 'Asia/Macau', PG: 'Pacific/Port_Moresby', FJ: 'Pacific/Fiji', NC: 'Pacific/Noumea', PF: 'Pacific/Tahiti', WS: 'Pacific/Apia',
    GU: 'Pacific/Guam', IE: 'Europe/Dublin', IS: 'Atlantic/Reykjavik', CH: 'Europe/Zurich', AT: 'Europe/Vienna', CZ: 'Europe/Prague', HU: 'Europe/Budapest', SK: 'Europe/Bratislava', RS: 'Europe/Belgrade', ME: 'Europe/Podgorica',
    AL: 'Europe/Tirane', LU: 'Europe/Luxembourg', BY: 'Europe/Minsk', GP: 'America/Guadeloupe', MQ: 'America/Martinique', GW: 'Africa/Bissau' };
  const WEEKEND = { SA: [5, 6], KW: [5, 6], QA: [5, 6], BH: [5, 6], OM: [5, 6], JO: [5, 6], EG: [5, 6], IQ: [5, 6], YE: [5, 6], DZ: [5, 6], LY: [5, 6], SD: [5, 6], MV: [5, 6], IL: [5, 6], IR: [5], SY: [5, 6], BD: [5, 6], AF: [4, 5], NP: [6], BN: [0, 5] };
  const OFFICE = [9 * 60, 17 * 60];                               // v2.9.2: companies work 09:00–17:00 local, Monday–Friday (or the country's week)
  const HOME_ZONE = { tz: 'Asia/Dubai', cc: 'AE', home: true, hours: [9 * 60, 18 * 60] };   // Ethix: 09:00–18:00 Dubai
  const hoursOf = (z) => (z && z.hours) || OFFICE;
  const hrsTxt = (z) => hoursOf(z).map((m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')).join('–');
  const zoneMemo = new Map(), fmtMemo = new Map();
  function portZone(port) {
    const s = upq(port);
    if (!s || s === '—') return null;
    if (zoneMemo.has(s)) return zoneMemo.get(s);
    let z = null;
    for (let i = 0; i < PORT_TZ.length && !z; i++) if (PORT_TZ[i][0].test(s)) z = { tz: PORT_TZ[i][1], cc: PORT_TZ[i][2] };
    if (!z) { const m = s.match(/(?:^|\(|\s)([A-Z]{2})[A-Z2-9]{3}(?:\)|$|\s)/); if (m && CC_TZ[m[1]]) z = { tz: CC_TZ[m[1]], cc: m[1] }; }
    zoneMemo.set(s, z);
    return z;
  }
  function zoneNow(tz, now) {
    let f = fmtMemo.get(tz);
    if (f === undefined) {
      const mk = (z) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: z, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return null; } };
      f = mk(tz) || ({ 'Europe/Kyiv': 'Europe/Kiev', 'Asia/Yangon': 'Asia/Rangoon' }[tz] ? mk({ 'Europe/Kyiv': 'Europe/Kiev', 'Asia/Yangon': 'Asia/Rangoon' }[tz]) : null);   // older browsers know the old names
      fmtMemo.set(tz, f);
    }
    if (!f) return null;
    const p = {}; f.formatToParts(now).forEach((x) => { p[x.type] = x.value; });
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    return dow < 0 ? null : { dow, h: (+p.hour) % 24, m: +p.minute };
  }
  // open now (and minutes to closing), or closed (and minutes to opening, and which day)
  function officeState(z, now) {
    const t = zoneNow(z.tz, now || new Date()); if (!t) return null;
    const off = WEEKEND[z.cc] || [0, 6], work = (d) => !off.includes(d), mins = t.h * 60 + t.m, H = hoursOf(z);
    if (work(t.dow) && mins >= H[0] && mins < H[1]) return { open: true, t, toClose: H[1] - mins };
    let add, d = t.dow;
    if (work(d) && mins < H[0]) add = H[0] - mins;
    else { add = 1440 - mins; d = (d + 1) % 7; for (let k = 0; k < 7 && !work(d); k++) { add += 1440; d = (d + 1) % 7; } add += H[0]; }
    return { open: false, t, toOpen: add, opensDow: d };
  }
  const hhmm = (t) => String(t.h).padStart(2, '0') + ':' + String(t.m).padStart(2, '0');
  const durTxt = (m) => (m < 60 ? m + ' MIN' : Math.floor(m / 60) + ' H' + (m % 60 && m < 300 ? ' ' + (m % 60) + ' MIN' : ''));
  const weekTxt = (z) => ((WEEKEND[z.cc] || [0, 6]).join() === '5,6' ? 'Sunday–Thursday' : (WEEKEND[z.cc] || []).join() === '5' ? 'Saturday–Thursday' : 'Monday–Friday');
  // state: short, on the clock · more: the whole story, for the tooltip
  function clockBits(z, now) {
    const o = officeState(z, now); if (!o) return null;
    const [o9, o5] = hrsTxt(z).split('–'), h9 = hoursOf(z)[0] / 60;
    if (o.open) return { time: hhmm(o.t), tone: o.toClose <= 60 ? 'amber' : 'open', state: o.toClose <= 60 ? 'CLOSES IN ' + durTxt(o.toClose) : 'OPEN', more: 'open · closes ' + o5 + ' (in ' + durTxt(o.toClose).toLowerCase() + ')', o };
    return { time: hhmm(o.t), tone: 'closed', state: 'CLOSED', more: 'closed · opens ' + (o.toOpen < 1440 && o.opensDow === (o.t.dow + (o.t.h >= h9 ? 1 : 0)) % 7 ? (o.t.h >= h9 ? 'tomorrow' : 'today') : DOW[o.opensDow]) + ' ' + o9 + ' (in ' + durTxt(o.toOpen).toLowerCase() + ')', o };
  }
  const clockTitle = (port, z, c) => 'Local time at ' + upq(port) + ' — ' + c.more + '. Office hours ' + hrsTxt(z) + ', ' + weekTxt(z) + '.';
  // The live clock under a port name on the job page (ticks by itself).
  function portClock(port, where) {
    const z = portZone(port); if (!z) return '';
    const c = clockBits(z); if (!c) return '';
    return '<div class="pclock pc-' + where + ' is-' + c.tone + '" data-clock="' + esc(port) + '" title="' + esc(clockTitle(port, z, c)) + '">' + icon('clock', 12) + '<b>' + c.time + '</b><span>' + esc(c.state) + '</span></div>';
  }
  // Follow-ups: the port whose office matters now — origin before sailing, destination after.
  function clockPort(j, t0) { if (j.mode === 'misc') return ''; return j.atSea || j.arrived || (j.etd && j.etd <= t0) ? j.pod : j.pol; }
  function rowClock(j, t0) {
    const p = clockPort(j, t0), z = p && portZone(p); if (!z) return '';
    const c = clockBits(z); if (!c) return '';
    return '<span class="pclock pc-mini is-' + c.tone + '" data-clock="' + esc(p) + '" data-mini="1" title="' + esc(clockTitle(p, z, c)) + '"><i></i><b>' + c.time + '</b>' + esc(upq(p)) + '</span>';
  }
  // urgent first (cutoff passed / today, free time) — then whose office closes soonest; closed offices by who opens first
  function dueSort8(t0) {
    const now = new Date(), memo = new Map();
    const score = (j) => {
      if (memo.has(j)) return memo.get(j);
      const p = clockPort(j, t0), z = (p && portZone(p)) || HOME_ZONE, o = officeState(z, now);
      const v = !o ? 5000 : o.open ? o.toClose : 1000 + o.toOpen;
      memo.set(j, v); return v;
    };
    const since = (x) => (x.f.since === null ? 1e9 : x.f.since);
    return (a, b) => ((a.j.next.rank === 0 ? 0 : 1) - (b.j.next.rank === 0 ? 0 : 1)) || score(a.j) - score(b.j) || a.j.next.rank - b.j.next.rank || since(b) - since(a);
  }
  function tickClocks() {
    const els = document.querySelectorAll('[data-clock]'); if (!els.length) return;
    const now = new Date();
    els.forEach((el) => {
      const z = portZone(el.dataset.clock); const c = z && clockBits(z, now); if (!c) return;
      el.classList.remove('is-open', 'is-amber', 'is-closed'); el.classList.add('is-' + c.tone);
      const b = el.querySelector('b'); if (b) b.textContent = c.time;
      const s = el.dataset.mini ? null : el.querySelector('span'); if (s) s.textContent = c.state;
      el.title = clockTitle(el.dataset.clock, z, c);
    });
  }

  // ================================================================ v2.8 — strict dates (the same rules as the server)
  const DATE_RULE_KEYS = ['etd', 'eta', 'siCut', 'edCut', 'dgCut', 'delivery'];
  const asDay = (v) => { if (v instanceof Date) return isNaN(v) ? null : dayOf(v); const d = parseDate(v); return d && !isNaN(d) ? dayOf(d) : null; };
  const dateLabels = (mode) => (mode === 'courier' ? { etd: 'Pick-up', eta: 'Delivery', a: 'is delivered before it is picked up' } : { etd: 'ETD', eta: 'ETA', a: 'cannot arrive before it leaves' });
  function dateProblem(get, touched, mode) {
    const on = (ks) => ks.some((k) => touched.includes(k)), L = dateLabels(mode), D = (d) => fmt(d, true);
    const etd = asDay(get('etd')), eta = asDay(get('eta')), del = asDay(get('delivery'));
    if (on(['etd', 'eta']) && etd && eta && eta < etd) return { key: 'eta', msg: L.eta + ' ' + D(eta) + ' is before ' + L.etd + ' ' + D(etd) + '. A shipment ' + L.a + '.' };
    const cuts = [['siCut', 'SI cutoff'], ['edCut', 'ED cutoff'], ['dgCut', 'DG cutoff']];
    for (let i = 0; i < cuts.length; i++) {
      const c = asDay(get(cuts[i][0]));
      if (on([cuts[i][0], 'etd']) && c && etd && c > etd) return { key: cuts[i][0], msg: cuts[i][1] + ' ' + D(c) + ' is after ' + L.etd + ' ' + D(etd) + '. A cutoff comes before sailing.' };
    }
    if (on(['delivery', 'eta']) && del && eta && del < eta) return { key: 'delivery', msg: 'Delivery ' + D(del) + ' is before ' + L.eta + ' ' + D(eta) + '.' };
    return null;
  }
  function sameDayOf(get, touched) {
    if (!touched.some((k) => k === 'etd' || k === 'eta')) return null;
    const etd = asDay(get('etd')), eta = asDay(get('eta'));
    return etd && eta && +etd === +eta ? etd : null;
  }
  // New job / Edit details: a wrong date stops the form at that field; a same-day arrival asks once
  // (press the button again to keep it) — the form stays open either way.
  function formDateCheck8(get, touched, mode, holder) {
    const fe = $('#formError'); if (fe) { fe.textContent = ''; fe.classList.remove('is-warn'); }
    const p = dateProblem(get, touched, mode);
    if (p) { fieldError(p.key, p.msg); const i = $('.field[data-field="' + p.key + '"] input'); if (i) i.focus(); return 'bad'; }
    const sd = sameDayOf(get, touched);
    if (sd) {
      const key = 'same:' + (+sd);
      if (holder.sameOk8 !== key) {
        holder.sameOk8 = key;
        const L = dateLabels(mode);
        if (fe) { fe.textContent = 'Same-day arrival — correct? ' + L.etd + ' and ' + L.eta + ' are both ' + fmt(sd, true) + ' (fine for a short hop). Press the button again to keep it.'; fe.classList.add('is-warn'); }
        return 'ask';
      }
    }
    return 'ok';
  }
  // Every other save (quick update, a stop, undo): a wrong date is refused before it leaves; same day asks once.
  function saveDateGate8(before, changes) {
    const touched = DATE_RULE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(changes, k));
    if (!touched.length) return null;
    const get = (k) => (Object.prototype.hasOwnProperty.call(changes, k) ? changes[k] : before[k]);
    const p = dateProblem(get, touched, before.mode);
    if (p) { toast(p.msg, { error: true }); return Promise.resolve(false); }
    const sd = sameDayOf(get, touched);
    if (sd && !(before.etd && before.eta && +dayOf(before.etd) === +dayOf(before.eta))) {
      const L = dateLabels(before.mode);
      return ask({ title: 'Same-day arrival — correct?', text: L.etd + ' and ' + L.eta + ' are both ' + fmt(sd, true) + ' for ' + before.jobNo + '. That is right for a short hop (a day or a few hours).', yes: 'Yes, same day', no: 'Change it' });
    }
    return null;
  }

  // ================================================================ v2.8 — your jobs only · job transfer
  function scopedJobs8() { return canEdit() ? state.jobs.filter((j) => j.cs === state.user) : state.jobs; }
  const unassigned8 = () => (canEdit() ? state.jobs.filter((j) => j.active && !j.cs) : []);
  function transferBtn(j) { return canEditJob(j) && j.active ? '<button type="button" class="tile-link" data-transfer="' + esc(j.jobNo) + '">' + (j.cs ? 'Transfer' : 'Assign') + '</button>' : ''; }
  const transferMenu = (no) => () => {
    const j = findJob(no); if (!j) return '';
    const T = state.transfer8 && state.transfer8.no === j.jobNo ? state.transfer8 : (state.transfer8 = { no: j.jobNo, to: '', note: '' });
    const names = csOptions('').filter((n) => n !== j.cs);
    return '<div class="pop-title">' + (j.cs ? 'Transfer this job' : 'Assign this job') + '</div><p class="pop-text">' + esc(j.jobNo) + ' · ' + esc(j.customer || '') + (j.cs ? ' · now with ' + esc(nice(j.cs)) : ' · no Customer Service yet') + '</p>' +
      (names.length ? '<div class="pop-label">To</div><div class="choice-row is-stack tf-names">' + names.map((n) => '<button type="button" class="choice' + (n === T.to ? ' is-on' : '') + '" data-transfer-to="' + esc(n) + '" aria-pressed="' + (n === T.to) + '">' + esc(nice(n)) + (n === state.user ? ' <span class="you">YOU</span>' : '') + '</button>').join('') + '</div>' +
        '<form class="pop-form" data-transfer-form="' + esc(j.jobNo) + '"><label class="pop-label" for="transferNote">Note (optional)</label><input type="text" id="transferNote" maxlength="200" placeholder="A line for them (optional)" autocomplete="off" value="' + esc(T.note) + '">' +
        '<button type="submit" class="btn-brutal pop-main" data-primary' + (T.to ? '' : ' disabled') + '>' + (T.to ? (T.to === state.user ? 'TAKE THIS JOB' : 'TRANSFER TO ' + esc(T.to)) : 'CHOOSE WHO') + '</button></form>'
        : '<p class="pop-text">There is no other Customer Service account yet.</p>') +
      '<div class="pop-hint">' + (T.to && T.to !== state.user ? esc(nice(T.to)) + ' gets a notification' : 'The new owner gets a notification') + (j.sales ? ', and so does ' + esc(nice(j.sales)) + ' (sales)' : '') + '. The job moves to their lists.</div>';
  };
  async function doTransfer8(no, to, note) {
    const j = findJob(no); if (!j || !to) return;
    const from = j.cs, k = keyOf(j);
    closeOverlays(true); state.transfer8 = null;
    setSaving(1);
    try {
      const res = await api.call('ethixJobTransfer', [j.jobNo, to, note || '']);
      if (res && res.ok) {
        applyRow6(res.row); state.syncedAt = Date.now();
        rerender(); updateNav();
        if (state.stories.has(k)) loadStory(j.jobNo, true);
        const undo = from && from !== to ? { action: { label: 'Undo', fn: () => doTransfer8(j.jobNo, from, 'undo') } } : {};
        toast(to === state.user ? 'Job ' + j.jobNo + ' is yours now' : 'Transferred to ' + nice(to) + ' — they were told', undo);
        return;
      }
      toast((res && res.error) || 'The job was not transferred.', { error: true });
    } catch (e) { if (e.kind !== 'auth') toast(/not available|unknown/i.test(e.message) ? 'Transfer needs the v2.8 Code.gs.' : 'Not transferred: ' + e.message, { error: true }); }
    finally { setSaving(-1); }
  }
  function transferText(a) {
    const m = String(a || '').match(/^TRANSFERRED THE JOB (?:FROM (.+?) )?TO (.+?)(?: — (.+))?$/);
    return m ? 'transferred the job ' + (m[1] ? 'from ' + m[1] + ' ' : '') + 'to ' + m[2] + (m[3] ? ' — ' + m[3].toLowerCase() : '') : null;
  }

  function initV28() {
    setInterval(tickClocks, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tickClocks(); });
    document.addEventListener('click', (e) => {
      const tb = e.target.closest('[data-transfer]');
      if (tb && canEdit()) { state.transfer8 = null; openPop(tb, 'CUSTOMER SERVICE', transferMenu(tb.dataset.transfer)); return; }
      const to = e.target.closest('[data-transfer-to]');
      if (to && state.transfer8) { const n = $('#transferNote'); if (n) state.transfer8.note = n.value; state.transfer8.to = to.dataset.transferTo; refreshOverlay(); const b = document.querySelector('[data-transfer-form] [data-primary]'); if (b) b.focus(); }
    });
    document.addEventListener('submit', (e) => {
      const f = e.target.closest('[data-transfer-form]'); if (!f) return;
      e.preventDefault();
      const T = state.transfer8; if (!T || !T.to) return;
      const n = $('#transferNote');
      doTransfer8(f.dataset.transferForm, T.to, n ? n.value.trim() : T.note);
    });
  }

  // ================================================================ v2.9 — changed since you looked
  // touch[job] = [time, who, what]: the newest change by someone else; seen[job] = when you last opened it.
  function applyBoot9(boot) {
    if (Array.isArray(boot.reminders)) state.reminders = boot.reminders;
    if (boot.seen && typeof boot.seen === 'object') state.seen = boot.seen;
    if (boot.touch && typeof boot.touch === 'object') state.touch = boot.touch;
  }
  function changeOf(j) {
    const k = keyOf(j), t = state.touch && state.touch[k];
    if (!t) return null;
    const seen = (state.seen && (state.seen[k] || state.seen._base)) || 0;
    return t[0] > seen ? { t: t[0], who: t[1], what: friendly(t[2]) } : null;
  }
  const isChanged = (j) => !!changeOf(j);
  const changeText = (c) => nice(c.who) + ' · ' + ago(c.t) + ' — ' + c.what;
  function changedDot(j) { const c = changeOf(j); return c ? '<span class="chg-dot" title="' + esc('Changed by ' + changeText(c)) + '" aria-label="Changed since you looked"></span>' : ''; }
  function changedJobs() { return scoped().filter((j) => j.active && isChanged(j)).sort((a, b) => changeOf(b).t - changeOf(a).t); }
  // Opening a job marks it seen (here at once, on the server in the background). The page says what changed.
  function seenOpen9(no) {
    const j = findJob(no); if (!j || !state.seen) { state.justSeen9 = null; return; }
    const c = changeOf(j);
    state.justSeen9 = c ? { k: keyOf(j), c } : null;
    if (!c) return;
    state.seen[keyOf(j)] = Date.now();
    api.call('ethixSeen', [j.jobNo]).then((r) => { if (r && r.seen) state.seen = Object.assign({}, r.seen, state.seen); }).catch(() => {});
  }
  function changedChip9(j) {
    const s = state.justSeen9;
    return s && s.k === keyOf(j) ? '<span class="chg-chip" title="Changed since you last opened it">' + icon('refresh', 12) + '<span>' + esc(changeText(s.c)) + '</span></span>' : '';
  }
  const changedMenu = () => () => {
    const list = changedJobs();
    return '<div class="pop-title">Changed since you looked</div>' +
      (list.length ? '<ul class="chg-list">' + list.slice(0, 30).map((j) => { const c = changeOf(j); return '<li><button type="button" data-fl-open="' + esc(j.jobNo) + '"><span class="chg-dot"></span><b>' + esc(j.jobNo) + '</b><span class="chg-who">' + esc(nice(c.who) + ' · ' + ago(c.t)) + '</span><span class="chg-what">' + esc(c.what) + '</span></button></li>'; }).join('') + '</ul>' +
        '<button type="button" class="btn-ghost pop-wide" data-act="seen-all">Mark all as seen</button>'
        : '<p class="pop-text">Nothing changed since you last looked.</p>');
  };

  // ================================================================ v2.9.1 — where a shipment is (before sailing · at sea · arrived)
  const STAGES91 = [['before', 'BEFORE SAILING'], ['sea', 'AT SEA'], ['arrived', 'ARRIVED'], ['nodate', 'DATES TO CONFIRM']];
  const MON91 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function stageOf91(j, t0) { if (!j.etd && !j.eta) return 'nodate'; if (j.eta && j.eta <= t0) return 'arrived'; if (j.etd && j.etd <= t0) return 'sea'; return 'before'; }
  function liveJobs91() { return scoped().filter((j) => j.active && j.mode !== 'misc'); }
  const portName91 = (p) => nice(p).replace(/\(([^)]+)\)/g, (x, a) => '(' + a.toUpperCase() + ')');

  // ================================================================ v2.9 — reminders: your own to-dos (with or without a job)
  const REPEAT_NAME = { '': 'Once', DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly' };
  const isoOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const remOpen = () => (state.reminders || []).filter((r) => r.status !== 'DONE');
  const remDue = () => { const t = isoOf(today0()); return remOpen().filter((r) => r.due <= t); };
  const remDueCount = () => (canNote() ? remDue().length : 0);
  function remWhen(r) {
    const d = parseDate(r.due), t0 = today0(), n = d ? days(t0, d) : 0;
    const w = !d ? '—' : n < 0 ? (n === -1 ? 'Yesterday' : (-n) + ' days late') : n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n < 7 ? DOW[d.getDay()] + ' ' + fmt(d) : fmt(d, d.getFullYear() !== t0.getFullYear());
    return w + (r.time ? ' · ' + r.time : '');
  }
  function remItem(r, noJob) {
    const done = r.status === 'DONE', d = parseDate(r.due), n = d ? days(today0(), d) : 0;
    const tone = done ? 'done' : n < 0 ? 'late' : n === 0 ? 'today' : 'later';
    return '<li class="rm is-' + tone + '"><button type="button" class="rm-tick' + (done ? ' is-on' : '') + '" data-rem-done="' + esc(r.id) + '" aria-label="' + esc((done ? 'Done — tap to put back: ' : 'Mark done: ') + r.text) + '">' + TICK + '</button>' +
      '<button type="button" class="rm-main" data-rem-edit="' + esc(r.id) + '" aria-label="' + esc('Edit or snooze: ' + r.text) + '"><span class="rm-text">' + esc(r.text) + '</span><span class="rm-meta"><span class="rm-when">' + esc(remWhen(r)) + '</span>' +
        (r.repeat ? '<span class="rm-rep">' + icon('refresh', 11) + REPEAT_NAME[r.repeat] + '</span>' : '') + '</span></button>' +
      (r.job && !noJob ? '<button type="button" class="rm-job" data-job="' + esc(r.job) + '">' + esc(r.job) + '</button>' : '') + '</li>';
  }
  // grouped: late · today · tomorrow · later (next 14 days) · done today
  function remGroups(list, max) {
    const t0 = today0(), T = isoOf(t0), M = isoOf(addDays(t0, 1)), H = isoOf(addDays(t0, 14));
    const open = list.filter((r) => r.status !== 'DONE');
    const g = [['LATE', open.filter((r) => r.due < T)], ['TODAY', open.filter((r) => r.due === T)], ['TOMORROW', open.filter((r) => r.due === M)], ['NEXT TWO WEEKS', open.filter((r) => r.due > M && r.due <= H)],
      ['DONE TODAY', list.filter((r) => r.status === 'DONE' && r.doneAt >= +t0)]];
    let shown = 0;
    return g.filter(([, l]) => l.length).map(([label, l]) => { const part = max ? l.slice(0, Math.max(0, max - shown)) : l; shown += part.length; return part.length ? '<div class="rm-gh is-' + label.split(' ')[0].toLowerCase() + '">' + label + '</div><ul class="rm-list">' + part.map((r) => remItem(r)).join('') + '</ul>' : ''; }).join('');
  }
  function remStart(r, job) {
    state.remForm = r ? { id: r.id, text: r.text, due: r.due, time: r.time, job: r.job, repeat: r.repeat || '' } : { id: '', text: '', due: isoOf(today0()), time: '', job: job || '', repeat: '' };
  }
  const remForm = () => () => {
    const F = state.remForm || {}, t0 = today0();
    const mon = addDays(t0, ((8 - t0.getDay()) % 7) || 7);
    const dayBtn = (d, label) => { const v = isoOf(d); return '<button type="button" class="choice' + (F.due === v ? ' is-on' : '') + '" data-rem-day="' + v + '" aria-pressed="' + (F.due === v) + '">' + label + '</button>'; };
    const myJobs = scoped().filter((j) => j.active);
    return '<div class="pop-title">' + (F.id ? 'Reminder' : 'New reminder') + '</div>' +
      '<form class="pop-form rm-form" data-rem-form novalidate>' +
        '<label class="pop-label" for="remText">What to remember</label><input type="text" id="remText" maxlength="200" autocomplete="off" value="' + esc(F.text) + '" placeholder="Write it in a few words">' +
        '<div class="pop-label">Day</div><div class="choice-row rm-days">' + dayBtn(t0, 'Today') + dayBtn(addDays(t0, 1), 'Tomorrow') + dayBtn(mon, DOW[mon.getDay()] + ' ' + fmt(mon)) +
          '<input type="date" id="remDue" value="' + esc(F.due) + '" aria-label="Pick a day"></div>' +
        '<div class="rm-two"><label><span class="pop-label">Time (optional)</span><input type="time" id="remTime" value="' + esc(F.time) + '"></label>' +
          '<label><span class="pop-label">Job (optional)</span><input type="text" id="remJob" list="dlMyJobs" autocomplete="off" spellcheck="false" value="' + esc(F.job) + '" placeholder="Job number"></label></div>' +
        '<div class="pop-label">Repeat</div><div class="seg seg-mini rm-rep-seg" role="group" aria-label="Repeat">' + Object.keys(REPEAT_NAME).map((k) => '<button type="button" data-rem-rep="' + k + '" aria-pressed="' + ((F.repeat || '') === k) + '">' + REPEAT_NAME[k] + '</button>').join('') + '</div>' +
        '<div class="form-error" id="remErr" role="alert"></div>' +
        '<button type="submit" class="btn-brutal pop-main" data-primary>' + (F.id ? 'SAVE' : 'ADD REMINDER') + '</button>' +
        (F.id ? '<div class="rm-snooze"><span class="pop-label">Snooze to</span><div class="choice-row">' + [[1, 'Tomorrow'], [3, 'In 3 days'], [((8 - t0.getDay()) % 7) || 7, 'Next ' + DOW[mon.getDay()]]].map(([n, l]) => '<button type="button" class="choice" data-rem-snooze="' + n + '">' + l + '</button>').join('') + '</div></div>' +
          '<button type="button" class="link-btn quiet rm-del" data-rem-del="' + esc(F.id) + '">Delete this reminder</button>' : '') +
      '</form><datalist id="dlMyJobs">' + myJobs.map((j) => '<option value="' + esc(j.jobNo) + '">' + esc(j.customer || '') + '</option>').join('') + '</datalist>';
  };
  function remOpenForm(anchor, r, job) { remStart(r, job); openPop(anchor, 'REMINDER', remForm()); }
  function remPaint() { rerender(); updateNav(); refreshOverlay(); }
  async function remSave(F, note) {
    const err = $('#remErr');
    if (!String(F.text || '').trim()) { if (err) err.textContent = 'Write what to remember.'; const t = $('#remText'); if (t) t.focus(); return false; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(F.due || '')) { if (err) err.textContent = 'Choose a day.'; return false; }
    setSaving(1);
    try {
      const res = await api.call('ethixReminderSave', [{ id: F.id || '', text: F.text, due: F.due, time: F.time || '', job: String(F.job || '').trim().toUpperCase(), repeat: F.repeat || '' }]);
      if (res && res.ok) {
        state.reminders = res.reminders || state.reminders; closeOverlays(true); state.remForm = null; remPaint();
        const r = (state.reminders || []).find((x) => x.id === (F.id || res.id));
        toast((note || (F.id ? 'Reminder saved' : 'Reminder added')) + (r ? ' · ' + remWhen(r) : ''));
        return true;
      }
      if (res && res.reminders) state.reminders = res.reminders;
      if (err) err.textContent = (res && res.error) || 'Not saved. Please try again.'; else toast((res && res.error) || 'Not saved.', { error: true });
    } catch (e) { if (e.kind !== 'auth') { if (err) err.textContent = /not available|unknown/i.test(e.message) ? 'Reminders need the v2.9 Code.gs.' : 'Not saved: ' + e.message; else toast('Not saved: ' + e.message, { error: true }); } }
    finally { setSaving(-1); }
    return false;
  }
  async function remDone(id, done) {
    const r = (state.reminders || []).find((x) => x.id === id); if (!r) return;
    const before = JSON.stringify(state.reminders);
    if (!r.repeat) { r.status = done ? 'DONE' : 'OPEN'; r.doneAt = done ? Date.now() : 0; remPaint(); }
    setSaving(1);
    try {
      const res = await api.call('ethixReminderDone', [id, done]);
      if (res && res.ok) {
        state.reminders = res.reminders || state.reminders; remPaint();
        const nx = res.next ? parseDate(res.next) : null;
        toast(done ? (nx ? 'Done · next ' + DOW[nx.getDay()] + ' ' + fmt(nx) : 'Done') : 'Back on your list', done ? { action: { label: 'Undo', fn: () => remDone(id, false) } } : {});
        return;
      }
      state.reminders = (res && res.reminders) || JSON.parse(before); remPaint(); toast((res && res.error) || 'Not saved.', { error: true });
    } catch (e) { state.reminders = JSON.parse(before); remPaint(); if (e.kind !== 'auth') toast('Not saved: ' + e.message, { error: true }); }
    finally { setSaving(-1); }
  }
  async function remDelete(id) {
    const r = (state.reminders || []).find((x) => x.id === id); if (!r) return;
    closeOverlays(true); state.remForm = null;
    setSaving(1);
    try {
      const res = await api.call('ethixReminderDelete', [id]);
      if (res && res.ok) { state.reminders = res.reminders || []; remPaint(); toast('Reminder deleted', { action: { label: 'Undo', fn: () => remSave({ text: r.text, due: r.due, time: r.time, job: r.job, repeat: r.repeat }, 'Reminder back') } }); }
    } catch (e) { if (e.kind !== 'auth') toast('Not deleted: ' + e.message, { error: true }); }
    finally { setSaving(-1); }
  }
  // the follow-ups page: reminders sit above the jobs (due today and late first)
  function remSection(anim) {
    if (!canNote()) return '';
    const list = state.reminders || [];
    const body = remGroups(list, 0);
    return '<section class="round-sec rm-sec' + (anim || '') + '" aria-labelledby="rs-rem"><div class="tile-head"><h2 class="tile-title" id="rs-rem">REMINDERS <span class="tile-count">' + remOpen().length + '</span></h2>' +
      '<button type="button" class="btn-ghost rm-add" data-act="rem-add">' + icon('plus', 15) + '<span>Reminder</span></button></div>' +
      (body || '<p class="rm-empty">Nothing to remember right now. Add one for anything that is not a booking — a call, a payment, a rate to check.</p>') + '</section>';
  }
  // the job page: this job's reminders in the follow-up card
  function jobReminders(j) {
    if (!canNote()) return '';
    const list = (state.reminders || []).filter((r) => r.job && r.job.toUpperCase() === keyOf(j) && r.status !== 'DONE');
    return '<div class="rm-job-block">' + (list.length ? '<ul class="rm-list">' + list.map((r) => remItem(r, true)).join('') + '</ul>' : '') +
      '<button type="button" class="btn-ghost rm-add" data-act="rem-add" data-rem-job="' + esc(j.jobNo) + '">' + icon('clock', 15) + '<span>Remind me</span></button></div>';
  }

  // ================================================================ v2.9 — Home: MY DAY (what came in · what to remember)
  function myDayTile(anim) {
    const ch = changedJobs(), un = notifUnread(), late = remOpen().filter((r) => r.due < isoOf(today0())).length;
    const line = (attrs, ic, txt, n, cls, tip) => '<button type="button" class="md-line' + (cls ? ' ' + cls : '') + '" ' + attrs + ' title="' + esc(tip) + '">' + icon(ic, 13) + '<b>' + n + '</b><span>' + txt + '</span></button>';
    const brief = (ch.length ? line('data-act="changed"', 'refresh', 'changed', ch.length, 'is-chg', (ch.length === 1 ? 'One of your jobs' : ch.length + ' of your jobs') + ' changed since you looked — tap to see') : '') +
      (un ? line('data-act="notif"', 'bell', un === 1 ? 'new alert' : 'new alerts', un, '', 'Open notifications') : '') +
      (late ? line('data-act="rem-late"', 'clock', 'late', late, 'is-late', (late === 1 ? 'A reminder is' : late + ' reminders are') + ' past their day') : '');
    const body = remGroups(state.reminders || [], 0);
    return '<section class="tile t-act t-day' + anim + '" style="--d:340ms" aria-labelledby="dayTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="dayTitle">MY DAY</h2><button type="button" class="tile-link rm-add" data-act="rem-add">' + icon('plus', 14) + 'Reminder</button></div>' +
      '<div class="tile-body">' + (brief ? '<div class="md-brief">' + brief + '</div>' : '') +
        (body || '<p class="rm-empty">No reminders. Add one for anything that is not a booking — a call, a payment, a rate to check.</p>') + '</div></section>';
  }
  // ================================================================ v2.9.1 — TODAY'S WATCH: what still has to happen, and by when
  // Before sailing: SI, ED and BL confirmation — by their cutoff, or by the sailing date when there is no cutoff
  // (v2.9.2: DGPC for DG sea exports, the DG cutoff for air). Still open after the ship sailed = overdue. Imports: the line free time ending or over.
  function watchItems91(active, t0) {
    const out = [];
    const cutW = (d) => (d < 0 ? (-d) + (d === -1 ? ' day' : ' days') + ' overdue' : d === 0 ? 'cutoff today' : d === 1 ? 'cutoff tomorrow' : 'cutoff in ' + d + ' days');
    const add = (j, what, say, d, when, extra) => out.push(Object.assign({ j, what, say, d, when, level: d <= 1 ? 'urgent' : 'soon' }, extra || {}));
    active.forEach((j) => {
      if (j.hold || j.mode === 'misc') return;
      if ((j.cat === 'EXPORT' || j.cat === 'CROSS') && j.type !== 'CRR') {
        const air = j.mode === 'air', sd = j.etd ? days(t0, j.etd) : null;
        const verb = air ? 'departs' : 'sails', past = air ? 'departed ' : 'sailed ';
        const task = (open, cut, what, say) => {
          if (!open) return;
          if (sd !== null && sd < 0) { if (sd >= -21) add(j, what, say, sd, past + (sd === -1 ? 'yesterday' : (-sd) + ' days ago')); return; }
          if (cut) { const dc = days(t0, cut); if (dc <= 3) add(j, what, say, dc, cutW(dc)); return; }
          if (sd !== null && sd <= 3) add(j, what, say, sd, sd === 0 ? verb + ' today' : sd === 1 ? verb + ' tomorrow' : verb + ' in ' + sd + ' days');
        };
        task(!j.sido || j.sido === 'PENDING', j.siCut, 'SI NOT SUBMITTED', 'SI not submitted');
        if (j.cat === 'EXPORT') task(!j.ed || j.ed === 'PENDING', j.edCut, 'ED NOT PASSED', 'ED not passed');
        task(j.bl !== NA && !BL_OK.includes(j.bl), null, air ? 'AWB NOT CONFIRMED' : 'BL NOT CONFIRMED', air ? 'AWB not confirmed' : 'BL not confirmed');
        if (j.cat === 'EXPORT' && j.dg === 'DG' && j.mode === 'sea') task(!j.dgpc || j.dgpc === 'PENDING', j.dgCut, 'DGPC NOT SUBMITTED', 'DGPC not submitted');   // v2.9.2
        else if (j.cat === 'EXPORT' && j.dg === 'DG' && j.dgCut && !(sd !== null && sd < 0)) { const dc = days(t0, j.dgCut); if (dc >= -1 && dc <= 3) add(j, 'DG CUTOFF', 'DG cutoff', dc, dc < 0 ? 'passed yesterday' : dc === 0 ? 'today' : dc === 1 ? 'tomorrow' : 'in ' + dc + ' days'); }
      }
      if (j.cat === 'IMPORT' && j.arrived && !j.delivery && j.lineFreeEnd) {
        const d = days(t0, j.lineFreeEnd);
        if (d <= 2 && d >= -30) add(j, d < 0 ? 'FREE TIME OVER' : 'FREE TIME ENDS', d < 0 ? 'Free time over' : 'Free time ends', d, d < 0 ? 'over by ' + (-d) + (d === -1 ? ' day' : ' days') : d === 0 ? 'ends today' : d === 1 ? 'ends tomorrow' : 'ends in 2 days', { free: true });
      }
    });
    return out.sort((a, b) => a.d - b.d || (a.level === b.level ? 0 : a.level === 'urgent' ? -1 : 1));
  }

  // ================================================================ v2.9.1 — Home: five counters (each opens the side panel)
  function kpiTiles91(m, anim) {
    const t0 = today0(), wk = addDays(t0, 6);
    const k = (id, label, n, sub, urgent, d) => '<button type="button" class="kpi' + (urgent ? ' is-urgent' : '') + anim + '" style="--d:' + d + 'ms" data-list="' + id + '">' +
      '<span class="kpi-label">' + label + '</span><span class="kpi-num">' + n + '</span><span class="kpi-sub">' + esc(sub) + '</span></button>';
    const holdSoon = m.hold.filter((j) => j.etd && j.etd >= t0 && j.etd <= wk).length;
    return '<div class="kpis is-5">' +
      k('active', 'ACTIVE JOBS', m.active.length, m.atSea.length + ' at sea now', false, 100) +
      k('costing', 'COSTING DUE', m.costing.length, m.costing.filter((j) => costDue91(j, t0)).length + ' sailed or arrived', false, 130) +
      k('sied', 'SI / ED DUE', m.sied.length, m.cut24 + (m.cut24 === 1 ? ' cutoff' : ' cutoffs') + ' in 24 h', false, 160) +
      k('free', 'FREE TIME', m.freeJobs.length, m.freeJobs.length ? 'ending in ≤ 2 days' : 'all clear', m.freeJobs.length > 0, 190) +
      k('hold', 'ON HOLD', m.hold.length, !m.hold.length ? 'all jobs moving' : holdSoon ? holdSoon + ' due to sail this week' : 'none due to sail this week', false, 220) +
      '</div>';
  }

  // ================================================================ v2.9.1 — Home: four tall tiles, each made for its job
  function watchTile91(m, anim) {
    const chip = (w) => (w.level === 'urgent' ? 'chip chip-urgent' : 'chip chip-amber-dark');
    const item = (w, more) => '<button type="button" class="wt li' + (more ? ' is-more' : '') + '" data-job="' + esc(w.j.jobNo) + '">' +
      '<span class="wt-top"><span class="wt-job">' + changedDot(w.j) + esc(w.j.jobNo) + '</span><span class="' + chip(w) + '">' + (w.level === 'urgent' ? icon('alert', 12) : '') + esc(w.when) + '</span></span>' +
      '<span class="wt-what">' + esc(w.what) + '</span><span class="wt-cust">' + esc(w.j.customer || '—') + ' · ' + esc(nice(w.j.route)) + '</span></button>';
    const G = [['over', 'OVERDUE', (w) => w.d < 0], ['today', 'TODAY', (w) => w.d === 0], ['soon', 'NEXT 3 DAYS', (w) => w.d > 0]];
    let n = 0;
    const body = G.map(([id, label, f]) => { const L = m.watch.filter(f).slice(0, LIST_MAX); if (!L.length) return ''; const head = '<div class="wt-gh is-' + id + (n >= 6 ? ' is-more' : '') + '">' + label + '<b>' + L.length + '</b></div>'; return head + L.map((w) => item(w, n++ >= 6)).join(''); }).join('');
    return '<section class="tile tile-ink t-watch' + anim + '" style="--d:250ms" aria-labelledby="watchTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="watchTitle">TODAY’S WATCH</h2><span class="watch-sub">' + (m.watch.length ? m.watch.length + ' to do' : 'All clear') + '</span></div>' +
      '<div class="tile-body">' + (body || empty('check', 'Nothing due in the next 3 days.')) + '</div>' + seeAll('watch', m.watch.length, true) + '</section>';
  }
  // the week as an agenda: a strip of seven days (how much sails and arrives each day), then day by day
  function weekTile91(m, anim) {
    const t0 = today0(); let ev = [];
    m.arriving.forEach((j) => ev.push({ j, d: j.eta, k: 'arr' }));
    m.departing.forEach((j) => ev.push({ j, d: j.etd, k: 'dep' }));
    ev.sort((a, b) => a.d - b.d || (a.k === b.k ? 0 : a.k === 'dep' ? -1 : 1));
    const pick = wkPick92(t0), all = ev;                          // v2.9.2: a day picked in the strip (tap it again for the whole week)
    ev = pick ? all.filter((x) => +dayOf(x.d) === +pick) : all;
    const nA = ev.filter((x) => x.k === 'arr').length, nD = ev.length - nA;
    const strip = '<div class="wk-strip' + (pick ? ' has-pick' : '') + '" role="group" aria-label="Pick a day">' + Array.from({ length: 7 }, (_, i) => addDays(t0, i)).map((d, i) => {
      const e = all.filter((x) => +dayOf(x.d) === +d), a = e.filter((x) => x.k === 'arr').length, s = e.length - a, on = !!pick && +pick === +d;
      return '<button type="button" class="wk-day' + (i === 0 ? ' is-today' : '') + (e.length ? '' : ' is-none') + (on ? ' is-on' : '') + '" data-wkday="' + isoOf(d) + '" aria-pressed="' + on + '" title="' + esc(DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON91[d.getMonth()] + ' · ' + (s ? s + ' sailing' : 'none sailing') + ', ' + (a ? a + ' arriving' : 'none arriving')) + '">' +
        '<em>' + DOW_UP[d.getDay()] + '</em><b>' + d.getDate() + '</b><span class="wk-n">' + (s ? '<i class="is-dep">' + s + '</i>' : '') + (a ? '<i class="is-arr">' + a + '</i>' : '') + '</span></button>';
    }).join('') + '</div>';
    const tag = (e) => (e.k === 'arr' ? (e.j.mode === 'courier' ? 'DELIVERY' : 'ARRIVES') : e.j.mode === 'air' ? 'DEPARTS' : e.j.mode === 'courier' ? 'PICK-UP' : 'SAILS');
    let last = -1, list = '';
    ev.slice(0, LIST_MAX).forEach((e, i) => {
      const n = days(t0, e.d);
      if (n !== last) { last = n; list += '<div class="wk-gh' + (i >= 6 ? ' is-more' : '') + '">' + (n === 0 ? 'TODAY' : n === 1 ? 'TOMORROW' : DOW_UP[e.d.getDay()]) + ' · ' + e.d.getDate() + ' ' + MON91[e.d.getMonth()].toUpperCase() + '</div>'; }
      list += '<button type="button" class="wk-row li' + (i >= 6 ? ' is-more' : '') + '" data-job="' + esc(e.j.jobNo) + '"><span class="wk-tag is-' + e.k + '">' + tag(e) + '</span><span class="li-main"><span class="li-job">' + changedDot(e.j) + esc(e.j.jobNo) + '</span><span class="li-sub">' + esc(nice(e.j.route)) + (e.j.cargo ? ' · ' + esc(e.j.cargo) : '') + '</span></span></button>';
    });
    return '<section class="tile t-week' + anim + '" style="--d:280ms" aria-labelledby="weekTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="weekTitle">THIS WEEK</h2><span class="tile-count">' + ev.length + '</span></div>' +
      strip + '<div class="wk-legend"><span><i class="is-dep"></i>Sailing ' + nD + '</span><span><i class="is-arr"></i>Arriving ' + nA + '</span>' + (pick ? '<button type="button" class="wk-all" data-wkday="">Whole week</button>' : '') + '</div>' +
      '<div class="tile-body">' + (list || empty('calendar', pick ? 'Nothing sails or arrives on ' + DOW[pick.getDay()] + ' ' + pick.getDate() + ' ' + MON91[pick.getMonth()] + '.' : 'Nothing sails or arrives in the next 7 days.')) + '</div>' + seeAll('week', ev.length) + '</section>';
  }
  // the picked day (a Date at local midnight) while it is still inside the coming seven days, else null
  function wkPick92(t0) {
    const k = state.wkDay92; if (!k) return null;
    for (let i = 0; i < 7; i++) { const d = addDays(t0 || today0(), i); if (isoOf(d) === k) return d; }
    state.wkDay92 = ''; return null;
  }
  // the side panel for THIS WEEK follows the picked day
  function weekPanel92(m) {
    const pick = wkPick92(today0()), list = m.departing.concat(m.arriving);
    if (!pick) return ['THIS WEEK', list];
    return [DOW_UP[pick.getDay()] + ' · ' + pick.getDate() + ' ' + MON91[pick.getMonth()].toUpperCase(), list.filter((j) => (m.departing.includes(j) && j.etd && +dayOf(j.etd) === +pick) || (m.arriving.includes(j) && j.eta && +dayOf(j.eta) === +pick))];
  }
  // ================================================================ v2.9.1 — Home: POD OFFICE HOURS (v2.9.2: times in Dubai time)
  // The destination port of each of your jobs, by name: teal = open, amber = closing within the hour, grey = closed.
  // Open ones by who closes first, then who opens first.
  function portList91(t0) {
    const now = new Date(), map = new Map();
    liveJobs91().forEach((j) => {
      const p = j.pod, z = p && portZone(p); if (!z) return;
      const k = upq(p), e = map.get(k) || { port: k, z, jobs: [] }; e.jobs.push(j); map.set(k, e);
    });
    return Array.from(map.values()).map((e) => Object.assign(e, { o: officeState(e.z, now) })).filter((e) => e.o)
      .sort((a, b) => (a.o.open !== b.o.open ? (a.o.open ? -1 : 1) : a.o.open ? a.o.toClose - b.o.toClose : a.o.toOpen - b.o.toOpen) || b.jobs.length - a.jobs.length);
  }
  const yourTime91 = (d) => { const x = dxb(d); return String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };   // Dubai time
  function portState91(o, now) {
    if (o.open) { const at = +now + o.toClose * 60000; return o.toClose <= 60 ? { tone: 'amber', txt: 'closes in ' + o.toClose + ' min' } : { tone: 'open', txt: 'closes ' + (days(dayOf(+now), dayOf(at)) === 1 ? 'tomorrow ' : '') + yourTime91(at) }; }
    const at = +now + o.toOpen * 60000, dd = days(dayOf(+now), dayOf(at));
    return { tone: 'closed', txt: 'opens ' + (dd === 0 ? '' : dd === 1 ? 'tomorrow ' : DOW[dxb(at).getDay()] + ' ') + yourTime91(at) };
  }
  function portChip91(e, now) {
    const c = portState91(e.o, now);
    return '<button type="button" class="po-chip is-' + c.tone + '" data-port91="' + esc(e.port) + '" title="' + esc(portName91(e.port) + ' — local time ' + hhmm(e.o.t) + ' · office ' + hrsTxt(e.z) + ' their time, ' + weekTxt(e.z) + ' · ' + e.jobs.length + (e.jobs.length === 1 ? ' job' : ' jobs')) + '">' +
      '<i></i><b>' + esc(portName91(e.port)) + '</b><span>' + esc(c.txt) + '</span></button>';
  }
  function portOffices(anim) {
    const t0 = today0(), now = new Date(), L = portList91(t0);
    return '<section class="ports glass' + (anim || '') + '" id="portOffices" aria-labelledby="poTitle" style="--d:20ms">' +
      '<div class="po-head"><h2 class="po-k" id="poTitle">POD OFFICE HOURS</h2><span class="po-now" title="Every time here is Dubai time. Ethix office hours 09:00–18:00, Monday–Friday.">DUBAI TIME <b>' + yourTime91(now) + '</b></span></div>' +
      (L.length ? '<div class="po-chips">' + L.map((e) => portChip91(e, now)).join('') + '<button type="button" class="po-chip is-more" data-act="ports-all" hidden>+0 more</button></div>'
        : '<p class="po-none">The ports of your jobs show here, with their office hours in Dubai time.</p>') + '</section>';
  }
  // keep the chips to two rows (three on the phone); the rest are counted in "+N more"
  function fitPorts91() {
    const box = $('#portOffices .po-chips'); if (!box) return;
    const chips = Array.from(box.querySelectorAll('.po-chip[data-port91]')), more = box.querySelector('.po-chip.is-more');
    if (!more || !chips.length) return;
    chips.forEach((c) => { c.hidden = false; }); more.hidden = true;
    const rows = window.innerWidth < 760 ? 3 : 2, top0 = chips[0].offsetTop, rowH = chips[0].offsetHeight + 6;
    const fits = (el) => Math.round((el.offsetTop - top0) / rowH) < rows;
    let n = chips.findIndex((c) => !fits(c)); if (n < 0) return;
    for (let k = n; k < chips.length; k++) chips[k].hidden = true;
    const say = () => { more.textContent = '+' + (chips.length - n) + ' more'; };
    more.hidden = false; say();
    while (n > 0 && !fits(more)) { n--; chips[n].hidden = true; say(); }
  }
  const portsPop91 = () => () => { const now = new Date(); return '<div class="pop-title">POD office hours</div><div class="po-chips is-all">' + portList91(today0()).map((e) => portChip91(e, now)).join('') + '</div>'; };
  const portJobsPop91 = (port) => () => {
    const e = portList91(today0()).find((x) => x.port === port); if (!e) return '<p class="pop-text">No jobs.</p>';
    const c = portState91(e.o, new Date());
    return '<div class="pop-title">' + esc(portName91(port)) + '</div><p class="pop-text">Local time ' + hhmm(e.o.t) + ' · ' + esc(c.txt) + ' Dubai time</p>' +
      '<ul class="chg-list">' + e.jobs.map((j) => '<li><button type="button" data-fl-open="' + esc(j.jobNo) + '">' + changedDot(j) + '<b>' + esc(j.jobNo) + '</b><span class="chg-who">' + esc(j.customer || '—') + '</span><span class="chg-what">' + esc(j.route) + ' · ' + esc(rowNext(j).text) + '</span></button></li>').join('') + '</ul>';
  };

  // ================================================================ v2.9.1 — the side panel: each list made for what it counts
  const rel91 = (d, t0) => { if (!d) return 'to confirm'; const n = days(t0, d); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? 'in ' + n + ' days' : (-n) + ' days ago'; };
  function drawerList91(kind, list, m) {
    const t0 = today0();
    const main = (j, below) => '<span class="dr-main"><span class="dr-job">' + changedDot(j) + esc(j.jobNo) + '<span class="badge">' + esc(j.type) + '</span></span>' +
      '<span class="dr-cust">' + esc(j.customer || '—') + '</span><span class="dr-route">' + esc(j.mode === 'misc' ? 'COSTING ONLY' : j.route) + '</span>' + (below || '') + '</span>';
    const side = (k, d, sub, tone, extra) => '<span class="dr-side' + (tone ? ' is-' + tone : '') + '"><span class="dr-k">' + k + '</span><b>' + (d ? esc(fmt(d)) : '—') + '</b>' + (sub ? '<span class="dr-s">' + esc(sub) + '</span>' : '') + (extra || '') + '</span>';
    const row = (j, below, right, attr) => '<button type="button" class="dr-row" ' + (attr || 'data-job="' + esc(j.jobNo) + '"') + '>' + main(j, below) + right + '</button>';
    const group = (label, rows, tone) => (rows.length ? '<div class="dr-gh' + (tone ? ' is-' + tone : '') + '"><span>' + label + '</span><b>' + rows.length + '</b></div>' + rows.join('') : '');
    const tm = (d) => (d ? +d : 9e15);
    const when = (j) => {
      const st = j.mode === 'misc' ? 'nodate' : stageOf91(j, t0);
      return st === 'before' ? side(j.mode === 'courier' ? 'PICK-UP' : 'ETD', j.etd, j.etd ? rel91(j.etd, t0) : 'to confirm')
        : st === 'sea' ? side('ETA', j.eta, rel91(j.eta, t0)) : st === 'arrived' ? side('ARRIVED', j.eta, rel91(j.eta, t0)) : side('DATES', null, j.mode === 'misc' ? 'costing only' : 'to confirm');
    };
    const next = (j) => '<span class="dr-next">' + toneChip(rowNext(j)) + '</span>';
    let html = '';
    if (kind === 'active') {
      const by = { before: [], sea: [], arrived: [], nodate: [] };
      list.forEach((j) => by[j.mode === 'misc' ? 'nodate' : stageOf91(j, t0)].push(j));
      by.before.sort((a, b) => tm(a.etd) - tm(b.etd)); by.sea.sort((a, b) => tm(a.eta) - tm(b.eta)); by.arrived.sort((a, b) => tm(b.eta) - tm(a.eta));
      html = STAGES91.map(([id, label]) => group(id === 'nodate' ? 'NO DATES YET' : label, by[id].map((j) => row(j, next(j), when(j))))).join('');
    } else if (kind === 'costing') {
      const due = (j) => costDue91(j, t0);
      const tag = (j) => { const s = costState(j); return '<span class="dr-tag is-' + s + '">' + (s === 'draft' ? 'Draft' : 'Pending') + '</span>'; };
      const r = (j) => row(j, '', due(j) ? side(j.arrived ? 'ARRIVED' : j.mode === 'air' ? 'DEPARTED' : 'SAILED', j.arrived ? j.eta : j.etd, rel91(j.arrived ? j.eta : j.etd, t0), 'red', tag(j)) : (costByArrival91(j) && j.eta ? side('ETA', j.eta, rel91(j.eta, t0), '', tag(j)) : side('ETD', j.etd, j.etd ? rel91(j.etd, t0) : j.mode === 'misc' ? 'costing only' : 'to confirm', '', tag(j))), 'data-cost="' + esc(j.jobNo) + '"');
      const at = (j) => tm(costByArrival91(j) ? j.eta : j.etd);
      html = group('SAILED OR ARRIVED', list.filter(due).sort((a, b) => at(a) - at(b)).map(r), 'red') + group('NOT DUE YET', list.filter((j) => !due(j)).sort((a, b) => at(a) - at(b)).map(r));
    } else if (kind === 'sied') {
      const item = (j) => {
        const sailed = !!(j.etd && j.etd < t0), C = cutsFor(j, t0);
        const one = (k, v, show, ck) => {
          if (!show || v === NA) return { h: '', d: 99 };
          if (v && v !== 'PENDING') return { h: '<span class="cut-chip is-done"><b>' + k + '</b>✓</span>', d: 99 };
          if (sailed) return { h: '<span class="cut-chip is-red"><b>' + k + '</b>SAILED</span>', d: -99 };
          const c = C.find((x) => x.k === (ck || k));
          return c ? { h: '<span class="cut-chip is-' + c.tone + '"><b>' + k + '</b>' + esc(cutWhen(c.d, c.date)) + '</span>', d: c.d } : { h: '<span class="cut-chip is-calm"><b>' + k + '</b>NO CUTOFF</span>', d: 50 };
        };
        const si = one('SI', j.sido, true), ed = one('ED', j.ed, j.cat === 'EXPORT'), dg = one('DGPC', j.dgpc, j.cat === 'EXPORT' && j.dg === 'DG' && j.mode === 'sea', 'DG'), d = Math.min(si.d, ed.d, dg.d);
        return { j, d, h: row(j, '', '<span class="dr-side is-cuts">' + si.h + ed.h + dg.h + '</span>') };
      };
      const L = list.map(item).sort((a, b) => a.d - b.d);
      html = group('OVERDUE OR WITHIN 24 H', L.filter((x) => x.d <= 1).map((x) => x.h), 'red') + group('NEXT 3 DAYS', L.filter((x) => x.d > 1 && x.d <= 3).map((x) => x.h), 'amber') + group('LATER', L.filter((x) => x.d > 3).map((x) => x.h));
    } else if (kind === 'free') {
      html = list.slice().sort((a, b) => tm(a.lineFreeEnd) - tm(b.lineFreeEnd)).map((j) => {
        const d = days(t0, j.lineFreeEnd);
        return row(j, '<span class="dr-note">Arrived ' + esc(fmt(j.eta)) + ' · ' + esc(rel91(j.eta, t0)) + '</span>',
          '<span class="dr-side is-' + (d <= 1 ? 'red' : 'amber') + '"><span class="dr-k">LINE FREE TIME</span><b>' + (d < 0 ? 'over ' + (-d) + (d === -1 ? ' day' : ' days') : d === 0 ? 'ends today' : d + (d === 1 ? ' day left' : ' days left')) + '</b><span class="dr-s">until ' + esc(fmt(j.lineFreeEnd)) + '</span></span>');
      }).join('');
    } else if (kind === 'hold') {
      html = list.slice().sort((a, b) => tm(a.etd) - tm(b.etd)).map((j) => row(j, j.remarks ? '<span class="dr-note">“' + esc(j.remarks) + '”</span>' : '', when(j))).join('');
    } else if (kind === 'watch') {
      html = m.watch.map((w) => row(w.j, '<span class="dr-next"><span class="dr-what">' + esc(w.say) + '</span></span>', '<span class="dr-side is-' + (w.level === 'urgent' ? 'red' : 'amber') + '"><b>' + esc(w.when) + '</b></span>')).join('');
    } else if (kind === 'week') {
      const pick = wkPick92(t0);
      const ev = m.departing.map((j) => ({ j, d: j.etd, k: 'dep' })).concat(m.arriving.map((j) => ({ j, d: j.eta, k: 'arr' }))).filter((e) => !pick || +dayOf(e.d) === +pick).sort((a, b) => a.d - b.d);
      html = ev.map((e) => row(e.j, '', side(e.k === 'arr' ? 'ARRIVES' : e.j.mode === 'air' ? 'DEPARTS' : 'SAILS', e.d, rel91(e.d, t0), e.k === 'arr' ? 'teal' : ''))).join('');
    } else if (kind === 'atsea') {
      html = list.map((j) => row(j, '<span class="dr-note">Day ' + j.dayN + ' of ' + j.dayT + '</span>', side('ETA', j.eta, rel91(j.eta, t0)))).join('');
    } else {
      html = list.map((j) => row(j, next(j), when(j))).join('');
    }
    return html ? '<div class="dr-list">' + html + '</div>' : '<div class="tile-empty">Nothing here right now.</div>';
  }
  // ================================================================ v2.9.1 — Word: your active jobs, by sales person
  // A4 landscape. The logo and the title on every page; one table per sales person (S.No · Job no. · Customer ·
  // Containers · POL → POD · Current status), its heading row repeated when a table runs onto the next page;
  // a job never splits across pages. Status = where the shipment is · BL (AWB) · costing.
  function jobStatus91(j, t0) {
    const air = j.mode === 'air', cr = j.mode === 'courier';
    const d = (x) => x.getDate() + ' ' + MON91[x.getMonth()];
    let where;
    if (j.mode === 'misc') where = 'Costing only';
    else if (j.eta && j.eta <= t0) where = (cr ? 'Delivered ' : 'Arrived ') + d(j.eta);
    else if (j.etd && j.etd <= t0) where = (air ? 'Departed ' : cr ? 'Picked up ' : 'Sailed ') + d(j.etd);
    else if (j.etd) where = (air ? 'Departs ' : cr ? 'Pick-up ' : 'Sails ') + d(j.etd);
    else where = (cr ? 'Pick-up' : 'ETD') + ' to confirm';
    const k = air ? 'AWB' : cr ? 'Tracking' : 'BL', v = j.bl;
    const bl = j.mode === 'misc' || v === NA ? '' : !v || v === 'BL PENDING' ? k + ' pending' : v === 'CONFIRMATION PENDING' ? k + ' to confirm'
      : /^CONFIRMED/.test(v) ? (air || cr ? k + ' confirmed' : v.slice(10) + ' confirmed') : /ISSUED$/.test(v) ? (air || cr ? k + ' issued' : v.slice(0, 3) + ' issued') : nice(v);
    const cs = costState(j), cost = cs === 'none' ? '' : 'Costing ' + (cs === 'draft' ? 'draft' : cs === 'done' ? 'done' : 'pending');
    const dgpc = j.cat === 'EXPORT' && j.dg === 'DG' && j.mode === 'sea' && j.dgpc !== NA ? (['SUBMITTED', 'APPROVED'].includes(j.dgpc) ? '' : 'DGPC pending') : '';
    return { hold: j.hold, where, rest: [bl, dgpc, cost].filter(Boolean) };
  }
  async function jobsWord91() {
    const t0 = today0(), X = XL.X, jobs = scoped().filter((j) => j.active);
    if (!jobs.length) { toast('No active jobs to put in the file'); return; }
    const groups = new Map();
    jobs.slice().sort((a, b) => String(a.jobNo).localeCompare(String(b.jobNo), 'en', { numeric: true })).forEach((j) => { const k = j.sales || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(j); });
    const names = Array.from(groups.keys()).sort((a, b) => (!a) - (!b) || a.localeCompare(b));
    const logo = await costLogo(), sz = logo ? XL.pngSize(logo) : null;
    const day = t0.getDate() + ' ' + MON91[t0.getMonth()] + ' ' + t0.getFullYear();
    const NAVY = '1C5179', INK = '0B1B2B', INK2 = '3E4C5E', MUTE = '6B7A8A', HAIR = 'DFE6ED', FOG = 'F3F6F9', TEAL = '0E7C7B', RED = 'B42318';
    const W = 15138, COLS = [600, 1650, 3900, 1700, 3200, 4088];
    const rPr = (o) => '<w:rPr>' + (o.b ? '<w:b/><w:bCs/>' : '') + (o.caps ? '<w:caps/>' : '') + '<w:color w:val="' + (o.c || INK) + '"/>' + (o.sp ? '<w:spacing w:val="' + o.sp + '"/>' : '') + '<w:sz w:val="' + (o.sz || 18) + '"/><w:szCs w:val="' + (o.sz || 18) + '"/></w:rPr>';
    const run = (t, o) => '<w:r>' + rPr(o || {}) + '<w:t xml:space="preserve">' + X(t) + '</w:t></w:r>';
    const para = (runs, o) => { o = o || {}; return '<w:p><w:pPr>' + (o.keep ? '<w:keepNext/>' : '') + '<w:spacing w:before="' + (o.before || 0) + '" w:after="' + (o.after || 0) + '" w:line="' + (o.line || 252) + '" w:lineRule="auto"/>' + (o.jc ? '<w:jc w:val="' + o.jc + '"/>' : '') + '</w:pPr>' + runs + '</w:p>'; };
    const cell = (w, content, o) => { o = o || {}; return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + (o.border ? '<w:tcBorders><w:bottom w:val="single" w:sz="8" w:space="0" w:color="' + NAVY + '"/></w:tcBorders>' : '') + (o.fill ? '<w:shd w:val="clear" w:color="auto" w:fill="' + o.fill + '"/>' : '') + '<w:vAlign w:val="' + (o.v || 'top') + '"/></w:tcPr>' + content + '</w:tc>'; };
    const head = ['S.NO', 'JOB NO.', 'CUSTOMER', 'CONTAINERS', 'POL → POD', 'CURRENT STATUS'];
    const headRow = '<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' + head.map((h, i) => cell(COLS[i], para(run(h, { b: true, c: INK2, sz: 14, sp: 10 }), { jc: i === 0 ? 'center' : 'left' }), { fill: FOG, border: true, v: 'bottom' })).join('') + '</w:tr>';
    const jobRow = (j, n) => {
      const st = jobStatus91(j, t0);
      const status = (st.hold ? run('On hold', { b: true, c: RED }) + run(' · ', { c: MUTE }) : '') + run(st.where, { b: true, c: NAVY }) + st.rest.map((x) => run(' · ', { c: MUTE }) + run(x, { c: INK2 })).join('');
      const route = j.mode === 'misc' ? 'Costing only' : !j.pol && !j.pod ? '—' : (j.pol ? portName91(j.pol) : '—') + ' → ' + (j.pod ? portName91(j.pod) : '—');
      return '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
        cell(COLS[0], para(run(String(n), { c: MUTE }), { jc: 'center' })) + cell(COLS[1], para(run(j.jobNo, { b: true }))) +
        cell(COLS[2], para(run(j.customer || '—'))) + cell(COLS[3], para(run(j.cargo || (j.mode === 'air' ? 'Air' : j.mode === 'courier' ? 'Courier' : '—'), { c: INK2 }))) +
        cell(COLS[4], para(run(route, { c: INK2 }))) + cell(COLS[5], para(status)) + '</w:tr>';
    };
    const table = (list) => '<w:tbl><w:tblPr><w:tblW w:w="' + W + '" w:type="dxa"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="' + HAIR + '"/><w:right w:val="nil"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="' + HAIR + '"/><w:insideV w:val="nil"/></w:tblBorders>' +
      '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="70" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0420" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
      '<w:tblGrid>' + COLS.map((c) => '<w:gridCol w:w="' + c + '"/>').join('') + '</w:tblGrid>' + headRow + list.map((j, i) => jobRow(j, i + 1)).join('') + '</w:tbl>';
    const who = isSales() ? 'Sales · ' + nice(state.user) : 'Customer Service · ' + nice(state.user);
    let body = para(run(jobs.length + (jobs.length === 1 ? ' active job' : ' active jobs'), { b: true, sz: 20 }) + run('   ·   ' + names.length + (names.length === 1 ? ' sales person' : ' sales persons') + '   ·   ' + who, { c: MUTE, sz: 18 }), { after: 60 });
    names.forEach((k, gi) => {
      const list = groups.get(k);
      body += para(run(k ? nice(k) : 'No sales person', { b: true, c: NAVY, sz: 24 }) + run('   ' + list.length + (list.length === 1 ? ' job' : ' jobs'), { c: MUTE, sz: 17 }), { keep: true, before: gi ? 360 : 240, after: 100 }) + table(list);
    });
    const sect = '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1300" w:right="850" w:bottom="1000" w:left="850" w:header="420" w:footer="420" w:gutter="0"/><w:cols w:space="720"/></w:sectPr>';
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const DNS = NS + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
    const XMLH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const doc = XMLH + '<w:document ' + NS + '><w:body>' + body + para('') + sect + '</w:body></w:document>';   // Word wants a paragraph after the last table
    const E = 360000, lh = Math.round(0.95 * E), lw = sz ? Math.round(lh * sz[0] / sz[1]) : 0;
    const pic = sz ? '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + lw + '" cy="' + lh + '"/><wp:docPr id="1" name="ETHIX logo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + lw + '" cy="' + lh + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>' : run('ETHIX SHIPPING', { b: true, c: NAVY, sz: 22 });
    const hcell = (w, content, jc) => '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/><w:vAlign w:val="bottom"/></w:tcPr>' + content + '</w:tc>';
    const header = XMLH + '<w:hdr ' + DNS + '><w:tbl><w:tblPr><w:tblW w:w="' + W + '" w:type="dxa"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="8" w:space="0" w:color="' + NAVY + '"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="' + (W / 2) + '"/><w:gridCol w:w="' + (W / 2) + '"/></w:tblGrid><w:tr>' +
      hcell(W / 2, para(pic)) + hcell(W / 2, para(run('ACTIVE JOBS', { b: true, c: INK, sz: 26, sp: 20 }), { jc: 'right' }) + para(run(day.toUpperCase() + ' · BY SALES PERSON', { b: true, c: TEAL, sz: 15, sp: 10 }), { jc: 'right' })) +
      '</w:tr></w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p></w:hdr>';
    const fld = (code) => '<w:fldSimple w:instr=" ' + code + ' "><w:r>' + rPr({ c: MUTE, sz: 15 }) + '<w:t>1</w:t></w:r></w:fldSimple>';
    const footer = XMLH + '<w:ftr ' + NS + '><w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="' + HAIR + '"/></w:pBdr><w:tabs><w:tab w:val="right" w:pos="' + W + '"/></w:tabs><w:spacing w:before="0" w:after="0"/></w:pPr>' +
      run('ETHIX · Active jobs · ' + day + ' · ' + who, { c: MUTE, sz: 15 }) + '<w:r>' + rPr({ c: MUTE, sz: 15 }) + '<w:tab/></w:r>' + run('Page ', { c: MUTE, sz: 15 }) + fld('PAGE') + run(' of ', { c: MUTE, sz: 15 }) + fld('NUMPAGES') + '</w:p></w:ftr>';
    const styles = XMLH + '<w:styles ' + NS + '><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:color w:val="' + INK + '"/><w:sz w:val="18"/><w:szCs w:val="18"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>';
    const settings = XMLH + '<w:settings ' + NS + '><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';
    const rel = (id, type, target) => '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type + '" Target="' + target + '"/>';
    const RELS = (inner) => XMLH + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + inner + '</Relationships>';
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const files = [
      { name: '[Content_Types].xml', data: XMLH + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + (sz ? '<Default Extension="png" ContentType="image/png"/>' : '') +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
        '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' },
      { name: '_rels/.rels', data: RELS('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>') },
      { name: 'docProps/core.xml', data: XMLH + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>ETHIX active jobs ' + X(day) + '</dc:title><dc:creator>' + X(state.user) + '</dc:creator><cp:lastModifiedBy>' + X(state.user) + '</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>' },
      { name: 'docProps/app.xml', data: XMLH + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>ETHIX</Application></Properties>' },
      { name: 'word/document.xml', data: doc },
      { name: 'word/styles.xml', data: styles },
      { name: 'word/settings.xml', data: settings },
      { name: 'word/header1.xml', data: header },
      { name: 'word/footer1.xml', data: footer },
      { name: 'word/_rels/document.xml.rels', data: RELS(rel('rIdS', 'styles', 'styles.xml') + rel('rIdT', 'settings', 'settings.xml') + rel('rIdH', 'header', 'header1.xml') + rel('rIdF', 'footer', 'footer1.xml')) }
    ];
    if (sz) { files.push({ name: 'word/_rels/header1.xml.rels', data: RELS(rel('rIdLogo', 'image', 'media/logo.png')) }); files.push({ name: 'word/media/logo.png', data: logo }); }
    try {
      const blob = XL.zip(files, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const name = 'ETHIX_Active_jobs_' + day.replace(/ /g, '-') + '.docx';
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      toast('Word file ready · ' + name);
    } catch (e) { toast('The Word file could not be made: ' + e.message, { error: true }); }
  }

  function initV291() {
    // the port offices move with the clock
    setInterval(() => { const po = $('#portOffices'); if (po && state.route && state.route.name === 'home') { po.outerHTML = portOffices(''); fitPorts91(); } }, 60000);
    window.addEventListener('resize', () => { if (state.route && state.route.name === 'home') fitPorts91(); });
    document.addEventListener('click', (e) => {
      if (!state.signedIn) return;
      const op = e.target.closest('[data-fl-open]'); if (op) { closeOverlays(true); openJob(op.dataset.flOpen); return; }
      const pc = e.target.closest('[data-port91]'); if (pc) { openPop(pc, 'POD OFFICE', portJobsPop91(pc.dataset.port91)); return; }
      const pa = e.target.closest('[data-act="ports-all"]'); if (pa) { openPop(pa, 'POD OFFICE HOURS', portsPop91()); return; }
      if (e.target.closest('[data-act="changed"]')) { openPop(e.target.closest('[data-act="changed"]'), 'MY DAY', changedMenu()); return; }
      if (e.target.closest('[data-act="seen-all"]')) {
        const keep = state.seen; state.seen = { _base: Date.now() }; closeOverlays(true); rerender();
        api.call('ethixSeenAll').then((r) => { if (r && r.seen) state.seen = r.seen; }).catch(() => { state.seen = keep; rerender(); });
        toast('All marked as seen'); return;
      }
      if (e.target.closest('[data-act="rem-late"]')) { go('#/follow-ups'); return; }
      if (e.target.closest('[data-act="jobs-word"]')) { jobsWord91(); return; }
      const wd = e.target.closest('[data-wkday]');
      if (wd) { state.wkDay92 = wd.dataset.wkday && wd.dataset.wkday !== state.wkDay92 ? wd.dataset.wkday : ''; rerender(); return; }
      const ra = e.target.closest('[data-act="rem-add"]'); if (ra && canNote()) { remOpenForm(ra, null, ra.dataset.remJob || ''); return; }
      const rd = e.target.closest('[data-rem-done]'); if (rd) { const r = (state.reminders || []).find((x) => x.id === rd.dataset.remDone); if (r) remDone(r.id, r.status !== 'DONE'); return; }
      const re = e.target.closest('[data-rem-edit]'); if (re) { const r = (state.reminders || []).find((x) => x.id === re.dataset.remEdit); if (r) remOpenForm(re, r); return; }
      const rday = e.target.closest('[data-rem-day]'); if (rday && state.remForm) { state.remForm.due = rday.dataset.remDay; refreshOverlay(); return; }
      const rrep = e.target.closest('[data-rem-rep]'); if (rrep && state.remForm) { state.remForm.repeat = rrep.dataset.remRep; refreshOverlay(); return; }
      const rsz = e.target.closest('[data-rem-snooze]'); if (rsz && state.remForm) { const d = addDays(today0(), +rsz.dataset.remSnooze); const F = Object.assign({}, state.remForm, { due: isoOf(d) }); remSave(F, 'Snoozed'); return; }
      const rdl = e.target.closest('[data-rem-del]'); if (rdl) { remDelete(rdl.dataset.remDel); return; }
    });
    document.addEventListener('input', (e) => {
      const F = state.remForm, id = e.target.id;
      if (F && ['remText', 'remDue', 'remTime', 'remJob'].includes(id)) { F[{ remText: 'text', remDue: 'due', remTime: 'time', remJob: 'job' }[id]] = e.target.value; if (id === 'remDue') refreshOverlay(); }
    });
    document.addEventListener('submit', (e) => {
      const f = e.target.closest('[data-rem-form]'); if (!f) return;
      e.preventDefault();
      if (state.remForm) remSave(state.remForm);
    });
  }

  // ------------------------------------------------------------ lists & menus
  function openList(kind, opener) {
    const m = lastMetrics; if (!m) return;
    const map = {
      active: ['ACTIVE JOBS', m.active], costing: ['COSTING DUE', m.costing], sied: ['SI / ED DUE', m.sied],
      free: ['FREE TIME ENDING ≤ 2 DAYS', m.freeJobs], atsea: ['AT SEA NOW', m.atSea], arriving: ['ARRIVING THIS WEEK', m.arriving],
      departing: ['DEPARTING THIS WEEK', m.departing], hold: ['ON HOLD', m.hold], watch: ['TODAY’S WATCH', m.watch.map((w) => w.j)], week: weekPanel92(m),
      behind: ['NOT FOLLOWED UP YET', isSales() ? behindList() : []]
    };
    const entry = map[kind]; if (!entry) return;
    const list = Array.from(new Set(entry[1]));
    closeOverlays(true);
    $('#drawerKicker').textContent = (kind === 'watch' ? m.watch.length + (m.watch.length === 1 ? ' TASK' : ' TASKS') : list.length + (list.length === 1 ? ' JOB' : ' JOBS'));
    $('#drawerBody').innerHTML = '<h2 class="peek-job list-title" id="drawerTitle">' + esc(entry[0]) + '</h2>' + drawerList91(kind, list, m);
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
      .sort((a, b) => (b.active - a.active) || (canEdit() ? (b.cs === state.user) - (a.cs === state.user) : 0) || ((b.jobNo.toUpperCase().startsWith(q) ? 1 : 0) - (a.jobNo.toUpperCase().startsWith(q) ? 1 : 0)))
      .slice(0, 8);
    searchIndex = -1;
    box.innerHTML = hits.length ? hits.map((j) =>
      '<button type="button" class="result" data-job="' + esc(j.jobNo) + '"><span class="result-job">' + esc(j.jobNo) + '</span><span class="result-cust">' + esc(j.customer || '—') + '</span><span class="result-route">' + esc(j.route) + ' · ' + esc(j.type) + (j.active ? '' : ' · ' + esc(j.status)) + (canEdit() && j.cs !== state.user ? ' · ' + (j.cs ? 'WITH ' + esc(j.cs) : 'UNASSIGNED') : '') + '</span></button>'
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
      if (['form', 'pop', 'sheet', 'admin', 'delay', 'enqform', 'close'].includes(state.overlay)) state.dirty = true;
      else { rerender(); refreshOverlay(); }
      updateNav();
      const fresh = state.notif ? state.notif.items.filter((x) => x.t > newest && x.t > (state.notif.seen || 0)) : [];
      state.nudged = fresh.length && notifUnread() > before && state.overlay !== 'drawer' && !(state.route && state.route.name === 'notif');
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
    if (state.resuming) return;
    if (ending) return; ending = true; api.token = null; dropSession();
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
    $('#confirmYes').onclick = () => { api.logout(); dropSession(); document.body.style.opacity = '0.6'; history.replaceState(null, '', location.pathname + location.search); setTimeout(() => window.location.reload(), 250); };
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
    });
    view.addEventListener('scroll', (e) => { if (e.target.classList && e.target.classList.contains('tile-body')) markOverflow(); }, true);
    window.addEventListener('resize', () => { if (!$('#shell').hidden) { markOverflow(); fitNames(); } });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitNames);
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
      if (e.target.closest('[data-act="new-enq"]')) { openNewEnquiry(); return; }
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
      if (['form', 'sheet', 'quick', 'admin', 'delay', 'enqform', 'close'].includes(state.overlay)) return;
      const jobBtn = e.target.closest('[data-job]'); if (jobBtn) { openJob(jobBtn.dataset.job); return; }
      if (e.target.closest('[data-act="logout"]')) { closeOverlays(true); confirmLogout(); }
    });
    $('#drawerClose').addEventListener('click', () => closeOverlays());
    $('#scrim').addEventListener('click', () => closeOverlays());
    $('#logoutBtn').addEventListener('click', confirmLogout);
    window.addEventListener('hashchange', () => { if (!state.signedIn) return; if (leaveGuard()) return; state.navDepth++; closeOverlays(true); render(false); });
  }

  // -------------------------------------------------------------------- start
  function start() {
    if (savedSession()) document.body.classList.add('is-resuming');
    initSignin();
    initApp();
    initJobs();
    initVoyage();
    initForms();
    initPeople();
    initPhase4();
    initV25();
    initV26();
    if (savedSession()) resumeSession();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // exposed for automated tests only (no data, no token)
  window.__ethix = { parseDate, mapHeaders, buildJob, computeHome, today0, journeyFor, nextStep, costWorkbook, voyage: () => ({ running: voyage.running, leg: voyage.leg, phase: voyage.phase }) };
})();
