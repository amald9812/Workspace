/* =============================================================================
   ETHIX v2 — APP (sign-in, Home, Jobs, voyage, new job, people, notifications,
   enquiries, follow-ups, delays, close & archive, costing, reminders, cover, system health, arrange Home, document reader, for Dubai Trade, BL check, view access — v2.9.20)
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
      if (state.role === 'VIEW' && !['ethixBootstrap', 'ethixJobStory', 'ethixCosting', 'ethixArchiveSearch', 'ethixArchivedJob', 'ethixPing'].includes(fn)) return null;   // v2.9.20: a viewer only reads
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
    ['sido', (h) => h.startsWith('SI /') || h.startsWith('SI/'), 16], ['ed', (h) => h === 'ED STATUS', 17], ['bl', (h) => h.startsWith('BL') && !/\bNO\b|NUMBER/.test(h), 18],
    ['delivery', (h) => h.startsWith('DELIVERY'), 19], ['docs', (h) => h.startsWith('ORIGINAL DOC'), 20], ['costing', (h) => h.includes('COSTING'), 21],
    ['sales', (h) => h.startsWith('SALES'), 22], ['eta', (h) => h.startsWith('ETA'), 23], ['pol', (h) => h === 'POL', 24],
    ['edCut', (h) => h.startsWith('ED CUTOFF'), 25], ['dgCut', (h) => h.startsWith('DG CUTOFF'), 26], ['lineFree', (h) => h.startsWith('LINE FREE'), 27],
    ['portFree', (h) => h.startsWith('PORT FREE'), 28], ['against', (h) => h.startsWith('AGAINST'), 29], ['freight', (h) => h.startsWith('LINE FREIGHT'), 30],
    ['dgpc', (h) => h.startsWith('DGPC'), -1],   // v2.9.2: added at the end of the tracker on first use
    ['switchBl', (h) => h.startsWith('SWITCH BL'), -1],   // v2.9.3: the same
    ['blNo', (h) => /^BL \/ AWB NO\b/.test(h), -1], ['invoice', (h) => h.startsWith('INVOICE'), -1]   // v2.9.8: the same
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
      loadlist: g('loadlist').toUpperCase(), sido: g('sido').toUpperCase(), ed: g('ed').toUpperCase(), bl: g('bl').toUpperCase(), dgpc: g('dgpc').toUpperCase(), switchBl: g('switchBl').toUpperCase(),
      docs: g('docs').toUpperCase(), costing: g('costing').toUpperCase(), blNo: g('blNo').toUpperCase(), invoice: g('invoice').toUpperCase(),
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
    bl: ['BL PENDING', 'CONFIRMATION PENDING', 'CONFIRMED OBL', 'CONFIRMED SBL', 'OBL ISSUED', 'SBL ISSUED', 'OBL SHARED TO CUSTOMER', 'SBL SHARED TO CUSTOMER', NA],   // v2.9.8: shared to customer
    docs: [NA, 'PENDING', 'RECEIVED'],
    dgpc: ['PENDING', 'SUBMITTED', 'APPROVED', NA],
    switchBl: ['NO', 'REQUESTED', 'CONFIRMATION PENDING', 'CONFIRMED', 'ISSUED'],
    costing: ['PENDING', 'JOB UPDATED', 'COSTING DONE', 'COMPLETED', 'CANCELLED'],
    dg: ['DG', 'NON DG'],
    type: ['SFEF', 'SFEL', 'AFE', 'SFIF', 'SFIL', 'AFI', 'CND', 'SFC', 'AFC', 'CRR', 'MIS']
  };
  const BL_OK = ['CONFIRMED OBL', 'CONFIRMED SBL', 'OBL ISSUED', 'SBL ISSUED', 'OBL SHARED TO CUSTOMER', 'SBL SHARED TO CUSTOMER'];
  const BL_ISSUED = ['OBL ISSUED', 'SBL ISSUED', 'OBL SHARED TO CUSTOMER', 'SBL SHARED TO CUSTOMER'];   // v2.9.8: shared = issued and sent
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
    blFinal:    { name: 'Final BL issued', kind: 'field', field: 'bl', done: BL_ISSUED, primary: 'SBL ISSUED', choices: ['CONFIRMED OBL', 'CONFIRMED SBL', 'OBL ISSUED', 'SBL ISSUED', NA], label: 'BL status', next: 'Final BL pending' },
    switchBl:   { name: 'Switch BL issued', kind: 'field', field: 'switchBl', done: ['ISSUED'], skip: ['NO', ''], primary: 'ISSUED', choices: ['REQUESTED', 'CONFIRMATION PENDING', 'CONFIRMED', 'ISSUED', 'NO'], label: 'Switch BL', next: 'Switch BL pending' },
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
    SEA_IM: { o: ['opened', 'blConf', 'sailed'], t: ['atSea', 'blFinal'], d: ['arrived', 'discharge', 'doRel', 'customs', 'delivered', 'costing', 'completed'], w: [26, 32, 42] },
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
    if (d >= 2 && d <= off911()) return 'CUTOFF ' + dayLong911(d).toUpperCase();   // v2.9.9: Friday → Sunday · v2.9.11: + UAE holidays
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
    const transit = (swOn93(j) ? J.t.concat('switchBl') : J.t).map((id) => make(id, 't'));   // v2.9.3: switch BL after the BL
    const dest = J.d.map((id) => make(id, 'd'));
    const all = origin.concat(transit, dest);
    swBl93(j, all);   // v2.9.3: a switch BL job's main BL is an OBL
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
    if (cut && cut.cutDays >= 1 && cut.cutDays <= off911(t0)) return { text: cut.def.next.replace(/ to .*/, '') + ' cutoff ' + dayLong911(cut.cutDays, t0), tone: 'urgent', rank: 0 };   // v2.9.9: Friday · v2.9.11: + UAE holidays
    if (j.cat === 'IMPORT' && j.arrived && !j.delivery && j.lineFreeEnd) {
      const d = days(t0, j.lineFreeEnd);
      if (d < 0) return { text: 'Free time over · ' + (-d) + (d === -1 ? ' day' : ' days'), tone: 'urgent', rank: 0 };
      if (d <= 2) return { text: 'Free time: ' + (d === 0 ? 'ends today' : d + (d === 1 ? ' day left' : ' days left')), tone: 'urgent', rank: 0 };
    }
    if (j.cat === 'IMPORT' && j.arrived && !j.delivery && j.portFreeEnd) {   // v2.9.9: port free time too
      const d = days(t0, j.portFreeEnd);
      if (d < 0) return { text: 'Port free over · ' + (-d) + (d === -1 ? ' day' : ' days'), tone: 'urgent', rank: 0 };
      if (d <= 2) return { text: 'Port free: ' + (d === 0 ? 'ends today' : d + (d === 1 ? ' day left' : ' days left')), tone: 'urgent', rank: 0 };
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

  function computeHome(jobs, t0) {
    const active = jobs.filter((j) => j.active);
    const watch = watchItems91(active, t0);   // v2.9.1: every open task before sailing, overdue after it, free time

    const atSea = active.filter((j) => j.atSea || (j.eta && cndWay95(j, t0))).sort((a, b) => a.eta - b.eta);   // v2.9.5: + CND on its way in
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
      costingDue: costing.filter((j) => costDueBy99(j, t0)), siedDue: sied.filter((j) => siedD99(j, t0) <= due99(t0)),   // v2.9.9: due by tomorrow (Friday: Sunday)
      costingSailed: costing.filter((j) => j.etd && j.etd < t0).length,
      deadlines: watch.filter((w) => w.level !== 'calm').length
    };
  }

  // ----------------------------------------------------------------- icons
  const I = {
    home: '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>',
    jobs: '<path d="M3 6h18M3 12h18M3 18h12"/>',
    enq: '<path d="M4 4h16v12H8l-4 4z"/>',
    costing: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h3"/>',
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

  // ==================================================================== v2.9.20 — VIEW ACCESS
  // A Customer Service user gives a one-time code (My account → VIEW ACCESS); whoever signs in with it sees only that user's
  // jobs, read only, until 6 PM Dubai (6 hours after a code given at / after 6 PM). The server refuses every change; the page
  // also never asks for anything a viewer may not read (no notifications, reminders, seen marks, lists, search in remarks).
  const isView = () => state.role === 'VIEW';
  const VW920 = { d: null, off: 0, busy: false, t: 0 };   // the code on screen (Customer Service)
  const EYE920 = (s) => '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  function vwInfo920() { const v = state.view920 || {}; return { g: v.g || state.user || '', code: v.code || '', until: v.untilText || '' }; }
  function vwBand920() {   // VIEW ONLY · AMAL’S JOBS · code 482 913
    let b = $('#vwBand920');
    if (!isView()) { if (b) b.remove(); document.body.classList.remove('is-view920'); return; }
    const v = vwInfo920();
    if (!b) { b = document.createElement('div'); b.id = 'vwBand920'; b.className = 'vw920-band'; b.setAttribute('role', 'status'); $('#shell').prepend(b); b.addEventListener('click', (e) => { if (e.target.closest('[data-vw920="leave"]')) confirmLogout(); }); }
    document.body.classList.add('is-view920');
    b.innerHTML = '<span class="vw920-eye">' + EYE920(16) + '</span>' +
      '<span class="vw920-txt"><span class="vw920-l1"><b>VIEW ONLY</b><i aria-hidden="true"> · </i><span>' + esc(v.g) + '’S JOBS</span><i class="vw920-sep" aria-hidden="true"> · </i></span><span class="vw920-c">code ' + esc(v.code) + '</span></span>' +
      (v.until ? '<span class="vw920-until">Until ' + esc(v.until) + ' Dubai</span>' : '') +
      '<button type="button" class="vw920-leave" data-vw920="leave">Leave</button>';
  }
  function vwAcct920() {   // My account for a viewer
    const v = vwInfo920();
    return '<div class="vw920-acct"><span class="vw920-acc-ic">' + EYE920(22) + '</span><div class="acct-name" id="drawerTitle">View only</div>' +
      '<dl class="vw920-dl"><dt>JOBS</dt><dd>' + esc(v.g) + '</dd><dt>CODE</dt><dd class="m">' + esc(v.code) + '</dd><dt>UNTIL</dt><dd>' + esc(v.until) + ' Dubai</dd></dl></div>' +
      '<button type="button" class="btn-ghost acct-logout" data-vw920="leave">' + icon('logout', 16) + 'Leave</button>';
  }
  // ---------- Customer Service: give view access ----------
  function vwLeft920() { if (!VW920.d) return 0; return Math.max(0, VW920.d.useBy - (Date.now() + VW920.off)); }
  const vwMmss920 = (ms) => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function vwGiveHtml920() {
    const d = VW920.d, left = vwLeft920();
    const head = '<h3 class="tile-title">VIEW ACCESS</h3>';
    if (!d) return head + '<p class="vw920-lead">A one-time code shows your jobs to someone — view only, until ' + (dxb().getHours() < 18 ? '6:00 PM' : 'six hours from now') + ' Dubai.</p>' +
      '<button type="button" class="btn-brutal vw920-go" data-vw920="new"' + (VW920.busy ? ' disabled' : '') + '>' + EYE920(16) + '<span>' + (VW920.busy ? 'MAKING A CODE…' : 'GIVE VIEW ACCESS') + '</span></button>';
    const live = d.viewing > 0 ? '<span class="vw920-live"><i></i>' + d.viewing + ' viewing now</span>' : '<span class="vw920-live is-off"><i></i>Nobody viewing now</span>';
    return head +
      '<div class="vw920-codebox' + (left ? '' : ' is-dead') + '"><span class="vw920-big" aria-label="Code ' + esc(d.code.split('').join(' ')) + '">' + esc(d.code.slice(0, 3)) + '<i></i>' + esc(d.code.slice(3)) + '</span>' +
        '<button type="button" class="icon-btn vw920-copy" data-vw920="copy" aria-label="Copy the code">' + icon('copy', 16) + '</button></div>' +
      '<div class="vw920-meta"><span>' + (left ? 'Use within <b id="vw920Left">' + vwMmss920(left) + '</b>' : '<b>Expired</b> — make a new code') + '</span><span>Access until <b>' + esc(d.untilText) + '</b> Dubai</span></div>' +
      '<div class="vw920-foot">' + live + '<span class="vw920-acts"><button type="button" class="btn-ghost" data-vw920="new"' + (VW920.busy ? ' disabled' : '') + '>New code</button>' +
        '<button type="button" class="btn-ghost is-danger" data-vw920="end"' + (VW920.busy ? ' disabled' : '') + '>End view access</button></span></div>';
  }
  function vwDraw920() { const t = $('#vw920Give'); if (t) t.innerHTML = vwGiveHtml920(); }
  function vwTick920() {
    clearInterval(VW920.t);
    VW920.t = setInterval(() => {
      const el = $('#vw920Left'); if (!$('#vw920Give')) { clearInterval(VW920.t); return; }
      if (!vwLeft920()) { vwDraw920(); clearInterval(VW920.t); return; }
      if (el) el.textContent = vwMmss920(vwLeft920());
    }, 1000);
  }
  async function vwAct920(a) {
    if (a === 'leave') { confirmLogout(); return; }
    if (a === 'copy' && VW920.d) { copyText93(VW920.d.code.slice(0, 3) + ' ' + VW920.d.code.slice(3), $('.vw920-copy')); return; }
    if (VW920.busy) return;
    VW920.busy = true; vwDraw920();
    try {
      if (a === 'new') { const r = await api.call('ethixViewCode'); if (r && r.ok) { VW920.d = r; VW920.off = (r.serverTime || Date.now()) - Date.now(); } }
      else if (a === 'end') { const r = await api.call('ethixViewEnd'); if (r && r.ok) { VW920.d = null; toast(r.ended ? 'View access ended — ' + r.ended + (r.ended === 1 ? ' viewer' : ' viewers') + ' signed out.' : 'View access ended.'); } }
    } catch (e) { if (e.kind !== 'auth') toast(e.message, { error: true }); }
    VW920.busy = false; vwDraw920(); if (VW920.d) vwTick920();
  }
  // ---------- the sign-in card: Sign in with a code ----------
  function codeShow920(on, msg) {
    $('#stepLogin').hidden = on; $('#stepCode').hidden = !on;
    setLoginMsg($('#codeMsg'), msg || '', msg ? 'error' : '');
    if (on) { $('#loginCode').value = ''; setTimeout(() => $('#loginCode').focus(), 30); } else $(store.get(LAST_USER, '') && !state.forgetKnown ? '#loginPass' : '#loginUser').focus();
  }
  async function codeSubmit920(e) {
    e.preventDefault();
    if (state.busy) return;
    const code = $('#loginCode').value.replace(/\D/g, ''), msg = $('#codeMsg'), btn = $('#codeGo');
    if (code.length !== 6) { setLoginMsg(msg, 'Enter the 6-digit code.', 'error'); $('#loginCode').focus(); return; }
    state.busy = true; btn.disabled = true; btn.textContent = 'OPENING…'; setLoginMsg(msg, '');
    try {
      const res = await api.call('ethixViewSignIn', [code, true], { timeout: 60000 });
      if (res && res.success && res.token && res.boot) {
        api.token = res.token;
        const user = (res.boot.me && res.boot.me.user) || 'VIEW';
        keepSession(user, 'VIEW');
        $('#signinCard').classList.add('leaving');
        setTimeout(() => enterApp(res.boot, user, 'VIEW'), 280);
        return;
      }
      shakeCard(); $('#loginCode').value = '';
      setLoginMsg(msg, (res && res.message) || 'Wrong code. Check it and try again.', res && res.locked ? 'locked' : 'error');
      $('#loginCode').focus();
    } catch (err) { setLoginMsg(msg, err.message, 'error'); }
    finally { state.busy = false; if (!$('#signinCard').classList.contains('leaving')) { btn.disabled = false; btn.textContent = 'VIEW JOBS'; } }
  }
  function codeInit920() {
    $('#codeBtn').addEventListener('click', () => codeShow920(true));
    $('#codeBack').addEventListener('click', () => codeShow920(false));
    $('#stepCode').addEventListener('submit', codeSubmit920);
    $('#loginCode').addEventListener('input', (e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 6); e.target.value = d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d; });
    let ended = false; try { ended = sessionStorage.getItem('ethix.vw920') === '1'; sessionStorage.removeItem('ethix.vw920'); } catch (e) { /* private mode */ }
    if (ended) codeShow920(true, 'View access has ended. Ask for a new code.');
  }

  // ============================================================== SIGN IN
  // Username + password. Nothing about the team is shown before sign-in; a
  // device only remembers the last username used on it.
  const LAST_USER = 'ethix.v2.lastUser';
  ['ethix.v2.team', 'ethix.v2.tab', 'ethix.v2.recent'].forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
  const ROLE_NAMES = { CS: 'CUSTOMER SERVICE', SALES: 'SALES', ADMIN: 'ADMIN', VIEW: 'VIEW ONLY' };
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
    codeInit920();   // v2.9.20: sign in with a code
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
    if (r === 'SALES' || r === 'VIEW') return r;   // v2.9.20: VIEW = signed in with a code
    return 'CS';
  }

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
    applyBoot911(boot);   // v2.9.11: holidays, briefings, waiting on, free time
    applyBoot912(boot);   // v2.9.12: every UAE holiday (the month calendar)
    applyBoot914(boot);   // v2.9.14: this person's Home, Face ID
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
    state.view920 = (boot.me && boot.me.view) || null;   // v2.9.20
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
    if (dayLink98(decodeURIComponent(location.hash || ''))) return currentRoute();   // v2.9.8: #/day/yyyy-mm-dd → Home on that day
    const h = decodeURIComponent(location.hash || '');
    const m = h.match(/^#\/job\/(.+)$/);
    const mc = h.match(/^#\/costing\/(.+)$/);
    let r = m ? { name: 'job', jobNo: m[1].trim() } : mc ? { name: 'costjob', jobNo: mc[1].trim() } : h === '#/costing' ? { name: 'costing' } : h === '#/jobs' ? { name: 'jobs' } : h === '#/admin' ? { name: 'admin' } : h === '#/activity' ? { name: 'activity' } : h === '#/health' ? { name: 'health' } : h === '#/names' ? { name: 'names' } : h === '#/enquiries' ? { name: 'enquiries' } : h === '#/follow-ups' || h === '#/round' ? { name: 'round' } : h === '#/notifications' ? { name: 'notif' } : h === '#/cover' ? { name: 'cover' } : h === '#/reader' ? { name: 'reader' } : { name: 'home' };   // v2.9.15: + the Document reader
    const mh911 = h.match(/^#\/handover(?:\/(.+))?$/); if (mh911) r = { name: 'handover', jobNo: (mh911[1] || '').trim().toUpperCase() };   // v2.9.11: the leave hand-over
    if (isAdmin()) { if (!['activity', 'health', 'names'].includes(r.name)) r = { name: 'admin' }; }      // admin works with people, not jobs (v2.9.13: + System health, Customer names)
    else if (r.name === 'admin' || r.name === 'activity' || r.name === 'health' || r.name === 'names' || (r.name === 'round' && !canEdit()) || (r.name === 'enquiries' && !canNote()) || ((r.name === 'costing' || r.name === 'costjob') && !canNote() && !isView()) || ((r.name === 'cover' || r.name === 'handover' || r.name === 'reader') && !canEdit())) r = { name: 'home' };
    const want = r.name === 'admin' ? '#/admin' : r.name === 'activity' ? '#/activity' : r.name === 'home' && /^#\/(admin|activity|health|names|round|follow-ups|enquiries|costing|reader)$/.test(h) ? '#/home' : r.name === 'round' && h === '#/round' ? '#/follow-ups' : null;
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
    const back99 = back99Save(prev, r, changed);   // v2.9.9: back to the list you came from — the same place
    view.classList.toggle('is-fit', r.name === 'home' ? homeFit93() : r.name === 'jobs');
    view.classList.toggle('is-flow', r.name === 'home' && !homeFit93());   // v2.9.3: short laptop screens scroll, six rows + See all
    document.body.classList.toggle('on-voyage', r.name === 'job' && canEdit());
    if (r.name === 'admin') renderAdmin(changed || first);
    else if (r.name === 'activity') renderActivity(changed || first);
    else if (r.name === 'health') renderHealth913(changed || first);   // v2.9.13
    else if (r.name === 'names') renderNames913(changed || first);
    else if (r.name === 'jobs') renderJobs(changed || first);
    else if (r.name === 'round') renderRound(back99 ? 'back99' : (changed || first));
    else if (r.name === 'enquiries') renderEnquiries(changed || first);
    else if (r.name === 'costing') renderCostList(changed || first);
    else if (r.name === 'costjob') renderCostJob(r.jobNo, changed || first);
    else if (r.name === 'notif') renderNotifPage(changed || first);
    else if (r.name === 'cover') renderCover98(changed || first);
    else if (r.name === 'handover') renderHandover911(r.jobNo, changed || first);
    else if (r.name === 'reader') renderReader915(changed || first);   // v2.9.15
    else if (r.name === 'job') { if (changed || first) { seenOpen9(r.jobNo); costAheadSoon98(r.jobNo); } renderVoyage(r.jobNo, changed || first); fitNames(); remarksFit93(); }
    else { renderHome(changed || first); fitNames(); fitPorts91(); moreBars93(); }
    if (changed && !back99Restore(back99, view)) view.scrollTop = 0;
    updateNav();
    covReq98();   // v2.9.8: a cover request waiting for you (Home)
  }
  // Re-draw the current page after data changed, without losing your place.
  function rerender() {
    if (!state.signedIn) return;
    if (H914.drag) { H914.pend = true; return; }   // v2.9.14: not while a tile is being moved
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
      { id: 'activity', label: 'Activity', icon: 'clock', href: '#/activity' },
      { id: 'health', label: 'System health', icon: 'health913', href: '#/health' },   // v2.9.13
      { id: 'names', label: 'Customer names', icon: 'names913', href: '#/names' }
    ];
    if (isView()) return [{ id: 'home', label: 'Home', icon: 'home', href: '#/home' }, { id: 'jobs', label: 'Jobs', icon: 'jobs', href: '#/jobs', count: active }, { id: 'costing', label: 'Costing', icon: 'costing', href: '#/costing', count: costRows().open }];   // v2.9.20
    const items = [
      { id: 'home', label: 'Home', icon: 'home', href: '#/home' },
      { id: 'jobs', label: isSales() ? 'My jobs' : 'Jobs', icon: 'jobs', href: '#/jobs', count: active },
      { id: 'notif', label: 'Notifications', icon: 'bell', act: 'notif' }
    ];
    if (isSales()) items.push({ id: 'enquiries', label: 'My enquiries', icon: 'enq', href: '#/enquiries', count: enqOpen().length });
    else if (canEdit()) items.push(
      { id: 'round', label: 'Follow-ups', icon: 'check', href: '#/follow-ups', count: roundRows(today0()).due.length + remDueCount() },
      { id: 'enquiries', label: 'Enquiries', icon: 'enq', href: '#/enquiries', count: enqNew().length },
      { id: 'costing', label: 'Costing', icon: 'costing', href: '#/costing', count: costRows().open },
      { id: 'cover', label: 'Cover', icon: 'swap', href: '#/cover', count: covIncoming98().length },   // v2.9.10: requests waiting for you
      { id: 'reader', label: 'Document reader', icon: 'reader915', href: '#/reader' });   // v2.9.15
    if (isSales()) items.splice(items.length - 1, 0, { id: 'costing', label: 'Costing', icon: 'costing', href: '#/costing', count: costRows().open });
    return items;
  }
  function renderChrome() {
    $('#navList').innerHTML = navItems().map((n) =>
      '<button type="button" class="nav-item" data-nav="' + n.id + '"' + (n.soon ? ' disabled title="Coming soon"' : n.act ? ' data-act="' + n.act + '"' : ' data-href="' + n.href + '"') + ' aria-label="' + esc(n.label) + '">' +
      '<span class="nav-ic">' + icon(n.icon) + (n.act === 'notif' ? '<span class="badge-dot" hidden></span>' : '') + '</span><span class="nav-label">' + esc(n.label) + '</span>' +
      (n.soon ? '<span class="soon">SOON</span>' : n.count !== undefined ? '<span class="count' + (['round', 'enquiries', 'cover'].includes(n.id) ? ' is-pill' : '')   /* v2.9.9: Costing is a plain count */ + '"' + (n.count ? '' : ' hidden') + '>' + n.count + '</span>' : '') + '</button>'
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
      : isView() ? tab('home', '#/home', 'home', 'Home') + tab('jobs', '#/jobs', 'jobs', 'Jobs') + tab('costing', '#/costing', 'costing', 'Costing') + more   // v2.9.20
      : tab('home', '#/home', 'home', 'Home') + tab('jobs', '#/jobs', 'jobs', 'Jobs') + bell + more;
    $('#bottomBar').classList.toggle('is-4', !canEdit() && !isSales());
    drawBadges();
    vwBand920();   // v2.9.20: VIEW ONLY · <USER>’S JOBS · code
  }
  function updateNav() {
    const r = state.route ? state.route.name : 'home';
    const cur = r === 'job' ? 'jobs' : r === 'costjob' ? 'costing' : r === 'handover' ? 'cover' : r;
    $$('[data-nav]').forEach((b) => { if (b.dataset.nav === cur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    const c = $('#navList [data-nav="jobs"] .count'); if (c) c.textContent = scoped().filter((j) => j.active).length;   // v2.8: your own jobs
    const p = $('#navList [data-nav="admin"] .count'); if (p && state.admin) p.textContent = state.admin.users.length;
    const setCount = (id, n) => { const el = $('#navList [data-nav="' + id + '"] .count'); if (el) { el.textContent = n; el.hidden = !n; } };
    if (canEdit()) { setCount('round', roundRows(today0()).due.length + remDueCount()); setCount('enquiries', enqNew().length); setCount('cover', covIncoming98().length); }   // v2.9.10: + cover
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


  // Lists show everything on laptops (the tile scrolls inside itself) and the
  // first 6 elsewhere, with a "See all" link that opens the full list.
  const LIST_MAX = 40;
  const seeAll = (id, n, dark) => n > 6 ? '<button type="button" class="tile-link see-all"' + (dark ? ' style="color:#7FD6D5"' : '') + ' data-list="' + id + '">See all ' + n + '</button>' : '';
  const empty = (iconName, text) => '<div class="tile-empty">' + icon(iconName, 22) + '<span>' + esc(text) + '</span></div>';






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
        '<h1 class="greeting">' + (isView() ? esc(nice(state.user)) + '’s jobs' : greeting() + ', ' + esc(state.user === 'MASTER' ? 'Admin' : nice(state.user))) + '</h1></div>' +   // v2.9.20: a viewer is not the owner
        '<div class="head-actions">' +
          '<div class="search-wrap"><label class="search">' + icon('search') + '<input id="searchInput" type="search" placeholder="Job no, customer, port…" aria-label="Search jobs" autocomplete="off" value="' + esc(searchVal) + '"><kbd>/</kbd></label><div class="search-results glass" id="searchResults" hidden></div></div>' +
          '<button type="button" class="btn-ghost" id="refreshBtn" data-act="refresh" aria-label="Refresh"><span class="spin">' + icon('refresh', 16) + '</span><span class="btn-label">Refresh</span></button>' + arrBtn914() +
        '</div>' +
      '</header>' + (canNote() ? portOffices(anim) : '') +
      bento914(m, anim) +   // v2.9.14: in this person's order
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
    if (q) list = list.filter((j) => (j.jobNo + ' ' + j.customer + ' ' + j.vendor + ' ' + j.pol + ' ' + j.pod + ' ' + j.cs + ' ' + j.sales + ' ' + j.type + ' ' + j.remarks + ' ' + j.against + ' ' + j.blNo).toUpperCase().includes(q));
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
      '<span class="jr-job">' + changedDot(j) + copyNo93(j.jobNo) + ownTag98(j) + '</span>' +
      '<span class="jr-type"><span class="badge">' + esc(j.type || '—') + '</span><span class="jr-typename">' + esc(j.typeName) + '</span></span>' +
      '<span class="jr-cust"><span class="jr-name">' + esc(j.customer || '—') + '</span><span class="jr-route">' + esc(j.mode === 'misc' ? (j.against ? 'AGAINST ' + j.against : 'COSTING ONLY') : j.route) + '</span></span>' +
      '<span class="jr-track">' + miniTrack(j, 26) + '</span>' +
      '<span class="jr-next">' + arch913Tag(j) + toneChip(rowNext(j)) + cutChips(j) + '</span>' +
      '<span class="jr-etd"><span class="jr-k">ETD</span>' + esc(j.etd ? fmt(j.etd) : '—') + '</span>' +
      '<span class="jr-eta"><span class="jr-k">ETA</span>' + esc(j.eta ? fmt(j.eta) : '—') + delayTag(j) + '</span>' +
      '<span class="jr-people"><span class="jr-cs' + (covered98(j) ? ' is-cover' : '') + '">' + esc(j.cs || '—') + '</span><span class="jr-sales">' + esc(j.sales || '') + '</span></span>' +
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
        '<div class="head-main"><div class="meta-line"><span>' + active.length + ' ACTIVE · ' + active.filter((j) => j.hold).length + ' ON HOLD · ' + active.filter((j) => j.atSea).length + ' AT SEA' + (unassigned8().length ? ' · ' + unassigned8().length + ' UNASSIGNED' : '') + '</span>' + covChips98() + '</div><h1 class="greeting">' + (isSales() || canEdit() ? 'My jobs' : 'Jobs') + '</h1></div>' +
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

  // v2.9.5: a CND has no ETD — until its ETA the vessel is on its way in. Gives { n: days to the ETA (null = ETA to
  // confirm), p: where the ship sits on the water, closer to the destination as the ETA nears }; null for any other job.
  function cndWay95(j, t0) {
    if (j.type !== 'CND' || j.etd || j.arrived || j.hold || !j.active) return null;
    const n = j.eta ? Math.max(1, days(t0, j.eta)) : null;
    return { n, p: n === null ? 0.25 : 0.25 + 0.6 * (1 - Math.min(n, 21) / 21) };
  }
  function voyageText(j, t0) {
    const W = MODE_WORDS[j.mode] || MODE_WORDS.sea;
    const total = j.etd && j.eta ? Math.max(1, days(j.etd, j.eta)) : null;
    if (j.status === 'CANCELLED') return { kicker: 'CANCELLED', title: 'Not going ahead', sub: '—', bubble: 'CANCELLED' };
    if (j.hold) return { kicker: 'ON HOLD', title: 'Waiting', sub: j.remarks ? j.remarks.toUpperCase().slice(0, 48) : 'NEXT STEP TO BE CONFIRMED', bubble: '' };
    if (j.arrived) return { kicker: W[4] + ' COMPLETE', title: total ? total + ' of ' + total + ' days' : 'Arrived', sub: 'ARRIVED ' + fmt(j.eta, true), bubble: W[3] + ' ' + fmt(j.eta) };
    if (j.atSea) return { kicker: W[0], title: j.dayN + ' of ' + j.dayT + ' days', sub: days(t0, j.eta) + (days(t0, j.eta) === 1 ? ' DAY' : ' DAYS') + ' TO ARRIVAL', bubble: 'DAY ' + j.dayN + ' OF ' + j.dayT };
    const cw = cndWay95(j, t0);   // v2.9.5
    if (cw) return { kicker: 'VESSEL ARRIVING', title: cw.n === null ? 'ETA to confirm' : cw.n === 1 ? 'Tomorrow' : 'In ' + cw.n + ' days', sub: j.eta ? 'ETA ' + fmt(j.eta, true) : '', bubble: '' };
    const sub = j.cat === 'EXPORT' ? (j.mode === 'air' ? 'SI, ED AND AWB BEFORE ETD' : j.dg === 'DG' ? 'SI, ED, DGPC AND BL BEFORE ETD' : 'SI, ED AND BL BEFORE ETD') : j.etd ? W[2] + ' ' + fmt(j.etd, true) : 'DATES TO CONFIRM';
    return { kicker: 'NOT ' + (j.mode === 'air' ? 'DEPARTED' : j.mode === 'courier' ? 'PICKED UP' : 'SAILED') + ' YET', title: total ? total + '-day ' + W[4].toLowerCase() : 'Dates to confirm', sub, bubble: j.etd ? W[2] + ' ' + fmt(j.etd) : '' };
  }
  function portLine(j, which) {
    if (which === 'o') return j.etd ? (j.mode === 'courier' ? 'PICK-UP ' : 'ETD ') + fmt(j.etd, true) : j.type === 'CND' ? '' : 'ETD TO CONFIRM';   // v2.9.5: a CND has no ETD
    return j.eta ? (j.arrived ? (j.mode === 'courier' ? 'DELIVERED ' : 'ARRIVED ') : (j.mode === 'courier' ? 'DELIVERY ' : 'ETA ')) + fmt(j.eta, true) : 'ETA TO CONFIRM';
  }

  // The big harbour picture used on laptops.
  function hero(j, jr, t0) {
    const vt = voyageText(j, t0);
    const w = jr.w;
    const cw = cndWay95(j, t0);   // v2.9.5: arrived = at the destination, ETD or not; a CND on its way in is on the water
    const p = j.hold ? 0 : j.arrived ? 1 : cw ? cw.p : !j.etd ? 0 : j.atSea ? j.pct : 0;
    const mode = j.mode === 'air' ? 'air' : j.mode === 'courier' ? 'road' : 'sea';
    const moverW = mode === 'air' ? 54 : mode === 'road' ? 76 : 124;
    const pos = p >= 1 ? 'calc(' + (w[0] + w[1]) + '% - ' + (moverW + 6) + 'px)' : p <= 0 ? 'calc(' + w[0] + '% + 6px)' : 'calc(' + w[0] + '% + ' + (w[1] * p).toFixed(2) + '% - ' + (moverW / 2) + 'px)';
    const centre = p >= 1 ? 'calc(' + (w[0] + w[1]) + '% - ' + (moverW / 2 + 6) + 'px)' : p <= 0 ? 'calc(' + w[0] + '% + ' + (moverW / 2 + 6) + 'px)' : 'calc(' + w[0] + '% + ' + (w[1] * p).toFixed(2) + '%)';
    const travelled = (w[1] * p).toFixed(2) + '%';
    const dgDone = j.mode === 'sea' && ['SUBMITTED', 'APPROVED'].includes(j.dgpc);   // v2.9.2
    const dg = j.dg === 'DG' && j.dgCut && j.cat === 'EXPORT' && !(j.etd && j.etd <= t0) ? '<div class="vh-dg' + (dgDone ? ' is-done' : '') + '">' + (dgDone ? 'DGPC ' + esc(j.dgpc) : 'DG CUTOFF ' + fmt(j.dgCut)) + '</div>' : '';
    return '<section class="vhero is-' + mode + (j.hold ? ' is-hold' : '') + (j.arrived ? ' is-arrived' : '') + (j.atSea || cw ? ' is-moving' : '') + '" style="--o:' + w[0] + '%;--s:' + w[1] + '%;--d:' + w[2] + '%" aria-label="' + esc('Voyage for job ' + j.jobNo + ' from ' + (j.pol || 'origin') + ' to ' + (j.pod || 'destination') + ': ' + vt.kicker.toLowerCase()) + '">' +
      '<div class="vh-sky">' +
        '<div class="vh-port vh-pol"><div class="kicker">ORIGIN · POL</div><div class="vh-name">' + esc(j.pol || '—') + '</div><div class="vh-date">' + esc(portLine(j, 'o') || '\u00a0') + '</div>' + portClock(j.pol, 'hero') + dg + '</div>' +
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
        '<div class="vc-progress" style="height:' + Math.round((j.hold ? 0 : j.arrived ? 1 : cndWay95(j, t0) ? cndWay95(j, t0).p : j.atSea ? j.pct : 0) * 100) + '%"></div>' +
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
    m = a.match(/^MARKED PREPONED (\d+) DAYS? — (.+?) \((.+)\)$/);
    if (m) return 'marked preponed: ' + m[1] + (m[1] === '1' ? ' day' : ' days') + ' earlier · ' + m[2].toLowerCase() + ' · ' + m[3].toLowerCase();
    m = a.match(/^REMOVED PREPONED (\d+) DAYS? — (.+)$/);
    if (m) return 'removed preponed (' + m[1] + (m[1] === '1' ? ' day' : ' days') + ' earlier · ' + m[2].toLowerCase() + ')';
    m = a.match(/^REMOVED DELAY \+(\d+) DAYS? — (.+)$/);
    if (m) return 'removed a delay (+' + m[1] + (m[1] === '1' ? ' day' : ' days') + ' · ' + m[2].toLowerCase() + ')';
    m = a.match(/^BOOKED ENQUIRY (\S+) AS JOB$/);
    if (m) return 'booked enquiry ' + m[1] + ' as this job';
    if (a === 'UPDATED JOB DETAILS') return 'updated the job details';
    m = a.match(/^UPDATED (.+)$/);
    if (m) return 'updated ' + m[1].toLowerCase().replace(/\b(si|do|ed|bl|awb|etd|eta|pol|pod|dgpc|dg|cs)\b/g, (x) => x.toUpperCase());   // v2.9.8
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
      ['DOCUMENTS', [[j.cat === 'IMPORT' ? 'DO status' : 'SI status', j.sido || '—'], [j.cat === 'IMPORT' ? 'Customs (ED)' : 'ED status', j.ed || '—'], [j.mode === 'air' ? 'AWB status' : 'BL status', j.bl || '—'], [blWord98(j) + ' numbers', blList98(j.blNo).join(', ') || '—'], [j.cat === 'IMPORT' ? 'Discharge list' : 'Loadlist', j.loadlist || '—'], ['Original docs', j.docs || '—'], ['Costing', j.costing || '—'], ['Invoice', invOf98(j).na ? '—' : invOf98(j).label]]]
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
        '<div class="vh-titles"><div class="vh-idrow"><h1 class="vh-job">' + copyNo93(j.jobNo) + '</h1><span class="badge badge-lg">' + esc(j.type + ' · ' + j.typeName.toUpperCase()) + '</span>' + (j.cargo ? '<span class="vh-cargo">' + esc(j.cargo) + '</span>' : '') + delayChip(j) + readyChip(j) + ownChip98(j) + '</div>' +
        custBtn910(j) + (j.closed && j.closed.reason ? '<div class="vh-why">' + esc(j.closed.reason) + '</div>' : '') + remarksLine93(j) + blLine98(j) + '</div>' +
        (j.closed ? closedActions(j) : canEdit() && !mayEdit911(j) ? viewOnly911(j) : canEdit() ? '<div class="vh-actions"><button type="button" class="btn-ghost" data-act="delay" title="Delay or prepone" aria-label="Delay or prepone">' + icon('clock', 16) + '<span class="bl-full">Delay / prepone</span><span class="bl-short">Delay</span></button>' + (DN_TYPES93.includes(j.type) ? '<button type="button" class="btn-ghost" data-act="dnote" title="Delivery note (Word)" aria-label="Delivery note">' + icon('truck', 16) + '<span class="bl-full">Delivery note</span><span class="bl-short">Delivery note</span></button>' : '') + '<button type="button" class="btn-ghost" data-act="duplicate" title="Duplicate job" aria-label="Duplicate job">' + icon('copy', 16) + '<span>Duplicate</span></button><button type="button" class="btn-ghost" data-act="edit" title="Edit details" aria-label="Edit details">' + icon('edit', 16) + '<span class="bl-full">Edit details</span><span class="bl-short">Edit</span></button><button type="button" class="btn-brutal" data-act="quick">UPDATE</button></div>'
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
    const was = state.savingCount;
    state.savingCount = Math.max(0, state.savingCount + delta);
    savePill98(was);   // v2.9.8: the glass pill — "Saving…", then "Saved"
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
    { let n = state.header.length; ['dgpc', 'switchBl', 'blNo', 'invoice'].forEach((k) => { if (k in changes && !(state.ix[k] > -1)) state.ix[k] = n++; }); }   // v2.9.8: + BL numbers, invoice   // v2.9.2 / v2.9.3: new columns land after the last one
    state.pending.set(k, Object.assign({}, state.pending.get(k) || {}, changes));
    rebuildJob(k); rerender(); refreshOverlay();
    setSaving(1);
    const run = () => {
      const server = state.rowMap.get(k) || [];
      const base = {};
      Object.keys(changes).forEach((f) => { const c = state.ix[f]; base[f] = c > -1 && server[c] != null ? String(server[c]) : ''; });
      const withStory = state.stories.has(k);   // v2.9.8: the notes and history come back with the save (one trip)
      return api.call('ethixUpdateJob', [before.jobNo, changes, base, '', withStory]).then((res) => {
        if (res && res.ok) {
          if (Array.isArray(res.row)) state.rowMap.set(k, res.row);
          if (Array.isArray(res.header) && res.header.length) { state.header = res.header; state.ix = mapHeaders(res.header); clearPending(k, changes); rebuildJobs(); }   // v2.9.2
          clearPending(k, changes); rebuildJob(k); rerender(); refreshOverlay();
          if (res.story) state.stories.set(k, { data: res.story, at: Date.now(), loading: false });
          else if (state.stories.has(k)) loadStory(no, true);
          if (res.story && state.route && state.route.name === 'job' && state.route.jobNo.toUpperCase() === k) rerender();
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
    $('#pop').classList.remove('is-peek99');
    if (!$('#drawer').hidden) hideDrawer(silent);
    state.overlay = null; state.quick99 = null; state.rmk99 = null;   // v2.9.9
    if (had && state.dirty) { state.dirty = false; rerender(); }
  }

  // ---------- what tapping a stop shows ----------
  const SAVE_NOTE = '<div class="pop-note">SAVES INSTANTLY · SYNCS IN BACKGROUND</div>';
  function fieldLabel(j, f) {
    if (f === 'sido') return j.cat === 'IMPORT' ? 'DO status' : j.type === 'CRR' ? 'Documents' : 'SI status';
    if (f === 'ed') return j.cat === 'IMPORT' ? 'Customs (ED) status' : 'ED status';
    if (f === 'bl') return j.mode === 'air' ? 'AWB status' : j.type === 'CRR' ? 'Tracking / AWB status' : 'BL status';
    if (f === 'loadlist') return j.cat === 'IMPORT' ? 'Discharge list' : 'Loadlist';
    return { docs: 'Original docs', dgpc: 'DGPC status', switchBl: 'Switch BL', costing: 'Costing', status: 'Job status', etd: j.mode === 'courier' ? 'Pick-up date' : 'ETD', eta: j.mode === 'courier' ? 'Delivery date' : 'ETA', delivery: 'Delivery date', against: 'Against job no.' }[f] || f;
  }
  function stopEditor(no, id) {
    return () => {
      const j = findJob(no); if (!j) return '';
      const s = j.journey.all.find((x) => x.id === id); if (!s) return '';
      const d = s.def;
      const head = '<div class="pop-title">' + esc(s.name) + '</div><div class="pop-state is-' + s.state + '">' + stopDot(s) + '<span>' + esc(s.sub) + '</span></div>';
      if (s.kind === 'field') {
        const choices = d.field === 'bl' ? blChoices98(j, d.choices || OPTS.bl) : (d.choices || OPTS[d.field]);   // v2.9.8: shared after the final BL
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
        ['status'].concat(fields.filter((f) => f !== 'delivery' && (f !== 'dgpc' || j.dg === 'DG'))).map((f) => '<div class="quick-row"><div class="pop-label">' + esc(fieldLabel(j, f)) + '</div><div class="choice-row">' + optsFor93(j, f).map((v) => '<button type="button" class="choice' + ((j[f] || '') === v ? ' is-on' : '') + '" data-set="' + f + '" data-val="' + esc(v) + '" aria-pressed="' + ((j[f] || '') === v) + '">' + esc(v === NA ? 'N/A' : v) + '</button>').join('') + '</div></div>').join('') + SAVE_NOTE;
    };
  }

  function onSet(no, field, val) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;   // v2.9.11: its owner, or their cover
    if ((j.raw[field] || '') === val && field !== 'status') { if (state.quick99) quickDone99(); else closeOverlays(); return; }
    const label = fieldLabel(j, field);
    const holdNote = $('#holdNote') ? $('#holdNote').value.trim() : '';
    if (state.quick99) quickDone99(); else if (state.overlay !== 'quick') closeOverlays();   // v2.9.9: back to the panel's list
    const shown = /^\d{4}-\d{2}-\d{2}$/.test(val) ? fmt(parseDate(val), true) : val === NA ? 'not needed' : val;
    saveJob(j.jobNo, Object.assign({ [field]: val }, swFix93(j, field, val)), { toast: (val === '' ? label + ' cleared' : label + ' → ' + shown) });   // v2.9.3: switch BL keeps an OBL
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
      const r = state.route; const no = (state.quick99 && state.quick99.no) || (r && r.jobNo);   // v2.9.9: a quick card names its job
      if (e.target.closest('[data-act="pop-close"]')) { closeOverlays(); return; }
      if (e.target.closest('[data-act="edit"]') && no) { closeOverlays(); openEdit(no); return; }
      const set = e.target.closest('[data-set]');
      if (set && no) { onSet(no, set.dataset.set, set.dataset.val); return; }
      const day = e.target.closest('[data-day]');
      if (day) { const inp = $('#popDate'); if (inp) inp.value = iso(addDays(today0(), +day.dataset.day)); }
    };
    const onOverlaySubmit = (e) => {
      const r = state.route; const no = (state.quick99 && state.quick99.no) || (r && r.jobNo); if (!no) return;   // v2.9.9
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
    SFEF: ['loadlist', 'sido', 'ed', 'bl', 'switchBl', 'dgpc'], SFEL: ['loadlist', 'sido', 'ed', 'bl', 'switchBl', 'dgpc'], AFE: ['sido', 'ed', 'bl'],
    SFIF: ['loadlist', 'sido', 'ed', 'bl', 'switchBl', 'docs', 'delivery'], SFIL: ['loadlist', 'sido', 'ed', 'bl', 'switchBl', 'docs', 'delivery'],
    AFI: ['sido', 'ed', 'bl', 'delivery'], CND: ['loadlist', 'sido', 'ed', 'bl', 'docs', 'delivery'],
    SFC: ['sido', 'bl', 'switchBl'], AFC: ['sido', 'bl'], CRR: ['sido', 'bl'], MIS: []
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
      switchBl: { label: 'Switch BL', kind: 'select', opts: OPTS.switchBl, blank: true },
      costing: { label: 'Costing', kind: 'select', opts: OPTS.costing, blank: true },
      blNo: { label: air ? 'AWB numbers' : crr ? 'Tracking numbers' : 'BL numbers', kind: 'blnos', word: air ? 'AWB' : crr ? 'Tracking' : 'BL' },   // v2.9.8
      invoice: { label: 'Invoice status', kind: 'select', opts: INV98 }
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
    } else if (m.kind === 'blnos') {
      ctl = blCtl98(id, blList98(val), m.word);   // v2.9.8
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
    return '<div class="field' + (m.kind === 'area' || m.kind === 'blnos' ? ' is-wide' : '') + (m.dgOnly ? ' dg-only' : '') + (extra.cls ? ' ' + extra.cls : '') + '" data-field="' + key + '"><label for="' + id + '">' + esc(m.label) + (m.req ? ' <b aria-hidden="true">*</b>' : '') + '</label>' + ctl + '<div class="field-err" id="' + id + '_err"></div></div>';
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
    const j = findJob(no); if (!j || !canEditJob(j)) return;   // v2.9.11: its owner, or their cover
    loadLists();
    closeOverlays(true);
    const t = j.type;
    const keys = ['customer', 'vendor', 'sales', 'opened'];   // v2.8: Customer Service moves by Transfer (People card)
    const route = TYPE_FIELDS[t] || [];
    const docs = (FORM_STATUS[t] || ['sido', 'ed', 'bl']).concat(t === 'MIS' ? [] : ['blNo'], invOf98(j).open ? ['invoice'] : []);   // v2.9.8
    const val = (k) => (k === 'invoice' ? invOf98(j).value : k === 'blNo' ? blList98(j.raw.blNo).join(', ') : asInput(k, j.raw[k]));
    state.editing = { no: j.jobNo, initial: {} };
    const norm = (k, v) => (fieldMeta(k, t) && fieldMeta(k, t).upper ? String(v).toUpperCase().replace(/\s+/g, ' ') : v);
    ['type', 'status'].concat(keys, route, docs, ['remarks', 'dgCut']).forEach((k) => { state.editing.initial[k] = norm(k, val(k)); });
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'EDIT DETAILS';
    $('#drawerBody').innerHTML = '<h2 class="peek-job form-title" id="drawerTitle">' + esc(j.jobNo) + '</h2>' +
      '<form class="job-form" id="editForm" novalidate>' +
        '<fieldset><legend>JOB</legend><div class="fgrid">' + input('type', t, val('type')) + input('status', t, val('status')) + keys.map((k) => input(k, t, val(k))).join('') + '</div><div class="type-warn" id="typeWarn" hidden>Changing the type changes the voyage stops for this job.</div></fieldset>' +
        (route.length ? '<fieldset><legend>' + (t === 'MIS' ? 'LINK' : 'CARGO & ROUTE') + '</legend><div class="fgrid">' + route.map((k) => input(k, t, val(k))).join('') + '</div></fieldset>' : '') +
        (docs.length || invStatic98(j) ? '<fieldset><legend>DOCUMENTS</legend><div class="fgrid">' + docs.map((k) => input(k, t, val(k))).join('') + invStatic98(j) + '</div></fieldset>' : '') +
        '<fieldset><legend>REMARKS</legend><div class="fgrid">' + input('remarks', t, val('remarks')) + '</div></fieldset>' +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit">SAVE CHANGES</button></div>' +
      '</form>' + formLists();
    const f = $('#editForm'); const dg = f.querySelector('[name="dg"]'); f.querySelectorAll('.dg-only').forEach((g) => { g.hidden = !(dg && dg.value === 'DG'); });
    blForm98(f, j);   // v2.9.8: "shared to customer" only after the final BL
    swForm93(f);   // v2.9.3: switch BL → the main BL list is OBL only
    showDrawer(document.activeElement);
    state.overlay = 'form';
  }
  function submitEdit(form) {
    const ed = state.editing; if (!ed) return;
    if (!blFlush98(form)) return;   // v2.9.8: a number still being typed becomes a chip (or says what is wrong)
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
    if (x.kind === 'cover') return '<strong>' + esc(x.from) + '</strong> · cover';   // v2.9.8
    return '<strong>' + esc(x.from) + '</strong> updated';
  }
  function openNotifications() {               // v2.7: notifications are a page of their own
    closeOverlays(true);
    go('#/notifications');
  }

  // ---------- my account ----------
  function accountPanel() {
    if (isView()) return vwAcct920();   // v2.9.20
    const go2 = (href, ic, label, n) => '<button type="button" class="acct-go" data-href="' + href + '">' + icon(ic, 18) + '<span>' + label + '</span>' + (n ? '<b>' + n + '</b>' : '') + '</button>';
    const shortcuts = canEdit() ? go2('#/follow-ups', 'check', 'Follow-ups', roundRows(today0()).due.length + remDueCount()) + go2('#/enquiries', 'enq', 'Enquiries', enqNew().length) + go2('#/costing', 'costing', 'Costing', costRows().open) + go2('#/cover', 'swap', 'Cover', covIncoming98().length) + go2('#/reader', 'reader915', 'Document reader') + arrGo914()   // v2.9.14: Arrange Home (phone) · v2.9.15: Document reader
      : isSales() ? go2('#/enquiries', 'enq', 'My enquiries', enqOpen().length) + go2('#/costing', 'costing', 'Costing', costRows().open) + arrGo914()
      : isAdmin() ? go2('#/health', 'health913', 'System health') + go2('#/names', 'names913', 'Customer names') : '';   // v2.9.13
    return (shortcuts ? '<div class="acct-shortcuts">' + shortcuts + '</div>' : '') + '<div class="acct"><span class="avatar">' + esc(initials(state.user)) + '</span><div><div class="acct-name" id="drawerTitle">' + esc(state.user === 'MASTER' ? 'ADMIN' : state.user) + '</div><div class="mono small">' + esc(ROLE_NAMES[state.role] || state.role) + '</div></div></div>' +
      (canEdit() ? '<section class="tile vw920-give" id="vw920Give">' + vwGiveHtml920() + '</section>' : '') +   // v2.9.20: give view access
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
    if (VW920.d) vwTick920();   // v2.9.20
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
  const ROLE_CHIP = { CS: ['Customer Service', 'chip-teal'], SALES: ['Sales', 'chip-sales'], ADMIN: ['Admin', 'chip-hold'], NONE: ['No access', 'chip-calm'] };   // v2.9.7: the Accounts role is retired
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
            '<span class="ur-name"><span class="avatar' + (u.role === 'SALES' ? ' is-other' : '') + '">' + esc(initials(u.name)) + '</span><span class="ur-who"><span><b>' + esc(u.name) + '</b>' + (u.name === state.user ? ' <span class="you">YOU</span>' : '') + '</span>' + (u.email ? '<small class="ur-mail">' + icon('mail', 12) + esc(u.email) + '</small>' : u.role === 'CS' ? '<small class="ur-mail is-none">No work email</small>' : '') + '</span></span>' +
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
      [/^SIGNED IN WITH (.+)$/, (m) => 'signed in with ' + pkOldWords916(m[1])], [/^TURNED (ON|OFF) (.+ · .+)$/, (m) => 'turned ' + m[1].toLowerCase() + ' ' + pkOldWords916(m[2])],   // v2.9.14 rows (Face ID, removed in v2.9.16)
      [/^REMOVED (.+ · .+) OF (.+)$/, (m) => 'removed ' + pkOldWords916(m[1]) + ' of ' + m[2]], [/^FACE ID REFUSED — (.+)$/, (m) => 'was refused by Face ID · ' + m[1].toLowerCase()],
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
        admMail98(name) +
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
        '<div class="field is-wide"><label for="auMail">Work email (optional — the morning email goes here)</label><input id="auMail" type="email" autocomplete="off" spellcheck="false" placeholder="Type their work email"><div class="field-err" id="auMail_err"></div></div>' +
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
        const mail = ($('#auMail', f) || {}).value ? $('#auMail', f).value.trim() : '';   // v2.9.8
        if (mail && !mailOk98(mail)) { $('#auMail_err').textContent = 'That does not look like an email address.'; return; }
        btn.disabled = true; btn.textContent = 'CREATING…';
        const res = await adminCall('ethixAdminCreate', [name, state.addRole, pw], null);
        if (res && mail) await adminCall('ethixAdminEmail', [name, mail], null);
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
  function planFor(j) { const p = state.follow.plan[keyOf(j)]; return planOk93(p) ? p : j.hold ? 'WEEKLY' : 'DAILY'; }   // v2.9.3: weekdays and dates too
  // checksFor, followState, remarksToday, lastRemark — v2.9.10 versions (remarks on their own) further down
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
  // A tap = checked today (once). A remark fills today's check, or is added as one more line with its own time (v2.7).
  async function followCheck(no, remark) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;
    const K = keyOf(j);
    if (state.followBusy.has(K)) return;
    const prev = (state.follow.checks[K] || []).slice();
    const t0 = today0();
    const mineAll = prev.filter((c) => !isNote910(c) && days(dayOf(c[0]), t0) === 0 && c[1] === state.user);   // v2.9.10: checks only
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
    const mine = (c) => !isNote910(c) && days(dayOf(c[0]), t0) === 0 && c[1] === state.user;   // v2.9.10: your remarks stay (as remarks on their own)
    state.follow.checks[K] = prev.filter((c) => !(mine(c) && !c[2])).map((c) => (mine(c) ? [c[0], c[1], c[2], 'R'] : c));
    closeOverlays(); rerender(); updateNav();
    setSaving(1);
    try { const res = await api.call('ethixFollowUndo', [j.jobNo]); if (!res || !res.ok) throw new Error((res && res.error) || 'Not undone.'); toast('Check undone'); }
    catch (e) { state.follow.checks[K] = prev; rerender(); updateNav(); if (e.kind !== 'auth') toast(e.message, { error: true }); }
    finally { setSaving(-1); }
  }
  async function followPlan(no, every) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;
    const K = keyOf(j), prev = state.follow.plan[K];
    state.follow.plan[K] = every;
    closeOverlays(); rerender(); updateNav();
    setSaving(1);
    try { const res = await api.call('ethixFollowPlan', [j.jobNo, every]); if (!res || !res.ok) throw new Error((res && res.error) || 'Not saved.'); toast(j.jobNo + ': ' + everyLabel93(every).toLowerCase()); }
    catch (e) { if (prev === undefined) delete state.follow.plan[K]; else state.follow.plan[K] = prev; rerender(); updateNav(); if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Follow-ups need the Phase 4 Code.gs update.' : e.message, { error: true }); }
    finally { setSaving(-1); }
  }
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
    const all = hist ? hist.filter((c) => !isNote910(c) && dayOf(c[0]) < windowStart).concat(checksFor(j)) : checksFor(j);   // v2.8 · v2.9.10: checks only
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
      (canEditJob(j) ? '<button type="button" class="every-pill" data-every="' + esc(j.jobNo) + '">' + esc(f.label) + icon('chevron', 13) + '</button>' : '<span class="every-pill is-ro">' + EVERY_LABEL[f.every] + '</span>') + '</div>' +
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
  // v2.9.5: the job's own REMARKS on its Follow-ups row (read only — all of it on hover; the job page edits them)
  const rmk95 = (j) => String(j.remarks || '').trim();
  const rowRemarks95 = (j) => rmk95(j) ? '<span class="rr-rmk-in" title="' + esc(rmk95(j)) + '"><span class="rr-rmk-k">REMARKS</span><span class="rr-rmk-t">' + esc(rmk95(j)) + '</span></span>' : '';
  // a job on hold: the chip says "On hold", its remarks are in the REMARKS column (not twice)
  const rrNext95 = (j) => { const n = rowNext(j); return j.hold && n && n.tone === 'hold' ? Object.assign({}, n, { text: 'On hold' }) : n; };
  function roundRow(x, t0) {
    const j = x.j, f = x.f;
    return '<li class="rr' + (f.today ? ' is-done' : '') + (f.mineToday ? ' is-mine' : '') + (f.due ? ' is-due' : '') + (rmk95(j) ? ' has-rmk' : '') + '">' +
      '<button type="button" class="rr-main" data-job="' + esc(j.jobNo) + '"><span class="rr-job">' + changedDot(j) + copyNo93(j.jobNo) + '<span class="badge">' + esc(j.type) + '</span>' + ownTag98(j) + '</span>' +
        '<span class="rr-cust">' + esc(j.customer || '—') + '</span>' + rrRoute99(j, t0) + '</button>' +   // v2.9.9: both ports' times
      '<span class="rr-next">' + toneChip(rrNext95(j)) + cutChips(j) + waitTag911(j) + '</span>' +   // v2.9.11: + waiting on
      '<span class="rr-last" data-rmk-cell="' + esc(j.jobNo) + '"><span>' + esc(lastCheckText(f, t0)) + '</span>' + ((lr) => (lr ? '<span class="rr-remark">“' + esc(lr.text) + '”' + (lr.n > 1 ? ' <b>+' + (lr.n - 1) + '</b>' : '') + '</span>' : ''))(lastRemark(f)) + '</span>' +
      '<span class="rr-rmk">' + rowRemarks95(j) + '</span>' +
      '<span class="rr-every"><button type="button" class="every-pill" data-every="' + esc(j.jobNo) + '">' + esc(f.label) + icon('chevron', 13) + '</button></span>' +
      '<span class="rr-act">' + rmkBtn99(j, f) + '<span class="rr-chk">' + checkCircle(j, f) + '</span></span>' +   // v2.9.9: the remark button
    '</li>';
  }
  function renderRound(first) {
    const t0 = today0();
    const anim = first && first !== 'back99' ? ' reveal' : '';   // v2.9.9: coming back from a job: no regrouping, no reveal
    const q = (state.roundQ || '').trim().toUpperCase();
    const R = roundRows(t0);
    const match = (x) => wMatch911(x) && (!q || (x.j.jobNo + ' ' + x.j.customer + ' ' + x.j.route + ' ' + x.j.cs + ' ' + x.j.sales).toUpperCase().includes(q));   // v2.9.11: + the waiting-on filter
    const total = R.due.length + R.done.length;
    const pct = total ? Math.round((R.done.length / total) * 100) : 100;
    // Jobs you check stay in place while you work down the list (nothing jumps under the mouse).
    // They regroup when you come back to the page, switch My jobs / Everyone, or press Refresh.
    if ((first && first !== 'back99') || !state.roundSnap) state.roundSnap = R.due.map((x) => keyOf(x.j));
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
          '<div class="rp-chips"><span>' + R.later.length + ' not due today</span><span>' + R.paused.length + ' paused</span><span>Tap the circle once you’ve followed a job up · set how often per job</span>' + kbdHint99() + '</div></div>' + waitBar911(R.all) +
      '</section>' +
      (state.wf911 ? '' : remSection(anim)) +
      section('due', 'DUE NOW', dueRows.filter(match), '', dueRows.filter((x) => x.f.due && match(x)).length) +
      section('done', 'CHECKED TODAY', doneRows.filter(match)) +
      section('later', 'NOT DUE TODAY', R.later.filter(match), 'By their own pace') +
      section('paused', 'PAUSED', R.paused.filter(match)) +
      (!R.all.length ? '<section class="tile">' + empty('check', 'No active jobs in this view.') + '</section>' : '') +
      '</div>';
    if (keepQ && state.roundFocus) { const s = $('#roundSearch'); s.focus(); s.setSelectionRange(keepQ.length, keepQ.length); }
    kbMark99(false);   // v2.9.9: the keyboard's row stays marked
  }

  // ---------- delays ----------
  const DELAY_WHERE = {
    sea: ['ORIGIN PORT', 'TRANSSHIPMENT', 'AT SEA', 'DESTINATION PORT', 'CUSTOMS', 'DELIVERY'],
    air: ['ORIGIN AIRPORT', 'TRANSIT', 'IN FLIGHT', 'DESTINATION AIRPORT', 'CUSTOMS', 'DELIVERY'],
    courier: ['PICK-UP', 'IN TRANSIT', 'CUSTOMS', 'DELIVERY'],
    misc: ['CUSTOMS', 'DELIVERY']
  };
  const DELAY_REASONS = ['Vessel delayed', 'Port congestion', 'Weather', 'Rolled over', 'Missed cutoff', 'Documents', 'Customs hold', 'Customer request'];
  const PREPONE_REASONS = ['Vessel advanced', 'Schedule change', 'Earlier vessel', 'Customer request'];   // v2.9.3
  const dsign = (n) => (n < 0 ? '−' + (-n) : '+' + n);
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
  const delayChip = (j) => { const d = delayInfo(j); if (!d || !d.total) return ''; const a = Math.abs(d.total); return '<button type="button" class="delay-chip' + (d.total < 0 ? ' is-early' : '') + '" data-act="delays">' + icon('clock', 13) + (d.total < 0 ? 'PREPONED ' : 'DELAYED +') + a + (a === 1 ? ' DAY' : ' DAYS') + '</button>'; };
  const delayTag = (j) => { const d = delayInfo(j); return d && d.total ? '<span class="jr-delay' + (d.total < 0 ? ' is-early' : '') + '" title="' + (d.total < 0 ? 'Preponed' : 'Delayed') + '">' + dsign(d.total) + 'D</span>' : ''; };
  function delayCard(j) {
    const d = delayInfo(j); if (!d) return '';
    const sign = (n) => (n > 0 ? '+' : '') + n;
    const early = d.list.some((x) => x.days < 0), a = Math.abs(d.total);
    return '<section class="tile side-card delay-card" id="delayCard" aria-labelledby="dlTitle"><div class="tile-head"><h2 class="tile-title" id="dlTitle">' + (early ? 'DATE CHANGES' : 'DELAYS') + '</h2>' + (canEditJob(j) ? '<button type="button" class="tile-link" data-act="delay">+ Mark another</button>' : '') + '</div>' +
      '<div class="dl-total' + (d.total < 0 ? ' is-early' : '') + '"><b>' + (d.total ? dsign(d.total) : '0') + '</b><span>' + (d.total === 0 ? 'days — back on the first dates' : (a === 1 ? 'day' : 'days') + (d.total < 0 ? ' earlier' : ' delayed') + ' in all') + ' · ' + d.list.length + (d.list.length === 1 ? ' change' : ' changes') + '</span></div>' +
      (d.etd ? '<div class="kv"><span class="kv-k">' + (j.mode === 'air' ? 'Departure' : j.mode === 'courier' ? 'Pick-up' : 'Sailing') + '</span><span class="kv-v">' + fmt(d.etd.from) + ' → ' + fmt(d.etd.to) + ' · ' + sign(d.etd.d) + 'D</span></div>' : '') +
      (d.eta ? '<div class="kv"><span class="kv-k">Arrival</span><span class="kv-v">' + fmt(d.eta.from) + ' → ' + fmt(d.eta.to) + ' · ' + sign(d.eta.d) + 'D</span></div>' : '') +
      (d.plan !== null && d.now !== null && d.plan !== d.now ? '<div class="kv"><span class="kv-k">Transit</span><span class="kv-v">planned ' + d.plan + ' days · now ' + d.now + '</span></div>' : '') +
      '<ol class="dl-list">' + d.list.slice().reverse().map((x) => '<li><span class="dl-days' + (x.days < 0 ? ' is-early' : '') + '">' + dsign(x.days) + 'D</span><span class="dl-body"><b>' + esc(nice(x.where)) + '</b> · ' + esc(x.reason) + (x.note ? '<span class="dl-note">' + esc(x.note) + '</span>' : '') +
        '<span class="dl-meta">' + esc(x.by) + ' · ' + esc(ago(x.t)) + '</span></span>' + (canEditJob(j) ? '<button type="button" class="icon-btn dl-rm" data-delay-rm="' + esc(x.id) + '" aria-label="' + (x.days < 0 ? 'Remove this prepone' : 'Remove this delay') + '">' + icon('close', 13) + '</button>' : '') + '</li>').join('') + '</ol></section>';
  }
  function openDelay(no) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;
    closeOverlays(true);
    const where = (DELAY_WHERE[j.mode] || DELAY_WHERE.sea);
    const start = j.atSea || j.arrived ? (j.arrived ? where[where.length - 3] || where[0] : where[2] || where[0]) : where[0];
    state.delayForm = { no: j.jobNo, dir: 'late', days: 2, where: start, reason: '', other: '', note: '', move: movesDates(start) };
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'DELAY / PREPONE';
    popRender = delayForm;
    $('#drawerBody').innerHTML = delayForm();
    showDrawer(document.activeElement);
    state.overlay = 'delay';
  }
  function delayForm() {
    const F = state.delayForm; const j = findJob(F.no); if (!j) return '';
    const where = DELAY_WHERE[j.mode] || DELAY_WHERE.sea, early = F.dir === 'early', sg = early ? -1 : 1;
    const shift = (d) => (d ? fmt(addDays(d, sg * F.days)) : '—');
    const reasons = early ? PREPONE_REASONS : DELAY_REASONS;
    const reasonOk = F.reason && (F.reason !== 'Other' || F.other.trim());
    const newEtd = early && j.etd && F.move.etd ? addDays(j.etd, -F.days) : null;   // v2.9.3: cutoffs after the new ETD move with it
    const cuts = newEtd ? [['siCut', 'SI cutoff'], ['edCut', 'ED cutoff'], ['dgCut', 'DG cutoff']].filter(([k]) => j[k] && j[k] > newEtd) : [];
    // v2.9.8: each date row = the switch (move it or not) + the new date; tap the new date to pick it on a calendar (the days follow)
    const row = (k, label) => '<div class="dl-move-row' + (F.move[k] ? ' is-on' : '') + '"><button type="button" class="toggle dl-move" data-dl-move="' + k + '" aria-pressed="' + F.move[k] + '"><span class="toggle-track"><span class="toggle-thumb"></span></span>' + label + ' ' + fmt(j[k]) + ' →</button>' +
      '<label class="dl-pick" title="Pick the new ' + label + ' on the calendar"><b>' + shift(j[k]) + '</b>' + icon('calendar', 15) + '<input type="date" class="dl-date" data-dl-date="' + k + '" value="' + iso(addDays(j[k], sg * F.days)) + '" aria-label="New ' + label + '"></label></div>';
    return '<h2 class="peek-job form-title" id="drawerTitle">' + esc(j.jobNo) + ' <span class="small">' + esc(j.customer || '') + '</span></h2>' +
      '<form class="job-form delay-form" id="delayForm" novalidate>' +
        '<div class="seg dl-dir" role="group" aria-label="Delayed or preponed"><button type="button" data-dl-dir="late" aria-pressed="' + !early + '">Delayed</button><button type="button" data-dl-dir="early" aria-pressed="' + early + '">Preponed</button></div>' +
        '<fieldset><legend>' + (early ? 'HOW MANY DAYS EARLIER?' : 'HOW MANY DAYS?') + '</legend><div class="dl-stepper"><button type="button" class="icon-btn" data-dl-step="-1" aria-label="One day less">−</button><output id="dlDays" aria-live="polite">' + F.days + '<small>' + (F.days === 1 ? 'day' : 'days') + '</small></output><button type="button" class="icon-btn" data-dl-step="1" aria-label="One day more">+</button></div>' +
          '<div class="choice-row">' + [1, 2, 3, 5, 7, 10, 14].map((n) => '<button type="button" class="choice' + (F.days === n ? ' is-on' : '') + '" data-dl-days="' + n + '">' + (early ? '−' : '') + n + 'D</button>').join('') + '</div></fieldset>' +
        '<fieldset><legend>MOVE THE DATES TOO?</legend>' +
          (j.etd ? row('etd', j.mode === 'courier' ? 'Pick-up' : 'ETD') : '') +
          (j.eta ? row('eta', j.mode === 'courier' ? 'Delivery' : 'ETA') : '') +
          (cuts.length ? '<p class="dl-cuts">' + cuts.map(([k, l]) => l + ' ' + fmt(j[k]) + ' → <b>' + fmt(addDays(j[k], -F.days)) + '</b>').join(' · ') + ' — cutoffs move with the ETD.</p>' : '') +
          (!j.etd && !j.eta ? '<p class="pop-hint">This job has no ETD / ETA yet.</p>' : '<p class="pop-hint">Editing ETD or ETA by hand never counts as ' + (early ? 'preponed' : 'a delay') + ' — only this does.</p>') + '</fieldset>' +
        '<fieldset><legend>WHERE?</legend><div class="choice-row">' + where.map((w) => '<button type="button" class="choice' + (F.where === w ? ' is-on' : '') + '" data-dl-where="' + w + '" aria-pressed="' + (F.where === w) + '">' + esc(nice(w)) + '</button>').join('') + '</div></fieldset>' +
        '<fieldset><legend>WHY?</legend><div class="choice-row">' + reasons.concat(['Other']).map((r) => '<button type="button" class="choice' + (F.reason === r ? ' is-on' : '') + '" data-dl-reason="' + esc(r) + '" aria-pressed="' + (F.reason === r) + '">' + esc(r) + '</button>').join('') + '</div>' +
          (F.reason === 'Other' ? '<div class="field is-wide"><label for="dlOther">Reason</label><input id="dlOther" maxlength="60" value="' + esc(F.other) + '" autocomplete="off"></div>' : '') +
          '<div class="field is-wide"><label for="dlNote">Note (optional — the sales person sees it)</label><input id="dlNote" maxlength="300" value="' + esc(F.note) + '" placeholder="Type a note for the sales person" autocomplete="off"></div></fieldset>' +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit"' + (reasonOk ? '' : ' disabled') + '>' + (early ? 'MARK PREPONED −' : 'MARK DELAY +') + F.days + 'D</button></div>' +
      '</form>';
  }
  async function submitDelay() {
    const F = state.delayForm; const j = findJob(F.no); if (!j) return;
    const reason = F.reason === 'Other' ? F.other.trim() : F.reason;
    if (!reason) { $('#formError').textContent = 'Choose a reason.'; return; }
    const btn = $('#formSubmit'); btn.disabled = true; btn.textContent = 'SAVING…';
    try {
      const early = F.dir === 'early';
      const res = await api.call('ethixDelayAdd', [j.jobNo, { days: early ? -F.days : F.days, where: F.where, reason, note: F.note.trim(), moveEtd: !!(F.move.etd && j.etd), moveEta: !!(F.move.eta && j.eta) }]);
      if (res && res.ok) {
        const K = keyOf(j);
        if (Array.isArray(res.row)) { state.rowMap.set(K, res.row); rebuildJob(K); }
        state.delays[K] = res.delays || [];
        closeOverlays(); rerender();
        toast((early ? 'Preponed ' + F.days : 'Delay +' + F.days) + (F.days === 1 ? ' day' : ' days') + ' marked', { action: { label: 'Undo', fn: () => removeDelay(res.id, true) } });
        state.syncedAt = Date.now();
        return;
      }
      $('#formError').textContent = (res && res.error) || 'Not saved.';
    } catch (e) { if (e.kind !== 'auth') $('#formError').textContent = /not available/i.test(e.message) ? 'Mark delay needs the Phase 4 Code.gs update.' : e.message; }
    btn.disabled = false; btn.textContent = (F.dir === 'early' ? 'MARK PREPONED −' : 'MARK DELAY +') + F.days + 'D';
  }
  async function removeDelay(id, quiet) {
    const was = Object.values(state.delays || {}).reduce((a, l) => a.concat(l || []), []).find((x) => x.id === id), word = was && was.days < 0 ? 'Prepone' : 'Delay';   // v2.9.3
    setSaving(1);
    try {
      const res = await api.call('ethixDelayRemove', [id]);
      if (res && res.ok) {
        const K = String(res.jobNo || '').toUpperCase();
        if (Array.isArray(res.row)) { state.rowMap.set(K, res.row); rebuildJob(K); }
        state.delays[K] = res.delays || [];
        rerender();
        toast(quiet ? word + ' undone' : word + ' removed' + (res.restored && res.restored.length ? ' — dates put back' : ''));
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
    loadLists();   // v2.9.3: sales too (the company's customer names)
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
      return covChips98(true) + '<button type="button" class="meta-chip' + (R.due.length ? '' : ' is-done') + '" data-href="#/follow-ups">' + icon('check', 12) + 'FOLLOW-UPS <b>' + R.done.length + '/' + total + '</b></button>' +
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
      if (b.dataset.checkMenu && canEdit()) { if (r === 'round') openPop(b, 'FOLLOW-UP', undoCard99(b.dataset.checkMenu)); else rmkOpen99(b, b.dataset.checkMenu, { add: true }); return; }   // v2.9.9: remarks have their own card
      if (b.dataset.every && canEdit()) { openPop(b, 'FOLLOW-UP', everyMenu93(b.dataset.every)); return; }
      if (b.dataset.cal) { const K = String(b.dataset.calJob).toUpperCase(); state.calOffset[K] = Math.min(0, (state.calOffset[K] || 0) + +b.dataset.cal); rerender(); return; }
      if (b.dataset.enq) { openEnquiry(b.dataset.enq, b); return; }
      if (b.dataset.enqTab) { state.enqTab = b.dataset.enqTab; rerender(); return; }
      if (b.dataset.act === 'delay' && r === 'job') { openDelay(state.route.jobNo); return; }
      if (b.dataset.act === 'delays') { const k = findJob(state.route.jobNo); if (!$('#delayCard') && k) { state.voyageTab[k.jobNo] = 'overview'; rerender(); } const c = $('#delayCard'); if (c) { c.scrollIntoView({ block: 'center', behavior: 'smooth' }); c.classList.remove('is-flash'); void c.offsetWidth; c.classList.add('is-flash'); } return; }
      if (b.dataset.delayRm && canEdit()) {
        const id = b.dataset.delayRm;
        const early = Object.values(state.delays || {}).reduce((a, l) => a.concat(l || []), []).some((x) => x.id === id && x.days < 0);   // v2.9.3
        confirmBox(early ? 'Remove this prepone?' : 'Remove this delay?', 'If it moved ETD/ETA and nobody changed them since, they go back too.', 'Remove', () => removeDelay(id));
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
      if (!text) { $('#remarkInput').focus(); return; }   // v2.9.10: a remark on its own — it never checks the job (the circle does)
      closeOverlays();
      followNote910(no, text);
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
        const t = e.target.closest('[data-dl-dir], [data-dl-step], [data-dl-days], [data-dl-where], [data-dl-reason], [data-dl-move], [data-act="form-cancel"]'); if (!t) return;
        if (t.dataset.act === 'form-cancel') { closeOverlays(); return; }
        const other = $('#dlOther'); if (other) F.other = other.value; F.note = $('#dlNote').value;
        if (t.dataset.dlDir && t.dataset.dlDir !== F.dir) { F.dir = t.dataset.dlDir; F.reason = ''; }
        if (t.dataset.dlStep) F.days = Math.max(1, Math.min(90, F.days + +t.dataset.dlStep));
        if (t.dataset.dlDays) F.days = +t.dataset.dlDays;
        if (t.dataset.dlWhere) { F.where = t.dataset.dlWhere; if (!F.moveSet98) F.move = movesDates(F.where); }   // v2.9.8: dates set by hand stay as set
        if (t.dataset.dlReason) F.reason = t.dataset.dlReason;
        if (t.dataset.dlMove) { F.move[t.dataset.dlMove] = !F.move[t.dataset.dlMove]; F.moveSet98 = true; }
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
  const readyChip = (j) => canEditJob(j) && isReady(j) ? '<button type="button" class="ready-chip" data-act="close-job">' + icon('check', 13) + 'READY TO CLOSE</button>' : '';
  const canEditJob = (j) => canEdit() && !(j && j.closed) && (!j || mayEdit911(j));   // v2.9.11: its owner, or the colleague covering them
  // closedActions — v2.9.13 version further down (the yearly archive is read-only)
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
      if (!r || r.name !== 'job' || !canEditJob(findJob(r.jobNo))) return;
      const st = e.target.closest('[data-stop="completed"]');
      const j = findJob(r.jobNo);
      if (st && j && !j.closed && j.status !== 'COMPLETED' && j.status !== 'CANCELLED') { e.stopImmediatePropagation(); openClose(r.jobNo); }
    }, true);
    view.addEventListener('click', (e) => {
      const r = state.route;
      if (e.target.closest('[data-act="ready-list"]')) { state.jobsUi.status = 'ready'; state.jobsUi.limit = 120; go('#/jobs'); return; }
      if (!r || r.name !== 'job') return;
      if (e.target.closest('[data-act="close-job"]') && canEditJob(findJob(r.jobNo))) { openClose(r.jobNo); return; }
      if (e.target.closest('[data-act="reopen"]') && canEdit() && mayEdit911(findJob(r.jobNo))) { reopenJob(r.jobNo); }
    });
    // choosing Completed / Cancelled anywhere (status card, quick update) goes through Close job
    const intercept = (e) => {
      const b = e.target.closest('[data-set="status"]');
      if (!b || !['COMPLETED', 'CANCELLED'].includes(b.dataset.val)) return;
      const r = state.route; if (!r || r.name !== 'job' || !canEditJob(findJob(r.jobNo))) return;
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
  // DGPC for DG sea exports, pick a day in This week. v2.9.3: overseas office hours, calendar weeks, switch BL, sea import
  // BL steps, remarks on the job page, copy a job number, follow-ups by weekday or date, preponed, delivery note
  // (at the end of this module). v2.9.4: the cost sheet's PROFIT and PROFIT / BOX in AED and USD. v2.9.5: a CND on its
  // way in counts as at sea (it has no ETD). v2.9.6: the Active jobs Word file shows the job type, the shipping line and
  // the ETA once sailed.
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
  const sellsNothing = (l) => !num6(l.sr);
  const newLineId = () => (Math.random().toString(36).slice(2, 10) + 'k0x9').slice(0, 8);
  const boxesOf = (j) => (j.c20 || 0) + (j.c40 || 0);
  const canCostSee = (j) => !!j && (canEdit() || isView() || (isSales() && j.sales === state.user));   // v2.9.20: + a viewer (read only)
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
  function dropSession() { rd915Clear(); try { localStorage.removeItem(SESSION); } catch (e) { /* private mode */ } }
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
    const j = findJob(no); if (!j || !canEdit() || j.closed) return;   // v2.9.11: anyone in Customer Service may copy any job
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
    if (data.status !== 'NEW' && !data.legacy) state.costing[C.no] = [data.status, data.sell, data.buy, data.profit, data.version, data.at, data.by, data.lockedBy, data.lockedAt || 0];   // v2.9.9: + locked at
  }
  function loadCost(no, force) {
    const K = String(no).toUpperCase();
    let C = costFor(K);
    if (C && (C.loading || (C.data && !force))) return C;
    if (!C) C = state.cost = { no: K, data: null, draft: null, dirty: false, loading: false, err: '', busy: '', showLog: false };
    C.loading = true;
    costFetch98(K, no).then((res) => {   // v2.9.8: fetched ahead from the job page when it can be
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
  const costCanEdit = (j, D) => !!D && !D.closed && D.status !== 'LOCKED' && ((canEdit() && mayEdit911(j)) || (isSales() && j.sales === state.user && D.sales === state.user));
  const costCanUnlock = (D) => !!D && canEdit() && !D.closed && D.status === 'LOCKED' && mayEdit911({ cs: D.cs });
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
      '<div class="ch-main"><div class="vh-idrow"><h1 class="vh-job">' + copyNo93(j.jobNo) + '</h1><span class="badge badge-lg">' + esc(j.type + ' · ' + j.typeName.toUpperCase()) + '</span>' + (j.cargo ? '<span class="vh-cargo">' + esc(j.cargo) + '</span>' : '') + '</div>' +
        custBtn910(j) +
        '<div class="ch-meta"><span>' + esc(j.mode === 'misc' ? (j.against ? 'AGAINST ' + j.against : 'COSTING ONLY') : j.route) + '</span><span>CS · ' + esc(j.cs || '—') + '</span>' + (j.sales ? '<span>SALES · ' + esc(j.sales) + '</span>' : '') +
        '<button type="button" class="link-btn" data-job="' + esc(j.jobNo) + '">Open job →</button></div></div>' +
      '<div class="ch-actions">' + xlsBtn + unlockBtn + saveBtn + doneBtn + '</div>' +
    '</header>';
  }
  function costBanner(j, D) {
    if (!D) return '';
    if (D.closed) return '<div class="cost-banner">' + icon('lock', 15) + '<span>This job is closed, so its costing is read-only. ' + (canEdit() ? 'Reopen the job to change it.' : '') + '</span></div>';
    if (D.status === 'LOCKED') return '<div class="cost-banner is-locked">' + icon('lock', 15) + '<span><b>Costing done</b>' + (D.lockedBy ? ' · locked by ' + esc(nice(D.lockedBy)) : '') + (D.lockedAt ? ' · ' + esc(ago(D.lockedAt)) : '') + (D.legacy ? ' · marked done before costing sheets (no lines)' : '') + '. ' + (canEdit() ? 'Unlock it to make changes.' : 'Ask Customer Service if something needs to change.') + '</span>' + invSeg98(j) + '</div>';
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
        '<span class="cp912-right"><span class="ct-mode-hint">All-in: a line without selling is included in the price</span>' + (edit ? '<button type="button" class="btn-ghost cp912-btn" data-act="cost-copy912" aria-label="Copy charges from another job" title="Copy charges from another job">' + icon('copy', 15) + '<span class="btn-label">Copy from job…</span></button>' : '') + '</span></div>' +
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
      '<span class="rr-main"><span class="rr-job">' + esc(j.jobNo) + ' <span class="badge">' + esc(j.type) + '</span>' + ownTag98(j) + '</span><span class="rr-cust">' + esc(j.customer || '—') + '</span><span class="rr-route">' + esc(j.mode === 'misc' ? 'COSTING ONLY' : j.route) + '</span></span>' +
      '<span class="cr-when">' + when + (x.st === 'done' && !invOf98(j).na ? invChip98(invOf98(j)) : '') + (who ? '<span class="cl-sub">' + esc(who) + '</span>' : '') + '</span>' +
      '<span class="cr-people"><span>CS · ' + esc(j.cs || '—') + '</span>' + (j.sales ? '<span>SALES · ' + esc(j.sales) + '</span>' : '') + '</span>' +
      '<span class="cr-nums">' + nums + '</span><span class="cr-go">' + icon('chevron', 16) + '</span></button></li>';
  }
  function renderCostList(first) {
    const t0 = today0(), anim = first ? ' reveal' : '';
    const U = state.costUi, R = costRows();
    const q = (U.q || '').trim().toUpperCase();
    const match = (x) => !q || (x.j.jobNo + ' ' + x.j.customer + ' ' + x.j.route + ' ' + x.j.cs + ' ' + x.j.sales + ' ' + x.j.type + ' ' + x.j.blNo + ' ' + invOf98(x.j).label).toUpperCase().includes(q);
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
        big('done', 'DONE', R.done.length, R.done.length ? invTodo98(R.done) : 'none yet') +
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
      invRow98(j) + '<button type="button" class="btn-ghost pop-wide" data-cost="' + esc(j.jobNo) + '">' + icon('costing', 16) + '<span>' + (s ? 'Open costing' : editable ? 'Start costing' : 'Open costing') + '</span></button></section>';
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
        const al = a.h || a.v || a.wrap || a.indent || a.shrink ? '<alignment' + (a.h ? ' horizontal="' + a.h + '"' : '') + (a.v ? ' vertical="' + a.v + '"' : '') + (a.wrap ? ' wrapText="1"' : '') + (a.indent ? ' indent="' + a.indent + '"' : '') + (a.shrink ? ' shrinkToFit="1"' : '') + '/>' : '';
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
  // v2.9.4: PROFIT and PROFIT / BOX read AED (the figure) then USD (company rate) on a line of its own.
  function costWorkbook(info, logo, opts = {}) {
    const S = XL.Styles(), C = XL.col;
    const INK = '0B1B2B', NAVY = '1C5179', GREY = '5A6878', MUTE = '7D8B9A', LINE = 'D5DDE5', HAIR = 'E8EDF2', TEAL = '0E7C7B', ZEBRA = 'F7F9FB', RED = 'B42318';
    const AED = '#,##0.00;[Red]-#,##0.00', AEDL = '#,##0.00;[Red]-#,##0.00;"–"', FX = '0.000##', PCT = '0.0%;[Red]-0.0%', USD2 = '#,##0.00;[Red]-#,##0.00';
    const AEDP = '"AED "#,##0.00;[Red]"AED -"#,##0.00', USDL = '"USD "#,##0.00;[Red]"USD -"#,##0.00';   // PROFIT and PROFIT / BOX: AED, then USD
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
    const tileVal = (first, sz, color, fmt, bottom, v) => S({ font: { sz, b: true, color: color || INK }, fmt, border: Object.assign(first ? {} : { left: ['thin', LINE] }, bottom ? { bottom: ['thin', LINE] } : {}), align: { h: 'left', v: v || 'center', indent: 1, shrink: first } });
    const tileUsd = (first, color, fmt, bottom) => S({ font: { sz: 9.5, b: true, color: color || MUTE }, fmt, border: Object.assign(first ? {} : { left: ['thin', LINE] }, bottom ? { bottom: ['thin', LINE] } : {}), align: { h: 'left', v: 'top', indent: 1, shrink: first } });
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
    const G = 17, H = 18, first = 19, lines = info.lines, last = first + lines.length - 1, T = first + lines.length;   // v2.9.4: two rows lower (the USD lines)
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
    // ---- the result (rows 10–12) and per box (rows 13–15): label · figure · the USD line (PROFIT and PROFIT / BOX only)
    const TILES = [[0, 0], [1, 1], [2, 3], [4, 6], [7, LAST]];        // the same columns as the table below
    const tiles = (rl, items, sz, bottom) => {
      items.forEach(([label, value, fmt, f, color, lcolor, usd], i) => {
        const [c1, c2] = TILES[i];
        cell(rl, c1, c2, label, tileLab(i === 0, lcolor));
        cell(rl + 1, c1, c2, value, tileVal(i === 0, sz, color, fmt, false, 'bottom'), f);
        cell(rl + 2, c1, c2, usd ? usd[0] : '', tileUsd(i === 0, usd && usd[3], usd && usd[1], bottom), usd ? usd[2] : null);
      });
    };
    const pc = p < 0 ? RED : TEAL;
    height(10, 14); height(11, 22); height(12, 15);
    tiles(10, [
      ['PROFIT', p, AEDP, jT + '-' + gT, pc, TEAL, [p / CO, USDL, '(' + jT + '-' + gT + ')/' + CO, pc]],
      ['MARGIN', ss ? p / ss : 0, PCT, 'IF(' + jT + '=0,0,(' + jT + '-' + gT + ')/' + jT + ')'],
      ['MARK-UP', sb ? p / sb : 0, PCT, 'IF(' + gT + '=0,0,(' + jT + '-' + gT + ')/' + gT + ')'],
      ['BUYING · AED', sb, AED, gT, INK, NAVY],
      ['SELLING · AED', ss, AED, jT, INK, TEAL]
    ], 15, false);
    height(13, 14); height(14, 19); height(15, 16);
    tiles(13, bx ? [
      ['PROFIT / BOX', p / bx, AEDP, '(' + jT + '-' + gT + ')/' + bx, pc, null, [p / bx / CO, USDL, '(' + jT + '-' + gT + ')/' + bx + '/' + CO, pc]],
      ['BOXES', bx + ' · ' + info.cargo, null, null, INK],
      ['USD RATE · PER BOX', CO, FX, null, INK],
      ['COST / BOX · USD', sb / bx / CO, USD2, gT + '/' + bx + '/' + CO, NAVY],
      ['SELL / BOX · USD', ss / bx / CO, USD2, jT + '/' + bx + '/' + CO, TEAL]
    ] : [
      ['PROFIT / BOX', '—', null, null, MUTE, null, ['—', null, null, MUTE]], ['BOXES', info.cargo || '—', null, null, INK], ['USD RATE · PER BOX', CO, FX, null, INK],
      ['COST / BOX · USD', '—', null, null, MUTE], ['SELL / BOX · USD', '—', null, null, MUTE]
    ], 12, true);
    height(16, 12);
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
  function mineJobs() { if (!canEdit()) return state.jobs; const o = covOwners98(); return state.jobs.filter((j) => j.cs === state.user || o.has(j.cs)); }   // v2.9.8: + a colleague you cover today

  // ================================================================ v2.7 — cutoffs, every open one, coloured
  // red: passed, today or tomorrow (inside 24 h) · amber: in 2–3 days · calm: later
  const cutTone = (d) => (d <= due99() ? 'red' : d <= 3 ? 'amber' : 'calm');   // v2.9.9: Friday — the weekend is red too
  const cutWhen = (d, date) => (d < 0 ? 'PASSED' : d === 0 ? 'TODAY' : d === 1 ? 'TOMORROW' : d >= 2 && d <= off911() ? dayLong911(d).toUpperCase() : fmt(date));
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
  const PEND_NAME = { si: 'SI submission', docsReady: 'Docs to prepare', ed: 'ED pending', dgpc: 'DGPC pending', blFinal: 'Final BL pending', switchBl: 'Switch BL pending', blConf: 'BL confirmation pending', blReceived: 'BL to receive', blIss: 'BL issue pending',
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
    return '<li><button type="button" class="notif' + (x.t > seen ? ' is-new' : '') + (x.kind === 'delay' ? ' is-delay' : '') + '" ' + (x.kind === 'cover' ? 'data-href="#/cover"' : (/^EQ-/.test(x.job) ? 'data-enq' : x.kind === 'costing' ? 'data-cost' : 'data-job') + '="' + esc(x.job) + '"') + '>' +
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
  function remarkList(list, max) {
    const show = max ? list.slice(0, max) : list;
    return '<ol class="fu-remarks">' + show.map((c) => '<li><span class="fr-when">' + esc(hm(c[0])) + (c[1] !== state.user ? ' · ' + esc(nice(c[1])) : '') + '</span><span class="fr-text">' + esc(c[2]) + '</span></li>').join('') + '</ol>' +
      (max && list.length > max ? '<span class="fr-more">+' + (list.length - max) + ' more today</span>' : '');
  }
  // The newest remark of the day the job was last checked (and how many that day).
  // lastRemark — v2.9.10 version further down

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
    pf.value = '10'; flashField(pf);
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
  // officeState — v2.9.11 version further down (public holidays are days off)
  const hhmm = (t) => String(t.h).padStart(2, '0') + ':' + String(t.m).padStart(2, '0');
  const durTxt = (m) => (m < 60 ? m + ' MIN' : Math.floor(m / 60) + ' H' + (m % 60 && m < 300 ? ' ' + (m % 60) + ' MIN' : ''));
  function weekTxt(z) {   // v2.9.3: any working week (Brunei: Monday–Thursday, Saturday)
    const off = WEEKEND[z.cc] || [0, 6], N = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const start = [0, 1, 2, 3, 4, 5, 6].find((d) => !off.includes(d) && off.includes((d + 6) % 7));
    if (start === undefined) return 'every day';
    const runs = []; let cur = null;
    for (let i = 0; i < 7; i++) { const d = (start + i) % 7; if (off.includes(d)) { if (cur) { runs.push(cur); cur = null; } } else if (!cur) cur = [d, d]; else cur[1] = d; }
    if (cur) runs.push(cur);
    return runs.map(([a, b]) => (a === b ? N[a] : N[a] + '–' + N[b])).join(', ');
  }
  // state: short, on the clock · more: the whole story, for the tooltip
  function clockBits(z, now) {
    const o = officeState(z, now); if (!o) return null;
    const [o9, o5] = hrsTxt(z).split('–'), h9 = hoursOf(z)[0] / 60;
    if (o.open) return { time: hhmm(o.t), tone: o.toClose <= 60 ? 'amber' : 'open', state: o.toClose <= 60 ? 'CLOSES IN ' + durTxt(o.toClose) : 'OPEN', more: 'open · closes ' + o5 + ' (in ' + durTxt(o.toClose).toLowerCase() + ')', o };
    return { time: hhmm(o.t), tone: 'closed', state: o.hol ? 'HOLIDAY' : 'CLOSED', more: 'closed' + (o.hol ? ' today — ' + o.hol : '') + ' · opens ' + (o.toOpen < 1440 && o.opensDow === (o.t.dow + (o.t.h >= h9 ? 1 : 0)) % 7 ? (o.t.h >= h9 ? 'tomorrow' : 'today') : DOW[o.opensDow]) + ' ' + o9 + ' (in ' + durTxt(o.toOpen).toLowerCase() + ')', o };
  }
  const clockTitle = (port, z, c) => 'Local time at ' + upq(port) + ' — ' + c.more + '. Office hours ' + hrsTxt(z) + ', ' + weekTxt(z) + '.';
  // The live clock under a port name on the job page (ticks by itself).
  function portClock(port, where) {
    const z = portZone(port); if (!z) return '';
    const c = clockBits(z); if (!c) return '';
    return '<div class="pclock pc-' + where + ' is-' + c.tone + '" data-clock="' + esc(port) + '" title="' + esc(clockTitle(port, z, c)) + '">' + icon('clock', 12) + '<b>' + c.time + '</b><span>' + esc(c.state) + '</span></div>';
  }
  // Follow-ups: the port whose office matters now — origin before sailing, destination after.
  function clockPort(j, t0) { if (j.mode === 'misc') return ''; return j.atSea || j.arrived || (j.etd && j.etd <= t0) || cndWay95(j, t0) ? j.pod : j.pol; }   // v2.9.5: CND on its way in
  function rowClock(j, t0) {
    const p = clockPort(j, t0), z = p && portZone(p); if (!z) return '';
    const c = clockBits(z); if (!c) return '';
    return '<span class="pclock pc-mini is-' + c.tone + '" data-clock="' + esc(p) + '" data-mini="1" title="' + esc(clockTitle(p, z, c)) + '"><i></i><b>' + c.time + '</b>' + esc(upq(p)) + '</span>';
  }
  // urgent first (cutoff passed / today, free time) — then whose office closes soonest; closed offices by who opens first
  function dueSort8(t0) {   // v2.9.9: overdue / cutoff today / free time first, then cutoff tomorrow, then the rest — inside each, office hours
    const now = new Date(), memo = new Map();
    const score = (j) => { if (!memo.has(j)) memo.set(j, officeScore99(j, now, t0)); return memo.get(j); };
    const since = (x) => (x.f.since === null ? 1e9 : x.f.since);
    return (a, b) => dueTier99(a.j) - dueTier99(b.j) || score(a.j) - score(b.j) || a.j.next.rank - b.j.next.rank || since(b) - since(a);
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
  function scopedJobs8() { if (!canEdit()) return state.jobs; const o = covOwners98(); return state.jobs.filter((j) => j.cs === state.user || o.has(j.cs)); }   // v2.9.8: + a colleague you cover today
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
      if (tb && canEditJob(findJob(tb.dataset.transfer))) { state.transfer8 = null; openPop(tb, 'CUSTOMER SERVICE', transferMenu(tb.dataset.transfer)); return; }
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
    if (Array.isArray(boot.covers)) state.covers = boot.covers;   // v2.9.8
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
  function stageOf91(j, t0) { if (!j.etd && !j.eta) return 'nodate'; if (j.eta && j.eta <= t0) return 'arrived'; if (j.etd && j.etd <= t0) return 'sea'; if (cndWay95(j, t0)) return 'sea'; return 'before'; }   // v2.9.5: CND on its way in
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
        (r.repeat ? '<span class="rm-rep">' + icon('refresh', 11) + remRep93(r) + '</span>' : '') + '</span></button>' +
      (r.job && !noJob ? '<button type="button" class="rm-job" data-job="' + esc(r.job) + '">' + esc(r.job) + '</button>' : '') + '</li>';
  }
  // remGroups — v2.9.12 version further down (every reminder shown, later days by date)
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
        (F.repeat && parseDate(F.due) ? '<p class="rm-rep-hint">' + esc(remRep93({ repeat: F.repeat, due: F.due }, true)) + '</p>' : '') +
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
      '<div class="tile-body">' + missBox912() + (brief ? '<div class="md-brief">' + brief + '</div>' : '') +
        (body || '<p class="rm-empty">No reminders. Add one for anything that is not a booking — a call, a payment, a rate to check.</p>') + '</div></section>';
  }
  // ================================================================ v2.9.1 — TODAY'S WATCH: what still has to happen, and by when
  // Before sailing: SI, ED and BL confirmation — by their cutoff, or by the sailing date when there is no cutoff
  // (v2.9.2: DGPC for DG sea exports, the DG cutoff for air). Still open after the ship sailed = overdue. Imports: the line free time ending or over.
  function watchItems91(active, t0) {   // v2.9.9: open tasks stay until done · original docs · port free time · invoice · Friday = the weekend too · office hours within a day
    const out = [], D = due99(t0);
    const cutW = (d) => (d < 0 ? (-d) + (d === -1 ? ' day' : ' days') + ' overdue' : 'cutoff ' + dayWord99(d, t0));
    const add = (j, what, say, d, when, extra) => out.push(Object.assign({ j, what, say, d, when, level: d <= D ? 'urgent' : 'soon' }, extra || {}));
    const ago = (d) => (d === -1 ? 'yesterday' : (-d) + ' days ago');
    active.forEach((j) => {
      if (j.hold || j.mode === 'misc') return;
      if ((j.cat === 'EXPORT' || j.cat === 'CROSS') && j.type !== 'CRR') {
        const air = j.mode === 'air', sd = j.etd ? days(t0, j.etd) : null;
        const verb = air ? 'departs' : 'sails', past = air ? 'departed ' : 'sailed ';
        const task = (open, cut, what, say, field) => {
          if (!open) return;
          if (sd !== null && sd < 0) { add(j, what, say, sd, past + ago(sd), { field }); return; }   // stays until it is done
          if (cut) { const dc = days(t0, cut); if (dc <= 3) add(j, what, say, dc, cutW(dc), { field }); return; }
          if (sd !== null && sd <= 3) add(j, what, say, sd, verb + ' ' + dayWord99(sd, t0), { field });
        };
        task(!j.sido || j.sido === 'PENDING', j.siCut, 'SI NOT SUBMITTED', 'SI not submitted', 'sido');
        if (j.cat === 'EXPORT') task(!j.ed || j.ed === 'PENDING', j.edCut, 'ED NOT PASSED', 'ED not passed', 'ed');
        task(j.bl !== NA && !BL_OK.includes(j.bl), null, air ? 'AWB NOT CONFIRMED' : 'BL NOT CONFIRMED', air ? 'AWB not confirmed' : 'BL not confirmed', 'bl');
        if (j.cat === 'EXPORT' && j.dg === 'DG' && j.mode === 'sea') task(!j.dgpc || j.dgpc === 'PENDING', j.dgCut, 'DGPC NOT SUBMITTED', 'DGPC not submitted', 'dgpc');   // v2.9.2
        else if (j.cat === 'EXPORT' && j.dg === 'DG' && j.dgCut && !(sd !== null && sd < 0)) { const dc = days(t0, j.dgCut); if (dc >= -1 && dc <= 3) add(j, 'DG CUTOFF', 'DG cutoff', dc, dc < 0 ? 'passed yesterday' : dayWord99(dc, t0)); }
      }
      if (j.type === 'SFIF' || j.type === 'SFIL') {   // sea imports: BL confirmation by the sailing date, overdue after it — arrived too (v2.9.9)
        const sd = j.etd ? days(t0, j.etd) : null;
        if (j.bl !== NA && !BL_OK.includes(j.bl)) {
          if (sd !== null && sd < 0) add(j, 'BL NOT CONFIRMED', 'BL not confirmed', sd, 'sailed ' + ago(sd), { field: 'bl' });
          else if (sd !== null && sd <= 3) add(j, 'BL NOT CONFIRMED', 'BL not confirmed', sd, 'sails ' + dayWord99(sd, t0), { field: 'bl' });
        }
      }
      if ((j.type === 'SFIF' || j.type === 'SFIL' || j.type === 'CND') && j.docs === 'PENDING' && !j.delivery && j.eta) {   // v2.9.9: no originals, no DO
        const d = days(t0, j.eta);
        if (d <= 2) add(j, 'ORIGINAL DOCS NOT RECEIVED', 'Original docs not received', d, d < 0 ? 'arrived ' + ago(d) : 'arrives ' + dayWord99(d, t0), { field: 'docs' });
      }
      if (j.cat === 'IMPORT' && j.arrived && !j.delivery) {   // free time (line, and port — v2.9.9) ending or over, until delivered
        const free = (end, port) => {
          if (!end) return;
          const d = days(t0, end); if (d > 2) return;
          const P = port ? 'PORT ' : '', p = port ? 'Port free time' : 'Free time';
          add(j, P + (d < 0 ? 'FREE TIME OVER' : 'FREE TIME ENDS'), p + (d < 0 ? ' over' : ' ends'), d, d < 0 ? 'over by ' + (-d) + (d === -1 ? ' day' : ' days') : 'ends ' + dayWord99(d, t0), { free: true, port, field: 'delivery' });
        };
        free(j.lineFreeEnd, false); free(j.portFreeEnd, true);
      }
      const inv = invOf98(j), cs = costSum(j);   // v2.9.9: the invoice, 3 days after costing was marked done here
      if (inv.open && inv.value === 'INVOICE NOT ISSUED' && cs && cs[0] === 'LOCKED' && cs[8]) {
        const n = days(dayOf(cs[8]), t0);
        if (n >= 3) add(j, 'INVOICE NOT ISSUED', 'Invoice not issued', 3 - n, 'costing done ' + n + ' days ago', { field: 'invoice' });
      }
    });
    const now = new Date(), memo = new Map(), sc = (j) => { if (!memo.has(j)) memo.set(j, officeScore99(j, now, t0)); return memo.get(j); };
    const long = (w) => (w.d < -21 ? 1 : 0);   // overdue 3+ weeks: kept, after today's work (the most recent of them first)
    return out.sort((a, b) => long(a) - long(b) || (long(a) ? b.d - a.d : a.d - b.d) || (a.level === b.level ? 0 : a.level === 'urgent' ? -1 : 1) || sc(a.j) - sc(b.j));
  }

  // ================================================================ v2.9.1 — Home: five counters (each opens the side panel)
  // kpiTiles91 — v2.9.14 version further down (in this person's order; Arrange mode)

  // ================================================================ v2.9.1 — Home: four tall tiles, each made for its job
  // watchTile91 — v2.9.10 version (one row per job) further down
  // the week as an agenda: a strip of seven days (how much sails and arrives each day), then day by day.
  // v2.9.3: calendar weeks Monday–Sunday with ‹ › (last week, next week …); days already gone say what sailed or arrived.
  const monday93 = (d) => addDays(d, -((d.getDay() + 6) % 7));
  const wkStart93 = () => addDays(monday93(today0()), 7 * (state.wkOff93 || 0));
  function wkEvents93(m, start) {
    const end = addDays(start, 6), ev = [];
    m.active.forEach((j) => {
      if (j.mode === 'misc') return;
      if (j.etd && j.etd >= start && j.etd <= end) ev.push({ j, d: j.etd, k: 'dep' });
      if (j.eta && j.eta >= start && j.eta <= end) ev.push({ j, d: j.eta, k: 'arr' });
    });
    return ev.sort((a, b) => a.d - b.d || (a.k === b.k ? 0 : a.k === 'dep' ? -1 : 1));
  }
  function wkTag93(e, t0) {
    const past = e.d < t0, cr = e.j.mode === 'courier';
    if (e.k === 'arr') return cr ? (past ? 'DELIVERED' : 'DELIVERY') : past ? 'ARRIVED' : 'ARRIVES';
    return e.j.mode === 'air' ? (past ? 'DEPARTED' : 'DEPARTS') : cr ? (past ? 'PICKED UP' : 'PICK-UP') : past ? 'SAILED' : 'SAILS';
  }
  const dm93 = (d) => d.getDate() + ' ' + MON91[d.getMonth()];
  function wkName93(off, start) {
    if (off === 0) return 'THIS WEEK';
    if (off === 1) return 'NEXT WEEK';
    if (off === -1) return 'LAST WEEK';
    const e = addDays(start, 6);
    return (start.getMonth() === e.getMonth() ? start.getDate() + '–' + dm93(e) : dm93(start) + ' – ' + dm93(e)).toUpperCase();
  }
  function weekTile91(m, anim) {
    const t0 = today0(), off = state.wkOff93 || 0, start = wkStart93(), end = addDays(start, 6);
    const all = wkEvents93(m, start), pick = wkPick92();                // a day picked in the strip (tap it again for the whole week)
    const ev = pick ? all.filter((x) => +dayOf(x.d) === +pick) : all;
    const nA = ev.filter((x) => x.k === 'arr').length, nD = ev.length - nA;
    const strip = '<div class="wk-strip' + (pick ? ' has-pick' : '') + '" role="group" aria-label="Pick a day">' + Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((d) => {
      const e = all.filter((x) => +dayOf(x.d) === +d), a = e.filter((x) => x.k === 'arr').length, s = e.length - a, on = !!pick && +pick === +d;
      return '<button type="button" class="wk-day' + (+d === +t0 ? ' is-today' : d < t0 ? ' is-past' : '') + (e.length ? '' : ' is-none') + (on ? ' is-on' : '') + '" data-wkday="' + isoOf(d) + '" aria-pressed="' + on + '" title="' + esc(DOW[d.getDay()] + ' ' + dm93(d) + ' · ' + (s ? s + ' sailing' : 'none sailing') + ', ' + (a ? a + ' arriving' : 'none arriving')) + '">' +
        '<em>' + DOW_UP[d.getDay()] + '</em><b>' + d.getDate() + '</b><span class="wk-n">' + (s ? '<i class="is-dep">' + s + '</i>' : '') + (a ? '<i class="is-arr">' + a + '</i>' : '') + '</span></button>';
    }).join('') + '</div>';
    let last = null, list = '';
    ev.slice(0, LIST_MAX).forEach((e, i) => {
      const n = days(t0, e.d);
      if (n !== last) { last = n; list += '<div class="wk-gh' + (i >= 6 ? ' is-more' : '') + '">' + (n === 0 ? 'TODAY' : n === 1 ? 'TOMORROW' : n === -1 ? 'YESTERDAY' : DOW_UP[e.d.getDay()]) + ' · ' + e.d.getDate() + ' ' + MON91[e.d.getMonth()].toUpperCase() + '</div>'; }
      list += '<button type="button" class="wk-row li' + (i >= 6 ? ' is-more' : '') + '" data-job="' + esc(e.j.jobNo) + '"><span class="wk-tag is-' + e.k + (e.d < t0 ? ' is-past' : '') + '">' + wkTag93(e, t0) + '</span><span class="li-main"><span class="li-job">' + changedDot(e.j) + esc(e.j.jobNo) + ownTag98(e.j) + '</span><span class="li-sub">' + esc(nice(e.j.route)) + (e.j.cargo ? ' · ' + esc(e.j.cargo) : '') + '</span></span></button>';
    });
    const gone = end < t0;
    const none = pick ? 'Nothing ' + (pick < t0 ? 'sailed or arrived' : 'sails or arrives') + ' on ' + DOW[pick.getDay()] + ' ' + dm93(pick) + '.'
      : 'Nothing ' + (gone ? 'sailed or arrived' : 'sails or arrives') + ' ' + (off === 0 ? 'this week' : off === 1 ? 'next week' : off === -1 ? 'last week' : 'from ' + dm93(start) + ' to ' + dm93(end)) + '.';
    return '<section class="tile t-week' + anim + '" style="--d:280ms" aria-labelledby="weekTitle">' +
      '<div class="tile-head"><div class="wk-head"><h2 class="tile-title" id="weekTitle">' + wkName93(off, start) + '</h2><button type="button" class="wk-arrow wk-cal912" data-act="cal912" aria-label="Month calendar" title="Month calendar">' + icon('cal912', 16) + '</button></div><span class="tile-count">' + ev.length + '</span></div>' +
      strip + '<div class="wk-legend"><span><i class="is-dep"></i>Sailing ' + nD + '</span><span><i class="is-arr"></i>Arriving ' + nA + '</span>' +
        (pick || off ? '<span class="wk-links">' + (pick ? '<button type="button" class="wk-all" data-wkday="">Whole week</button>' : '') + (off ? '<button type="button" class="wk-all" data-wk-off="0">This week</button>' : '') + '</span>' : '') + '</div>' +
      '<div class="tile-body">' + (list || empty('calendar', none)) + '</div>' + seeAll('week', ev.length) + '</section>';
  }
  // the picked day (a Date at local midnight) while it is inside the week shown, else null
  function wkPick92() {
    const k = state.wkDay92; if (!k) return null;
    const start = wkStart93();
    for (let i = 0; i < 7; i++) { const d = addDays(start, i); if (isoOf(d) === k) return d; }
    state.wkDay92 = ''; return null;
  }
  // the side panel for the week follows the week and the picked day
  function weekPanel92(m) {
    const pick = wkPick92(), ev = wkEvents93(m, wkStart93()).filter((e) => !pick || +dayOf(e.d) === +pick);
    return [pick ? DOW_UP[pick.getDay()] + ' · ' + dm93(pick).toUpperCase() : wkName93(state.wkOff93 || 0, wkStart93()), ev.map((e) => e.j)];
  }
  // ================================================================ v2.9.3 — Home: OVERSEAS OFFICE HOURS (times in Dubai time)
  // The far end of every live job — exports: POD; imports: POL; cross-trade: both — not the UAE (Dubai time is shown).
  // Teal = open, amber = closing within the hour, grey = closed; open ones by who closes first, then who opens first.
  function farEnds93(j) { return j.cat === 'EXPORT' ? [j.pod] : j.cat === 'IMPORT' ? [j.pol] : j.cat === 'CROSS' ? [j.pol, j.pod] : []; }
  function portList91(t0) {
    const now = new Date(), map = new Map();
    liveJobs91().forEach((j) => farEnds93(j).forEach((p) => {
      const z = p && portZone(p); if (!z || z.cc === 'AE') return;
      const k = upq(p), e = map.get(k) || { port: k, z, jobs: [] }; if (!e.jobs.includes(j)) e.jobs.push(j); map.set(k, e);
    }));
    return Array.from(map.values()).map((e) => Object.assign(e, { o: officeState(e.z, now) })).filter((e) => e.o)
      .sort((a, b) => (a.o.open !== b.o.open ? (a.o.open ? -1 : 1) : a.o.open ? a.o.toClose - b.o.toClose : a.o.toOpen - b.o.toOpen) || b.jobs.length - a.jobs.length);
  }
  const yourTime91 = (d) => { const x = dxb(d); return String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };   // Dubai time
  function portState91(o, now) {
    if (o.open) { const at = +now + o.toClose * 60000; return o.toClose <= 60 ? { tone: 'amber', txt: 'closes in ' + o.toClose + ' min' } : { tone: 'open', txt: 'closes ' + (days(dayOf(+now), dayOf(at)) === 1 ? 'tomorrow ' : '') + yourTime91(at) }; }
    const at = +now + o.toOpen * 60000, dd = days(dayOf(+now), dayOf(at));
    if (o.hol) return { tone: 'closed', txt: 'closed · ' + o.hol };   // v2.9.11: a public holiday there today
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
      '<div class="po-head"><h2 class="po-k" id="poTitle">OVERSEAS OFFICE HOURS</h2>' + aeHolChip911() + '<span class="po-now" title="Every time here is Dubai time. Ethix office hours 09:00–18:00, Monday–Friday.">DUBAI TIME <b>' + yourTime91(now) + '</b></span></div>' +
      (L.length ? '<div class="po-chips" id="poChips" aria-live="polite">' + L.map((e) => portChip91(e, now)).join('') + '</div>' +
        '<div class="po-foot"><span class="po-dots" id="poDots"></span><button type="button" class="po-all" data-act="offices-all">All ' + L.length + (L.length === 1 ? ' office' : ' offices') + '</button></div>'
        : '<p class="po-none">The overseas ports of your jobs show here, with their office hours in Dubai time.</p>') + '</section>';
  }
  // the chips in pages of two rows (three on the phone); the pages turn by themselves (pause while pointed at or touched)
  function fitPorts91() {
    const box = $('#poChips'), dots = $('#poDots'); if (!box) return;
    const chips = Array.from(box.querySelectorAll('.po-chip[data-port91]')); if (!chips.length) return;
    box.style.minHeight = ''; box.classList.remove('is-paged');
    chips.forEach((c) => { c.hidden = false; });
    const rows = window.innerWidth < 760 ? 3 : 2, top0 = chips[0].offsetTop, rowH = chips[0].offsetHeight + 6;
    chips.forEach((c) => { c.dataset.page = String(Math.floor(Math.round((c.offsetTop - top0) / rowH) / rows)); });
    const n = +chips[chips.length - 1].dataset.page + 1;
    state.poPages93 = n;
    if (!(state.poPage93 < n)) state.poPage93 = 0;
    if (n > 1) { box.style.minHeight = (rows * rowH - 6) + 'px'; box.classList.add('is-paged'); }
    if (dots) dots.innerHTML = n > 1 ? Array.from({ length: n }, (_, i) => '<button type="button" class="po-dot" data-po-page="' + i + '" aria-label="Offices, page ' + (i + 1) + ' of ' + n + '"></button>').join('') : '';
    showPorts93(state.poPage93, false);
  }
  function showPorts93(p, turn) {
    const box = $('#poChips'); if (!box) return;
    state.poPage93 = p;
    box.querySelectorAll('.po-chip[data-port91]').forEach((c) => { c.hidden = +c.dataset.page !== p; });
    $$('#poDots .po-dot').forEach((d, i) => { d.classList.toggle('is-on', i === p); d.setAttribute('aria-current', i === p ? 'true' : 'false'); });
    if (turn) { box.classList.remove('is-turn'); void box.offsetWidth; box.classList.add('is-turn'); }
  }
  // every overseas office in the side panel: open now · closed, with local time and the jobs there
  function openOffices93(opener) {
    const now = new Date(), L = portList91(today0());
    const row = (e) => {
      const c = portState91(e.o, now);
      return '<div class="of-row is-' + c.tone + '"><div class="of-top"><i></i><b>' + esc(portName91(e.port)) + '</b><span class="of-state">' + esc(c.txt) + '</span></div>' +
        '<div class="of-sub">' + hhmm(e.o.t) + ' local · ' + esc(weekTxt(e.z)) + '</div><div class="of-jobs">' + e.jobs.map((j) => '<button type="button" class="of-job" data-fl-open="' + esc(j.jobNo) + '" title="' + esc((j.customer || '') + ' · ' + j.route) + '">' + changedDot(j) + esc(j.jobNo) + '</button>').join('') + '</div></div>';
    };
    const group = (label, list, tone) => (list.length ? '<div class="dr-gh' + (tone ? ' is-' + tone : '') + '"><span>' + label + '</span><b>' + list.length + '</b></div>' + list.map(row).join('') : '');
    closeOverlays(true);
    $('#drawerKicker').textContent = L.length + (L.length === 1 ? ' OFFICE' : ' OFFICES');
    $('#drawerBody').innerHTML = '<h2 class="peek-job list-title" id="drawerTitle">OVERSEAS OFFICE HOURS</h2><p class="of-intro">Dubai time ' + yourTime91(now) + ' · offices work 09:00–17:00 their own time</p>' +
      (L.length ? group('OPEN NOW', L.filter((e) => e.o.open), 'teal') + group('CLOSED', L.filter((e) => !e.o.open)) : '<p class="of-intro">No overseas ports on your jobs.</p>');
    showDrawer(opener);
    state.overlay = 'drawer';
  }
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
      const soon = (j) => !due(j) && costDueBy99(j, t0);   // v2.9.9: sailing / arriving by tomorrow (Friday: Sunday) is due too
      html = group('SAILED OR ARRIVED', list.filter(due).sort((a, b) => at(a) - at(b)).map(r), 'red') + group(off911(t0) ? 'SAILS OR ARRIVES BY ' + dayLong911(off911(t0), t0).toUpperCase() : 'SAILS OR ARRIVES BY TOMORROW', list.filter(soon).sort((a, b) => at(a) - at(b)).map(r), 'amber') +
        group('NOT DUE YET', list.filter((j) => !costDueBy99(j, t0)).sort((a, b) => at(a) - at(b)).map(r));
    } else if (kind === 'sied') {   // v2.9.9: the red group is the Home number; no cutoff → the sailing date; tap a chip → its choice card
      const D = due99(t0);
      const item = (j) => {
        const chip = (p) => (p.done ? '<span class="cut-chip is-done"><b>' + p.k + '</b>✓</span>'
          : '<span class="cut-chip is-' + p.tone + (canEditJob(j) ? ' is-q99" data-q99="' + esc(j.jobNo) + '" data-q99-f="' + p.f + '" role="button" tabindex="0" aria-label="' + esc(p.k + ' · ' + p.text + ' — update') + '"' : '"') + '><b>' + p.k + '</b>' + esc(p.text) + '</span>');
        return { j, d: siedD99(j, t0), h: row(j, '', '<span class="dr-side is-cuts">' + siedParts99(j, t0).map(chip).join('') + '</span>') };
      };
      const L = list.map(item).sort((a, b) => a.d - b.d);
      html = group(off911(t0) ? 'OVERDUE, TODAY OR ' + (offWord911(t0) === 'WEEKEND' ? 'THIS WEEKEND' : 'BY ' + dayLong911(off911(t0), t0).toUpperCase()) : 'OVERDUE, TODAY OR TOMORROW', L.filter((x) => x.d <= D).map((x) => x.h), 'red') + group('NEXT 3 DAYS', L.filter((x) => x.d > D && x.d <= 3).map((x) => x.h), 'amber') + group('LATER', L.filter((x) => x.d > 3).map((x) => x.h));
    } else if (kind === 'free') {   // v2.9.9: line and port free time — the sooner one on the right, the other one below
      const ends = (j) => [j.lineFreeEnd && { k: 'LINE FREE TIME', e: j.lineFreeEnd }, j.portFreeEnd && { k: 'PORT FREE TIME', e: j.portFreeEnd }].filter(Boolean).sort((a, b) => a.e - b.e);
      const txt = (d) => (d < 0 ? 'over ' + (-d) + (d === -1 ? ' day' : ' days') : d === 0 ? 'ends today' : d + (d === 1 ? ' day left' : ' days left'));
      html = list.slice().sort((a, b) => tm((ends(a)[0] || {}).e) - tm((ends(b)[0] || {}).e)).map((j) => {
        const E = ends(j), first = E[0] || { k: 'FREE TIME', e: null }, other = E[1], d = first.e ? days(t0, first.e) : 0;
        return row(j, '<span class="dr-note">Arrived ' + esc(fmt(j.eta)) + ' · ' + esc(rel91(j.eta, t0)) + (other ? ' · ' + (other.k === 'PORT FREE TIME' ? 'port' : 'line') + ' free time ' + esc(txt(days(t0, other.e))) : '') + '</span>',
          '<span class="dr-side is-' + (d <= 1 ? 'red' : 'amber') + '"><span class="dr-k">' + first.k + '</span><b>' + txt(d) + '</b><span class="dr-s">until ' + esc(fmt(first.e)) + '</span></span>');
      }).join('');
    } else if (kind === 'hold') {
      html = list.slice().sort((a, b) => tm(a.etd) - tm(b.etd)).map((j) => row(j, j.remarks ? '<span class="dr-note">“' + esc(j.remarks) + '”</span>' : '', when(j))).join('');
    } else if (kind === 'watch') {
      html = watchPanel910(m, t0, row, main);   // v2.9.10: one row per job, its tasks together; v2.9.9: tap a task → its choice card
    } else if (kind === 'week') {
      const pick = wkPick92();
      const ev = wkEvents93(m, wkStart93()).filter((e) => !pick || +dayOf(e.d) === +pick);   // v2.9.3: the week shown on Home
      html = ev.map((e) => row(e.j, '', side(wkTag93(e, t0), e.d, rel91(e.d, t0), e.k === 'arr' ? 'teal' : ''))).join('');
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
    else if (j.type === 'CND') where = 'Vessel arriving';   // v2.9.6: a CND has no ETD — its vessel is on the way in
    else if (j.etd) where = (air ? 'Departs ' : cr ? 'Pick-up ' : 'Sails ') + d(j.etd);
    else where = (cr ? 'Pick-up' : 'ETD') + ' to confirm';
    const k = air ? 'AWB' : cr ? 'Tracking' : 'BL', v = j.bl;
    const bl = j.mode === 'misc' || v === NA ? '' : !v || v === 'BL PENDING' ? k + ' pending' : v === 'CONFIRMATION PENDING' ? k + ' to confirm'
      : /^CONFIRMED/.test(v) ? (air || cr ? k + ' confirmed' : v.slice(10) + ' confirmed') : /ISSUED$/.test(v) ? (air || cr ? k + ' issued' : v.slice(0, 3) + ' issued') : nice(v);
    const cs = costState(j), cost = cs === 'none' ? '' : 'Costing ' + (cs === 'draft' ? 'draft' : cs === 'done' ? 'done' : 'pending');
    const dgpc = j.cat === 'EXPORT' && j.dg === 'DG' && j.mode === 'sea' && j.dgpc !== NA ? (['SUBMITTED', 'APPROVED'].includes(j.dgpc) ? '' : 'DGPC pending') : '';
    const sw = swOn93(j) ? 'Switch BL ' + (j.switchBl === 'CONFIRMATION PENDING' ? 'to confirm' : j.switchBl.toLowerCase()) : '';   // v2.9.3
    // v2.9.6: once sailed (or a CND on its way in) and not arrived yet, the ETA follows where it is
    const onWay = j.mode !== 'misc' && !(j.eta && j.eta <= t0) && ((j.etd && j.etd <= t0) || j.type === 'CND');
    const eta = onWay ? (cr ? 'Delivery ' : 'ETA ') + (j.eta ? d(j.eta) : 'to confirm') : '';
    return { hold: j.hold, where, eta, rest: [bl, sw, dgpc, cost].filter(Boolean) };
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
      const status = (st.hold ? run('On hold', { b: true, c: RED }) + run(' · ', { c: MUTE }) : '') + run(st.where, { b: true, c: NAVY }) + (st.eta ? run(' · ', { c: MUTE }) + run(st.eta, { b: true, c: NAVY }) : '') + st.rest.map((x) => run(' · ', { c: MUTE }) + run(x, { c: INK2 })).join('');
      const route = j.mode === 'misc' ? 'Costing only' : !j.pol && !j.pod ? '—' : (j.pol ? portName91(j.pol) : '—') + ' → ' + (j.pod ? portName91(j.pod) : '—');
      return '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
        cell(COLS[0], para(run(String(n), { c: MUTE }), { jc: 'center' })) + cell(COLS[1], para(run(j.jobNo, { b: true })) + para(run(j.type || '—', { b: true, c: MUTE, sz: 14, sp: 10 }), { before: 20 })) +
        cell(COLS[2], para(run(j.customer || '—'))) + cell(COLS[3], para(run(j.cargo || (j.mode === 'air' ? 'Air' : j.mode === 'courier' ? 'Courier' : '—'), { c: INK2 }))) +
        cell(COLS[4], para(run(route, { c: INK2 })) + (String(j.vendor || '').trim() ? para(run(String(j.vendor).trim().toUpperCase(), { b: true, c: MUTE, sz: 14, sp: 6 }), { before: 20 }) : '')) + cell(COLS[5], para(status)) + '</w:tr>';
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

  // ================================================================ v2.9.3 — from Amal's use of v2.9.2
  // ---------- switch BL (sea jobs): one column SWITCH BL — NO, or where the switch BL stands. The main BL is then an OBL.
  const SW_TYPES93 = ['SFEF', 'SFEL', 'SFIF', 'SFIL', 'SFC'];
  const SBL93 = ['CONFIRMED SBL', 'SBL ISSUED', 'SBL SHARED TO CUSTOMER'];
  const swOn93 = (j) => !!j && SW_TYPES93.includes(j.type) && !!j.switchBl && j.switchBl !== 'NO';
  const toObl93 = (v) => (v === 'CONFIRMED SBL' ? 'CONFIRMED OBL' : v === 'SBL ISSUED' ? 'OBL ISSUED' : v === 'SBL SHARED TO CUSTOMER' ? 'OBL SHARED TO CUSTOMER' : v);
  function swBl93(j, all) {
    if (!swOn93(j)) return;
    all.forEach((st) => { if (st.field === 'bl' && st.def) st.def = Object.assign({}, st.def, { choices: (st.def.choices || OPTS.bl).filter((v) => !SBL93.includes(v)), primary: toObl93(st.def.primary) }); });
  }
  const optsFor93 = (j, f) => (f === 'bl' ? blChoices98(j, swOn93(j) ? OPTS.bl.filter((v) => !SBL93.includes(v)) : OPTS.bl) : OPTS[f]);   // v2.9.8: shared after the final BL
  // turning switch BL on while the main BL is an SBL: the main BL moves to the OBL in the same save
  function swFix93(j, field, val) { return field === 'switchBl' && val && val !== 'NO' && SBL93.includes(j.bl) ? { bl: toObl93(j.bl) } : {}; }
  // Edit details: the BL list follows switch BL
  function swForm93(form) {
    if (!form) return;
    const sw = form.querySelector('[name="switchBl"]'), bl = form.querySelector('[name="bl"]'); if (!sw || !bl) return;
    if (!bl.dataset.all) bl.dataset.all = JSON.stringify([...bl.options].map((o) => [o.value, o.textContent]));
    const on = !!sw.value && sw.value !== 'NO', cur = bl.value;
    bl.innerHTML = JSON.parse(bl.dataset.all).filter(([v]) => !on || !SBL93.includes(v)).map(([v, t]) => '<option value="' + esc(v) + '">' + esc(t) + '</option>').join('');
    bl.value = on ? toObl93(cur) : cur;
    const f = bl.closest('.field'); let h = f && f.querySelector('.sw-hint');
    if (on && f && !h) { h = document.createElement('p'); h.className = 'sw-hint'; h.textContent = 'Switch BL: the main BL is an OBL.'; f.appendChild(h); }
    if (!on && h) h.remove();
  }

  // ---------- tap a job number to copy it (job page, Jobs, Follow-ups, the costing page)
  const copyNo93 = (no) => '<span class="copy-no" data-copy="' + esc(no) + '" role="button" tabindex="0" title="Copy ' + esc(no) + '">' + esc(no) + '</span>';
  async function copyText93(no, el) {
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(no); ok = true; } } catch (e) { ok = false; }
    if (!ok) {
      const ta = document.createElement('textarea'); ta.value = no; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch (e) { ok = false; } ta.remove();
    }
    if (el) { el.classList.remove('is-copied'); void el.offsetWidth; el.classList.add('is-copied'); setTimeout(() => el.classList.remove('is-copied'), 1400); }
    toast(ok ? 'Copied ' + no : 'Could not copy — select the number instead', ok ? {} : { error: true });
  }

  // ---------- remarks on the job page (under the customer name; edit them there)
  function remarksLine93(j) {
    const can = canEditJob(j) && !j.closed;
    if (!j.remarks) return can ? '<button type="button" class="vh-rm-add" data-act="remarks93">' + icon('plus', 14) + 'Add remarks</button>' : '';
    return '<div class="vh-remarks"><span class="vh-rm-k">REMARKS</span><p class="vh-rm-text" id="vhRemarks">' + esc(j.remarks) + '</p>' +
      '<span class="vh-rm-act"><button type="button" class="link-btn vh-rm-more" data-act="remarks-more" hidden>More</button>' + (can ? '<button type="button" class="icon-btn vh-rm-edit" data-act="remarks93" aria-label="Edit remarks" title="Edit remarks">' + icon('edit', 15) + '</button>' : '') + '</span></div>';
  }
  function remarksFit93() {   // "More" only when the remarks run past two lines
    const p = $('#vhRemarks'), b = $('.vh-rm-more'); if (!p || !b) return;
    b.hidden = p.classList.contains('is-open') ? false : p.scrollHeight <= p.clientHeight + 2;
    b.textContent = p.classList.contains('is-open') ? 'Less' : 'More';
  }
  const remarksPop93 = (no) => () => {
    const j = findJob(no); if (!j) return '';
    return '<div class="pop-title">Remarks</div><form class="pop-form" data-remarks-form="' + esc(j.jobNo) + '"><label class="pop-label" for="rmText93">' + esc(j.jobNo) + ' · ' + esc(j.customer || '') + '</label>' +
      '<textarea id="rmText93" rows="4" maxlength="500" placeholder="Type the remarks">' + esc(j.remarks || '') + '</textarea>' +
      '<button type="submit" class="btn-brutal pop-main" data-primary>SAVE REMARKS</button>' + (j.remarks ? '<button type="button" class="link-btn quiet pop-clear" data-remarks-clear="' + esc(j.jobNo) + '">Clear remarks</button>' : '') + '</form>' + SAVE_NOTE;
  };
  function saveRemarks93(no, text) {
    const j = findJob(no); if (!j) return;
    const v = String(text || '').trim();
    closeOverlays();
    if (v === String(j.raw.remarks || '').trim()) return;
    saveJob(j.jobNo, { remarks: v }, { toast: v ? 'Remarks saved' : 'Remarks cleared' });
  }

  // ---------- follow-up plans: daily · every 2 days · weekly · every Monday … · next check on a date (then back) · paused
  const DOW3_93 = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const DOWFULL93 = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function planParse93(p) {
    p = String(p || '').toUpperCase().trim();
    if (EVERY_N[p] !== undefined) return p === 'PAUSED' ? { kind: 'paused' } : { kind: 'n', n: EVERY_N[p], base: p };
    let m = p.match(/^EVERY (SUN|MON|TUE|WED|THU|FRI|SAT)$/);
    if (m) return { kind: 'dow', dow: DOW3_93.indexOf(m[1]), base: p };
    m = p.match(/^ON (\d{4}-\d{2}-\d{2}) THEN (.+)$/);
    if (m && parseDate(m[1])) { const then = planParse93(m[2]); if (then && (then.kind === 'n' || then.kind === 'dow')) return { kind: 'on', date: parseDate(m[1]), iso: m[1], then, base: then.base }; }
    return null;
  }
  const planOk93 = (p) => !!planParse93(p);
  function everyLabel93(p, t0) {
    const P = planParse93(p); if (!P) return 'Daily';
    if (P.kind === 'paused') return 'Paused';
    if (P.kind === 'dow') return 'Every ' + DOWFULL93[P.dow];
    if (P.kind === 'on') return (t0 && P.date <= t0 ? '' : 'Next ') + 'check ' + dm93(P.date);
    return EVERY_LABEL[P.base];
  }
  function followState93(j, t0, every, checks, last) {
    const P = planParse93(every) || { kind: 'n', n: 1, base: 'DAILY' };
    const lastDay = last ? dayOf(last[0]) : null, since = last ? days(lastDay, t0) : null, today = since === 0;
    const mineToday = checks.find((c) => days(dayOf(c[0]), t0) === 0 && c[1] === state.user) || null;
    const out = (due, nextIn, label) => ({ every, checks, last, since, today, mineToday, due, nextIn, label: label || everyLabel93(every, t0) });
    if (P.kind === 'paused') return out(false, null);
    let Q = P;
    if (P.kind === 'on') {
      if (t0 < P.date) return out(false, days(t0, P.date), 'Next check ' + dm93(P.date));
      if (!lastDay || lastDay < P.date) return out(!today, 0, 'Check ' + dm93(P.date));   // the day has come: due until checked
      Q = P.then;                                                                          // checked on or after the day: back to the usual plan
    }
    if (Q.kind === 'dow') {
      const back = (t0.getDay() - Q.dow + 7) % 7, target = addDays(t0, -back);
      const due = !today && (!lastDay || lastDay < target);
      return out(due, due ? 0 : (Q.dow - t0.getDay() + 7) % 7 || 7, 'Every ' + DOWFULL93[Q.dow]);
    }
    const n = Q.n;
    return out(!today && (since === null || since >= n), today ? n : since === null ? 0 : Math.max(0, n - since), EVERY_LABEL[Q.base]);
  }
  const everyMenu93 = (no) => () => {
    const j = findJob(no); if (!j) return '';
    const cur = planFor(j), P = planParse93(cur) || { kind: 'n', base: 'DAILY' }, base = P.kind === 'on' ? P.then.base : P.kind === 'paused' ? 'DAILY' : P.base;
    const t0 = today0(), btn = (val, label) => '<button type="button" class="choice' + (val === cur ? ' is-on' : '') + '" data-set-every="' + esc(val) + '" data-no="' + esc(j.jobNo) + '" aria-pressed="' + (val === cur) + '">' + label + '</button>';
    const onIso = P.kind === 'on' ? P.iso : '';
    return '<div class="pop-title">How often?</div><p class="pop-text">' + esc(j.jobNo) + ' · ' + esc(j.customer || '') + '</p>' +
      '<div class="choice-row">' + btn('DAILY', 'Daily') + btn('2 DAYS', 'Every 2 days') + btn('WEEKLY', 'Weekly') + '</div>' +
      '<div class="pop-label">Every week on</div><div class="choice-row ev-days">' + [1, 2, 3, 4, 5, 6, 0].map((d) => btn('EVERY ' + DOW3_93[d], DOW[d])).join('') + '</div>' +
      '<form class="pop-form ev-on" data-plan-date="' + esc(j.jobNo) + '" data-base="' + esc(base) + '"><label class="pop-label" for="evOn93">Next check on</label>' +
        '<div class="date-row"><input type="date" id="evOn93" min="' + isoOf(addDays(t0, 1)) + '" value="' + esc(onIso) + '">' + [7, 10, 14].map((n) => '<button type="button" class="choice" data-plan-in="' + n + '">+' + n + ' days</button>').join('') + '</div>' +
        '<button type="submit" class="btn-ghost pop-wide">Set the date</button>' +
        '<div class="pop-hint">Out of Due now until that day; after that check it goes back to ' + esc((planParse93(base) && planParse93(base).kind === 'dow' ? 'every ' + DOWFULL93[planParse93(base).dow] : EVERY_LABEL[base] || 'Daily').toLowerCase()) + '.</div></form>' +
      '<div class="choice-row">' + btn('PAUSED', 'Paused') + '</div><div class="pop-hint">Paused jobs leave Follow-ups until you change it back.</div>';
  };
  function setPlanDate93(no, iso, base) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) { toast('Choose a day', { error: true }); return; }
    const d = parseDate(iso); if (!d || d <= today0()) { toast('Choose a day after today', { error: true }); return; }
    followPlan(no, 'ON ' + iso + ' THEN ' + (base || 'DAILY'));
  }

  // ---------- reminders: a weekly one says its day
  function remRep93(r, long) {
    const d = parseDate(r.due);
    if (r.repeat === 'WEEKLY' && d) return long ? 'Every ' + DOWFULL93[d.getDay()] : 'Weekly · ' + DOW[d.getDay()];
    if (r.repeat === 'MONTHLY' && d) return long ? 'Every month on the ' + d.getDate() + (['th', 'st', 'nd', 'rd'][(d.getDate() % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][d.getDate() % 100] || 'th') : 'Monthly';
    if (r.repeat === 'DAILY') return long ? 'Every day' : 'Daily';
    return REPEAT_NAME[r.repeat] || '';
  }

  // ---------- Home on laptop screens: one screen only when it is tall enough; otherwise it flows like the phone
  const homeFit93 = () => window.innerWidth >= 1024 && window.innerHeight >= 900;
  function homeMode93() {
    const view = $('#view'); if (!view || !state.route || state.route.name !== 'home') return;
    const fit = homeFit93();
    if (view.classList.contains('is-fit') !== fit) { view.classList.toggle('is-fit', fit); view.classList.toggle('is-flow', !fit); fitPorts91(); }
    moreBars93();
  }
  // a tall screen keeps one screen: a tile with rows out of sight says how many, and opens them
  function moreBars93() {
    $$('#view .home .tile').forEach((t) => {
      const body = t.querySelector('.tile-body'); let bar = t.querySelector('.more-bar');
      const fit = $('#view').classList.contains('is-fit');
      if (!body || !fit) { if (bar) bar.remove(); return; }
      const B = body.getBoundingClientRect();
      const rows = Array.from(body.querySelectorAll('[data-job], [data-q99], .rm, .is-multi910')).filter((r) => r.offsetParent !== null && (r.classList.contains('is-multi910') || !r.closest('.is-multi910')));   // v2.9.9: + tasks with a choice card · v2.9.10: a job with several tasks is one row
      const n = rows.filter((r) => r.getBoundingClientRect().bottom > B.bottom + 2).length;   // not fully in sight
      if (!n) { if (bar) bar.remove(); return; }
      const list = t.classList.contains('t-watch') ? 'watch' : t.classList.contains('t-week') ? 'week' : '';
      if (!bar) { bar = document.createElement('button'); bar.type = 'button'; bar.className = 'more-bar'; body.after(bar); }
      if (list) bar.dataset.list = list; else bar.dataset.moreScroll = '1';
      bar.innerHTML = '<span>' + n + ' more</span>' + icon('chevron', 14);
    });
  }

  // ---------- delivery note (sea / air imports, clearance): a one-page Word file, the rest filled in by hand
  const DN_TYPES93 = ['SFIF', 'SFIL', 'AFI', 'CND'];
  async function deliveryNote93(j) {
    if (!j) return;
    const X = XL.X, t0 = today0(), air = j.mode === 'air';
    const logo = await costLogo(), sz = logo ? XL.pngSize(logo) : null;
    const day = (d) => (d ? d.getDate() + ' ' + MON91[d.getMonth()] + ' ' + d.getFullYear() : '');
    const NAVY = '1C5179', INK = '0B1B2B', INK2 = '3E4C5E', MUTE = '6B7A8A', HAIR = 'C5CFD9', FOG = 'F1F4F8', TEAL = '0E7C7B';
    const W = 10206;
    const rPr = (o) => '<w:rPr>' + (o.b ? '<w:b/><w:bCs/>' : '') + (o.i ? '<w:i/><w:iCs/>' : '') + (o.caps ? '<w:caps/>' : '') + '<w:color w:val="' + (o.c || INK) + '"/>' + (o.sp ? '<w:spacing w:val="' + o.sp + '"/>' : '') + '<w:sz w:val="' + (o.sz || 19) + '"/><w:szCs w:val="' + (o.sz || 19) + '"/></w:rPr>';
    const run = (t, o) => '<w:r>' + rPr(o || {}) + '<w:t xml:space="preserve">' + X(t) + '</w:t></w:r>';
    const para = (runs, o) => { o = o || {}; return '<w:p><w:pPr>' + (o.keep ? '<w:keepNext/>' : '') + (o.rule ? '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="' + HAIR + '"/></w:pBdr>' : '') + '<w:spacing w:before="' + (o.before || 0) + '" w:after="' + (o.after || 0) + '" w:line="' + (o.line || 252) + '" w:lineRule="auto"/>' + (o.jc ? '<w:jc w:val="' + o.jc + '"/>' : '') + '</w:pPr>' + (runs || '') + '</w:p>'; };
    const bd = (c, w) => '<w:top w:val="single" w:sz="' + (w || 4) + '" w:space="0" w:color="' + c + '"/><w:left w:val="single" w:sz="' + (w || 4) + '" w:space="0" w:color="' + c + '"/><w:bottom w:val="single" w:sz="' + (w || 4) + '" w:space="0" w:color="' + c + '"/><w:right w:val="single" w:sz="' + (w || 4) + '" w:space="0" w:color="' + c + '"/>';
    const tbl = (cols, rows, o) => { o = o || {}; return '<w:tbl><w:tblPr><w:tblW w:w="' + cols.reduce((a, b) => a + b, 0) + '" w:type="dxa"/>' +
      (o.lines ? '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="' + HAIR + '"/><w:right w:val="nil"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="' + HAIR + '"/><w:insideV w:val="nil"/></w:tblBorders>'
        : o.none ? '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>'
        : '<w:tblBorders>' + bd(HAIR) + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="' + HAIR + '"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="' + HAIR + '"/></w:tblBorders>') +
      '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="' + (o.none ? 0 : 60) + '" w:type="dxa"/><w:left w:w="' + (o.none ? 0 : 110) + '" w:type="dxa"/><w:bottom w:w="' + (o.none ? 0 : 60) + '" w:type="dxa"/><w:right w:w="' + (o.none ? 0 : 110) + '" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
      '<w:tblGrid>' + cols.map((c) => '<w:gridCol w:w="' + c + '"/>').join('') + '</w:tblGrid>' + rows.join('') + '</w:tbl>'; };
    const tc = (w, content, o) => { o = o || {}; return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + (o.span ? '<w:gridSpan w:val="' + o.span + '"/>' : '') + (o.under ? '<w:tcBorders><w:bottom w:val="single" w:sz="8" w:space="0" w:color="' + NAVY + '"/></w:tcBorders>' : '') + (o.fill ? '<w:shd w:val="clear" w:color="auto" w:fill="' + o.fill + '"/>' : '') + '<w:vAlign w:val="' + (o.v || 'center') + '"/></w:tcPr>' + (content || para('')) + '</w:tc>'; };
    const tr = (cells, h) => '<w:tr><w:trPr><w:cantSplit/>' + (h ? '<w:trHeight w:val="' + h + '" w:hRule="atLeast"/>' : '') + '</w:trPr>' + cells.join('') + '</w:tr>';
    const K = (t, o) => para(run(t, Object.assign({ b: true, c: INK2, sz: 14, sp: 12 }, o || {})));
    const V = (t, o) => para(t ? run(t, Object.assign({ b: true, sz: 19 }, o || {})) : '');
    const box = j.c20 || j.c40 ? [j.c20 ? j.c20 + ' × 20′' : '', j.c40 ? j.c40 + ' × 40′' : ''].filter(Boolean).join(' · ') : j.type === 'SFIL' ? 'LCL' : '';
    const route = (j.pol ? portName91(j.pol) : '—') + ' → ' + (j.pod ? portName91(j.pod) : '—');
    // 1 · the job (filled in from the workspace) and what you fill in by hand
    const C4 = [1750, 3353, 1750, 3353];
    const info = tbl(C4, [
      tr([tc(C4[0], K('DEL-ADV NO.'), { fill: FOG }), tc(C4[1], V(j.jobNo)), tc(C4[2], K('DATE'), { fill: FOG }), tc(C4[3], V(day(t0)))], 400),
      tr([tc(C4[0], K('JOB NO.'), { fill: FOG }), tc(C4[1], V(j.jobNo)), tc(C4[2], K('ETA'), { fill: FOG }), tc(C4[3], V(day(j.eta)))], 400),
      tr([tc(C4[0], K(air ? 'AWB NO.' : 'B/L NO.'), { fill: FOG }), tc(C4[1], V('')), tc(C4[2], K('B/E DEC NO.'), { fill: FOG }), tc(C4[3], V(''))], 400),
      tr([tc(C4[0], K(air ? 'AIRLINE' : 'LINE'), { fill: FOG }), tc(C4[1], V(j.vendor || '')), tc(C4[2], K('LOT NO.'), { fill: FOG }), tc(C4[3], V(''))], 400),
      tr([tc(C4[0], K('POL → POD'), { fill: FOG }), tc(C4[1], V(route)), tc(C4[2], K(air ? 'PACKAGES' : 'CONTAINERS'), { fill: FOG }), tc(C4[3], V(box))], 400),
      tr([tc(C4[0], K('CONSIGNEE'), { fill: FOG }), tc(C4[1] + C4[2] + C4[3], V(j.customer || ''), { span: 3 })], 400),
      tr([tc(C4[0], K('ADDRESS'), { fill: FOG, v: 'top' }), tc(C4[1] + C4[2] + C4[3], V(''), { span: 3 })], 760)
    ]);
    // 2 · the cargo, by hand
    const C6 = [700, 4306, 1100, 1100, 1500, 1500];
    const ch = (t, jc) => para(run(t, { b: true, c: INK2, sz: 14, sp: 10 }), { jc: jc || 'left' });
    const cargo = tbl(C6, [
      tr(['NO.', 'DESCRIPTION & MARKS', 'QTY', 'UNIT', 'WEIGHT (KGS)', 'VOLUME (CBM)'].map((h, i) => tc(C6[i], ch(h, i === 0 || i > 1 ? 'center' : 'left'), { fill: FOG, under: true })), 380)
    ].concat([1, 2, 3, 4, 5].map((n) => tr(C6.map((w, i) => tc(w, i === 0 ? para(run(String(n), { c: MUTE, sz: 17 }), { jc: 'center' }) : para(''))), 430)),
      [tr([tc(C6[0] + C6[1], para(run('TOTAL', { b: true, sz: 17, sp: 12 }), { jc: 'right' }), { span: 2, fill: FOG }), tc(C6[2], para(''), { fill: FOG }), tc(C6[3], para(''), { fill: FOG }), tc(C6[4], para(''), { fill: FOG }), tc(C6[5], para(''), { fill: FOG })], 430)]));
    // 3 · delivery details (containers one by one) and who received it
    const n20 = Math.min(j.c20 || 0, 20), n40 = Math.min(j.c40 || 0, 20);
    const boxes = [].concat(Array.from({ length: n20 }, () => '20′'), Array.from({ length: n40 }, () => '40′')).slice(0, 12);
    const crows = boxes.length ? boxes : [air ? '' : j.type === 'SFIL' ? 'LCL' : '', '', ''];
    const L2 = [1900, 3003], R2 = [1800, 3103];
    const left = tbl(L2, [
      tr([tc(L2[0] + L2[1], para(run('DELIVERY DETAILS', { b: true, c: NAVY, sz: 16, sp: 20 })), { span: 2, fill: FOG, under: true })], 380),
      tr([tc(L2[0], K('DELIVERY AT')), tc(L2[1], V(j.pod ? portName91(j.pod) : ''))], 400)
    ].concat(crows.map((b, i) => tr([tc(L2[0], K(air ? 'PACKAGES' : 'CONTAINER ' + (i + 1)) + (b && !air ? para(run(b, { c: MUTE, sz: 14 })) : '')), tc(L2[1], para(''))], 420))));
    const right = tbl(R2, [
      tr([tc(R2[0] + R2[1], para(run('RECEIVED BY', { b: true, c: NAVY, sz: 16, sp: 20 })), { span: 2, fill: FOG, under: true })], 380),
      tr([tc(R2[0], K('VEHICLE NO.')), tc(R2[1], para(''))], 420),
      tr([tc(R2[0], K('DRIVER NAME')), tc(R2[1], para(''))], 420),
      tr([tc(R2[0], K('TEL. NO.')), tc(R2[1], para(''))], 420),
      tr([tc(R2[0], K('DATE & TIME')), tc(R2[1], para(''))], 420),
      tr([tc(R2[0], K('SIGN & STAMP'), { v: 'top' }), tc(R2[1], para(''))], 1300)
    ]);
    const pair = tbl([4903, 400, 4903], [tr([tc(4903, left + para(''), { v: 'top' }), tc(400, para('')), tc(4903, right + para(''), { v: 'top' })])], { none: true });
    const body = info + para('', { after: 160 }) +
      para(run('CARGO', { b: true, c: NAVY, sz: 16, sp: 20 }), { after: 80, keep: true }) + cargo +
      para(run('We hereby acknowledge that we have received the above said cargo in good condition.', { i: true, c: INK2, sz: 18 }), { before: 160, after: 200 }) +
      pair +
      para(run('NOTE', { b: true, c: NAVY, sz: 16, sp: 20 }), { before: 220, after: 0, keep: true }) + tbl([W], [tr([tc(W, para(''))], 440), tr([tc(W, para(''))], 440), tr([tc(W, para(''))], 440)], { lines: true });   // three lines to write on
    const sect = '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1500" w:right="850" w:bottom="1000" w:left="850" w:header="420" w:footer="420" w:gutter="0"/><w:cols w:space="720"/></w:sectPr>';
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const DNS = NS + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
    const XMLH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const doc = XMLH + '<w:document ' + NS + '><w:body>' + body + para('') + sect + '</w:body></w:document>';
    const E = 360000, lh = Math.round(1.05 * E), lw = sz ? Math.round(lh * sz[0] / sz[1]) : 0;
    const pic = sz ? '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + lw + '" cy="' + lh + '"/><wp:docPr id="1" name="ETHIX logo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + lw + '" cy="' + lh + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>' : run('ETHIX SHIPPING', { b: true, c: NAVY, sz: 24 });
    const hc = (w, content) => '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/><w:vAlign w:val="bottom"/></w:tcPr>' + content + '</w:tc>';
    const header = XMLH + '<w:hdr ' + DNS + '><w:tbl><w:tblPr><w:tblW w:w="' + W + '" w:type="dxa"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="12" w:space="0" w:color="' + NAVY + '"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="110" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="' + (W / 2) + '"/><w:gridCol w:w="' + (W / 2) + '"/></w:tblGrid><w:tr>' +
      hc(W / 2, para(pic)) + hc(W / 2, para(run('DELIVERY NOTE', { b: true, c: INK, sz: 32, sp: 30 }), { jc: 'right' }) + para(run('DEL-ADV NO. ' + j.jobNo, { b: true, c: TEAL, sz: 16, sp: 12 }), { jc: 'right' })) +
      '</w:tr></w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p></w:hdr>';
    const footer = XMLH + '<w:ftr ' + NS + '><w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="' + HAIR + '"/></w:pBdr><w:tabs><w:tab w:val="right" w:pos="' + W + '"/></w:tabs><w:spacing w:before="0" w:after="0"/></w:pPr>' +
      run('ETHIX Shipping · Delivery note · ' + j.jobNo, { c: MUTE, sz: 15 }) + '<w:r>' + rPr({ c: MUTE, sz: 15 }) + '<w:tab/></w:r>' + run('Issued ' + day(t0) + ' · ' + nice(state.user), { c: MUTE, sz: 15 }) + '</w:p></w:ftr>';
    const styles = XMLH + '<w:styles ' + NS + '><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:color w:val="' + INK + '"/><w:sz w:val="19"/><w:szCs w:val="19"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
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
      { name: 'docProps/core.xml', data: XMLH + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>ETHIX delivery note ' + X(j.jobNo) + '</dc:title><dc:creator>' + X(state.user) + '</dc:creator><cp:lastModifiedBy>' + X(state.user) + '</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>' },
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
      const name = 'ETHIX_Delivery_note_' + String(j.jobNo).replace(/[^A-Za-z0-9-]+/g, '-') + '.docx';
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      toast('Delivery note ready · ' + name);
    } catch (e) { toast('The delivery note could not be made: ' + e.message, { error: true }); }
  }

  function initV293() {
    // tap a job number: copied (before any row opens the job)
    document.addEventListener('click', (e) => {
      const c = e.target.closest('[data-copy]'); if (!c || !state.signedIn) return;
      e.preventDefault(); e.stopPropagation(); copyText93(c.dataset.copy, c);
    }, true);
    document.addEventListener('keydown', (e) => {
      const c = e.target.closest && e.target.closest('[data-copy]'); if (!c || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault(); e.stopPropagation(); copyText93(c.dataset.copy, c);
    }, true);
    document.addEventListener('click', (e) => {
      if (!state.signedIn) return;
      const pg = e.target.closest('[data-po-page]'); if (pg) { state.poHold93 = Date.now() + 15000; showPorts93(+pg.dataset.poPage, true); return; }
      const mb = e.target.closest('.more-bar[data-more-scroll]'); if (mb) { const b = mb.previousElementSibling; if (b) b.scrollBy({ top: b.clientHeight * 0.8, behavior: 'smooth' }); return; }
      if (e.target.closest('[data-act="dnote"]')) { const j = state.route && findJob(state.route.jobNo); if (j) deliveryNote93(j); return; }
      if (e.target.closest('[data-act="remarks93"]')) { const j = state.route && findJob(state.route.jobNo); if (j) openPop(e.target.closest('[data-act="remarks93"]'), 'REMARKS', remarksPop93(j.jobNo)); return; }
      if (e.target.closest('[data-act="remarks-more"]')) { const p = $('#vhRemarks'); if (p) { p.classList.toggle('is-open'); remarksFit93(); } return; }
      const rc = e.target.closest('[data-remarks-clear]'); if (rc) { saveRemarks93(rc.dataset.remarksClear, ''); return; }
      const pin = e.target.closest('[data-plan-in]'); if (pin) { const f = pin.closest('[data-plan-date]'), inp = f && f.querySelector('#evOn93'); if (inp) { inp.value = isoOf(addDays(today0(), +pin.dataset.planIn)); $$('[data-plan-in]', f).forEach((b) => b.classList.toggle('is-on', b === pin)); } return; }
    });
    document.addEventListener('submit', (e) => {
      const rf = e.target.closest('[data-remarks-form]');
      if (rf) { e.preventDefault(); saveRemarks93(rf.dataset.remarksForm, ($('#rmText93') || {}).value); return; }
      const pf = e.target.closest('[data-plan-date]');
      if (pf) { e.preventDefault(); setPlanDate93(pf.dataset.planDate, ($('#evOn93') || {}).value, pf.dataset.base); }
    });
    document.addEventListener('change', (e) => { if (e.target.name === 'switchBl' && e.target.form && e.target.form.id === 'editForm') swForm93(e.target.form); });
    // the office pages turn by themselves (not while pointed at, focused or just touched; never with reduced motion)
    const calm = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    setInterval(() => {
      if (calm.matches || document.hidden || !state.route || state.route.name !== 'home' || (state.poPages93 || 1) < 2 || (state.poHold93 || 0) > Date.now()) return;
      if (document.querySelector('#portOffices:hover, #portOffices:focus-within')) return;
      showPorts93(((state.poPage93 || 0) + 1) % state.poPages93, true);
    }, 6000);
    document.addEventListener('touchstart', (e) => { if (e.target.closest && e.target.closest('#portOffices')) state.poHold93 = Date.now() + 15000; }, { passive: true });
    // Home: one screen on tall screens, flowing on short ones; the "N more" bars follow the rows in sight
    window.addEventListener('resize', () => { homeMode93(); remarksFit93(); });
    document.addEventListener('scroll', (e) => { if (e.target.classList && e.target.classList.contains('tile-body')) moreBars93(); }, true);
  }

  function initV291() {
    // the port offices move with the clock
    setInterval(() => { const po = $('#portOffices'); if (po && state.route && state.route.name === 'home') { po.outerHTML = portOffices(''); fitPorts91(); } }, 60000);
    window.addEventListener('resize', () => { if (state.route && state.route.name === 'home') fitPorts91(); });
    document.addEventListener('click', (e) => {
      if (!state.signedIn) return;
      const op = e.target.closest('[data-fl-open]'); if (op) { closeOverlays(true); openJob(op.dataset.flOpen); return; }
      const pc = e.target.closest('[data-port91]'); if (pc) { openPop(pc, 'OVERSEAS OFFICE', portJobsPop91(pc.dataset.port91)); return; }
      const pa = e.target.closest('[data-act="offices-all"]'); if (pa) { openOffices93(pa); return; }
      if (e.target.closest('[data-act="changed"]')) { openPop(e.target.closest('[data-act="changed"]'), 'MY DAY', changedMenu()); return; }
      if (e.target.closest('[data-act="seen-all"]')) {
        const keep = state.seen; state.seen = { _base: Date.now() }; closeOverlays(true); rerender();
        api.call('ethixSeenAll').then((r) => { if (r && r.seen) state.seen = r.seen; }).catch(() => { state.seen = keep; rerender(); });
        toast('All marked as seen'); return;
      }
      if (e.target.closest('[data-act="rem-late"]')) { go('#/follow-ups'); return; }
      if (e.target.closest('[data-act="jobs-word"]')) { jobsWord91(); return; }
      const wo = e.target.closest('[data-wk-off]'); if (wo) { state.wkOff93 = +wo.dataset.wkOff || 0; state.wkDay92 = ''; rerender(); return; }
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
    initV293();
  }

  // ------------------------------------------------------------ lists & menus
  function openList(kind, opener) {
    const m = lastMetrics; if (!m) return;
    const entry = listEntry99(kind, m); if (!entry) return;   // v2.9.9: shared with the panel's way back from a choice card
    state.list99 = kind;
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
  // runSearch — v2.9.11 version further down (+ MENTIONED IN REMARKS AND NOTES)

  // ----------------------------------------------------------------- refresh
  async function refresh(manual) {
    if (state.refreshing) return;
    state.refreshing = true;
    const btn = $('#refreshBtn'), sync = $('#sync');
    if (btn) btn.classList.add('is-busy'); if (sync) sync.classList.add('is-busy');
    try {
      const boot = await api.call('ethixBootstrap');
      const before = notifUnread(), newest = state.notif && state.notif.items[0] ? state.notif.items[0].t : 0;
      applyBoot(boot);
      if (['form', 'pop', 'sheet', 'admin', 'delay', 'enqform', 'close'].includes(state.overlay)) state.dirty = true;
      else { rerender(); refreshOverlay(); }
      updateNav();
      const fresh = state.notif ? state.notif.items.filter((x) => x.t > newest && x.t > (state.notif.seen || 0)) : [];
      state.nudged = fresh.length && notifUnread() > before && state.overlay !== 'drawer' && !(state.route && state.route.name === 'notif');
      if (state.nudged) toast(fresh.length === 1 ? nice(fresh[0].from) + ' · ' + (fresh[0].job ? fresh[0].job + ': ' : '') + fresh[0].text : fresh.length + ' new notifications', { news: true, action: { label: 'View', fn: () => openNotifications() } });
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
    if (ending) return; ending = true;
    if (isView()) { msg = 'View access has ended. Ask for a new code.'; try { sessionStorage.setItem('ethix.vw920', '1'); } catch (e) { /* private mode */ } }   // v2.9.20
    api.token = null; dropSession();
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
    $('#confirmTitle').textContent = isView() ? 'Leave view access?' : 'Log out?'; $('#confirmText').textContent = isView() ? 'You’ll need a new code to come back in.' : 'You’ll need your password to come back in.'; $('#confirmYes').textContent = isView() ? 'Leave' : 'Log out';
    const wrap = $('#confirmWrap'); wrap.hidden = false; $('#confirmNo').focus();
    const close = () => { wrap.hidden = true; };
    $('#confirmNo').onclick = close;
    $('#confirmYes').onclick = () => { api.logout(); dropSession(); document.body.style.opacity = '0.6'; history.replaceState(null, '', location.pathname + location.search); setTimeout(() => window.location.reload(), 250); };
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
  }

  function toast(text, opts = {}) {
    if (typeof opts === 'boolean') opts = { error: opts };
    if (!opts.error) { note99(text, opts); return; }   // v2.9.9: the glass capsule (problems stay red, below)
    const t = document.createElement('div');
    t.className = 'toast' + (opts.error ? ' is-error' : '');
    if (opts.error && state.savingCount) state.saveFail98 = true;   // v2.9.8: no "Saved" after a refusal
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
      const vb920 = e.target.closest('[data-vw920]'); if (vb920 && state.overlay === 'account') { vwAct920(vb920.dataset.vw920); return; }   // v2.9.20
      if (['form', 'sheet', 'quick', 'admin', 'delay', 'enqform', 'close'].includes(state.overlay)) return;
      const jobBtn = e.target.closest('[data-job]'); if (jobBtn) { openJob(jobBtn.dataset.job); return; }
      if (e.target.closest('[data-act="logout"]')) { closeOverlays(true); confirmLogout(); }
    });
    $('#drawerClose').addEventListener('click', () => closeOverlays());
    $('#scrim').addEventListener('click', () => closeOverlays());
    $('#logoutBtn').addEventListener('click', confirmLogout);
    window.addEventListener('hashchange', () => { if (!state.signedIn) return; if (leaveGuard()) return; state.navDepth++; closeOverlays(true); render(false); });
  }

  // ================================================================ v2.9.8 — from Amal's list of 2 Nov 2026
  I.swap = '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>';
  I.mail = '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5 12 13l8.5-6.5"/>';

  // ---------- faster: the app's link travels with the first load (for the morning email); a new column learnt from costing done
  const APP_URL98 = location.origin + location.pathname;
  (function () {
    const call = api.call.bind(api);
    api.call = function (fn, args, opts) {
      let a = Array.isArray(args) ? args.slice() : [];
      if (fn === 'ethixSignIn' && a.length === 3) a.push(APP_URL98);
      if (fn === 'ethixBootstrap' && !a.length && !state.urlSent98) a = [APP_URL98];
      const p = call(fn, a, opts);
      if (fn === 'ethixBootstrap') p.then(() => { state.urlSent98 = true; }, () => {});
      if (fn === 'ethixCostingLock') p.then((res) => { if (res && Array.isArray(res.header) && res.header.length) { state.header = res.header; state.ix = mapHeaders(res.header); rebuildJobs(); } }, () => {});
      return p;
    };
  })();

  // ---------- the costing of the job you are looking at is fetched ahead, so it opens at once
  function costAhead98(no) {
    const K = String(no || '').toUpperCase(); if (!K || !api.token) return;
    const j = findJob(K); if (!j || !canCostSee(j)) return;
    if (state.cost && state.cost.no === K && (state.cost.data || state.cost.loading)) return;
    const P = state.costPre98;
    if (P && P.no === K && Date.now() - P.at < 60000) return;
    const p = api.call('ethixCosting', [j.jobNo]);
    state.costPre98 = { no: K, at: Date.now(), p };
    p.catch(() => { if (state.costPre98 && state.costPre98.p === p) state.costPre98 = null; });
  }
  function costFetch98(K, no) {
    const P = state.costPre98;
    if (P && P.no === K && Date.now() - P.at < 90000) { state.costPre98 = null; return P.p; }
    return api.call('ethixCosting', [no]);
  }
  function costAheadSoon98(no) { clearTimeout(state.costPreT98); state.costPreT98 = setTimeout(() => { if (state.route && state.route.name === 'job' && String(state.route.jobNo).toUpperCase() === String(no).toUpperCase()) costAhead98(no); }, 700); }

  // ---------- the saving pill: frosted glass — "Saving…", then a tick and "Saved" that fades
  function savePill98(was) {   // v2.9.9: the capsule says what was saved (with Undo), or "Saved"
    const pill = $('#savePill'); if (!pill) return;
    const n = state.savingCount;
    clearTimeout(state.pillT98);
    if (n > 0) {
      if (was === 0) { state.saveFail98 = false; state.pillMsg99 = null; }
      pill99('saving', n > 1 ? 'Saving ' + n + ' changes…' : 'Saving…');
      return;
    }
    const m = state.pillMsg99; state.pillMsg99 = null;
    if (state.saveFail98) { pillOut99(true); return; }
    if (pill.hidden && !m) return;
    pill99(m && m.news ? 'news' : 'done', m ? m.text : 'Saved', m && m.action);
    pillTimer99(m ? (m.action ? 6000 : 2400) : 1100);
  }

  // ---------- Home on a day from the morning email: #/day/yyyy-mm-dd
  function dayLink98(h) {
    const m = String(h || '').match(/^#\/day\/(\d{4}-\d{2}-\d{2})$/); if (!m) return false;
    const d = parseDate(m[1]);
    history.replaceState(null, '', '#/home');
    if (d) { state.wkOff93 = Math.round(days(monday93(today0()), monday93(d)) / 7); state.wkDay92 = m[1]; }
    return true;
  }

  // ---------- BL shared to customer: offered once the final BL is issued
  const SHARED98 = ['OBL SHARED TO CUSTOMER', 'SBL SHARED TO CUSTOMER'];
  function blChoices98(j, list) {
    const cur = (j && j.bl) || '', out = [];
    list.filter((v) => !SHARED98.includes(v)).forEach((v) => {
      out.push(v);
      if (v === 'OBL ISSUED' && (cur === 'OBL ISSUED' || cur === 'OBL SHARED TO CUSTOMER')) out.push('OBL SHARED TO CUSTOMER');
      if (v === 'SBL ISSUED' && (cur === 'SBL ISSUED' || cur === 'SBL SHARED TO CUSTOMER')) out.push('SBL SHARED TO CUSTOMER');
    });
    if (SHARED98.includes(cur) && !out.includes(cur)) out.push(cur);
    return out;
  }
  function blForm98(form, j) {   // Edit details: the shared choices only after the final BL
    const bl = form && form.querySelector('[name="bl"]'); if (!bl) return;
    const ok = blChoices98(j, OPTS.bl);
    [...bl.options].forEach((o) => { if (SHARED98.includes(o.value) && !ok.includes(o.value)) o.remove(); });
  }

  // ---------- BL / AWB / tracking numbers: several per job, tap one to copy it
  const blWord98 = (j) => (j.mode === 'air' ? 'AWB' : j.type === 'CRR' ? 'Tracking' : 'BL');
  const blList98 = (v) => String(v || '').split(/[,;\n\r]+/).map((x) => x.replace(/\s+/g, ' ').trim().toUpperCase()).filter((x, i, a) => x && a.indexOf(x) === i);
  const blBad98 = (x) => (x.length > 40 ? 'A number can be up to 40 characters.' : !/^[A-Z0-9][A-Z0-9 \-\/.#_]*$/.test(x) ? '“' + x + '” — use letters, digits, - / . only.' : '');
  function blCtl98(id, list, word) {
    return '<div class="bln" data-bln data-word="' + esc(word) + '"><input type="hidden" name="blNo" value="' + esc(list.join(', ')) + '">' +
      list.map((x) => '<span class="bln-chip">' + esc(x) + '<button type="button" class="bln-x" data-bln-x="' + esc(x) + '" aria-label="Remove ' + esc(x) + '">' + icon('close', 11) + '</button></span>').join('') +
      '<input type="text" class="bln-in" id="' + id + '" placeholder="' + (list.length ? 'Add another' : 'Type the ' + word + ' number, then press Enter') + '" autocomplete="off" spellcheck="false" autocapitalize="characters" enterkeyhint="done"></div>';
  }
  function blRead98(box) { return blList98((box.querySelector('input[name="blNo"]') || {}).value); }
  function blDraw98(box, list, keep) {
    if (!box || !box.isConnected) return;
    const inp = box.querySelector('.bln-in'), id = inp ? inp.id : 'blIn98';
    const word = box.dataset.word || 'BL';
    state.blDrawing98 = true;   // the box is redrawn: its input losing focus must not redraw it again
    try { box.outerHTML = blCtl98(id, list, word); } finally { state.blDrawing98 = false; }
    const n = document.getElementById(id); if (n) { if (keep) n.value = keep; if (keep !== undefined || document.activeElement === document.body) n.focus({ preventScroll: true }); }
  }
  // the text being typed becomes chips (Enter, comma, paste, leaving the box). Returns an error, or ''.
  function blTake98(box) {
    const inp = box.querySelector('.bln-in'); if (!inp) return '';
    const add = blList98(inp.value); if (!add.length) return '';
    const bad = add.map(blBad98).find(Boolean); if (bad) return bad;
    const list = blRead98(box); add.forEach((x) => { if (!list.includes(x)) list.push(x); });
    if (list.length > 20) return 'Up to 20 numbers per job.';
    blDraw98(box, list, '');
    return '';
  }
  function blErr98(box, msg) {
    const f = box.closest('.field'); const e = f && f.querySelector('.field-err'); if (e) e.textContent = msg || '';
    if (f) f.classList.toggle('has-error', !!msg);
  }
  function blFlush98(form) { const box = form && form.querySelector('[data-bln]'); if (!box) return true; const err = blTake98(box); blErr98(box, err); return !err; }
  function blLine98(j) {
    if (j.mode === 'misc') return '';
    const L = blList98(j.blNo), can = canEditJob(j) && !j.closed, w = blWord98(j);
    if (!L.length) return can ? '<button type="button" class="vh-rm-add vh-bl-add" data-act="bl98">' + icon('plus', 14) + 'Add ' + w + ' no.</button>' : '';
    return '<div class="vh-bl"><span class="vh-rm-k">' + w.toUpperCase() + ' NO.</span><span class="vh-bl-list">' +
      L.map((x) => '<span class="bl-chip" data-copy="' + esc(x) + '" role="button" tabindex="0" title="Copy ' + esc(x) + '"><span>' + esc(x) + '</span>' + icon('copy', 12) + '</span>').join('') + '</span>' +
      (can ? '<button type="button" class="icon-btn vh-rm-edit" data-act="bl98" aria-label="Edit the ' + w + ' numbers" title="Edit">' + icon('edit', 15) + '</button>' : '') + '</div>';
  }
  const blPop98 = (no) => () => {
    const j = findJob(no); if (!j) return '';
    const w = blWord98(j), D = state.blDraft98 && state.blDraft98.no === j.jobNo ? state.blDraft98.list : blList98(j.blNo);
    return '<div class="pop-title">' + w + ' numbers</div><p class="pop-text">' + esc(j.jobNo) + ' · ' + esc(j.customer || '') + '</p>' +
      '<form class="pop-form" data-bl-form="' + esc(j.jobNo) + '"><div class="field is-wide">' + blCtl98('blIn98', D, w) + '<div class="field-err"></div></div>' +
      '<button type="submit" class="btn-brutal pop-main" data-primary>SAVE</button></form>' + SAVE_NOTE;
  };

  // ---------- invoice status (for the customer): opens once costing is done; kept and frozen if costing is unlocked
  const INV98 = ['INVOICE NOT ISSUED', 'INVOICE ISSUED', 'SHARED TO CUSTOMER'];
  const INV_LABEL98 = { 'INVOICE NOT ISSUED': 'Invoice not issued', 'INVOICE ISSUED': 'Invoice issued', 'SHARED TO CUSTOMER': 'Shared to customer' };
  const INV_TONE98 = { 'INVOICE NOT ISSUED': 'amber', 'INVOICE ISSUED': 'teal', 'SHARED TO CUSTOMER': 'done' };
  function invOf98(j) {
    if (!j || j.costing === 'CANCELLED') return { na: true, label: 'Not needed', tone: 'calm' };
    const done = ['COSTING DONE', 'COMPLETED'].includes(j.costing), v = INV98.includes(j.invoice) ? j.invoice : '';
    if (done) { const x = v || 'INVOICE NOT ISSUED'; return { open: true, value: x, label: INV_LABEL98[x], tone: INV_TONE98[x] }; }
    if (v) return { frozen: true, value: v, label: INV_LABEL98[v], tone: 'calm' };
    return { label: 'Invoice pending', tone: 'calm' };
  }
  const invChip98 = (s) => '<span class="inv-chip is-' + s.tone + '">' + (s.open ? '' : icon('lock', 12)) + '<span>' + esc(s.label) + '</span></span>';
  function invRow98(j) {
    const s = invOf98(j); if (s.na) return '';
    const can = canEditJob(j);
    return '<div class="kv inv-row"><span class="kv-k">Invoice</span>' + (can ? '<button type="button" class="inv-btn" data-inv="' + esc(j.jobNo) + '" aria-label="Invoice: ' + esc(s.label) + (s.open ? '. Change' : '') + '">' + invChip98(s) + (s.open ? icon('chevron', 13) : '') + '</button>' : invChip98(s)) + '</div>';
  }
  const invPop98 = (no) => () => {
    const j = findJob(no); if (!j) return '';
    const s = invOf98(j);
    const head = '<div class="pop-title">Invoice</div><p class="pop-text">' + esc(j.jobNo) + ' · ' + esc(j.customer || '') + '</p>';
    if (!s.open) return head + '<div class="inv-ro">' + invChip98(s) + '</div><p class="pop-text">' + (s.frozen ? 'Costing was unlocked, so this stays as it is until costing is done again.' : 'Opens once costing is done.') + '</p>';
    return head + '<div class="inv-pick" role="group" aria-label="Invoice status">' + INV98.map((v) => '<button type="button" class="inv-opt is-' + INV_TONE98[v] + (v === s.value ? ' is-on' : '') + '" data-inv-set="' + v + '" data-no="' + esc(j.jobNo) + '" aria-pressed="' + (v === s.value) + '"><i></i><span>' + INV_LABEL98[v] + '</span>' + (v === s.value ? icon('check', 16) : '') + '</button>').join('') + '</div>' + SAVE_NOTE;
  };
  function invSeg98(j) {   // the costing page, once costing is done
    const s = invOf98(j); if (!s.open) return '';
    if (!canEditJob(j)) return '<span class="inv-on-cost"><span class="inv-k">INVOICE</span>' + invChip98(s) + '</span>';
    return '<span class="inv-on-cost"><span class="inv-k">INVOICE</span><span class="inv-seg" role="group" aria-label="Invoice status">' + INV98.map((v) => '<button type="button" class="' + (v === s.value ? 'is-on is-' + INV_TONE98[v] : '') + '" data-inv-set="' + v + '" data-no="' + esc(j.jobNo) + '" aria-pressed="' + (v === s.value) + '">' + INV_LABEL98[v].replace('Invoice ', '').replace(/^n/, 'N').replace(/^i/, 'I') + '</button>').join('') + '</span></span>';
  }
  function invSave98(no, v) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;
    const s = invOf98(j); if (!s.open) { toast(s.frozen ? 'Costing was unlocked — the invoice status opens again once costing is done.' : 'The invoice status opens once costing is done.', { error: true }); return; }
    if (state.quick99) quickDone99(); else closeOverlays();   // v2.9.9
    if ((j.invoice || '') === v) return;
    saveJob(j.jobNo, { invoice: v }, { toast: 'Invoice → ' + INV_LABEL98[v].toLowerCase().replace(/^./, (c) => c.toUpperCase()) });
  }
  function invTodo98(done) {
    const n = done.filter((x) => { const s = invOf98(x.j); return s.open && s.value === 'INVOICE NOT ISSUED'; }).length;
    return n ? n + (n === 1 ? ' invoice' : ' invoices') + ' not issued' : 'all invoiced';
  }
  function invStatic98(j) {
    const s = invOf98(j); if (s.open || s.na) return '';
    return '<div class="field" data-field="invoice"><label>Invoice status</label><div class="ro-field">' + invChip98(s) + '<span>' + (s.frozen ? 'Kept until costing is done again' : 'Opens once costing is done') + '</span></div></div>';
  }

  // ---------- cover for a colleague (ask or offer — the other side accepts, like a friend request)
  const covToday98 = () => isoOf(today0());
  const covOn98 = (c, t) => c.status === 'ACCEPTED' && c.start <= t && t <= c.end;
  function covOwners98() { const o = new Set(); if (!canEdit()) return o; const t = covToday98(); (state.covers || []).forEach((c) => { if (c.cover === state.user && covOn98(c, t)) o.add(c.owner); }); return o; }
  const covered98 = (j) => !!j && canEdit() && !!j.cs && j.cs !== state.user && covOwners98().has(j.cs);
  const ownTag98 = (j) => (covered98(j) ? '<span class="own-tag" title="' + esc('Covering ' + nice(j.cs)) + '">' + esc(j.cs) + '</span>' : '');
  const ownChip98 = (j) => (covered98(j) ? '<span class="own-chip">' + icon('swap', 13) + 'COVERING · ' + esc(j.cs) + '</span>' : '');
  const covIncoming98 = () => (state.covers || []).filter((c) => c.status === 'ASKED' && c.from !== state.user && c.end >= covToday98());
  const covOther98 = (c) => (c.owner === state.user ? c.cover : c.owner);
  const covDays98 = (c) => { const a = parseDate(c.start), b = parseDate(c.end); return a && b ? days(a, b) + 1 : 0; };
  const covDay98 = (iso) => { const d = parseDate(iso); return d ? DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON91[d.getMonth()] : '—'; };
  const covRange98 = (c) => (c.start === c.end ? covDay98(c.start) : covDay98(c.start) + ' – ' + covDay98(c.end));
  const covJobs98 = (owner) => state.jobs.filter((j) => j.active && j.cs === owner).length;
  function covChips98(home) {   // on Home the request itself is the glass card; its chip shows once the card is put away
    if (!canEdit()) return '';
    const t = covToday98(), L = (state.covers || []).filter((c) => covOn98(c, t));
    const inc = covIncoming98().filter((c) => !home || (state.covLater98 || []).includes(c.id));
    const short = (iso) => { const d = parseDate(iso); return d ? d.getDate() + ' ' + MON_UP[d.getMonth()] : ''; };
    return (inc.length ? '<button type="button" class="meta-chip is-cover-ask" data-href="#/cover">' + icon('swap', 12) + '<b>' + inc.length + '</b> COVER ' + (inc.length === 1 ? 'REQUEST' : 'REQUESTS') + '</button>' : '') +
      L.map((c) => '<button type="button" class="meta-chip is-cover" data-href="#/cover">' + icon('swap', 12) + (c.cover === state.user ? 'COVERING <b>' + esc(c.owner) + '</b>' : '<b>' + esc(c.cover) + '</b> COVERS YOU') + ' · TILL ' + short(c.end) + '</button>').join('');
  }
  function covWho98(c) {   // how a cover reads from where I stand
    const o = nice(covOther98(c)), mine = c.cover === state.user;
    if (c.status === 'ASKED') return c.from === state.user ? (mine ? 'You offered to cover ' + o : 'You asked ' + o + ' to cover you') : (mine ? o + ' asks you to cover their jobs' : o + ' offers to cover your jobs');
    return mine ? 'You cover ' + o : o + ' covers you';
  }
  function covCard98(c, kind) {
    const other = covOther98(c), n = covDays98(c), mine = c.cover === state.user, t = covToday98();
    const live = covOn98(c, t), jobs = covJobs98(c.owner);
    const btns = kind === 'incoming' ? '<button type="button" class="btn-ghost" data-cov-no="' + esc(c.id) + '">Decline</button><button type="button" class="btn-brutal" data-cov-yes="' + esc(c.id) + '">ACCEPT</button>'
      : kind === 'sent' ? hoBtn911(c) + '<button type="button" class="btn-ghost" data-cov-end="' + esc(c.id) + '">Withdraw</button>'
      : kind === 'live' || kind === 'soon' ? hoBtn911(c) + (live && mine ? '<button type="button" class="btn-ghost" data-href="#/jobs">' + icon('jobs', 15) + '<span>See the jobs</span></button>' : '') + '<button type="button" class="btn-ghost" data-cov-end="' + esc(c.id) + '">' + (live ? 'End cover' : 'Call off') + '</button>' : '';
    const state98 = kind === 'incoming' ? '<span class="cv-state is-ask">WAITING FOR YOU</span>' : kind === 'sent' ? '<span class="cv-state">WAITING FOR ' + esc(other) + '</span>'
      : kind === 'live' ? '<span class="cv-state is-live"><i></i>ON NOW</span>' : kind === 'soon' ? '<span class="cv-state is-soon">FROM ' + esc(covDay98(c.start).toUpperCase()) + '</span>' : '';
    return '<article class="cv-card' + (kind === 'incoming' ? ' is-incoming' : kind === 'live' ? ' is-live' : '') + '">' +
      '<div class="cv-top"><span class="avatar' + (mine ? '' : ' is-other') + '">' + esc(initials(other)) + '</span><div class="cv-title"><b>' + esc(covWho98(c)) + '</b>' + state98 + '</div></div>' +
      '<div class="cv-when"><span class="cv-range">' + esc(covRange98(c)) + '</span><span>' + n + (n === 1 ? ' day' : ' days') + '</span><span>' + jobs + ' active ' + (jobs === 1 ? 'job' : 'jobs') + (c.owner === state.user ? ' of yours' : ' of ' + esc(nice(c.owner))) + '</span></div>' +
      (c.note ? '<p class="cv-note">“' + esc(c.note) + '”</p>' : '') +
      (btns ? '<div class="cv-act">' + btns + '</div>' : '') + '</article>';
  }
  function renderCover98(first) {
    const t0 = today0(), t = covToday98(), anim = first ? ' reveal' : '';
    const C = state.covers || [];
    const inc = covIncoming98(), sent = C.filter((c) => c.status === 'ASKED' && c.from === state.user && c.end >= t);
    const live = C.filter((c) => covOn98(c, t)), soon = C.filter((c) => c.status === 'ACCEPTED' && c.start > t);
    const past = C.filter((c) => !inc.includes(c) && !sent.includes(c) && !live.includes(c) && !soon.includes(c)).slice(0, 8);
    const sec = (title, list, kind, d) => list.length ? '<section class="cv-sec' + anim + '" style="--d:' + d + 'ms"><div class="tile-head"><h2 class="tile-title">' + title + ' <span class="tile-count">' + list.length + '</span></h2></div><div class="cv-grid">' + list.map((c) => covCard98(c, kind)).join('') + '</div></section>' : '';
    const pastWho = (c) => { const o = nice(covOther98(c)), mine = c.cover === state.user;
      if (c.status === 'ACCEPTED' || c.status === 'ENDED') return mine ? 'You covered ' + o : o + ' covered you';
      return c.from === state.user ? (mine ? 'You offered to cover ' + o : 'You asked ' + o + ' to cover you') : (mine ? o + ' asked you to cover their jobs' : o + ' offered to cover your jobs'); };
    const pastWord = (c) => c.status === 'DECLINED' ? 'declined' : c.status === 'WITHDRAWN' ? 'withdrawn' : c.status === 'ENDED' ? 'ended early' : c.status === 'ASKED' ? 'not answered' : 'done';
    $('#view').innerHTML = '<div class="wrap cover-page no-seg">' +
      '<header class="page-head' + anim + '"><div class="head-main"><div class="meta-line"><span>COVER · ' + esc(fmtLong(t0)) + '</span></div><h1 class="greeting">Cover</h1></div>' +
        '<div class="head-actions"><button type="button" class="btn-ghost ho-open911" data-href="#/handover">' + icon('handover911', 16) + '<span class="btn-label">Hand-over</span></button><button type="button" class="btn-ghost" data-cov-new="offer">' + icon('users', 16) + '<span class="btn-label">Offer to cover</span></button><button type="button" class="btn-brutal btn-icon" data-cov-new="ask">' + icon('plus', 16) + '<span>ASK FOR COVER</span></button></div></header>' +
      sec('WAITING FOR YOU', inc, 'incoming', 40) + sec('ON NOW', live, 'live', 80) + sec('COMING UP', soon, 'soon', 110) + sec('SENT', sent, 'sent', 140) +
      (!inc.length && !live.length && !soon.length && !sent.length ? '<section class="tile cv-empty' + anim + '" style="--d:40ms">' + empty('swap', 'No cover running or asked for.') + '</section>' : '') +
      (past.length ? '<section class="cv-sec' + anim + '" style="--d:170ms"><div class="tile-head"><h2 class="tile-title">EARLIER</h2></div><ul class="cv-past">' + past.map((c) => '<li><span class="avatar is-other">' + esc(initials(covOther98(c))) + '</span><span class="cv-p-who">' + esc(pastWho(c)) + '</span><span class="cv-p-when">' + esc(covRange98(c)) + '</span><span class="cv-p-st is-' + c.status.toLowerCase() + '">' + pastWord(c) + '</span></li>').join('') + '</ul></section>' : '') +
      '</div>';
  }
  // the request form (a side panel)
  function covForm98() {
    const F = state.covForm98, ask = F.kind === 'ask';
    const names = csOptions('').filter((n) => n !== state.user);
    const n = F.start && F.end ? days(parseDate(F.start), parseDate(F.end)) + 1 : 0;
    return '<h2 class="peek-job form-title" id="drawerTitle">' + (ask ? 'Ask for cover' : 'Offer to cover') + '</h2>' +
      '<form class="job-form cover-form" id="coverForm" novalidate>' +
        '<fieldset><legend>' + (ask ? 'WHO COVERS YOU?' : 'WHOSE JOBS?') + '</legend>' + (names.length ? '<div class="choice-row cv-names">' + names.map((x) => '<button type="button" class="choice cv-name' + (F.who === x ? ' is-on' : '') + '" data-cov-who="' + esc(x) + '" aria-pressed="' + (F.who === x) + '"><span class="avatar">' + esc(initials(x)) + '</span>' + esc(nice(x)) + '</button>').join('') + '</div>' : '<p class="pop-text">There is no other Customer Service account yet.</p>') + '</fieldset>' +
        '<fieldset><legend>WHEN?</legend><div class="fgrid cv-dates">' +
          '<div class="field"><label for="cvStart">First day</label><input type="date" id="cvStart" min="' + covToday98() + '" value="' + esc(F.start) + '"></div>' +
          '<div class="field"><label for="cvEnd">Last day</label><input type="date" id="cvEnd" min="' + esc(F.start || covToday98()) + '" value="' + esc(F.end) + '"></div></div>' +
          '<div class="choice-row cv-len">' + [[1, '1 day'], [2, '2 days'], [5, '5 days'], [7, '1 week'], [14, '2 weeks']].map(([d, l]) => '<button type="button" class="choice' + (n === d ? ' is-on' : '') + '" data-cov-len="' + d + '">' + l + '</button>').join('') + '</div>' +
          (n > 0 ? '<p class="cv-sum">' + esc(covDay98(F.start)) + (n > 1 ? ' – ' + esc(covDay98(F.end)) : '') + ' · <b>' + n + (n === 1 ? ' day' : ' days') + '</b></p>' : '') + '</fieldset>' +
        '<fieldset><legend>NOTE</legend><div class="field is-wide"><label for="cvNote">For them (optional)</label><input id="cvNote" maxlength="200" value="' + esc(F.note) + '" placeholder="Type a line for them" autocomplete="off"></div></fieldset>' +
        (F.who ? '<p class="pop-hint cv-hint">' + (ask ? esc(nice(F.who)) + ' sees your jobs and gets your alerts on those days. The jobs stay yours.' : 'You see ' + esc(nice(F.who)) + '’s jobs and get their alerts on those days. The jobs stay theirs.') + '</p>' : '') +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit"' + (F.who && n > 0 ? '' : ' disabled') + '>' + (ask ? 'SEND REQUEST' : 'SEND OFFER') + '</button></div></form>';
  }
  function covOpen98(kind) {
    if (!canEdit()) return;
    closeOverlays(true);
    const t = covToday98();
    state.covForm98 = { kind, who: '', start: t, end: t, note: '' };
    $('#drawer').classList.add('is-wide');
    $('#drawerKicker').textContent = 'COVER';
    popRender = covForm98;
    $('#drawerBody').innerHTML = covForm98();
    showDrawer(document.activeElement);
    state.overlay = 'cover';
  }
  async function covCall98(fn, args, ok) {
    setSaving(1);
    try {
      const res = await api.call(fn, args);
      if (res && Array.isArray(res.covers)) state.covers = res.covers;
      if (res && res.ok) { rerender(); updateNav(); covReq98(); if (ok) toast(typeof ok === 'function' ? ok(res) : ok); return res; }
      rerender(); covReq98();
      toast((res && res.error) || 'Not done.', { error: true });
    } catch (e) { if (e.kind !== 'auth') toast(/not available|unknown/i.test(e.message) ? 'Cover needs the v2.9.8 Code.gs.' : e.message, { error: true }); }
    finally { setSaving(-1); }
    return null;
  }
  async function covSubmit98() {
    const F = state.covForm98; if (!F) return;
    F.note = ($('#cvNote') || {}).value || '';
    if (!F.who || !F.start || !F.end) return;
    const btn = $('#formSubmit'); if (btn) { btn.disabled = true; btn.textContent = 'SENDING…'; }
    const res = await covCall98('ethixCoverAsk', [{ kind: F.kind, who: F.who, start: F.start, end: F.end, note: F.note.trim() }], null);
    if (res) { closeOverlays(); toast(F.kind === 'ask' ? 'Request sent to ' + nice(F.who) : 'Offer sent to ' + nice(F.who)); go('#/cover'); return; }
    if (btn) { btn.disabled = false; btn.textContent = F.kind === 'ask' ? 'SEND REQUEST' : 'SEND OFFER'; }
  }
  function covAnswer98(id, yes) {
    const c = (state.covers || []).find((x) => x.id === id); if (!c) return;
    covCall98('ethixCoverAnswer', [id, yes], () => (yes ? (c.cover === state.user ? 'You cover ' + nice(c.owner) + ' · ' + covRange98(c) : nice(c.cover) + ' covers you · ' + covRange98(c)) : 'Declined'));
  }
  function covEnd98(id) {
    const c = (state.covers || []).find((x) => x.id === id); if (!c) return;
    const other = nice(covOther98(c));
    if (c.status === 'ASKED') { covCall98('ethixCoverEnd', [id], 'Request withdrawn'); return; }
    const live = covOn98(c, covToday98());
    confirmBox(live ? 'End the cover now?' : 'Call off this cover?', (c.cover === state.user ? other + '’s jobs leave your lists' : 'Your jobs leave ' + other + '’s lists') + (live ? ' now.' : '.') + ' ' + other + ' is told.', live ? 'End cover' : 'Call off', () => covCall98('ethixCoverEnd', [id], live ? 'Cover ended' : 'Cover called off'));
  }
  // a request waiting for you: a glass card on Home, like a friend request
  function covReq98() {
    let el = $('#covReq98');
    const on = state.signedIn && canEdit() && state.route && state.route.name === 'home';
    const c = on ? covIncoming98().find((x) => !(state.covLater98 || []).includes(x.id)) : null;
    if (!c) { if (el) el.remove(); return; }
    const html = '<div class="cq-top"><span class="avatar">' + esc(initials(c.from)) + '</span><div class="cq-head"><div class="cq-kick">COVER REQUEST</div><div class="cq-title"><b>' + esc(nice(c.from)) + '</b> ' + (c.cover === state.user ? 'asks you to cover their jobs' : 'offers to cover your jobs') + '</div></div>' +
      '<button type="button" class="icon-btn cq-x" data-cov-later="' + esc(c.id) + '" aria-label="Later">' + icon('close', 14) + '</button></div>' +
      '<div class="cq-when"><b>' + esc(covRange98(c)) + '</b><span>' + covDays98(c) + (covDays98(c) === 1 ? ' day' : ' days') + ' · ' + covJobs98(c.owner) + ' active ' + (covJobs98(c.owner) === 1 ? 'job' : 'jobs') + '</span></div>' +
      (c.note ? '<p class="cq-note">“' + esc(c.note) + '”</p>' : '') +
      '<div class="cq-act"><button type="button" class="btn-ghost" data-cov-no="' + esc(c.id) + '">Decline</button><button type="button" class="btn-brutal" data-cov-yes="' + esc(c.id) + '">ACCEPT</button></div>';
    if (!el) { el = document.createElement('aside'); el.id = 'covReq98'; el.className = 'cov-req glass'; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Cover request'); document.body.appendChild(el); }
    if (el.dataset.id !== c.id || el.dataset.v !== html.length + '') { el.innerHTML = html; el.dataset.id = c.id; el.dataset.v = html.length + ''; }
  }

  // ---------- People: work emails (the morning email goes to them)
  const mailOk98 = (v) => /^[^\s@<>"',;:()[\]]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(v);
  function admMail98(name) {
    const u = adminData().users.find((x) => x.name === name); if (!u) return '';
    return '<form class="pop-form adm-mail" novalidate data-adm-mail="' + esc(name) + '"><label class="pop-label" for="admMail98">Work email · morning email</label>' +
      '<input type="email" id="admMail98" value="' + esc(u.email || '') + '" placeholder="Type their work email" autocomplete="off" spellcheck="false">' +
      '<div class="field-err" id="admMail98_err"></div><button type="submit" class="btn-ghost pop-wide">' + icon('mail', 16) + (u.email ? 'Save email' : 'Add email') + '</button>' +
      (u.email ? '<button type="button" class="link-btn quiet pop-clear" data-adm-mail-clear="' + esc(name) + '">Remove email</button>' : '') + '</form>';
  }

  function initV298() {
    const body = $('#drawerBody');
    // costing fetched ahead when the pointer rests on a costing button or row
    document.addEventListener('pointerover', (e) => {
      const c = e.target.closest && e.target.closest('[data-cost]'); if (!c || !state.signedIn) return;
      clearTimeout(state.costHoverT98);
      state.costHoverT98 = setTimeout(() => costAhead98(c.dataset.cost), 150);
    }, { passive: true });
    document.addEventListener('click', (e) => {
      if (!state.signedIn) return;
      // BL numbers: edit from the job page
      const b = e.target.closest('[data-act="bl98"]');
      if (b && state.route && state.route.name === 'job') { const j = findJob(state.route.jobNo); if (j && canEditJob(j)) { state.blDraft98 = null; openPop(b, blWord98(j).toUpperCase() + ' NUMBERS', blPop98(j.jobNo)); setTimeout(() => { const i = $('#blIn98'); if (i) i.focus(); }, 40); } return; }
      const bx = e.target.closest('[data-bln-x]');
      if (bx) { const box = bx.closest('[data-bln]'); const list = blRead98(box).filter((x) => x !== bx.dataset.blnX); if (state.blDraft98) state.blDraft98.list = list; blDraw98(box, list, (box.querySelector('.bln-in') || {}).value || ''); return; }
      // invoice
      const ib = e.target.closest('[data-inv]');
      if (ib) { openPop(ib, 'INVOICE', invPop98(ib.dataset.inv)); return; }
      const is = e.target.closest('[data-inv-set]');
      if (is) { invSave98(is.dataset.no, is.dataset.invSet); return; }
      // cover
      const cn = e.target.closest('[data-cov-new]'); if (cn) { covOpen98(cn.dataset.covNew); return; }
      const cy = e.target.closest('[data-cov-yes]'); if (cy) { covAnswer98(cy.dataset.covYes, true); return; }
      const cd = e.target.closest('[data-cov-no]'); if (cd) { covAnswer98(cd.dataset.covNo, false); return; }
      const ce = e.target.closest('[data-cov-end]'); if (ce) { covEnd98(ce.dataset.covEnd); return; }
      const cl = e.target.closest('[data-cov-later]'); if (cl) { state.covLater98 = (state.covLater98 || []).concat(cl.dataset.covLater); covReq98(); rerender(); return; }
      // the delay form: tap the new date → the calendar
      const pk = e.target.closest('.dl-pick input[type="date"]');
      if (pk && typeof pk.showPicker === 'function') { try { pk.showPicker(); } catch (er) { /* the browser opens it itself */ } }
    });
    body.addEventListener('click', (e) => {
      if (state.overlay !== 'cover') return;
      const F = state.covForm98; if (!F) return;
      if (e.target.closest('[data-act="form-cancel"]')) { closeOverlays(); return; }
      const w = e.target.closest('[data-cov-who]'), l = e.target.closest('[data-cov-len]');
      if (!w && !l) return;
      F.note = ($('#cvNote') || {}).value || F.note;
      if (w) F.who = w.dataset.covWho;
      if (l) { const a = parseDate(F.start) || today0(); F.end = isoOf(addDays(a, +l.dataset.covLen - 1)); }
      const y = body.scrollTop; body.innerHTML = covForm98(); body.scrollTop = y;
    });
    body.addEventListener('change', (e) => {
      if (state.overlay === 'cover' && state.covForm98 && (e.target.id === 'cvStart' || e.target.id === 'cvEnd')) {
        const F = state.covForm98; F.note = ($('#cvNote') || {}).value || F.note;
        if (e.target.id === 'cvStart') { const n = F.start && F.end ? days(parseDate(F.start), parseDate(F.end)) : 0; F.start = e.target.value || F.start; if (F.start) F.end = isoOf(addDays(parseDate(F.start), Math.max(0, n))); }
        else F.end = e.target.value && e.target.value >= F.start ? e.target.value : F.start;
        const y = body.scrollTop; body.innerHTML = covForm98(); body.scrollTop = y;
        return;
      }
      if (state.overlay === 'delay' && e.target.matches('[data-dl-date]')) {   // a new ETD / ETA picked → the days, and delayed or preponed
        const F = state.delayForm; const j = F && findJob(F.no); if (!j) return;
        const k = e.target.dataset.dlDate, from = j[k], to = parseDate(e.target.value);
        if (!from || !to) return;
        const n = days(from, to);
        if (n === 0) { toast('That is the same date as now — pick another day.', { error: true }); }
        else {
          const other = $('#dlOther'); if (other) F.other = other.value; const note = $('#dlNote'); if (note) F.note = note.value;
          const dir = n < 0 ? 'early' : 'late';
          if (dir !== F.dir) { F.dir = dir; F.reason = ''; }
          F.days = Math.min(90, Math.abs(n)); F.move[k] = true; F.moveSet98 = true;
          if (Math.abs(n) > 90) toast('Up to 90 days at a time — set to 90.', { error: true });
        }
        const y = body.scrollTop; body.innerHTML = delayForm(); body.scrollTop = y;
      }
    });
    body.addEventListener('submit', (e) => {
      if (state.overlay !== 'cover' || e.target.id !== 'coverForm') return;
      e.preventDefault(); covSubmit98();
    });
    // the chips box for BL numbers (Edit details and the job page)
    document.addEventListener('keydown', (e) => {
      const inp = e.target.closest && e.target.closest('.bln-in'); if (!inp) return;
      const box = inp.closest('[data-bln]');
      if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
        if (!inp.value.trim()) { if (e.key !== 'Enter') e.preventDefault(); return; }
        e.preventDefault(); const err = blTake98(box); const nb = document.querySelector('#' + inp.id); blErr98((nb && nb.closest('[data-bln]')) || box, err);
        if (state.blDraft98 && nb) state.blDraft98.list = blRead98(nb.closest('[data-bln]'));
      } else if (e.key === 'Backspace' && !inp.value) {
        const list = blRead98(box); if (!list.length) return;
        e.preventDefault(); list.pop(); if (state.blDraft98) state.blDraft98.list = list; blDraw98(box, list, '');
      }
    });
    document.addEventListener('paste', (e) => {
      const inp = e.target.closest && e.target.closest('.bln-in'); if (!inp) return;
      const txt = (e.clipboardData && e.clipboardData.getData('text')) || '';
      if (!/[,;\n\r]/.test(txt)) return;
      e.preventDefault(); inp.value = (inp.value + ',' + txt); const box = inp.closest('[data-bln]'); const err = blTake98(box);
      const nb = document.querySelector('#' + inp.id); blErr98((nb && nb.closest('[data-bln]')) || box, err);
    });
    document.addEventListener('focusout', (e) => {
      const inp = e.target.closest && e.target.closest('.bln-in'); if (!inp || !inp.value.trim() || state.blDrawing98) return;
      const to = e.relatedTarget;
      if (to && to.closest && to.closest('[data-bln-x]')) return;
      const box = inp.closest('[data-bln]'); if (!box) return;
      const err = blTake98(box); const nb = document.querySelector('#' + inp.id); blErr98((nb && nb.closest('[data-bln]')) || box, err);
      if (state.blDraft98 && nb) state.blDraft98.list = blRead98(nb.closest('[data-bln]'));
    });
    $('#pop').addEventListener('submit', (e) => {
      const f = e.target.closest('[data-bl-form]');
      if (f) {
        e.preventDefault();
        if (!blFlush98(f)) return;
        const j = findJob(f.dataset.blForm); if (!j) return;
        const v = blRead98(f.querySelector('[data-bln]')).join(', ');
        state.blDraft98 = null; closeOverlays();
        if (v === blList98(j.blNo).join(', ')) return;
        saveJob(j.jobNo, { blNo: v }, { toast: v ? blWord98(j) + ' numbers saved' : blWord98(j) + ' numbers cleared' });
        return;
      }
      const m = e.target.closest('[data-adm-mail]');
      if (m && isAdmin()) {
        e.preventDefault();
        const v = ($('#admMail98') || {}).value.trim(), err = $('#admMail98_err');
        if (v && !mailOk98(v)) { if (err) err.textContent = 'That does not look like an email address.'; return; }
        closeOverlays(); adminCall('ethixAdminEmail', [m.dataset.admMail, v], v ? 'Work email saved for ' + m.dataset.admMail : 'Work email removed');
      }
    });
    $('#pop').addEventListener('click', (e) => {
      const c = e.target.closest('[data-adm-mail-clear]'); if (!c || !isAdmin()) return;
      closeOverlays(); adminCall('ethixAdminEmail', [c.dataset.admMailClear, ''], 'Work email removed');
    });
    window.addEventListener('hashchange', () => setTimeout(covReq98, 0));
  }

  // ================================================================ v2.9.9
  I.remark = '<path d="M20 12.2c0 3.9-3.6 7-8 7-1.1 0-2.2-.2-3.1-.6L4 20l1.3-3.6C4.5 15.2 4 13.8 4 12.2c0-3.9 3.6-7 8-7s8 3.1 8 7z"/>';

  // ---------- one glass capsule for every message ----------
  // "Saving…" → what was done, with Undo when there is one → fades. A note on its own (Copied, Excel ready) uses the same
  // capsule. Problems stay in the red message. Hovering the capsule holds it.
  function pill99(mode, text, action) {
    const pill = $('#savePill'); if (!pill) return null;
    const txt = $('#savePillText') || pill, act = $('#savePillAct');
    pill.classList.remove('is-out', 'is-done', 'is-news', 'is-msg', 'has-act');
    if (mode !== 'saving') pill.classList.add('is-done');
    if (mode === 'news') pill.classList.add('is-news');
    if (mode !== 'saving' && text !== 'Saved') pill.classList.add('is-msg');
    txt.textContent = text;
    if (act) {
      act.hidden = !action;
      if (action) {
        pill.classList.add('has-act');
        act.textContent = action.label;
        act.onclick = () => { clearTimeout(state.pillT98); pillOut99(true); action.fn(); };
      } else act.onclick = null;
    }
    pill.hidden = false;
    return pill;
  }
  function pillOut99(now) {
    const pill = $('#savePill'); if (!pill || pill.hidden) return;
    const done = () => { pill.hidden = true; pill.classList.remove('is-done', 'is-out', 'is-news', 'is-msg', 'has-act'); const a = $('#savePillAct'); if (a) a.hidden = true; };
    if (now) { done(); return; }
    pill.classList.add('is-out');
    state.pillT98 = setTimeout(done, 360);
  }
  function pillTimer99(ms) {
    clearTimeout(state.pillT98);
    state.pillMs99 = ms;
    if (state.pillHover99) return;
    state.pillT98 = setTimeout(() => pillOut99(false), ms);
  }
  function note99(text, opts) {
    const m = { text: String(text || ''), action: opts.action || null, news: !!opts.news };
    if (state.savingCount > 0) { state.pillMsg99 = m; return; }   // shown when the save lands
    clearTimeout(state.pillT98);
    if (!pill99(m.news ? 'news' : 'done', m.text, m.action)) return;
    pillTimer99(m.action ? 6000 : 2400);
  }

  // ---------- Friday: Saturday and Sunday count as due today ----------
  // fri99, due99, dayWord99 — v2.9.11 versions further down (the days off after today: weekend and UAE holidays)

  // ---------- Home: what is due now (overdue, today, tomorrow — Friday: the weekend too) ----------
  // Costing: an export once it has sailed or sails by then; an import / clearance once it has arrived or arrives by then.
  function costDueBy99(j, t0) {
    if (costDue91(j, t0)) return true;
    const at = costByArrival91(j) ? j.eta : j.etd;
    return !!(at && days(t0, at) <= due99(t0));
  }
  // SI / ED (and DGPC): each open one by its cutoff; with no cutoff, by the sailing date; still open after sailing = overdue.
  function siedParts99(j, t0) {
    const sailed = !!(j.etd && j.etd < t0), C = cutsFor(j, t0), air = j.mode === 'air', out = [];
    const one = (k, f, v, show, ck) => {
      if (!show || v === NA) return;
      if (v && v !== 'PENDING') { out.push({ k, f, done: true, d: 99 }); return; }
      if (sailed) { out.push({ k, f, tone: 'red', text: air ? 'DEPARTED' : 'SAILED', d: -99 }); return; }
      const c = C.find((x) => x.k === (ck || k));
      if (c) { out.push({ k, f, tone: c.tone, text: cutWhen(c.d, c.date), d: c.d }); return; }
      if (j.etd) { const d = days(t0, j.etd); out.push({ k, f, tone: cutTone(d), text: 'NO CUTOFF · ' + (air ? 'DEPARTS ' : 'SAILS ') + (d === 0 ? 'TODAY' : d === 1 ? 'TOMORROW' : fmt(j.etd)), d }); return; }
      out.push({ k, f, tone: 'calm', text: 'NO CUTOFF', d: 50 });
    };
    one('SI', 'sido', j.sido, true);
    one('ED', 'ed', j.ed, j.cat === 'EXPORT');
    one('DGPC', 'dgpc', j.dgpc, j.cat === 'EXPORT' && j.dg === 'DG' && j.mode === 'sea', 'DG');
    return out;
  }
  function siedD99(j, t0) { return siedParts99(j, t0).reduce((a, p) => Math.min(a, p.d), 99); }

  // ---------- TODAY'S WATCH within a day: the office that matters now, closing soonest first ----------
  function officeScore99(j, now, t0) {
    const p = clockPort(j, t0), z = (p && portZone(p)) || HOME_ZONE, o = officeState(z, now);
    return !o ? 5000 : o.open ? o.toClose : 1000 + o.toOpen;
  }

  // ---------- tap a task → its choice card, right there ----------
  // From TODAY'S WATCH (the tile: a card beside it; the side panel: inside the panel, with a way back) and the SI / ED
  // panel's chips. Saving works as on the job page; "Open job" is at the bottom.
  function quickStop99(j, field) {
    const all = j.journey.all.filter((s) => s.def && s.def.field === field && (s.kind === 'field' || s.kind === 'date'));
    return all.find((s) => s.state !== 'done' && s.state !== 'skip') || all[0] || null;
  }
  const docsCard99 = (no) => () => {   // original docs have no stop of their own
    const j = findJob(no); if (!j) return '';
    const cur = j.docs || '';
    return '<div class="pop-title">Original docs</div><div class="pop-state is-' + (cur === 'RECEIVED' ? 'done' : 'todo') + '"><span>' + esc(cur === NA ? 'NOT NEEDED' : cur || 'PENDING') + '</span></div>' +
      '<div class="choice-row">' + OPTS.docs.map((v) => '<button type="button" class="choice' + (v === cur ? ' is-on' : '') + (v === 'RECEIVED' ? ' is-good' : '') + '" data-set="docs" data-val="' + esc(v) + '" aria-pressed="' + (v === cur) + '">' + esc(v === NA ? 'Not needed' : v) + '</button>').join('') + '</div>' +
      (cur !== 'RECEIVED' ? '<button type="button" class="btn-brutal pop-main" data-primary data-set="docs" data-val="RECEIVED">MARK DONE · RECEIVED</button>' : '') + SAVE_NOTE;
  };
  function quickRender99(no, field) {
    const j = findJob(no); if (!j) return null;
    let inner = null;
    if (field === 'invoice') inner = invPop98(no);
    else if (field === 'docs') inner = docsCard99(no);
    else { const s = quickStop99(j, field); if (s) inner = stopEditor(no, s.id); }
    if (!inner) return null;
    return () => {
      const k = findJob(no); if (!k) return '';
      const P = state.quick99 || {};
      return (P.panel ? '<button type="button" class="q99-back" data-q99-back>' + icon('back', 14) + esc(P.title || 'Back') + '</button>' : '') +
        '<div class="q99-job"><b>' + esc(k.jobNo) + '</b>' + esc(k.customer ? ' · ' + nice(k.customer) : '') + '</div>' + inner() +
        '<button type="button" class="btn-ghost pop-wide q99-open" data-q99-open="' + esc(k.jobNo) + '">Open job ' + icon('chevron', 14) + '</button>';
    };
  }
  function quickOpen99(el) {
    const no = el.dataset.q99, field = el.dataset.q99F, j = findJob(no);
    if (!j) return;
    if (!canEditJob(j) || !field) { openJob(j.jobNo); return; }
    const inPanel = !!el.closest('#drawerBody') && !$('#drawer').hidden && state.overlay === 'drawer';
    const panel = inPanel ? { kind: state.list99, title: ($('#drawerTitle') || {}).textContent || 'Back', kicker: $('#drawerKicker').textContent } : null;
    state.quick99 = { no: j.jobNo, field, panel: !!panel, kind: panel && panel.kind, title: panel && panel.title, kicker: panel && panel.kicker };
    const render = quickRender99(j.jobNo, field);
    if (!render) { state.quick99 = null; openJob(j.jobNo); return; }
    if (panel) {
      popRender = render;
      $('#drawerKicker').textContent = field === 'invoice' ? 'INVOICE' : 'UPDATE STOP';
      $('#drawerBody').innerHTML = render();
      $('#drawerBody').scrollTop = 0;
      state.overlay = 'sheet';
      focusFirst($('#drawerBody'));
      return;
    }
    const keep = state.quick99;
    openPop(el, field === 'invoice' ? 'INVOICE' : 'UPDATE STOP', render);   // openPop closes what was open (and the quick state)
    state.quick99 = keep;
  }
  function listRender99(kind) {
    return () => {
      const m = lastMetrics; if (!m) return '';
      const entry = listEntry99(kind, m); if (!entry) return '';
      return '<h2 class="peek-job list-title" id="drawerTitle">' + esc(entry[0]) + '</h2>' + drawerList91(kind, Array.from(new Set(entry[1])), m);
    };
  }
  function quickDone99() {   // after a save from a quick card: the panel goes back to its list (fresh), a card closes
    const P = state.quick99; state.quick99 = null;
    if (!P || !P.panel || $('#drawer').hidden) { closeOverlays(); return; }
    popRender = listRender99(P.kind);
    $('#drawerKicker').textContent = P.kicker || '';
    $('#drawerBody').innerHTML = popRender();
    state.overlay = 'drawer';
  }

  // ---------- Follow-ups: both ports' local times on the route ----------
  // POL and POD each with their time under the name; the white one is the port that matters now (it sets the order).
  // rrRoute99 — v2.9.11 version further down (+ OFF TODAY / TOMORROW / DAY AFTER)

  // ---------- Follow-ups: the remark button and the remark card ----------
  function rmkBtn99(j, f) {
    if (!canEdit() || !j.active) return '';
    const n = remarksToday(f, today0()).length;
    return '<button type="button" class="rr-note' + (n ? ' has-note' : '') + '" data-rmk-open="' + esc(j.jobNo) + '" aria-label="' + esc('Remarks for ' + j.jobNo + (n ? ' — ' + n + ' today' : '')) + '" title="Remarks">' + icon('remark', 17) + (n ? '<b>' + n + '</b>' : '') + '</button>';
  }
  const rmkDay99 = (t, t0) => { const d = days(dayOf(t), t0); return d === 0 ? 'TODAY' : d === 1 ? 'YESTERDAY' : (DOW[dayOf(t).getDay()] + ' ' + fmt(dayOf(t))).toUpperCase(); };
  // rmkAll99, rmkCard99, undoCard99, rmkSave99 — v2.9.10 versions further down


  function rmkOpen99(anchor, no, how) {
    const j = findJob(no); if (!j) return;
    const st = { no: j.jobNo, edit: null, add: !!how.add, more: false, peek: !!(how.peek && usePop()) };
    if (st.peek) {   // a look on hover: no focus taken, closes when the mouse leaves
      closeOverlays(true);
      state.rmk99 = st; st.anchor = anchor;
      popRender = rmkCard99(j.jobNo);
      const pop = $('#pop');
      pop.innerHTML = '<div class="pop-head"><div class="kicker">FOLLOW-UP REMARKS</div><button type="button" class="icon-btn" data-act="pop-close" aria-label="Close">' + icon('close', 14) + '</button></div><div class="pop-body">' + popRender() + '</div>';
      pop.hidden = false; pop.classList.add('is-peek99');
      popAnchor = anchor; popKey = null;
      placePop();
      state.overlay = 'pop';
      return;
    }
    openPop(anchor, 'FOLLOW-UP REMARKS', rmkCard99(j.jobNo));   // closes what was open (and the card's state) first
    state.rmk99 = st;
    refreshOverlay();
    if (st.add) setTimeout(() => { const i = $('#remarkInput'); if (i) i.focus(); }, 40);
  }
  function rmkPin99() { if (state.rmk99 && state.rmk99.peek) { state.rmk99.peek = false; $('#pop').classList.remove('is-peek99'); } }
  function rmkRedraw99(focus) { refreshOverlay(); if (focus) setTimeout(() => { const i = document.getElementById(focus); if (i) { i.focus(); if (i.value !== undefined && i.setSelectionRange) i.setSelectionRange(i.value.length, i.value.length); } }, 30); }

  // edit (or clear) one of your own remarks — any day


  // ---------- Follow-ups: the order — overdue / today first, then cutoff tomorrow, then the rest; inside each, office hours ----------
  function dueTier99(j) { const r = j.next ? j.next.rank : 9; return r === 0 ? 0 : r === 1 ? 1 : 2; }

  // ---------- Follow-ups on a laptop: the keyboard ----------
  // ↑ ↓ (or J K) move · Space checks (and moves on) · R opens the remark card · Enter opens the job · Esc lets go
  const kbdHint99 = () => '<span class="rp-kbd"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Space</kbd> check · <kbd>R</kbd> remark · <kbd>Enter</kbd> open</span>';
  function kbRows99() { return $$('#view .round-list .rr').filter((li) => li.offsetParent !== null); }
  function kbMark99(scroll) {
    $$('#view .rr.is-kb').forEach((x) => x.classList.remove('is-kb'));
    if (!state.kb99) return null;
    const li = kbRows99().find((x) => { const b = x.querySelector('.rr-main[data-job]'); return b && b.dataset.job.toUpperCase() === state.kb99; });
    if (!li) return null;
    li.classList.add('is-kb');
    if (scroll) li.scrollIntoView({ block: 'nearest' });
    return li;
  }
  function kbMove99(step) {
    const rows = kbRows99(); if (!rows.length) return;
    const keys = rows.map((li) => li.querySelector('.rr-main[data-job]').dataset.job.toUpperCase());
    let i = state.kb99 ? keys.indexOf(state.kb99) : -1;
    const from = !state.kb99 && state.kbFrom99 ? keys.indexOf(state.kbFrom99) : -1;   // back from a job: carry on from it
    state.kbFrom99 = null;
    i = from > -1 ? from : i < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + step));
    state.kb99 = keys[i];
    kbMark99(true);
  }
  function kbKey99(e) {
    if (!state.route || state.route.name !== 'round' || !usePop() || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (state.overlay && !(state.rmk99 && state.rmk99.peek)) { return; }
    const k = e.key;
    if (k === 'ArrowDown' || k === 'j' || k === 'J') { e.preventDefault(); closeOverlays(true); kbMove99(1); return; }
    if (k === 'ArrowUp' || k === 'k' || k === 'K') { e.preventDefault(); closeOverlays(true); kbMove99(-1); return; }
    if (!state.kb99) return;
    const li = kbMark99(false); if (!li) return;
    const no = li.querySelector('.rr-main[data-job]').dataset.job;
    if (k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      const j = findJob(no); if (!j) return;
      const f = followState(j, today0());
      if (!f.mineToday && canEdit()) followCheck(j.jobNo);
      kbMove99(1);
      return;
    }
    if (k === 'r' || k === 'R') { e.preventDefault(); const a = li.querySelector('[data-rmk-open]') || li; rmkOpen99(a, no, { add: true }); return; }
    if (k === 'Enter') { e.preventDefault(); openJob(no); return; }
    if (k === 'Escape') { state.kb99 = null; kbMark99(false); }
  }

  // ---------- Back to a list keeps your place ----------
  // Leaving Follow-ups, Jobs, Costing, Notifications or Home for a job: where you were is kept. Coming straight back:
  // the same place, and the job you opened glows for a moment (Follow-ups keep their order — nothing regroups).
  const LIST99 = ['round', 'jobs', 'costing', 'notif', 'home'];
  function back99Save(prev, r, changed) {
    const view = $('#view');
    if (changed && prev && LIST99.includes(prev.name) && (r.name === 'job' || r.name === 'costjob'))
      state.back99 = { name: prev.name, y: view.scrollTop, inner: $$('#view .tile-body, #view .jobs-scroll').map((e) => e.scrollTop), no: r.jobNo };
    const b = state.back99;
    const isBack = !!(changed && prev && (prev.name === 'job' || prev.name === 'costjob') && b && b.name === r.name);
    if (changed && !isBack && !(r.name === 'job' || r.name === 'costjob')) state.back99 = null;
    return isBack ? b : null;
  }
  function back99Restore(b, view) {
    if (!b) return false;
    state.back99 = null;
    view.scrollTop = b.y;
    $$('#view .tile-body, #view .jobs-scroll').forEach((e, i) => { if (b.inner[i] !== undefined) e.scrollTop = b.inner[i]; });
    const K = String(b.no || '').toUpperCase();
    const hit = $$('#view [data-job], #view [data-cost], #view [data-check], #view [data-q99]').find((x) => String(x.dataset.job || x.dataset.cost || x.dataset.check || x.dataset.q99 || '').toUpperCase() === K && x.offsetParent !== null);
    if (hit) {
      const box = hit.closest('.rr, .jr, .wt, .li, .cl-row, .nt, .dr-row, li') || hit;
      const r = box.getBoundingClientRect(), vr = view.getBoundingClientRect();
      if (r.top < vr.top || r.bottom > Math.min(vr.bottom, window.innerHeight)) box.scrollIntoView({ block: 'center' });
      box.classList.remove('is-back99'); void box.offsetWidth; box.classList.add('is-back99');
      setTimeout(() => box.classList.remove('is-back99'), 1800);
      if (b.name === 'round') state.kbFrom99 = K;
    }
    return true;
  }

  // ------------------------------------------------------------------ wiring
  function initV299() {
    // the capsule holds while the mouse is on it
    const pill = $('#savePill');
    if (pill) {
      pill.addEventListener('mouseenter', () => { state.pillHover99 = true; if (pill.classList.contains('is-done')) clearTimeout(state.pillT98); });
      pill.addEventListener('mouseleave', () => { state.pillHover99 = false; if (pill.classList.contains('is-done') && !pill.hidden) pillTimer99(1600); });
    }
    // tap a task (TODAY'S WATCH, the SI / ED panel's chips) → its choice card; before the row's own "open the job"
    document.addEventListener('click', (e) => {
      const q = e.target.closest('[data-q99]');
      if (q) { e.preventDefault(); e.stopPropagation(); quickOpen99(q); return; }
      const qb = e.target.closest('[data-q99-back]');
      if (qb) { e.preventDefault(); e.stopPropagation(); const P = state.quick99; state.quick99 = null; if (P && P.panel) { popRender = listRender99(P.kind); $('#drawerKicker').textContent = P.kicker || ''; $('#drawerBody').innerHTML = popRender(); state.overlay = 'drawer'; } return; }
      const qo = e.target.closest('[data-q99-open]');
      if (qo) { e.preventDefault(); e.stopPropagation(); openJob(qo.dataset.q99Open); return; }
    }, true);
    document.addEventListener('keydown', (e) => {
      const q = e.target.closest && e.target.closest('[data-q99]');
      if (q && q.tagName !== 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); quickOpen99(q); }
    }, true);
    // Follow-ups: the remark button, the remark on the row (tap it, or hover on a laptop), the card's own buttons
    const view = $('#view');
    view.addEventListener('click', (e) => {
      const ro = e.target.closest('[data-rmk-open]');
      if (ro && canEdit()) { e.stopPropagation(); rmkOpen99(ro, ro.dataset.rmkOpen, { add: false }); return; }
      const cell = e.target.closest('[data-rmk-cell]');
      if (cell && e.target.closest('.rr-remark')) {
        e.stopPropagation();
        if (state.overlay === 'pop' && state.rmk99 && state.rmk99.peek && state.rmk99.no === findJob(cell.dataset.rmkCell).jobNo) { rmkPin99(); return; }
        rmkOpen99(cell, cell.dataset.rmkCell, { add: false });
      }
    });
    view.addEventListener('mouseover', (e) => {
      if (!usePop() || !state.route || state.route.name !== 'round') return;
      const cell = e.target.closest('[data-rmk-cell]');
      clearTimeout(state.rmkLeaveT99);
      if (!cell || !cell.querySelector('.rr-remark')) return;
      if (state.overlay && !(state.rmk99 && state.rmk99.peek)) return;
      if (state.rmk99 && state.rmk99.peek && state.rmk99.anchor === cell && state.overlay === 'pop') return;
      clearTimeout(state.rmkHoverT99);
      state.rmkHoverT99 = setTimeout(() => { if (cell.isConnected && cell.matches(':hover')) rmkOpen99(cell, cell.dataset.rmkCell, { peek: true }); }, 280);
    });
    const leave = () => {
      clearTimeout(state.rmkHoverT99);
      if (!(state.rmk99 && state.rmk99.peek && state.overlay === 'pop')) return;
      clearTimeout(state.rmkLeaveT99);
      state.rmkLeaveT99 = setTimeout(() => {
        const pop = $('#pop'), a = state.rmk99 && state.rmk99.anchor;
        if (!(state.rmk99 && state.rmk99.peek) || pop.matches(':hover') || (a && a.isConnected && a.matches(':hover'))) return;
        pop.classList.remove('is-peek99'); closeOverlays(true);
      }, 240);
    };
    view.addEventListener('mouseout', (e) => { if (e.target.closest('[data-rmk-cell]')) leave(); });
    $('#pop').addEventListener('mouseleave', leave);
    $('#pop').addEventListener('mouseenter', () => clearTimeout(state.rmkLeaveT99));
    const onCard = (e) => {
      const ro = e.target.closest('[data-rmk-open]'); if (ro && canEdit()) { const a = findAnchor() || ro; rmkOpen99(a, ro.dataset.rmkOpen, { add: false }); return; }
      if (!state.rmk99) return;
      const no = state.rmk99.no;
      if (e.target.closest('#pop, #drawerBody') && e.target.closest('button, input, textarea, form')) rmkPin99();
      const ed = e.target.closest('[data-rmk-edit]'); if (ed) { state.rmk99.edit = +ed.dataset.rmkEdit; state.rmk99.add = false; rmkRedraw99('rmkEdit99'); return; }
      if (e.target.closest('[data-rmk-cancel]')) { state.rmk99.edit = null; rmkRedraw99(); return; }
      const ad = e.target.closest('[data-rmk-add]'); if (ad) { state.rmk99.add = true; state.rmk99.edit = null; rmkRedraw99('remarkInput'); return; }
      if (e.target.closest('[data-rmk-more]')) { state.rmk99.more = true; const j = findJob(no); if (j) loadFollowHistory(j); rmkRedraw99(); }
    };
    $('#pop').addEventListener('click', onCard);
    $('#drawerBody').addEventListener('click', (e) => { if (state.overlay === 'sheet') onCard(e); });
    const onSave = (e) => {
      const f = e.target.closest('[data-rmk-save]'); if (!f) return;
      e.preventDefault(); e.stopPropagation();
      rmkSave99(f.dataset.no, f.dataset.rmkSave, ($('#rmkEdit99', f) || {}).value || '');
    };
    $('#pop').addEventListener('submit', onSave, true);
    $('#drawerBody').addEventListener('submit', onSave, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && e.target && e.target.id === 'rmkEdit99') { e.preventDefault(); const f = e.target.closest('form'); if (f) f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); }
    });
    // the keyboard on Follow-ups (laptop)
    document.addEventListener('keydown', kbKey99);
  }
  // the side panels' lists (Home counters) — one place for openList and the way back from a choice card
  function listEntry99(kind, m) {
    const map = {
      active: ['ACTIVE JOBS', m.active], costing: ['COSTING DUE', m.costing], sied: ['SI / ED DUE', m.sied],
      free: ['FREE TIME ENDING ≤ 2 DAYS', m.freeJobs], atsea: ['AT SEA NOW', m.atSea], arriving: ['ARRIVING THIS WEEK', m.arriving],
      departing: ['DEPARTING THIS WEEK', m.departing], hold: ['ON HOLD', m.hold], watch: ['TODAY’S WATCH', m.watch.map((w) => w.j)], week: weekPanel92(m),
      behind: ['NOT FOLLOWED UP YET', isSales() ? behindList() : []]
    };
    return map[kind] || null;
  }
  // a TODAY'S WATCH task: its choice card when there is one to make (and you can), else the job
  function wtAttr99(w) { return w.field && canEditJob(w.j) ? 'data-q99="' + esc(w.j.jobNo) + '" data-q99-f="' + w.field + '"' : 'data-job="' + esc(w.j.jobNo) + '"'; }


  // ==================================================================== v2.9.10
  // Amal's 3 Nov list: TODAY'S WATCH one row per job · a remark on its own (it never checks the job; the circle does) ·
  // a customer's active jobs from the job page · Cover in the laptop menu.

  // ---------- TODAY'S WATCH: one row per job, its tasks together ----------
  // The watch is already in order (most urgent first), so a job's first task leads: the job sits in that task's group,
  // its other tasks follow it in the same row. A job with one task looks as before.
  function watchJobs910(watch) {
    const by = new Map(), out = [];
    watch.forEach((w) => { const k = keyOf(w.j); let g = by.get(k); if (!g) { g = { j: w.j, lead: w, tasks: [] }; by.set(k, g); out.push(g); } g.tasks.push(w); });
    return out;
  }
  // watchGroups910 — v2.9.11 version further down (TODAY + WEEKEND / a UAE holiday)
  const wtChip910 = (w) => '<span class="' + (w.level === 'urgent' ? 'chip chip-urgent' : 'chip chip-amber-dark') + '">' + (w.level === 'urgent' ? icon('alert', 12) : '') + esc(w.when) + '</span>';
  function watchTile91(m, anim) {
    const item = (w, more) => '<button type="button" class="wt li' + (more ? ' is-more' : '') + '" ' + wtAttr99(w) + '>' +   // one task: tap → its choice card (v2.9.9)
      '<span class="wt-top"><span class="wt-job">' + changedDot(w.j) + esc(w.j.jobNo) + ownTag98(w.j) + '</span>' + wtChip910(w) + '</span>' +
      '<span class="wt-what">' + esc(w.what) + '</span><span class="wt-cust">' + esc(w.j.customer || '—') + ' · ' + esc(nice(w.j.route)) + '</span></button>';
    const many = (g, more) => '<div class="wt li is-multi910' + (more ? ' is-more' : '') + '">' +   // several: the job opens the job, each task its card
      '<button type="button" class="wt-head910" data-job="' + esc(g.j.jobNo) + '"><span class="wt-top"><span class="wt-job">' + changedDot(g.j) + esc(g.j.jobNo) + ownTag98(g.j) + '</span><span class="wt-n910">' + g.tasks.length + ' TO DO</span></span>' +
        '<span class="wt-cust">' + esc(g.j.customer || '—') + ' · ' + esc(nice(g.j.route)) + '</span></button>' +
      '<span class="wt-tasks910">' + g.tasks.map((w) => '<button type="button" class="wt-t910" ' + wtAttr99(w) + '><span class="wt-what">' + esc(w.what) + '</span>' + wtChip910(w) + '</button>').join('') + '</span></div>';
    const G = watchJobs910(m.watch);
    let n = 0;
    const body = watchGroups910(today0()).map(([id, label, f]) => {
      const L = G.filter((g) => f(g.lead)).slice(0, LIST_MAX); if (!L.length) return '';
      const head = '<div class="wt-gh is-' + id + (n >= 6 ? ' is-more' : '') + '">' + label + '<b>' + L.reduce((a, g) => a + g.tasks.length, 0) + '</b></div>';   // the group counts its tasks
      return head + L.map((g) => (g.tasks.length > 1 ? many(g, n++ >= 6) : item(g.lead, n++ >= 6))).join('');
    }).join('');
    return '<section class="tile tile-ink t-watch' + anim + '" style="--d:250ms" aria-labelledby="watchTitle">' +
      '<div class="tile-head"><h2 class="tile-title" id="watchTitle">TODAY’S WATCH</h2><span class="watch-sub">' + (m.watch.length ? m.watch.length + ' to do' : 'All clear') + '</span></div>' +
      '<div class="tile-body">' + (body || empty('check', 'Nothing due in the next 3 days.')) + '</div>' + (G.length > 6 ? seeAll('watch', m.watch.length, true) : '') + '</section>';
  }
  // the side panel: the same rows (white), grouped as on Home
  function watchPanel910(m, t0, row, main) {
    const tone = (w) => (w.level === 'urgent' ? 'red' : 'amber');
    const one = (w) => row(w.j, '<span class="dr-next"><span class="dr-what">' + esc(w.say) + '</span></span>', '<span class="dr-side is-' + tone(w) + '"><b>' + esc(w.when) + '</b></span>', wtAttr99(w));
    const many = (g) => '<div class="dr-row is-multi910"><button type="button" class="dr-head910" data-job="' + esc(g.j.jobNo) + '">' + main(g.j, '') +
        '<span class="dr-side is-' + tone(g.lead) + '"><span class="dr-k">TO DO</span><b>' + g.tasks.length + ' tasks</b></span></button>' +
      '<div class="dr-tasks910">' + g.tasks.map((w) => '<button type="button" class="dr-t910" ' + wtAttr99(w) + '><span class="dr-what">' + esc(w.say) + '</span><span class="dr-when910 is-' + tone(w) + '">' + esc(w.when) + '</span></button>').join('') + '</div></div>';
    const G = watchJobs910(m.watch);
    return watchGroups910(t0).map(([id, label, f, tn]) => {
      const L = G.filter((g) => f(g.lead)); if (!L.length) return '';
      return '<div class="dr-gh' + (tn ? ' is-' + tn : '') + '"><span>' + label + '</span><b>' + L.reduce((a, g) => a + g.tasks.length, 0) + '</b></div>' + L.map((g) => (g.tasks.length > 1 ? many(g) : one(g.lead))).join('');
    }).join('');
  }

  // ---------- Follow-ups: a remark on its own ----------
  // A row of state.follow.checks is [time, user, remark] for a check, [time, user, remark, 'R'] for a remark on its own.
  // Checks decide checked / due / the calendar; remarks of both kinds show on the row and in the remark card.
  const isNote910 = (c) => !!c && c[3] === 'R';
  function rowsFor910(j) { return state.follow.checks[keyOf(j)] || []; }
  function checksFor(j) { return rowsFor910(j).filter((c) => !isNote910(c)); }
  function followState(j, t0) {
    const every = planFor(j), checks = checksFor(j), last = checks[0] || null;
    const f = followState93(j, t0, every, checks, last);   // v2.9.3
    f.all = rowsFor910(j);
    return f;
  }
  function remarksToday(f, t0) { return (f.all || f.checks).filter((c) => c[2] && days(dayOf(c[0]), t0) === 0); }
  // The remarks of the newest day there is one: the day of the last check, or a later day with a remark on its own.
  function lastRemark(f) {
    const all = f.all || f.checks;
    let d0 = f.last ? +dayOf(f.last[0]) : null;
    all.forEach((c) => { if (isNote910(c) && c[2]) { const d = +dayOf(c[0]); if (d0 === null || d > d0) d0 = d; } });
    if (d0 === null) return null;
    const list = all.filter((c) => c[2] && +dayOf(c[0]) === d0).sort((a, b) => b[0] - a[0]);
    return list.length ? { text: list[0][2], n: list.length } : null;
  }
  async function followNote910(no, text) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;
    const K = keyOf(j);
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    const entry = [Date.now(), state.user, text, 'R'];
    state.follow.checks[K] = [entry].concat(state.follow.checks[K] || []);
    rerender(); refreshOverlay(); updateNav();
    setSaving(1);
    try {
      const res = await api.call('ethixFollowNote', [j.jobNo, text]);
      if (!res || !res.ok) throw new Error((res && res.error) || 'Not saved.');
      if (res.t) entry[0] = res.t;
      toast('Remark added', { action: { label: 'Undo', fn: () => rmkSave99(j.jobNo, entry[0], '') } });
    } catch (e) {
      state.follow.checks[K] = (state.follow.checks[K] || []).filter((c) => c !== entry);
      rerender(); refreshOverlay(); updateNav();
      if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Remarks without a check need the v2.9.10 Code.gs update.' : 'Not saved: ' + e.message, { error: true });
    } finally { setSaving(-1); }
  }
  function rmkAll99(j) {   // every remark known here, newest first (the last 35 days, and older ones once loaded) — checks' and on their own
    const K = keyOf(j), seen = new Set(), out = [];
    rowsFor910(j).concat(state.followHist[K] || []).forEach((c) => { const k = c[0] + '|' + c[1]; if (!c[2] || seen.has(k)) return; seen.add(k); out.push(c); });
    return out.sort((a, b) => b[0] - a[0]);
  }
  const rmkCard99 = (no) => () => {   // v2.9.10: adding a remark never checks the job
    const j = findJob(no); if (!j) return '';
    const t0 = today0(), f = followState(j, t0), R = state.rmk99 && state.rmk99.no === j.jobNo ? state.rmk99 : {};
    const can = canEditJob(j) && j.active;
    const all = rmkAll99(j), list = all.slice(0, R.more ? 30 : 8);
    let day = '', html = '';
    list.forEach((c) => {
      const dl = rmkDay99(c[0], t0), mine = c[1] === state.user && canEditJob(j);
      if (dl !== day) { day = dl; html += '<div class="rk-day">' + dl + '</div>'; }
      const ed = R.edit === c[0] && mine;
      html += '<div class="rk-item' + (ed ? ' is-edit' : '') + '"><div class="rk-top"><span class="rk-when"><b>' + hm(c[0]) + '</b> · ' + esc(c[1] === state.user ? 'You' : nice(c[1])) + '</span>' +
        (mine && !ed ? '<button type="button" class="rk-edit" data-rmk-edit="' + c[0] + '">' + icon('edit', 13) + 'Edit</button>' : '') + '</div>' +
        (ed ? '<form class="rk-form" data-rmk-save="' + c[0] + '" data-no="' + esc(j.jobNo) + '"><textarea id="rmkEdit99" maxlength="200" rows="3" aria-label="Edit the remark">' + esc(c[2]) + '</textarea>' +
          '<div class="rk-acts"><button type="button" class="btn-ghost" data-rmk-cancel>Cancel</button><button type="submit" class="btn-brutal" data-primary>SAVE</button></div>' +
          '<div class="pop-hint">Clear the text and save to remove this remark.</div></form>' : '<p class="rk-text">' + esc(c[2]) + '</p>') + '</div>';
    });
    const add = !can ? '' : R.add ? '<form class="pop-form rk-addf" data-remark="' + esc(j.jobNo) + '"><label class="pop-label" for="remarkInput">Add a remark</label><input type="text" id="remarkInput" maxlength="200" value="" placeholder="Type a remark" autocomplete="off">' +
        '<button type="submit" class="btn-brutal pop-main" data-primary>ADD REMARK</button></form>'
      : '<button type="button" class="btn-ghost pop-wide rk-add" data-rmk-add="' + esc(j.jobNo) + '">' + icon('remark', 16) + 'Add remark</button>';
    return '<div class="pop-title">' + (f.mineToday ? 'Checked today ' + hm(f.mineToday[0]) : 'Remarks') + '</div><p class="pop-text">' + esc(j.jobNo) + ' · ' + esc(j.customer || '') + '</p>' + waitBlock911(j, can) +
      (html ? '<div class="rk-list">' + html + '</div>' : '<p class="pop-text rk-none">No follow-up remarks yet.</p>') +
      (all.length > list.length ? '<button type="button" class="link-btn quiet rk-more" data-rmk-more>Show older remarks</button>' : '') + add +
      (can && f.mineToday ? '<button type="button" class="link-btn quiet rk-undo" data-undo-check="' + esc(j.jobNo) + '">Undo today’s check</button>' : '');
  };
  const undoCard99 = (no) => () => {   // tapping a checked circle: the check, and Undo (your remarks stay — v2.9.10)
    const j = findJob(no); if (!j) return '';
    const f = followState(j, today0()), mine = f.mineToday;
    if (!mine) return '<p class="pop-text">Not checked today.</p>';
    return '<div class="pop-title">Checked today ' + hm(mine[0]) + '</div><p class="pop-text">' + esc(j.jobNo) + ' · ' + esc(j.customer || '') + '</p>' +
      '<button type="button" class="btn-ghost pop-wide" data-undo-check="' + esc(j.jobNo) + '">Undo today’s check</button>' +
      '<button type="button" class="btn-ghost pop-wide rk-add" data-rmk-open="' + esc(j.jobNo) + '">' + icon('remark', 16) + 'Remarks</button>';
  };
  // edit (or clear) one of your own remarks — any day. Cleared: a remark on its own goes; a check's remark goes and the check
  // stays, unless you have another check that day on that job (then the line goes) — as the server does.
  async function rmkSave99(no, t, text) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;
    const K = keyOf(j); t = +t; text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const lists = [state.follow.checks[K], state.followHist[K]].filter(Array.isArray);
    const before = lists.map((L) => L.map((c) => c.slice()));
    const hit = lists.map((L) => L.find((c) => c[0] === t && c[1] === state.user)).find(Boolean);
    if (!hit) { toast('That remark is not there any more. Refresh and try again.', { error: true }); return; }
    if ((hit[2] || '') === text) { if (state.rmk99) state.rmk99.edit = null; rmkRedraw99(); return; }
    const sameDay = (c) => c[0] !== t && !isNote910(c) && c[1] === state.user && +dayOf(c[0]) === +dayOf(t);
    const drop = !text && (isNote910(hit) || lists.some((L) => L.some(sameDay)));
    lists.forEach((L) => { const i = L.findIndex((c) => c[0] === t && c[1] === state.user); if (i < 0) return; if (drop) L.splice(i, 1); else L[i][2] = text; });
    if (state.rmk99) state.rmk99.edit = null;
    rerender(); refreshOverlay(); updateNav();
    setSaving(1);
    try {
      const res = await api.call('ethixFollowRemark', [j.jobNo, t, text]);
      if (!res || !res.ok) throw new Error((res && res.error) || 'Not saved.');
      toast(text ? 'Remark updated' : 'Remark removed');
    } catch (e) {
      lists.forEach((L, i) => { L.length = 0; before[i].forEach((c) => L.push(c)); });
      rerender(); refreshOverlay();
      if (e.kind !== 'auth') toast(/not available/i.test(e.message) ? 'Editing remarks needs the v2.9.9 Code.gs update.' : e.message, { error: true });
    } finally { setSaving(-1); }
  }

  // ---------- a customer's active jobs: tap the customer's name on the job page (and the costing page) ----------
  const custKey910 = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
  function custJobs910(j) { const k = custKey910(j && j.customer); return k ? state.jobs.filter((x) => x.active && custKey910(x.customer) === k) : []; }
  // custBtn910 — v2.9.11 version further down (+ the customer briefing)
  const custCard910 = (no) => () => {
    const j = findJob(no); if (!j) return '';
    const t0 = today0(), L = custJobs910(j);
    const mine = (x) => !canEdit() || x.cs === state.user || covered98(x);
    const stage = (x) => (x.mode === 'misc' ? 'nodate' : stageOf91(x, t0));
    const rank = { before: 0, sea: 1, arrived: 2, nodate: 3 };
    const tm = (x) => { const s = stage(x), d = s === 'before' ? x.etd : s === 'nodate' ? null : x.eta; return d ? (s === 'arrived' ? -d : +d) : 9e15; };
    const sort = (a, b) => rank[stage(a)] - rank[stage(b)] || tm(a) - tm(b) || String(a.jobNo).localeCompare(String(b.jobNo));
    const day = (d) => d.getDate() + ' ' + MON_UP[d.getMonth()];
    const when = (x) => { const s = stage(x); return s === 'before' ? (x.etd ? (x.mode === 'courier' ? 'PICK-UP ' : 'ETD ') + day(x.etd) : 'ETD TO CONFIRM') : s === 'sea' ? 'ETA ' + day(x.eta) : s === 'arrived' ? 'ARRIVED ' + day(x.eta) : x.mode === 'misc' ? 'COSTING ONLY' : 'DATES TO CONFIRM'; };
    const item = (x) => '<button type="button" class="cj910' + (x === j ? ' is-here' : '') + '" data-cust-open910="' + esc(x.jobNo) + '"' + (x === j ? ' aria-current="page"' : '') + '>' +
      '<span class="cj-top910"><span class="cj-no910">' + changedDot(x) + esc(x.jobNo) + '<span class="badge">' + esc(x.type) + '</span>' + (x === j ? '<span class="cj-here910">THIS JOB</span>' : '') +
        (canEdit() && x.cs && x.cs !== state.user ? '<span class="own-tag">' + esc(x.cs) + '</span>' : '') + '</span><span class="cj-when910">' + esc(when(x)) + '</span></span>' +
      '<span class="cj-route910">' + esc(x.mode === 'misc' ? (x.against ? 'AGAINST ' + x.against : 'COSTING ONLY') : x.route) + '</span>' +
      '<span class="cj-next910">' + toneChip(rowNext(x)) + '</span></button>';
    const yours = L.filter(mine).sort(sort), others = L.filter((x) => !mine(x)).sort(sort);
    const head = (label, n) => '<div class="cj-gh910">' + label + '<b>' + n + '</b></div>';
    const sub = L.length ? L.length + (L.length === 1 ? ' active job' : ' active jobs') + (canEdit() && others.length ? ' · ' + yours.length + ' yours' : '') : 'No active jobs';
    return '<div class="pop-title cj-title910">' + esc(j.customer) + '</div><p class="pop-text">' + esc(sub) + '</p>' +
      (L.length ? '<div class="cj-list910">' + (canEdit() && others.length ? (yours.length ? head('YOURS', yours.length) + yours.map(item).join('') : '') + head('WITH COLLEAGUES', others.length) + others.map(item).join('')
        : yours.concat(others).map(item).join('')) + '</div>' : '');
  };

  function initV2910() {
    const custOpen = (c) => !!(c && state.overlay === 'pop' && state.cust910 && popRender === state.cust910.render && state.cust910.no === c.dataset.cust910);
    // the card closes on any tap outside it (before the click) — remember it was open, so tapping the name again closes it
    window.addEventListener('pointerdown', (e) => { state.custWas910 = custOpen(e.target.closest && e.target.closest('[data-cust910]')); }, true);
    document.addEventListener('click', (e) => {
      const c = e.target.closest('[data-cust910]');
      if (c) {
        e.preventDefault(); e.stopPropagation();
        if (state.custWas910) { state.custWas910 = false; if (custOpen(c)) closeOverlays(); return; }   // tapped again: it closes
        if (custOpen(c)) { closeOverlays(); return; }   // (the keyboard)
        const render = custCard910(c.dataset.cust910);
        openPop(c, 'CUSTOMER', render);
        state.cust910 = { no: c.dataset.cust910, render };
        return;
      }
      const o = e.target.closest('[data-cust-open910]');
      if (o) {
        e.preventDefault(); e.stopPropagation();
        const no = o.dataset.custOpen910, here = state.route && state.route.name === 'job' && String(state.route.jobNo).toUpperCase() === no.toUpperCase();
        closeOverlays(true);
        if (!here) openJob(no);
      }
    }, true);
  }

  // ==================================================================== v2.9.11
  // Amal's next list (agreed 4 Nov 2026, "chambikko" 5 Nov):
  //  1–2 the customer briefing beside the customer's name on the job page, with WhatsApp contacts
  //  3   line free time learnt from earlier jobs (same customer + line, else the line's usual) — filled in, always editable
  //  4   search: MENTIONED IN REMARKS AND NOTES (the job's remarks, notes, follow-up remarks)
  //  5   public holidays: port clocks and Home office hours know them, OFF TODAY / TOMORROW / DAY AFTER under the port times
  //      on Follow-ups, and a UAE holiday counts like the Friday weekend ("TODAY + NATIONAL DAY")
  //  6   leave hand-over: a page (from Cover) and a Word file in the style of the Active jobs list
  //  7   a job is changed by its Customer Service owner — and the colleague covering them on those days
  //  8   "waiting on" on Follow-ups: the tag on the row, the choice in the remark card, the filter in the dark tile
  I.brief911 = '<rect x="5" y="4" width="14" height="17" rx="3"/><path d="M9.5 4v2.5h5V4"/><path d="M8.5 11h7M8.5 15h5"/>';
  I.wa911 = '<path d="M20 11.6a8.4 8.4 0 0 1-12.4 7.4L3.5 20.3l1.3-4A8.4 8.4 0 1 1 20 11.6z"/><path d="M9 9.2c.2 2.3 2.4 4.6 4.8 4.9l1.1-1.2 1.6.9"/>';
  I.hourglass911 = '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M5 2h14v2.2h-1.6v2.3c0 2.3-1.7 4-3.7 5.5 2 1.5 3.7 3.2 3.7 5.5v2.3H19V22H5v-2.2h1.6v-2.3c0-2.3 1.7-4 3.7-5.5-2-1.5-3.7-3.2-3.7-5.5V4.2H5V2zm3.8 2.2v2.3c0 1.3 1.1 2.6 3.2 4.1 2.1-1.5 3.2-2.8 3.2-4.1V4.2H8.8zM12 13.4c-2.1 1.5-3.2 2.8-3.2 4.1v2.3h6.4v-2.3c0-1.3-1.1-2.6-3.2-4.1z"/><path fill="currentColor" stroke="none" d="M9.6 19.8h4.8v-1.3c0-.8-.8-1.7-2.4-2.9-1.6 1.2-2.4 2.1-2.4 2.9z"/>';
  I.off911 = '<rect x="4" y="5.5" width="16" height="14" rx="3"/><path d="M4 10h16M9 13.5l6 4.5M15 13.5l-6 4.5"/>';
  I.handover911 = '<rect x="3.5" y="3.5" width="12" height="17" rx="2.5"/><path d="M7 8.5h5M7 12h4M13 16.5h7.5M17.5 13.5l3 3-3 3"/>';

  function applyBoot911(boot) {
    if (Array.isArray(boot.holidays)) { state.hol911 = boot.holidays; holIx911 = null; offMemo911.clear(); }
    if (boot.briefs && typeof boot.briefs === 'object') state.briefs911 = boot.briefs;
    if (boot.waits && typeof boot.waits === 'object') state.waits911 = boot.waits;
    if (Array.isArray(boot.waitNames)) state.waitNames911 = boot.waitNames;
    if (boot.freeMem && typeof boot.freeMem === 'object') state.freeMem911 = boot.freeMem;
  }
  const DAYS_LONG911 = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayTxt911 = (t) => { const d = dayOf(t); return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON91[d.getMonth()]; };   // a moment → "Tue 3 Nov" (Dubai)
  const isoTxt911 = (iso) => { const d = parseDate(iso); return d ? DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON91[d.getMonth()] : iso; };
  const needs911 = (e, what) => (/not available|unknown/i.test((e && e.message) || '') ? what + ' needs the v2.9.11 Code.gs update.' : (e && e.message) || 'Not saved.');

  // ================================================================ 7 · who changes a job
  // Its Customer Service owner, and the colleague covering them on those days. A job with no owner, or whose owner is no
  // longer a Customer Service account, is open to everyone in Customer Service (nothing is ever stuck). Anyone can still
  // read it, add notes and duplicate it. The server checks the same.
  function isCsName911(n) {
    const L = state.users || [], u = L.find((x) => String((x && x.name) || '').toUpperCase().trim() === n);
    return u ? normRole(u.role, n) === 'CS' : !L.length;
  }
  function mayEdit911(j) {
    if (!j || !canEdit()) return false;
    const o = String(j.cs || '').toUpperCase().trim();
    return !o || o === state.user || covOwners98().has(o) || !isCsName911(o);
  }
  function viewOnly911(j) {
    const o = nice(j.cs);
    return '<div class="vh-actions is-ro is-view911"><span class="ro-chip" title="' + esc('Only ' + o + ' — or the colleague covering ' + o + ' — changes this job. You can add notes.') + '">' + icon('lock', 14) + '<span>' + esc(j.cs) + '’S JOB · VIEW ONLY</span></span>' +
      '<button type="button" class="btn-ghost" data-act="duplicate" title="Duplicate job" aria-label="Duplicate job">' + icon('copy', 16) + '<span>Duplicate</span></button>' +
      '<button type="button" class="btn-brutal btn-icon" data-act="focus-note">' + icon('note', 16) + '<span>ADD A NOTE</span></button></div>';
  }

  // ================================================================ 1–2 · the customer briefing
  const briefKey911 = (c) => String(c || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const briefOf911 = (c) => (state.briefs911 || {})[briefKey911(c)] || null;
  const canBrief911 = (j) => !!j && !!briefKey911(j.customer) && (canEdit() || (isSales() && j.sales === state.user));
  const waDigits911 = (p) => { let d = String(p || '').replace(/[^\d+]/g, ''); if (d.startsWith('00')) d = d.slice(2); d = d.replace(/\+/g, ''); return d.length >= 7 && d.length <= 15 ? d : ''; };
  function briefBtn911(j) {
    if (!briefKey911(j.customer)) return '';
    const b = briefOf911(j.customer);
    return '<button type="button" class="brief911' + (b ? ' has' : '') + '" data-brief911="' + esc(j.jobNo) + '" aria-haspopup="dialog" aria-label="' + esc(b ? 'Customer briefing' : 'Customer briefing — none yet') + '" title="Customer briefing">' + icon('brief911', 15) + '</button>';
  }
  function custBtn910(j) {   // the name opens the customer's active jobs (v2.9.10); v2.9.11: + the briefing beside it, on the job page
    if (!custKey910(j.customer)) return '<div class="vh-cust">—</div>';
    const n = custJobs910(j).length, show = n > 1 || (n === 1 && !j.active);
    const brief = state.route && state.route.name === 'job' ? briefBtn911(j) : '';
    return '<div class="vh-cust' + (brief ? ' has-brief911' : '') + '"><button type="button" class="cust910" data-cust910="' + esc(j.jobNo) + '" aria-haspopup="dialog" aria-label="' + esc('Active jobs for ' + j.customer) + '">' +
      '<span class="cust-name910">' + esc(j.customer) + '</span>' + (show ? '<span class="cust-n910">' + n + (n === 1 ? ' ACTIVE JOB' : ' ACTIVE JOBS') + icon('chevron', 12) + '</span>' : '') + '</button>' + brief + '</div>';
  }
  function contactRow911(c) {
    const d = waDigits911(c[2]);
    return '<div class="bf-ct911"><span class="bf-who911"><b>' + esc(c[0] || 'Contact') + (c[1] ? '<i> · ' + esc(c[1]) + '</i>' : '') + '</b><span>' + esc(c[2]) + '</span></span>' +
      (d ? '<a class="bf-wa911" href="https://wa.me/' + d + '" target="_blank" rel="noopener" aria-label="' + esc('WhatsApp ' + (c[0] || c[2])) + '">' + icon('wa911', 15) + 'WhatsApp</a>' : '') + '</div>';
  }
  function briefBody911(b) {
    return (b.req.length ? '<div class="bf-k911">REQUIREMENTS</div><ul class="bf-list911">' + b.req.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul>' : '') +
      (b.ct.length ? '<div class="bf-k911">CONTACTS</div><div class="bf-cts911">' + b.ct.map(contactRow911).join('') + '</div>' : '');
  }
  const briefCard911 = (no) => () => {
    const j = findJob(no); if (!j) return '';
    const b = briefOf911(j.customer), can = canBrief911(j);
    const edit = can ? '<button type="button" class="bf-edit911" data-brief-edit911="' + esc(j.jobNo) + '">' + icon('edit', 13) + (b ? 'Edit' : 'Add briefing') + '</button>' : '';
    return '<div class="pop-title bf-name911">' + esc(j.customer) + '</div>' +
      (b ? briefBody911(b) + '<div class="bf-foot911"><span>Edited by ' + esc(b.by === state.user ? 'you' : nice(b.by)) + (b.at ? ' · ' + esc(dayTxt911(b.at)) : '') + '</span>' + edit + '</div>'
        : '<p class="pop-text bf-none911">No briefing yet' + (can ? ' — what should a colleague know about this customer?' : '.') + '</p>' + (edit ? '<div class="bf-foot911"><span></span>' + edit + '</div>' : ''));
  };
  const bfOpen911 = () => !!(state.overlay === 'pop' && state.brief911 && popRender === state.brief911.render);
  function openBrief911(btn, pinned) {
    const render = briefCard911(btn.dataset.brief911);
    keepFocus911(() => openPop(btn, 'CUSTOMER BRIEFING', render), pinned);
    state.brief911 = { no: btn.dataset.brief911, render, pinned: !!pinned };
  }
  // a card opened by pointing at something must not take the keyboard from where you are typing
  function keepFocus911(open, pinned) {
    const had = document.activeElement;
    open();
    if (!pinned && had && had !== document.body && document.body.contains(had)) had.focus({ preventScroll: true });
  }
  // the form (side panel): requirements one per line, up to six contacts
  function briefEdit911(no) {
    const j = findJob(no); if (!j || !canBrief911(j)) return;
    const b = briefOf911(j.customer) || { req: [], ct: [] };
    state.bfForm911 = { no: j.jobNo, cust: j.customer, req: b.req.join('\n'), ct: b.ct.length ? b.ct.map((c) => c.slice()) : [['', '', '']] };
    closeOverlays(true);
    $('#drawerKicker').textContent = 'CUSTOMER BRIEFING';
    popRender = briefForm911;
    $('#drawerBody').innerHTML = briefForm911();
    showDrawer(document.activeElement);
    state.overlay = 'sheet';
    const t = $('#bfReq911'); if (t) t.focus({ preventScroll: true });
  }
  function briefForm911() {
    const F = state.bfForm911; if (!F) return '';
    const row = (c, i) => '<div class="bf-row911">' +
      '<div class="field"><label for="bfN' + i + '">Name</label><input id="bfN' + i + '" maxlength="40" value="' + esc(c[0]) + '" placeholder="Contact name" autocomplete="off"></div>' +
      '<div class="field"><label for="bfR' + i + '">Role</label><input id="bfR' + i + '" maxlength="30" value="' + esc(c[1]) + '" placeholder="Their role" autocomplete="off"></div>' +
      '<div class="field bf-ph911"><label for="bfP' + i + '">WhatsApp number</label><input id="bfP' + i + '" maxlength="24" inputmode="tel" value="' + esc(c[2]) + '" placeholder="Number with country code" autocomplete="off"></div>' +
      '<button type="button" class="icon-btn bf-rm911" data-bf-rm911="' + i + '" aria-label="Remove this contact">' + icon('close', 14) + '</button></div>';
    return '<h2 class="peek-job form-title" id="drawerTitle">' + esc(F.cust) + '</h2>' +
      '<form class="job-form bf-form911" id="briefForm911" novalidate>' +
        '<fieldset><legend>REQUIREMENTS</legend><div class="field is-wide"><label for="bfReq911">What a colleague should know — one per line</label><textarea id="bfReq911" rows="6" maxlength="1800" placeholder="One requirement per line">' + esc(F.req) + '</textarea></div></fieldset>' +
        '<fieldset><legend>CONTACTS</legend><div class="bf-rows911">' + F.ct.map(row).join('') + '</div>' +
          (F.ct.length < 6 ? '<button type="button" class="link-btn bf-addct911" data-bf-addct911>' + icon('plus', 14) + 'Add a contact</button>' : '') + '</fieldset>' +
        '<p class="pop-hint">Shows beside ' + esc(F.cust) + ' on the job page, for everyone in Customer Service' + (isSales() ? ' and you' : ' and the sales person') + '. WhatsApp opens a chat with that number — EWS sends nothing.</p>' +
        '<div class="form-error" id="formError" role="alert"></div>' +
        '<div class="form-actions"><button type="button" class="btn-ghost" data-act="form-cancel">Cancel</button><button type="submit" class="btn-brutal" id="formSubmit">SAVE BRIEFING</button></div></form>';
  }
  function briefRedraw911() { const b = $('#drawerBody'); if (!b || !state.bfForm911) return; const y = b.scrollTop; b.innerHTML = briefForm911(); b.scrollTop = y; }
  function briefCollect911() {
    const F = state.bfForm911; if (!F) return null;
    const v = (id) => (($('#' + id) || {}).value || '');
    F.req = v('bfReq911');
    F.ct = F.ct.map((c, i) => [v('bfN' + i), v('bfR' + i), v('bfP' + i)]);
    return F;
  }
  async function briefSave911() {
    const F = briefCollect911(); if (!F) return;
    const err = $('#formError'), btn = $('#formSubmit');
    const req = F.req.split(/\r?\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const ct = F.ct.map((c) => ({ name: c[0].trim(), role: c[1].trim(), phone: c[2].trim() })).filter((c) => c.name || c.phone);
    const bad = ct.find((c) => !waDigits911(c.phone));
    if (bad) { if (err) err.textContent = bad.phone ? 'Check the number for ' + (bad.name || 'the contact') + ' — the full number with the country code.' : 'Add the number for ' + (bad.name || 'the contact') + '.'; return; }
    if (err) err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING…'; }
    setSaving(1);
    try {
      const res = await api.call('ethixBriefSave', [F.cust, { req, ct }]);
      if (!res || !res.ok) throw new Error((res && res.error) || 'Not saved.');
      state.briefs911 = state.briefs911 || {};
      if (res.brief) state.briefs911[res.key || briefKey911(F.cust)] = res.brief; else delete state.briefs911[res.key || briefKey911(F.cust)];
      state.bfForm911 = null;
      closeOverlays(); rerender();
      toast(res.brief ? 'Briefing saved · ' + F.cust : 'Briefing cleared · ' + F.cust);
    } catch (e) {
      if (e.kind === 'auth') return;
      if (err) err.textContent = needs911(e, 'The briefing');
      if (btn) { btn.disabled = false; btn.textContent = 'SAVE BRIEFING'; }
    } finally { setSaving(-1); }
  }

  // ================================================================ 3 · line free time learnt from earlier jobs
  // New job: filled in (and said where it came from) — change it if this one differs. Edit details, field empty: offered.
  function freeSuggest911(type, cust, line, skipNo) {
    if (!['SFIF', 'SFIL', 'CND'].includes(type)) return null;
    const L = upq(line), C = upq(cust); if (!L) return null;
    let best = null;
    if (C) state.jobs.forEach((j) => {
      if (j.jobNo === skipNo || upq(j.vendor) !== L || upq(j.customer) !== C || !/^\d{1,3}$/.test(String(j.lineFreeRaw || ''))) return;
      const t = +(j.opened || j.eta || 0);
      if (!best || t >= best.t) best = { d: +j.lineFreeRaw, no: j.jobNo, t };
    });
    const ln = L;   // line names stay as the tracker has them (MSC, HAPAG LLOYD)
    if (best && best.d > 0) return { d: best.d, why: 'from this customer’s last ' + ln + ' job · ' + best.no };
    const M = state.freeMem911 || {}, p = C && M.pairs && M.pairs[L + '|' + C];
    if (p && p[0] > 0) return { d: p[0], why: 'from this customer’s last ' + ln + ' job' + (p[1] ? ' · ' + p[1] : '') };
    const u = M.lines && M.lines[L];
    if (u && u[0] > 0) return { d: u[0], why: ln + '’s usual · ' + u[1] + ' of ' + u[2] + (u[2] === 1 ? ' job' : ' jobs') };
    return null;
  }
  function freeRun911() {
    const f = $('#jobForm') || $('#editForm'), inp = f && f.querySelector('[name="lineFree"]'), hint = $('#ftHint911');
    if (!inp || !hint) return;
    const isNew = f.id === 'jobForm', val = (n) => ((f.querySelector('[name="' + n + '"]') || {}).value || '');
    const type = val('type') || (isNew ? state.newJob && state.newJob.type : (findJob(state.editing && state.editing.no) || {}).type) || '';
    const sug = freeSuggest911(type, val('customer'), val('vendor'), isNew ? '' : state.editing && state.editing.no);
    if (isNew) {
      const auto = inp.dataset.auto911 === '1';
      if (!inp.value || auto) { if (sug) { inp.value = sug.d; inp.dataset.auto911 = '1'; } else if (auto) { inp.value = ''; inp.dataset.auto911 = ''; } }
      hint.innerHTML = inp.dataset.auto911 === '1' && sug ? '<span>' + esc(sug.why.charAt(0).toUpperCase() + sug.why.slice(1)) + '</span>' : '';
    } else {
      hint.innerHTML = !String(inp.value).trim() && sug ? '<button type="button" class="ft-use911" data-ft-use911="' + sug.d + '">Use ' + sug.d + ' days</button><span>' + esc(sug.why) + '</span>' : '';
    }
  }
  function freeWire911() {
    const f = $('#jobForm') || $('#editForm'), inp = f && f.querySelector('[name="lineFree"]');
    if (!inp || inp.dataset.w911) return;
    inp.dataset.w911 = '1';
    const field = inp.closest('.field'); if (!field) return;
    field.insertAdjacentHTML('beforeend', '<div class="ft-hint911" id="ftHint911" aria-live="polite"></div>');
    freeRun911();
  }

  // ================================================================ 4 · search: words in remarks, notes and follow-up remarks
  let srchT911 = 0;
  function runSearch(q) {   // v2.9.11: + MENTIONED IN REMARKS AND NOTES under the jobs
    const box = $('#searchResults'); if (!box) return;
    q = q.trim().toUpperCase();
    if (!q) { box.hidden = true; return; }
    const blHit = (j) => blList98(j.blNo).find((x) => x.includes(q)) || '';   // v2.9.8: BL / AWB numbers are searched too
    const hits = state.jobs.filter((j) => (j.jobNo + ' ' + j.customer + ' ' + j.pol + ' ' + j.pod + ' ' + j.cs + ' ' + j.sales + ' ' + j.type + ' ' + j.blNo).toUpperCase().includes(q))
      .sort((a, b) => (b.active - a.active) || (canEdit() ? (b.cs === state.user) - (a.cs === state.user) : 0) || ((b.jobNo.toUpperCase().startsWith(q) ? 1 : 0) - (a.jobNo.toUpperCase().startsWith(q) ? 1 : 0)))
      .slice(0, 8);
    searchIndex = -1;
    const jobs = hits.map((j) =>
      '<button type="button" class="result" data-job="' + esc(j.jobNo) + '"><span class="result-job">' + esc(j.jobNo) + '</span><span class="result-cust">' + esc(j.customer || '—') + '</span><span class="result-route">' + (blHit(j) && !(j.jobNo + ' ' + j.customer).toUpperCase().includes(q) ? esc(blWord98(j) + ' ' + blHit(j)) + ' · ' : '') + esc(j.route) + ' · ' + esc(j.type) + (j.active ? '' : ' · ' + esc(j.status)) + (canEdit() && j.cs !== state.user ? ' · ' + (j.cs ? 'WITH ' + esc(j.cs) : 'UNASSIGNED') : '') + '</span></button>'
    ).join('');
    state.srchQ911 = q;
    const T = q.length >= 3 ? textHits911(q) : null;
    const group = T && (T.list.length || T.loading) ? textGroup911(q, T) : '';
    box.innerHTML = (jobs ? (group ? '<div class="sr-k911 is-jobs">JOBS</div>' : '') + jobs : group ? '' : '<div class="result-empty">No jobs match “' + esc(q) + '”.</div>') + group;
    box.hidden = false;
    if (T && T.loading) { clearTimeout(srchT911); srchT911 = setTimeout(() => textAsk911(q), 350); }
  }
  // the job's own REMARKS here and now; notes and follow-up remarks from the server (asked once per word)
  function textHits911(q) {
    const C = state.srch911 || {}, got = C[q];
    const list = state.jobs.filter((j) => j.active && String(j.remarks || '').toUpperCase().includes(q)).slice(0, 8).map((j) => ({ no: j.jobNo, kind: 'remarks', text: String(j.remarks), t: 0 }));
    (got || []).forEach((h) => { if (findJob(h.no)) list.push(h); });
    return { list, loading: !got };
  }
  function snippet911(text, q) {
    const T = String(text).replace(/\s+/g, ' ').trim(), i = T.toUpperCase().indexOf(q);
    if (i < 0) return esc(T.slice(0, 90)) + (T.length > 90 ? '…' : '');
    const a = Math.max(0, i - 34), b = Math.min(T.length, i + q.length + 56);
    return (a ? '…' : '') + esc(T.slice(a, i)) + '<mark>' + esc(T.slice(i, i + q.length)) + '</mark>' + esc(T.slice(i + q.length, b)) + (b < T.length ? '…' : '');
  }
  function textGroup911(q, T) {
    const src = (h) => (h.kind === 'remarks' ? 'REMARKS' : (h.kind === 'note' ? 'NOTE' : 'FOLLOW-UP') + (h.by ? ' · ' + esc(h.by) : '') + (h.t ? ' · ' + esc(dayTxt911(h.t).toUpperCase().replace(/^\w+ /, '')) : ''));
    return '<div class="sr-group911" role="group" aria-label="Mentioned in remarks and notes"><div class="sr-k911">MENTIONED IN REMARKS AND NOTES' + (T.loading ? '<span class="sr-wait911"><i></i>Looking in notes…</span>' : '') + '</div>' +
      T.list.slice(0, 10).map((h) => { const j = findJob(h.no) || { customer: '' };
        return '<button type="button" class="result is-text911" data-job="' + esc(h.no) + '"' + (h.kind === 'note' ? ' data-tab911="notes"' : '') + '><span class="result-job">' + esc(h.no) + '</span><span class="result-cust">' + esc(j.customer || '—') + '</span>' +
          '<span class="sr-line911"><b>' + src(h) + '</b><span>' + snippet911(h.text, q) + '</span></span></button>'; }).join('') + '</div>';
  }
  async function textAsk911(q) {
    state.srch911 = state.srch911 || {};
    if (state.srch911[q]) return;
    let hits = [];
    try { const res = await api.call('ethixSearchText', [q]); hits = (res && Array.isArray(res.hits)) ? res.hits : []; } catch (e) { hits = []; }
    const keys = Object.keys(state.srch911); if (keys.length > 30) delete state.srch911[keys[0]];
    state.srch911[q] = hits;
    const inp = $('#searchInput'), box = $('#searchResults');
    if (inp && box && !box.hidden && inp.value.trim().toUpperCase() === q) runSearch(inp.value);
  }

  // ================================================================ 5 · public holidays
  let holIx911 = null;
  const holC911 = {};
  function holIndex911() {
    if (holIx911) return holIx911;
    holIx911 = new Map();
    (state.hol911 || []).forEach((h) => { const k = h[1] + '|' + h[0]; if (!holIx911.has(k)) holIx911.set(k, []); holIx911.get(k).push({ name: h[2], note: h[3] || '' }); if (h[4]) holC911[h[1]] = h[4]; });
    return holIx911;
  }
  const holOn911 = (cc, iso) => (cc && iso && holIndex911().get(cc + '|' + iso)) || [];
  const isoPlus911 = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const zIsoMemo911 = new Map();
  function zoneIso911(tz, now) {   // today's date where the port is
    let f = zIsoMemo911.get(tz);
    if (f === undefined) {
      const mk = (z) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (e) { return null; } };
      f = mk(tz) || ({ 'Europe/Kyiv': 'Europe/Kiev', 'Asia/Yangon': 'Asia/Rangoon' }[tz] ? mk({ 'Europe/Kyiv': 'Europe/Kiev', 'Asia/Yangon': 'Asia/Rangoon' }[tz]) : null);
      zIsoMemo911.set(tz, f);
    }
    if (!f) return null;
    const p = {}; f.formatToParts(now || new Date()).forEach((x) => { p[x.type] = x.value; });
    return p.year && p.month && p.day ? p.year + '-' + p.month + '-' + p.day : null;
  }
  function officeState(z, now) {   // v2.9.11: a public holiday (the HOLIDAYS tab) is a day off, like the weekend
    now = now || new Date();
    const t = zoneNow(z.tz, now); if (!t) return null;
    const iso0 = zoneIso911(z.tz, now), off = WEEKEND[z.cc] || [0, 6];
    const hol = (k) => !!iso0 && holOn911(z.cc, isoPlus911(iso0, k)).length > 0;
    const work = (d, k) => !off.includes(d) && !hol(k), mins = t.h * 60 + t.m, H = hoursOf(z);
    if (work(t.dow, 0) && mins >= H[0] && mins < H[1]) return { open: true, t, toClose: H[1] - mins };
    let add, d = t.dow, k = 0;
    if (work(d, 0) && mins < H[0]) add = H[0] - mins;
    else { add = 1440 - mins; d = (d + 1) % 7; k = 1; for (let n = 0; n < 30 && !work(d, k); n++) { add += 1440; d = (d + 1) % 7; k++; } add += H[0]; }
    const h = iso0 ? holOn911(z.cc, iso0) : [];
    return { open: false, t, toOpen: add, opensDow: d, hol: h.length ? h[0].name : '' };
  }
  // Home · OVERSEAS OFFICE HOURS: Ethix closed for a UAE holiday shows beside Dubai time
  function aeHolChip911() {
    const h = holOn911('AE', isoOf(today0()));
    return h.length ? '<span class="po-hol911" title="' + esc('UAE public holiday — ' + h.map((x) => x.name).join(', ')) + '">' + icon('off911', 12) + 'CLOSED · ' + esc(h[0].name.toUpperCase()) + '</span>' : '';
  }
  // Follow-ups: OFF TODAY / OFF TOMORROW / OFF DAY AFTER under a port's time (that port's own calendar)
  function holSoon911(port) {
    const z = portZone(port); if (!z) return null;
    const iso0 = zoneIso911(z.tz); if (!iso0) return null;
    const hits = [];
    for (let n = 0; n <= 2; n++) holOn911(z.cc, isoPlus911(iso0, n)).forEach((h) => hits.push({ n, iso: isoPlus911(iso0, n), name: h.name, note: h.note }));
    return hits.length ? { port, z, hits } : null;
  }
  function holChip911(port, col) {
    const o = holSoon911(port); if (!o) return '';
    const n = o.hits[0].n;
    return '<span class="hol911' + (n === 0 ? ' is-today' : '') + '" style="grid-column:' + col + '" role="button" tabindex="0" data-hol911="' + esc(port) + '" aria-label="' + esc('Public holiday at ' + portName91(port)) + '">' + icon('off911', 10) + (n === 0 ? 'OFF TODAY' : n === 1 ? 'OFF TOMORROW' : 'OFF DAY AFTER') + '</span>';
  }
  const holCard911 = (port) => () => {
    const o = holSoon911(port); if (!o) return '<p class="pop-text">No public holiday at ' + esc(portName91(port)) + ' in the next days.</p>';
    const when = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'day after tomorrow');
    return '<div class="hp911">' + o.hits.map((h) => '<div class="hp-day911"><b>' + esc(h.name) + '</b><span>' + esc(isoTxt911(h.iso)) + ' · ' + when(h.n) + (/estimat/i.test(h.note) ? ' · date estimated' : '') + '</span></div>').join('') +
      '<div class="hp-port911">' + esc(portName91(port)) + ' office closed' + (o.hits.length === 1 && o.hits[0].n > 0 ? ' that day' : '') + '</div></div>';
  };
  const holKick911 = (port) => { const z = portZone(port); holIndex911(); return 'PUBLIC HOLIDAY' + (z && holC911[z.cc] ? ' · ' + holC911[z.cc].toUpperCase() : ''); };
  function rrRoute99(j, t0) {   // both ports' local times (v2.9.9); v2.9.11: + a public holiday at either port in the next days
    const plain = '<span class="rr-route">' + esc(j.mode === 'misc' ? 'COSTING ONLY' : j.route) + '</span>';
    if (j.mode === 'misc' || !j.pol || !j.pod) return plain;
    const lead = clockPort(j, t0);
    const tm = (port) => {
      const z = portZone(port), c = z && clockBits(z);
      if (!c) return '<span class="rt99 is-none"></span>';
      return '<span class="rt99 is-' + c.tone + (port === lead ? ' is-lead' : '') + '" data-clock="' + esc(port) + '" data-mini="1" title="' + esc(clockTitle(port, z, c)) + '"><i></i><b>' + c.time + '</b></span>';
    };
    const a = tm(j.pol), b = tm(j.pod);
    if (/is-none/.test(a) && /is-none/.test(b)) return plain;
    const ha = holChip911(j.pol, 1), hb = holChip911(j.pod, 3);
    return '<span class="rr-route r99' + (ha || hb ? ' has-hol911' : '') + '"><span class="rp-n">' + esc(j.pol) + '</span><span class="rp-ar">→</span><span class="rp-n">' + esc(j.pod) + '</span>' + a + '<span></span>' + b + ha + hb + '</span>';
  }
  // The Friday rule, wider: the days off right after a working day (Saturday, Sunday, UAE holidays) count as today's.
  const offMemo911 = new Map();
  const isOff911 = (d) => d.getDay() === 0 || d.getDay() === 6 || holOn911('AE', isoOf(d)).length > 0;
  function off911(t0) {
    t0 = t0 || today0();
    const k = isoOf(t0); if (offMemo911.has(k)) return offMemo911.get(k);
    let n = 0;
    if (!isOff911(t0)) for (let i = 1; i <= 10 && isOff911(addDays(t0, i)); i++) n++;   // a day off itself: just today
    offMemo911.set(k, n);
    return n;
  }
  function offWord911(t0) {   // WEEKEND · a holiday's name · LONG WEEKEND · HOLIDAYS
    t0 = t0 || today0();
    const n = off911(t0); if (!n) return '';
    let weekend = false; const names = [];
    for (let i = 1; i <= n; i++) { const d = addDays(t0, i); if (d.getDay() === 0 || d.getDay() === 6) weekend = true; holOn911('AE', isoOf(d)).forEach((h) => { const x = h.name.replace(/\s+holiday$/i, ''); if (!names.includes(x)) names.push(x); }); }
    if (!names.length) return 'WEEKEND';
    if (weekend) return 'LONG WEEKEND';
    return names.length === 1 && names[0].length <= 22 ? names[0].toUpperCase() : 'HOLIDAYS';
  }
  const dayLong911 = (d, t0) => DAYS_LONG911[addDays(t0 || today0(), d).getDay()];
  function fri99(t0) { return off911(t0) > 0; }   // v2.9.11: Friday — or the day before UAE holidays
  function due99(t0) { return Math.max(1, off911(t0)); }
  const dayWord99 = (d, t0) => (d === 0 ? 'today' : off911(t0) && d >= 1 && d <= off911(t0) ? dayLong911(d, t0) : d === 1 ? 'tomorrow' : 'in ' + d + ' days');
  function watchGroups910(t0) {   // the days off after today are today's (Friday: the weekend, v2.9.9 · v2.9.11: UAE holidays)
    const F = off911(t0);
    return [['over', 'OVERDUE', (w) => w.d < 0 && w.d >= -21, 'red'], ['today', F ? 'TODAY + ' + offWord911(t0) : 'TODAY', (w) => w.d >= 0 && w.d <= F, 'red'],
      ['soon', 'NEXT 3 DAYS', (w) => w.d > F, 'amber'], ['long', 'OVERDUE 3+ WEEKS', (w) => w.d < -21, '']];
  }

  // ================================================================ 8 · "waiting on" (Follow-ups)
  const WAIT_FIX911 = ['CUSTOMER', 'LINE', 'AGENT', 'CUSTOMS', 'SALES'];
  const waitOf911 = (j) => (state.waits911 || {})[keyOf(j)] || null;
  const waitDays911 = (w) => Math.max(0, days(dayOf(+w[1] || Date.now()), today0()));
  function waitTitle911(w) { const n = waitDays911(w); return 'Waiting on ' + nice(w[0]) + ' since ' + (n ? dayTxt911(w[1]) + ' (' + n + (n === 1 ? ' day' : ' days') + ')' : 'today') + ' · set by ' + (w[2] === state.user ? 'you' : nice(w[2])); }
  function waitTag911(j, ro) {
    const w = waitOf911(j); if (!w) return '';
    const n = waitDays911(w), txt = upq(w[0]) + (n ? ' · ' + n + (n === 1 ? ' DAY' : ' DAYS') : '');
    const tight = txt.length >= 18;   // a long name or many days: the hourglass alone says "waiting", so the whole text fits
    const inner = icon('hourglass911', 11) + (tight ? '<b class="sr-only">WAITING </b>' : '<b>WAITING</b>') + '<span>' + esc(txt) + '</span>';
    const cls = 'wtag911' + (tight ? ' is-tight911' : '');
    return ro ? '<span class="' + cls + '" title="' + esc(waitTitle911(w)) + '">' + inner + '</span>'
      : '<button type="button" class="' + cls + '" data-wait911="' + esc(j.jobNo) + '" title="' + esc(waitTitle911(w) + ' — tap to change') + '" aria-label="' + esc(waitTitle911(w) + '. Change') + '">' + inner + '</button>';
  }
  function waitNames911() {   // the five, then names typed by hand (everyone's), then any other name still on a job
    const out = WAIT_FIX911.slice();
    (state.waitNames911 || []).concat(Object.values(state.waits911 || {}).map((w) => w[0])).forEach((n) => { n = upq(n); if (n && !out.includes(n)) out.push(n); });
    return out;
  }
  function waitBlock911(j, can) {   // inside the remark card
    const w = waitOf911(j), adding = state.woAdd911 === j.jobNo;
    if (!can) return w ? '<div class="wo911 is-ro"><div class="wo-k911">' + icon('hourglass911', 11) + 'WAITING ON</div><div class="wo-foot911"><span>' + esc(waitTitle911(w)) + '</span></div></div>' : '';
    return '<div class="wo911" data-wo911="' + esc(j.jobNo) + '"><div class="wo-k911">' + icon('hourglass911', 11) + 'WAITING ON</div>' +
      '<div class="wo-chips911" role="group" aria-label="Waiting on">' + waitNames911().map((n) => '<button type="button" class="wo-c911' + (w && upq(w[0]) === n ? ' is-on' : '') + '" data-wo-set911="' + esc(n) + '" aria-pressed="' + !!(w && upq(w[0]) === n) + '">' + esc(nice(n)) + '</button>').join('') +
        (adding ? '' : '<button type="button" class="wo-c911 is-add" data-wo-add911>' + icon('plus', 12) + 'Add</button>') + '</div>' +
      (adding ? '<form class="wo-new911" data-wo-new911><input id="woName911" maxlength="24" placeholder="Type a name" autocomplete="off" aria-label="Who are you waiting on?"><button type="submit" class="btn-brutal">ADD</button><button type="button" class="link-btn quiet" data-wo-cancel911>Cancel</button></form>' : '') +
      '<div class="wo-foot911">' + (w ? '<span>Since ' + (waitDays911(w) ? esc(dayTxt911(w[1])) + ' · ' + waitDays911(w) + (waitDays911(w) === 1 ? ' day' : ' days') : 'today') + ' · set by ' + esc(w[2] === state.user ? 'you' : nice(w[2])) + '</span><button type="button" class="wo-clear911" data-wo-clear911>Clear</button>'
        : '<span>Shows on the row until you change or clear it. A name you add is there for everyone.</span>') + '</div></div>';
  }
  async function waitSet911(no, on) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;
    const K = keyOf(j), prev = waitOf911(j), names = (state.waitNames911 || []).slice();
    on = upq(on).slice(0, 24);
    state.waits911 = state.waits911 || {};
    if (!on) delete state.waits911[K];
    else state.waits911[K] = prev && upq(prev[0]) === on ? prev : [on, Date.now(), state.user];
    if (on && !WAIT_FIX911.includes(on) && !(state.waitNames911 || []).includes(on)) state.waitNames911 = (state.waitNames911 || []).concat([on]);
    state.woAdd911 = null;
    rerender(); refreshOverlay();
    try {
      const res = await api.call('ethixWaitSet', [j.jobNo, on]);
      if (!res || !res.ok) throw new Error((res && res.error) || 'Not saved.');
      if (res.wait) state.waits911[K] = res.wait; else delete state.waits911[K];
      if (Array.isArray(res.names)) state.waitNames911 = res.names;
      rerender(); refreshOverlay();
      toast(on ? 'Waiting on ' + nice(on) + ' · ' + j.jobNo : 'Cleared · ' + j.jobNo);
    } catch (e) {
      if (prev) state.waits911[K] = prev; else delete state.waits911[K];
      state.waitNames911 = names;
      rerender(); refreshOverlay();
      if (e.kind !== 'auth') toast(needs911(e, '“Waiting on”'), { error: true });
    }
  }
  // the filter: a row along the bottom of the dark tile — only the names in use, with how many
  const wMatch911 = (x) => !state.wf911 || (waitOf911(x.j) && upq(waitOf911(x.j)[0]) === state.wf911);
  function waitBar911(rows) {
    const n = new Map();
    rows.forEach((x) => { const w = waitOf911(x.j); if (w) n.set(upq(w[0]), (n.get(upq(w[0])) || 0) + 1); });
    if (state.wf911 && !n.has(state.wf911)) state.wf911 = '';
    if (!n.size) return '';
    const order = waitNames911().filter((x) => n.has(x));
    return '<div class="rp-wait911" role="group" aria-label="Waiting on"><span class="rpw-k911">' + icon('hourglass911', 12) + 'WAITING ON</span>' +
      order.map((k) => '<button type="button" class="rpw911' + (state.wf911 === k ? ' is-on' : '') + '" data-wf911="' + esc(k) + '" aria-pressed="' + (state.wf911 === k) + '">' + esc(nice(k)) + '<b>' + n.get(k) + '</b></button>').join('') +
      (state.wf911 ? '<button type="button" class="rpw911 is-all" data-wf911="">Show all</button>' : '') + '</div>';
  }

  // ================================================================ 6 · leave hand-over
  // Your active jobs (or the colleague's you cover — from the day they accept), the way a colleague needs them: what needs
  // doing in the next three days first, then by where the shipment is; each with its open tasks, the last follow-up remark
  // and who you are waiting on; then the customers' briefings. The Word file has the same, in the Active jobs style.
  function hoOwnerOk911(owner) {
    if (!canEdit()) return false;
    if (owner === state.user) return true;
    const t = covToday98();
    return (state.covers || []).some((c) => c.cover === state.user && c.owner === owner && c.status === 'ACCEPTED' && c.end >= t);
  }
  function hoCover911(owner) {   // the cover this hand-over is for (running first, then coming up, then asked)
    const t = covToday98(), L = (state.covers || []).filter((c) => c.owner === owner && (c.status === 'ACCEPTED' || c.status === 'ASKED') && c.end >= t && (owner === state.user || c.cover === state.user));
    return L.sort((a, b) => (a.status === 'ACCEPTED' ? 0 : 1) - (b.status === 'ACCEPTED' ? 0 : 1) || (a.start < b.start ? -1 : 1))[0] || null;
  }
  function hoBtn911(c) {
    if (c.owner === state.user) return '<button type="button" class="btn-ghost" data-href="#/handover">' + icon('handover911', 15) + '<span>Hand-over</span></button>';
    if (c.cover === state.user && c.status === 'ACCEPTED') return '<button type="button" class="btn-ghost" data-href="#/handover/' + esc(encodeURIComponent(c.owner)) + '">' + icon('handover911', 15) + '<span>Their hand-over</span></button>';
    return '';
  }
  function hoData911(owner) {
    const t0 = today0(), jobs = state.jobs.filter((j) => j.active && j.cs === owner);
    const watch = watchItems91(jobs, t0), tasks = new Map();
    watch.forEach((w) => { const k = keyOf(w.j); if (!tasks.has(k)) tasks.set(k, []); tasks.get(k).push(w); });
    const soonD = (j) => (tasks.get(keyOf(j)) || []).filter((w) => w.d >= -21).reduce((a, w) => Math.min(a, w.d), 99);   // as TODAY'S WATCH: older than 3 weeks is not "now"
    const stage = (j) => (j.mode === 'misc' ? 'nodate' : stageOf91(j, t0));
    const tm = (d) => (d ? +d : 9e15);
    const need = jobs.filter((j) => soonD(j) <= 3).sort((a, b) => soonD(a) - soonD(b) || String(a.jobNo).localeCompare(String(b.jobNo)));
    const rest = jobs.filter((j) => !need.includes(j));
    const by = (s) => rest.filter((j) => stage(j) === s);
    const groups = [
      ['need', 'NEEDS DOING — NEXT 3 DAYS', need],
      ['before', 'BEFORE SAILING', by('before').sort((a, b) => tm(a.etd) - tm(b.etd))],
      ['sea', 'ON THE WAY', by('sea').sort((a, b) => tm(a.eta) - tm(b.eta))],
      ['arrived', 'ARRIVED', by('arrived').sort((a, b) => tm(a.eta) - tm(b.eta))],
      ['nodate', 'COSTING ONLY · NO DATES YET', by('nodate').concat(rest.filter((j) => !['before', 'sea', 'arrived', 'nodate'].includes(stage(j))))]
    ].filter((g) => g[2].length);
    const custs = []; jobs.forEach((j) => { const k = briefKey911(j.customer); if (k && briefOf911(k) && !custs.includes(k)) custs.push(k); });
    return { t0, jobs, tasks, groups, custs: custs.sort(), cover: hoCover911(owner), waiting: jobs.filter((j) => waitOf911(j)).length, needN: need.length };
  }
  function hoLast911(j) {   // the newest follow-up remark: [t, user, text]
    const L = rmkAll99(j); return L.length ? L[0] : null;
  }
  const hoRoute911 = (j) => [j.mode === 'misc' ? (j.against ? 'AGAINST ' + j.against : 'COSTING ONLY') : j.pol && j.pod ? j.pol + ' → ' + j.pod : j.pol || j.pod || '', String(j.vendor || '').trim().toUpperCase()].filter(Boolean).join(' · ') || '—';
  function hoRow911(j, D) {
    const st = jobStatus91(j, D.t0), T = D.tasks.get(keyOf(j)) || [], last = hoLast911(j), f = followState(j, D.t0);
    const where = '<span class="ho-where911">' + (st.hold ? '<b class="is-hold">On hold</b> · ' : '') + '<b>' + esc(st.where) + '</b>' + (st.eta ? ' · <b>' + esc(st.eta) + '</b>' : '') + (st.rest.length ? '<span>' + esc(st.rest.join(' · ')) + '</span>' : '') + '</span>';
    const todo = T.length ? '<span class="ho-tasks911">' + T.slice(0, 4).map((w) => '<span class="ho-t911 is-' + (w.level === 'urgent' ? 'red' : 'amber') + '"><b>' + esc(w.what) + '</b>' + esc(w.when) + '</span>').join('') + (T.length > 4 ? '<span class="ho-more911">+' + (T.length - 4) + ' more</span>' : '') + '</span>'
      : '<span class="ho-next911">' + toneChip(rowNext(j)) + '</span>';
    const fu = (last ? '<span class="ho-rmk911">“' + esc(last[2]) + '”</span><span class="ho-by911">' + esc(last[1] === state.user ? 'You' : nice(last[1])) + ' · ' + esc(dayTxt911(last[0])) + '</span>' : '<span class="ho-by911">' + esc(lastCheckText(f, D.t0)) + '</span>') +
      '<span class="ho-tags911">' + waitTag911(j, true) + '<span class="ho-pace911">' + esc(f.label) + '</span></span>';
    return '<li class="ho-row911"><button type="button" class="ho-main911" data-job="' + esc(j.jobNo) + '"><span class="ho-no911">' + changedDot(j) + esc(j.jobNo) + '<span class="badge">' + esc(j.type) + '</span></span>' +
        '<span class="ho-cust911">' + esc(j.customer || '—') + '</span><span class="ho-route911">' + esc(hoRoute911(j)) + '</span></button>' +
      '<span class="ho-mid911">' + where + todo + '</span><span class="ho-fu911">' + fu + '</span>' + (briefOf911(j.customer) ? '<span class="ho-bf911">' + briefBtn911(j) + '</span>' : '') + '</li>';
  }
  function renderHandover911(owner, first) {
    owner = upq(owner || state.user);
    if (!hoOwnerOk911(owner)) { history.replaceState(null, '', '#/cover'); render(false); return; }
    const anim = first ? ' reveal' : '', D = hoData911(owner), me = owner === state.user, c = D.cover;
    const other = c ? (me ? c.cover : c.owner) : '', days = c ? covDays98(c) : 0;
    const forTxt = c ? (me ? 'For ' + nice(other) : 'From ' + nice(other)) + ' · ' + covRange98(c) + ' · ' + days + (days === 1 ? ' day' : ' days') + (c.status === 'ASKED' ? ' (not accepted yet)' : '') : me ? 'For whoever covers you — set the days on Cover' : '';
    const sec = (g, i) => '<section class="ho-sec911' + anim + '" style="--d:' + (80 + i * 30) + 'ms" aria-labelledby="ho-' + g[0] + '"><div class="tile-head"><h2 class="tile-title" id="ho-' + g[0] + '">' + g[1] + ' <span class="tile-count">' + g[2].length + '</span></h2></div><ol class="ho-list911">' + g[2].map((j) => hoRow911(j, D)).join('') + '</ol></section>';
    const briefs = D.custs.length ? '<section class="ho-sec911 ho-briefs911' + anim + '" style="--d:' + (80 + D.groups.length * 30) + 'ms" aria-labelledby="ho-bf"><div class="tile-head"><h2 class="tile-title" id="ho-bf">CUSTOMER BRIEFINGS <span class="tile-count">' + D.custs.length + '</span></h2></div><div class="ho-bgrid911">' +
      D.custs.map((k) => { const b = briefOf911(k); return '<article class="ho-bcard911"><div class="ho-bname911">' + esc(k) + '</div>' + briefBody911(b) + '<div class="bf-foot911"><span>Edited by ' + esc(b.by === state.user ? 'you' : nice(b.by)) + (b.at ? ' · ' + esc(dayTxt911(b.at)) : '') + '</span></div></article>'; }).join('') + '</div></section>' : '';
    $('#view').innerHTML = '<div class="wrap handover-page no-seg">' +
      '<header class="page-head' + anim + '"><div class="head-main"><div class="crumbs ho-crumbs911"><button type="button" class="back-btn" data-href="#/cover" aria-label="Back to Cover">' + icon('back', 18) + '</button><button type="button" class="link-btn" data-href="#/cover">COVER</button><span>/ HAND-OVER</span></div>' +
        '<h1 class="greeting">' + (me ? 'Your hand-over' : esc(nice(owner)) + '’s hand-over') + '</h1></div>' +
        '<div class="head-actions"><button type="button" class="btn-brutal btn-icon" data-ho-word911="' + esc(owner) + '"' + (D.jobs.length ? '' : ' disabled') + '>' + icon('download', 16) + '<span>WORD FILE</span></button></div></header>' +
      '<section class="ho-sum911 tile tile-ink' + anim + '" style="--d:40ms" aria-label="Summary"><div class="rp-num"><b>' + D.jobs.length + '</b><span>' + (D.jobs.length === 1 ? 'active job' : 'active jobs') + '</span></div>' +
        '<div class="rp-main"><div class="rp-label">' + esc(forTxt || fmtLong(D.t0)) + '</div><div class="ho-chips911">' +
          '<span class="' + (D.needN ? 'is-red' : '') + '"><b>' + D.needN + '</b> to do in the next 3 days</span><span><b>' + D.waiting + '</b> waiting on someone</span><span><b>' + D.jobs.filter((j) => j.hold).length + '</b> on hold</span><span><b>' + D.custs.length + '</b> ' + (D.custs.length === 1 ? 'customer briefing' : 'customer briefings') + '</span>' +
        '</div></div></section>' +
      (D.jobs.length ? D.groups.map(sec).join('') + briefs : '<section class="tile' + anim + '">' + empty('check', me ? 'You have no active jobs to hand over.' : nice(owner) + ' has no active jobs.') + '</section>') +
      '</div>';
  }
  // ---------- the Word file (A4 landscape, the look of the Active jobs list) ----------
  function docXml911(o) {   // o: { W, title, sub, foot, body, logo, sz } → the files of a .docx
    const X = XL.X, NAVY = '1C5179', INK = '0B1B2B', MUTE = '6B7A8A', HAIR = 'DFE6ED', TEAL = '0E7C7B', W = o.W;
    const rPr = (q) => '<w:rPr>' + (q.b ? '<w:b/><w:bCs/>' : '') + '<w:color w:val="' + (q.c || INK) + '"/>' + (q.sp ? '<w:spacing w:val="' + q.sp + '"/>' : '') + '<w:sz w:val="' + (q.sz || 18) + '"/><w:szCs w:val="' + (q.sz || 18) + '"/></w:rPr>';
    const run = (t, q) => '<w:r>' + rPr(q || {}) + '<w:t xml:space="preserve">' + X(t) + '</w:t></w:r>';
    const para = (runs, q) => { q = q || {}; return '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/>' + (q.jc ? '<w:jc w:val="' + q.jc + '"/>' : '') + '</w:pPr>' + runs + '</w:p>'; };
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const DNS = NS + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
    const XMLH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const sect = '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1300" w:right="850" w:bottom="1000" w:left="850" w:header="420" w:footer="420" w:gutter="0"/><w:cols w:space="720"/></w:sectPr>';
    const doc = XMLH + '<w:document ' + NS + '><w:body>' + o.body + para('') + sect + '</w:body></w:document>';
    const E = 360000, lh = Math.round(0.95 * E), lw = o.sz ? Math.round(lh * o.sz[0] / o.sz[1]) : 0;
    const pic = o.sz ? '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + lw + '" cy="' + lh + '"/><wp:docPr id="1" name="ETHIX logo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + lw + '" cy="' + lh + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>' : run('ETHIX SHIPPING', { b: true, c: NAVY, sz: 22 });
    const hcell = (w, content) => '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/><w:vAlign w:val="bottom"/></w:tcPr>' + content + '</w:tc>';
    const header = XMLH + '<w:hdr ' + DNS + '><w:tbl><w:tblPr><w:tblW w:w="' + W + '" w:type="dxa"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="8" w:space="0" w:color="' + NAVY + '"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="' + (W / 2) + '"/><w:gridCol w:w="' + (W / 2) + '"/></w:tblGrid><w:tr>' +
      hcell(W / 2, para(pic)) + hcell(W / 2, para(run(o.title, { b: true, c: INK, sz: 26, sp: 20 }), { jc: 'right' }) + para(run(o.sub, { b: true, c: TEAL, sz: 15, sp: 10 }), { jc: 'right' })) +
      '</w:tr></w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p></w:hdr>';
    const fld = (code) => '<w:fldSimple w:instr=" ' + code + ' "><w:r>' + rPr({ c: MUTE, sz: 15 }) + '<w:t>1</w:t></w:r></w:fldSimple>';
    const footer = XMLH + '<w:ftr ' + NS + '><w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="' + HAIR + '"/></w:pBdr><w:tabs><w:tab w:val="right" w:pos="' + W + '"/></w:tabs><w:spacing w:before="0" w:after="0"/></w:pPr>' +
      run(o.foot, { c: MUTE, sz: 15 }) + '<w:r>' + rPr({ c: MUTE, sz: 15 }) + '<w:tab/></w:r>' + run('Page ', { c: MUTE, sz: 15 }) + fld('PAGE') + run(' of ', { c: MUTE, sz: 15 }) + fld('NUMPAGES') + '</w:p></w:ftr>';
    const styles = XMLH + '<w:styles ' + NS + '><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:color w:val="' + INK + '"/><w:sz w:val="18"/><w:szCs w:val="18"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>';
    const settings = XMLH + '<w:settings ' + NS + '><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';
    const rel = (id, type, target) => '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type + '" Target="' + target + '"/>';
    const RELS = (inner) => XMLH + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + inner + '</Relationships>';
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const files = [
      { name: '[Content_Types].xml', data: XMLH + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + (o.sz ? '<Default Extension="png" ContentType="image/png"/>' : '') +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
        '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' },
      { name: '_rels/.rels', data: RELS('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>') },
      { name: 'docProps/core.xml', data: XMLH + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + X(o.docTitle) + '</dc:title><dc:creator>' + X(state.user) + '</dc:creator><cp:lastModifiedBy>' + X(state.user) + '</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>' },
      { name: 'docProps/app.xml', data: XMLH + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>ETHIX</Application></Properties>' },
      { name: 'word/document.xml', data: doc },
      { name: 'word/styles.xml', data: styles },
      { name: 'word/settings.xml', data: settings },
      { name: 'word/header1.xml', data: header },
      { name: 'word/footer1.xml', data: footer },
      { name: 'word/_rels/document.xml.rels', data: RELS(rel('rIdS', 'styles', 'styles.xml') + rel('rIdT', 'settings', 'settings.xml') + rel('rIdH', 'header', 'header1.xml') + rel('rIdF', 'footer', 'footer1.xml')) }
    ];
    if (o.sz) { files.push({ name: 'word/_rels/header1.xml.rels', data: RELS(rel('rIdLogo', 'image', 'media/logo.png')) }); files.push({ name: 'word/media/logo.png', data: o.logo }); }
    return files;
  }
  async function hoWord911(owner) {
    owner = upq(owner || state.user);
    if (!hoOwnerOk911(owner)) return;
    const D = hoData911(owner); if (!D.jobs.length) { toast('No active jobs to put in the file'); return; }
    const X = XL.X, t0 = D.t0, c = D.cover, me = owner === state.user;
    const NAVY = '1C5179', INK = '0B1B2B', INK2 = '3E4C5E', MUTE = '6B7A8A', HAIR = 'DFE6ED', FOG = 'F3F6F9', RED = 'B42318', AMBER = 'B54708';
    const W = 15138, COLS = [680, 1640, 2780, 2440, 2900, 2500, 2198];   // S.NO wide enough to stay on one line
    const rPr = (o) => '<w:rPr>' + (o.b ? '<w:b/><w:bCs/>' : '') + (o.i ? '<w:i/><w:iCs/>' : '') + '<w:color w:val="' + (o.c || INK) + '"/>' + (o.sp ? '<w:spacing w:val="' + o.sp + '"/>' : '') + '<w:sz w:val="' + (o.sz || 18) + '"/><w:szCs w:val="' + (o.sz || 18) + '"/></w:rPr>';
    const run = (t, o) => '<w:r>' + rPr(o || {}) + '<w:t xml:space="preserve">' + X(t) + '</w:t></w:r>';
    const para = (runs, o) => { o = o || {}; return '<w:p><w:pPr>' + (o.keep ? '<w:keepNext/>' : '') + '<w:spacing w:before="' + (o.before || 0) + '" w:after="' + (o.after || 0) + '" w:line="' + (o.line || 252) + '" w:lineRule="auto"/>' + (o.jc ? '<w:jc w:val="' + o.jc + '"/>' : '') + '</w:pPr>' + runs + '</w:p>'; };
    const cell = (w, content, o) => { o = o || {}; return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + (o.border ? '<w:tcBorders><w:bottom w:val="single" w:sz="8" w:space="0" w:color="' + NAVY + '"/></w:tcBorders>' : '') + (o.fill ? '<w:shd w:val="clear" w:color="auto" w:fill="' + o.fill + '"/>' : '') + '<w:vAlign w:val="' + (o.v || 'top') + '"/></w:tcPr>' + content + '</w:tc>'; };
    const tbl = (cols, head, rows) => '<w:tbl><w:tblPr><w:tblW w:w="' + W + '" w:type="dxa"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="' + HAIR + '"/><w:right w:val="nil"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="' + HAIR + '"/><w:insideV w:val="nil"/></w:tblBorders>' +
      '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="70" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0420" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
      '<w:tblGrid>' + cols.map((x) => '<w:gridCol w:w="' + x + '"/>').join('') + '</w:tblGrid>' +
      '<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>' + head.map((h, i) => cell(cols[i], para(run(h, { b: true, c: INK2, sz: 14, sp: 10 }), { jc: i === 0 && h === 'S.NO' ? 'center' : 'left' }), { fill: FOG, border: true, v: 'bottom' })).join('') + '</w:tr>' + rows.join('') + '</w:tbl>';
    const jobRow = (j, n) => {
      const st = jobStatus91(j, t0), T = D.tasks.get(keyOf(j)) || [], last = hoLast911(j), w = waitOf911(j), f = followState(j, t0);
      const where = para((st.hold ? run('On hold', { b: true, c: RED }) + run(' · ', { c: MUTE }) : '') + run(st.where, { b: true, c: NAVY }) + (st.eta ? run(' · ', { c: MUTE }) + run(st.eta, { b: true, c: NAVY }) : '')) + (st.rest.length ? para(run(st.rest.join(' · '), { c: INK2, sz: 16 }), { before: 30 }) : '');
      const todo = T.length ? T.slice(0, 5).map((x, i) => para(run(x.what, { b: true, c: x.level === 'urgent' ? RED : AMBER, sz: 16 }) + run(' · ' + x.when, { c: INK2, sz: 16 }), { before: i ? 30 : 0 })).join('')
        : (j.next && j.next.text ? para(run(j.next.text, { c: INK2 })) : para(run('—', { c: MUTE })));
      const fu = (last ? para(run('“' + last[2] + '”', { i: true, c: INK })) + para(run((last[1] === state.user && me ? nice(owner) : nice(last[1])) + ' · ' + dayTxt911(last[0]), { c: MUTE, sz: 15 }), { before: 20 }) : para(run(lastCheckText(f, t0), { c: MUTE })))
        + (w ? para(run('WAITING ON ' + upq(w[0]), { b: true, c: NAVY, sz: 15, sp: 6 }) + run((waitDays911(w) ? ' · ' + waitDays911(w) + (waitDays911(w) === 1 ? ' DAY' : ' DAYS') : ' · TODAY'), { c: NAVY, sz: 15 }), { before: 40 }) : '')
        + para(run('Follow-up ' + f.label.toLowerCase(), { c: MUTE, sz: 15 }), { before: 20 });
      const route = j.mode === 'misc' ? (j.against ? 'Against ' + j.against : 'Costing only') : (j.pol ? portName91(j.pol) : '—') + ' → ' + (j.pod ? portName91(j.pod) : '—');
      return '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
        cell(COLS[0], para(run(String(n), { c: MUTE }), { jc: 'center' })) + cell(COLS[1], para(run(j.jobNo, { b: true })) + para(run(j.type || '—', { b: true, c: MUTE, sz: 14, sp: 10 }), { before: 20 })) +
        cell(COLS[2], para(run(j.customer || '—')) + (briefOf911(j.customer) ? para(run('BRIEFING AT THE END', { b: true, c: '0E7C7B', sz: 13, sp: 6 }), { before: 30 }) : '')) +
        cell(COLS[3], para(run(route, { c: INK2 })) + (String(j.vendor || '').trim() ? para(run(String(j.vendor).trim().toUpperCase(), { b: true, c: MUTE, sz: 14, sp: 6 }), { before: 20 }) : '')) +
        cell(COLS[4], where) + cell(COLS[5], todo) + cell(COLS[6], fu) + '</w:tr>';
    };
    const head = ['S.NO', 'JOB NO.', 'CUSTOMER', 'ROUTE · LINE', 'WHERE IT STANDS', 'TO DO', 'LAST FOLLOW-UP'];
    const day = t0.getDate() + ' ' + MON91[t0.getMonth()] + ' ' + t0.getFullYear();
    const forTxt = c ? (me ? 'For ' + nice(c.cover) : 'From ' + nice(c.owner)) + ' · ' + covRange98(c) + (c.status === 'ASKED' ? ' (not accepted yet)' : '') : '';
    let body = para(run(D.jobs.length + (D.jobs.length === 1 ? ' active job' : ' active jobs') + ' of ' + nice(owner), { b: true, sz: 20 }) + (forTxt ? run('   ·   ' + forTxt, { c: MUTE, sz: 18 }) : '') +
      run('   ·   ' + D.needN + ' to do in the next 3 days   ·   ' + D.waiting + ' waiting on someone', { c: MUTE, sz: 18 }), { after: 60 });
    let n = 0;
    D.groups.forEach((g, gi) => {
      body += para(run(g[1].charAt(0) + g[1].slice(1).toLowerCase().replace(/ — next 3 days/, ' — next 3 days'), { b: true, c: g[0] === 'need' ? RED : NAVY, sz: 24 }) + run('   ' + g[2].length + (g[2].length === 1 ? ' job' : ' jobs'), { c: MUTE, sz: 17 }), { keep: true, before: gi ? 360 : 240, after: 100 }) +
        tbl(COLS, head, g[2].map((j) => jobRow(j, ++n)));
    });
    if (D.custs.length) {
      const BC = [3300, 6838, 5000];
      body += para(run('Customer briefings', { b: true, c: NAVY, sz: 24 }) + run('   ' + D.custs.length, { c: MUTE, sz: 17 }), { keep: true, before: 360, after: 100 }) +
        tbl(BC, ['CUSTOMER', 'REQUIREMENTS', 'CONTACTS'], D.custs.map((k) => { const b = briefOf911(k);
          return '<w:tr><w:trPr><w:cantSplit/></w:trPr>' + cell(BC[0], para(run(k, { b: true })) + para(run('Edited by ' + nice(b.by) + (b.at ? ' · ' + dayTxt911(b.at) : ''), { c: MUTE, sz: 15 }), { before: 30 })) +
            cell(BC[1], b.req.length ? b.req.map((r, i) => para(run('•  ' + r, { c: INK }), { before: i ? 40 : 0 })).join('') : para(run('—', { c: MUTE }))) +
            cell(BC[2], b.ct.length ? b.ct.map((x, i) => para(run(x[0] || 'Contact', { b: true }) + (x[1] ? run(' · ' + x[1], { c: INK2 }) : '') + run('   ' + x[2], { c: NAVY }), { before: i ? 40 : 0 })).join('') : para(run('—', { c: MUTE }))) + '</w:tr>'; }));
    }
    const logo = await costLogo(), sz = logo ? XL.pngSize(logo) : null;
    const files = docXml911({ W, title: 'HAND-OVER', sub: (nice(owner) + ' · ' + day).toUpperCase() + (c ? ' · ' + (me ? 'FOR ' + c.cover : 'COVERED BY ' + c.cover) : ''), foot: 'ETHIX · Hand-over · ' + nice(owner) + ' · ' + day, body, logo, sz, docTitle: 'ETHIX hand-over ' + nice(owner) + ' ' + day });
    try {
      const blob = XL.zip(files, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const name = 'ETHIX_Hand-over_' + nice(owner).replace(/\s+/g, '-') + '_' + day.replace(/ /g, '-') + '.docx';
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      toast('Word file ready · ' + name);
    } catch (e) { toast('The Word file could not be made: ' + e.message, { error: true }); }
  }

  // ================================================================ wiring
  function initV2911() {
    // ---- hover cards (laptop): pointing opens after a moment, leaving closes; a click keeps it open. Phone: a tap.
    const hoverable = () => usePop() && window.matchMedia && window.matchMedia('(hover: hover)').matches;
    let hT = 0, hOpenT = 0, hWas = null;
    const kinds = [
      ['[data-brief911]', (el, pin) => openBrief911(el, pin), () => bfOpen911(), () => state.brief911],
      ['[data-hol911]', (el, pin) => { const render = holCard911(el.dataset.hol911); keepFocus911(() => openPop(el, holKick911(el.dataset.hol911), render), pin); state.hol911p = { port: el.dataset.hol911, render, pinned: !!pin }; },
        () => !!(state.overlay === 'pop' && state.hol911p && popRender === state.hol911p.render), () => state.hol911p]
    ];
    const kindOf = (el) => kinds.find((k) => el && el.closest && el.closest(k[0]));
    const same = (k, el) => { const s = k[3](); if (!s) return false; const a = el.closest(k[0]); return k[0] === '[data-brief911]' ? s.no === a.dataset.brief911 : s.port === a.dataset.hol911; };
    document.addEventListener('mouseover', (e) => {
      if (!hoverable()) return;
      if (e.target.closest && e.target.closest('#pop')) { clearTimeout(hT); return; }
      const k = kindOf(e.target); if (!k) return;
      clearTimeout(hT);
      const el = e.target.closest(k[0]);
      if (k[2]() && same(k, el)) return;
      clearTimeout(hOpenT);
      hOpenT = setTimeout(() => { if (el.matches(':hover') && !(state.overlay && state.overlay !== 'pop')) k[1](el, false); }, 220);
    }, true);
    document.addEventListener('mouseout', (e) => {
      if (!hoverable()) return;
      const k = kinds.find((x) => x[2]()); if (!k || k[3]().pinned) return;
      const to = e.relatedTarget;
      if (to && to.closest && (to.closest('#pop') || to.closest(k[0]))) return;
      clearTimeout(hOpenT);
      hT = setTimeout(() => { if (k[2]() && !k[3]().pinned && !$('#pop').matches(':hover')) closeOverlays(); }, 280);
    }, true);
    // the click: open and keep open — or, when it is already kept open, close (the tap outside closes it before the click)
    window.addEventListener('pointerdown', (e) => {
      const k = kindOf(e.target); hWas = null;
      if (!k) return;
      const el = e.target.closest(k[0]);
      if (k[2]() && same(k, el)) { hWas = k[3]().pinned ? 'pinned' : 'hover'; if (hWas === 'hover') e.stopPropagation(); }
    }, true);
    document.addEventListener('click', (e) => {
      const k = kindOf(e.target);
      if (k) {
        e.preventDefault(); e.stopPropagation(); clearTimeout(hOpenT); clearTimeout(hT);
        const el = e.target.closest(k[0]);
        if (hWas === 'pinned') { hWas = null; if (k[2]()) closeOverlays(); return; }
        if (hWas === 'hover' && k[2]()) { k[3]().pinned = true; hWas = null; return; }
        hWas = null;
        k[1](el, true);
        return;
      }
      const be = e.target.closest('[data-brief-edit911]'); if (be) { e.preventDefault(); briefEdit911(be.dataset.briefEdit911); return; }
      const ac = e.target.closest('[data-bf-addct911]'); if (ac) { const F = briefCollect911(); if (F && F.ct.length < 6) { F.ct.push(['', '', '']); briefRedraw911(); const i = $('#bfN' + (F.ct.length - 1)); if (i) i.focus(); } return; }
      const rm = e.target.closest('[data-bf-rm911]'); if (rm) { const F = briefCollect911(); if (F) { F.ct.splice(+rm.dataset.bfRm911, 1); if (!F.ct.length) F.ct.push(['', '', '']); briefRedraw911(); } return; }
      const tag = e.target.closest('[data-wait911]'); if (tag) { e.preventDefault(); e.stopPropagation(); rmkOpen99(tag, tag.dataset.wait911, { add: false }); return; }
      const ws = e.target.closest('[data-wo-set911]'); if (ws) { const no = ws.closest('[data-wo911]').dataset.wo911, cur = waitOf911(findJob(no)); if (!cur || upq(cur[0]) !== ws.dataset.woSet911) waitSet911(no, ws.dataset.woSet911); return; }
      if (e.target.closest('[data-wo-clear911]')) { waitSet911(e.target.closest('[data-wo911]').dataset.wo911, ''); return; }
      if (e.target.closest('[data-wo-add911]')) { state.woAdd911 = e.target.closest('[data-wo911]').dataset.wo911; refreshOverlay(); const i = $('#woName911'); if (i) i.focus(); return; }
      if (e.target.closest('[data-wo-cancel911]')) { state.woAdd911 = null; refreshOverlay(); return; }
      const wf = e.target.closest('[data-wf911]'); if (wf) { state.wf911 = state.wf911 === wf.dataset.wf911 ? '' : wf.dataset.wf911; rerender(); return; }
      const fu = e.target.closest('[data-ft-use911]'); if (fu) { const i = $('[name="lineFree"]'); if (i) { i.value = fu.dataset.ftUse911; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); } return; }
      const hw = e.target.closest('[data-ho-word911]'); if (hw) { hoWord911(hw.dataset.hoWord911); return; }
      const nt = e.target.closest('[data-tab911]'); if (nt && nt.dataset.job) { const j = findJob(nt.dataset.job); if (j) state.voyageTab[j.jobNo] = nt.dataset.tab911; }
    }, true);
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('[data-hol911]')) { e.preventDefault(); e.target.click(); }
    });
    document.addEventListener('submit', (e) => {
      if (e.target.closest('#briefForm911')) { e.preventDefault(); e.stopPropagation(); briefSave911(); return; }
      const wn = e.target.closest('[data-wo-new911]');
      if (wn) { e.preventDefault(); e.stopPropagation(); const v = (($('#woName911') || {}).value || '').replace(/\s+/g, ' ').trim(); const no = wn.closest('[data-wo911]').dataset.wo911; if (v) waitSet911(no, v); else { const i = $('#woName911'); if (i) i.focus(); } }
    }, true);
    document.addEventListener('input', (e) => {
      const n = e.target.name;
      if (!e.target.closest('#jobForm, #editForm')) return;
      if (n === 'lineFree') { e.target.dataset.auto911 = ''; freeRun911(); }
      else if (n === 'customer' || n === 'vendor' || n === 'type') freeRun911();
    }, true);
    document.addEventListener('change', (e) => { if (e.target.closest('#jobForm, #editForm') && ['type', 'customer', 'vendor'].includes(e.target.name)) freeRun911(); }, true);
    const body = $('#drawerBody');
    if (body && window.MutationObserver) new MutationObserver(() => freeWire911()).observe(body, { childList: true });
  }

  // ================================================================ v2.9.12 — Amal's list of 6 Nov 2026 (Chambikko)
  //  1 every reminder always shown — after NEXT TWO WEEKS each later day has its own heading (the count = the list)
  //  2 the month calendar from THIS WEEK: glass, dots and counts only, the day's jobs on the side, UAE public holidays
  //  3 MISSING INFO at the top of MY DAY — Fill opens Edit details at that field
  //  4 Copy from job… on a costing page — the lines come in as a draft; nothing is saved until Save
  I.cal912 = '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>';
  I.l912 = '<path d="M15 6l-6 6 6 6"/>';
  I.r912 = '<path d="M9 6l6 6-6 6"/>';
  I.x912 = '<path d="M6 6l12 12M18 6L6 18"/>';
  I.hol912 = '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.2"/>';
  const MONTHS912 = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dm912 = (d) => d.getDate() + ' ' + MON91[d.getMonth()];   // "6 Nov"

  // ---------------------------------------------------------------- 1 · reminders: every one shown
  const remDay912 = (iso, t0) => { const d = parseDate(iso); return d ? DOW_UP[d.getDay()] + ' ' + d.getDate() + ' ' + MON91[d.getMonth()].toUpperCase() + (d.getFullYear() !== t0.getFullYear() ? ' ' + d.getFullYear() : '') : String(iso || ''); };
  // grouped: late · today · tomorrow · next two weeks · then each later day under its own date · done today
  function remGroups(list, max) {
    const t0 = today0(), T = isoOf(t0), M = isoOf(addDays(t0, 1)), H = isoOf(addDays(t0, 14));
    const open = list.filter((r) => r.status !== 'DONE');
    const byDay = [];
    open.filter((r) => r.due > H).sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : String(a.time || '').localeCompare(String(b.time || ''))))
      .forEach((r) => { const g = byDay[byDay.length - 1]; if (g && g.k === r.due) g.l.push(r); else byDay.push({ k: r.due, l: [r] }); });
    const g = [['LATE', open.filter((r) => r.due < T), 'late'], ['TODAY', open.filter((r) => r.due === T), 'today'], ['TOMORROW', open.filter((r) => r.due === M), 'tomorrow'],
      ['NEXT TWO WEEKS', open.filter((r) => r.due > M && r.due <= H), 'next']].concat(byDay.map((x) => [remDay912(x.k, t0), x.l, 'date912']))
      .concat([['DONE TODAY', list.filter((r) => r.status === 'DONE' && r.doneAt >= +t0), 'done']]);
    let shown = 0;
    return g.filter(([, l]) => l.length).map(([label, l, cls]) => { const part = max ? l.slice(0, Math.max(0, max - shown)) : l; shown += part.length; return part.length ? '<div class="rm-gh is-' + cls + '">' + label + '</div><ul class="rm-list">' + part.map((r) => remItem(r)).join('') + '</ul>' : ''; }).join('');
  }

  // ---------------------------------------------------------------- 2 · the month calendar (THIS WEEK → calendar button)
  // Own jobs (+ the colleague you cover today), the dates THIS WEEK and TODAY'S WATCH use: ETD · ETA · the cutoffs still open
  // (SI · ED · DG) · free time ending (imports not delivered yet). Every date is a Dubai day.
  const KEYS912 = ['sail', 'arr', 'cut', 'free'];
  const CHIP912 = { all: 'All', sail: 'Sailing', arr: 'Arriving', cut: 'Cutoffs', free: 'Free time' };
  const LEG912 = { sail: 'Sailing', arr: 'Arriving', cut: 'Cutoff', free: 'Free time ends' };
  const cutTime912 = (raw) => { const m = String(raw || '').match(/\b(\d{1,2}):(\d{2})\b/); return m ? ' ' + m[1].padStart(2, '0') + ':' + m[2] : ''; };
  // calEvents912 — v2.9.13 version further down (done cutoffs too)
  // UAE public holidays: the whole HOLIDAYS tab (v2.9.12 Code.gs), else the six weeks every app has
  function holAE912(iso) {
    const all = state.holAE912;
    if (Array.isArray(all) && all.length) return all.filter((h) => h[0] === iso).map((h) => h[1]);
    return holOn911('AE', iso).map((h) => h.name);
  }
  const holShort912 = (n) => String(n || '').replace(/\s+holiday$/i, '').trim();
  const cal912 = () => state.cal912 || (state.cal912 = { f: 'all' });
  const isPh912 = () => !usePop();
  function calPick912(iso) {   // the day shown on the side (and its month)
    const d = parseDate(iso) || today0(), C = cal912();
    C.sel = isoOf(d); C.y = d.getFullYear(); C.m = d.getMonth();
  }
  function calMonth912(step) {
    const C = cal912(), t0 = today0(), d = new Date(C.y, C.m + step, 1);
    C.y = d.getFullYear(); C.m = d.getMonth();
    C.sel = (t0.getFullYear() === C.y && t0.getMonth() === C.m) ? isoOf(t0) : isoOf(d);
  }
  // calDayList912 — v2.9.13 version further down (Open / Done ✓ / Missed)
  // calHtml912 — v2.9.13 version further down (dot = open, ring = done)
  function calPaint912(keepFocus) {
    const box = $('#cal912 .c912-cal'); if (!box) return;
    const fa = document.activeElement, wasDay = fa && fa.closest && fa.closest('.c912-grid'), wasEl = fa && fa.closest && fa.closest('#cal912') ? (fa.dataset.c912F ? '[data-c912-f="' + fa.dataset.c912F + '"]' : fa.dataset.c912Mo ? '[data-c912-mo="' + fa.dataset.c912Mo + '"]' : fa.hasAttribute('data-c912-today') ? '[data-c912-today]' : '') : '';
    const y = ($('#cal912 .c912-dl') || {}).scrollTop || 0, same = box.dataset.sel === cal912().sel;
    box.innerHTML = calHtml912(); box.dataset.sel = cal912().sel;
    const dl = $('#cal912 .c912-dl'); if (dl && same) dl.scrollTop = y;
    if (keepFocus || wasDay) { const s = $('#cal912 .c912-d.is-sel'); if (s) s.focus({ preventScroll: true }); }
    else if (wasEl) { const el = $('#cal912 ' + wasEl); if (el) el.focus({ preventScroll: true }); }
  }
  function openCal912(from) {
    if ($('#cal912')) return;
    closeOverlays(true);
    const C = cal912(); calPick912(state.wkDay92 || isoOf(today0()));
    C.from = from || document.activeElement;
    const ph = isPh912();
    document.body.insertAdjacentHTML('beforeend', '<div class="c912-ov' + (ph ? ' is-ph' : '') + '" id="cal912"><div class="c912-cal' + (ph ? ' is-ph' : '') + '" role="dialog" aria-modal="true" aria-labelledby="c912Title" tabindex="-1"></div></div>');
    calPaint912();
    const ov = $('#cal912');
    requestAnimationFrame(() => { ov.classList.add('is-in'); const s = $('#cal912 .c912-d.is-sel'); (s || $('#cal912 .c912-cal')).focus({ preventScroll: true }); });
  }
  function closeCal912(quiet) {
    const ov = $('#cal912'); if (!ov) return;
    const C = cal912(), back = C.from; C.from = null;
    ov.classList.remove('is-in'); ov.classList.add('is-out');
    ov.removeAttribute('id');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => ov.remove(), reduce ? 0 : 220);
    if (!quiet && back && document.body.contains(back)) back.focus({ preventScroll: true });
  }
  function initCal912() {
    document.addEventListener('click', (e) => {
      const ob = e.target.closest('[data-act="cal912"]'); if (ob) { openCal912(ob); return; }
      const ov = e.target.closest('.c912-ov'); if (!ov || !ov.id) return;
      const C = cal912();
      if (e.target === ov || e.target.closest('[data-c912-close]')) { closeCal912(); return; }
      const jb = e.target.closest('[data-c912-job]'); if (jb) { closeCal912(true); openJob(jb.dataset.c912Job); return; }
      const dy = e.target.closest('[data-c912-day]');
      if (dy) { const iso = dy.dataset.c912Day, d = parseDate(iso); if (d && d.getMonth() !== C.m) calPick912(iso); else C.sel = iso; calPaint912(true); return; }
      const mo = e.target.closest('[data-c912-mo]'); if (mo) { calMonth912(+mo.dataset.c912Mo); calPaint912(); return; }
      if (e.target.closest('[data-c912-today]')) { calPick912(isoOf(today0())); calPaint912(); return; }
      const fc = e.target.closest('[data-c912-f]'); if (fc) { C.f = fc.dataset.c912F; calPaint912(); return; }
    });
    // keyboard: Esc closes · arrows move the day · Page Up / Down the month · T today · Tab stays inside
    document.addEventListener('keydown', (e) => {
      const ov = $('#cal912'); if (!ov) return;
      const C = cal912(), k = e.key;
      if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeCal912(); return; }
      if (k === 'Tab') {
        const f = $$('#cal912 button:not([tabindex="-1"]), #cal912 .c912-d.is-sel').filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (i === f.length - 1 || i === -1)) { e.preventDefault(); f[0].focus(); }
        return;
      }
      const inGrid = document.activeElement && document.activeElement.closest && document.activeElement.closest('.c912-grid');
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[k];
      if (step && inGrid) { e.preventDefault(); calPick912(isoOf(addDays(parseDate(C.sel) || today0(), step))); calPaint912(true); return; }
      if (k === 'PageUp' || k === 'PageDown') { e.preventDefault(); calMonth912(k === 'PageUp' ? -1 : 1); calPaint912(true); return; }
      if ((k === 't' || k === 'T') && !e.metaKey && !e.ctrlKey) { calPick912(isoOf(today0())); calPaint912(true); }
    }, true);
    // phone: swipe the month sideways, pull the sheet down to close
    let sx = 0, sy = 0, where = '';
    document.addEventListener('touchstart', (e) => {
      if (!$('#cal912') || !e.target.closest('#cal912')) { where = ''; return; }
      const t = e.touches[0]; sx = t.clientX; sy = t.clientY;
      where = e.target.closest('.c912-grid') ? 'grid' : e.target.closest('[data-c912-grab], .c912-mh') ? 'grab' : '';
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (!where || !$('#cal912')) return;
      const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (where === 'grid' && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) { calMonth912(dx < 0 ? 1 : -1); calPaint912(); }
      else if (where === 'grab' && dy > 80 && Math.abs(dy) > Math.abs(dx)) closeCal912();
      where = '';
    }, { passive: true });
    window.addEventListener('hashchange', () => closeCal912(true));
  }

  // ---------------------------------------------------------------- 3 · MISSING INFO (top of MY DAY)
  // Own jobs (+ covered), from the jobs already loaded: no ETA once sailed · no BL / AWB no. once sailed or sailing within
  // 2 days · no line within 3 days of the ETD (the tracker has no vessel column) · no POL / POD. On hold and misc jobs are left out.
  function when912(j, t0) {
    const air = j.mode === 'air', cr = j.mode === 'courier';
    if (j.etd) {
      const n = days(t0, j.etd);
      if (n < 0) return (cr ? 'picked up ' : air ? 'departed ' : 'sailed ') + dm912(j.etd);
      const v = cr ? 'pick-up ' : air ? 'departs ' : 'sails ';
      return v + (n === 0 ? 'today' : n === 1 ? 'tomorrow' : dm912(j.etd));
    }
    if (j.eta) { const n = days(t0, j.eta); return n < 0 ? 'arrived ' + dm912(j.eta) : 'arrives ' + (n === 0 ? 'today' : n === 1 ? 'tomorrow' : dm912(j.eta)); }
    return 'no dates yet';
  }
  function missing912() {
    const t0 = today0(), out = [];
    scoped().forEach((j) => {
      if (!j.active || j.hold || j.mode === 'misc' || !TYPE_FIELDS[j.type]) return;
      const sd = j.etd ? days(t0, j.etd) : null, air = j.mode === 'air', cr = j.mode === 'courier', miss = [];
      if (!cr) {
        if (sd !== null && sd < 0 && !j.eta) miss.push(['eta', 'ETA']);
        if (sd !== null && sd <= 2 && j.bl !== NA && !blList98(j.raw.blNo).length) miss.push(['blNo', air ? 'AWB no.' : 'BL no.']);
        if (sd !== null && sd <= 3 && !j.vendor) miss.push(['vendor', air ? 'Airline' : 'Line']);
      }
      if (!j.pol) miss.push(['pol', cr ? 'From' : 'POL']);
      if (!j.pod) miss.push(['pod', cr ? 'To' : 'POD']);
      if (miss.length) out.push({ j, miss, n: sd !== null ? sd : j.eta ? days(t0, j.eta) : null, when: when912(j, t0) });
    });
    const rank = (x) => (x.n === null ? [2, 0] : x.n >= 0 ? [0, x.n] : [1, -x.n]);   // coming up first (soonest), then gone (latest), then no dates
    return out.sort((a, b) => { const p = rank(a), q = rank(b); return p[0] - q[0] || p[1] - q[1] || String(a.j.jobNo).localeCompare(String(b.j.jobNo)); });
  }
  function missBox912() {
    if (!canEdit()) return '';   // Customer Service fills the tracker (sales see their jobs, they do not edit them)
    const L = missing912(); if (!L.length) return '';
    const all = !!state.mi912All, show = all || L.length <= 4 ? L : L.slice(0, 3);
    return '<div class="mi912" role="region" aria-label="Missing info">' +
      '<div class="mi912-h"><span>MISSING INFO · ' + L.length + (L.length === 1 ? ' JOB' : ' JOBS') + '</span><span aria-hidden="true">FIX</span></div>' +
      show.map((x) => '<div class="mi912-r"><button type="button" class="mi912-no" data-job="' + esc(x.j.jobNo) + '">' + esc(x.j.jobNo) + '</button><span class="mi912-w">' + esc(x.miss.map((m) => m[1]).join(' · ')) + '</span><em>' + esc(x.when) + '</em>' +
        '<button type="button" class="mi912-fill" data-mi912-fill="' + esc(x.j.jobNo) + '" data-mi912-f="' + esc(x.miss.map((m) => m[0]).join(',')) + '" aria-label="' + esc('Fill ' + x.miss.map((m) => m[1]).join(' and ') + ' for ' + x.j.jobNo) + '">Fill</button></div>').join('') +
      (L.length > show.length || all && L.length > 4 ? '<button type="button" class="mi912-more" data-mi912-more>' + (all ? 'Show fewer' : (L.length - show.length) + ' more') + '</button>' : '') +
    '</div>';
  }
  // Fill: Edit details opens with every missing field marked, the cursor in the first one
  function fill912(no, fields) {
    const j = findJob(no); if (!j || !canEditJob(j)) return;
    openEdit(no);
    const F = String(fields || '').split(',').filter(Boolean);
    setTimeout(() => {
      const form = $('#editForm'); if (!form) return;
      let first = null;
      F.forEach((f) => { const box = form.querySelector('[data-field="' + f + '"]'); if (!box) return; box.classList.add('is-miss912'); if (!first) first = box; });
      if (!first) return;
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const inp = first.querySelector('input:not([type="hidden"]), select, textarea'); if (inp) inp.focus({ preventScroll: true });
    }, 60);
  }

  // ---------------------------------------------------------------- 4 · Copy from job… (costing page)
  // Any costing you can open is a source; its lines come in as this job's draft (charges, vendors, basis, amounts,
  // currencies and USD rates — box quantities follow this job). Nothing is saved until Save.
  const cp912 = () => state.cp912 || (state.cp912 = { q: '', step: 'pick' });
  function cpSources912(j) {
    const K = String(j.jobNo).toUpperCase(), cu = upq(j.customer);
    return state.jobs.filter((x) => { const s = state.costing[String(x.jobNo).toUpperCase()]; return String(x.jobNo).toUpperCase() !== K && canCostSee(x) && s && (s[0] === 'DRAFT' || s[0] === 'LOCKED') && (Number(s[1]) || Number(s[2])); })
      .map((x) => { const s = state.costing[String(x.jobNo).toUpperCase()]; return { x, s, g: upq(x.customer) === cu && cu ? 0 : x.type === j.type ? 1 : 2, at: Number(s[5]) || 0 }; })
      .sort((a, b) => a.g - b.g || b.at - a.at);
  }
  function cpRow912(o) {
    const x = o.x, s = o.s;
    return '<button type="button" class="cp912-row" data-cp912="' + esc(x.jobNo) + '"><span class="cp912-a"><b>' + esc(x.jobNo) + '</b><i>' + esc(x.type) + '</i></span>' +
      '<span class="cp912-c">' + esc(x.customer || '—') + '</span><span class="cp912-d">' + esc(x.mode === 'misc' ? (x.against ? 'Against ' + x.against : 'Costing only') : nice(x.route)) + '</span>' +
      '<span class="cp912-s">' + (s[0] === 'LOCKED' ? 'DONE' : 'DRAFT') + ' · SELL ' + money(s[1]) + '</span></button>';
  }
  function cpList912(j) {
    const P = cp912(), q = upq(P.q), src = cpSources912(j);
    const hit = q ? src.filter((o) => (o.x.jobNo + ' ' + o.x.customer + ' ' + o.x.route + ' ' + o.x.type).toUpperCase().includes(q)) : src;
    const names = ['THIS CUSTOMER', 'SAME JOB TYPE', 'OTHER JOBS'];
    let html = '', last = -1;
    hit.slice(0, 40).forEach((o) => { if (!q && o.g !== last) { last = o.g; html += '<div class="cp912-gh">' + names[o.g] + '</div>'; } html += cpRow912(o); });
    const look = q.replace(/\s+/g, '');
    if (/^(?=.*\d)[A-Z0-9/-]{6,}$/.test(look) && !hit.some((o) => String(o.x.jobNo).toUpperCase() === look) && look !== String(j.jobNo).toUpperCase())
      html += '<button type="button" class="cp912-row cp912-look" data-cp912="' + esc(look) + '"><span class="cp912-a"><b>' + esc(look) + '</b></span><span class="cp912-c">Open this job’s costing — closed jobs too</span></button>';
    return html || '<div class="cp912-none">' + esc(q ? 'No costing matches “' + P.q.trim() + '”.' : 'No other job has a saved costing yet.') + '</div>';
  }
  function cpDraft912(j, data) {   // the source's lines as this job's draft lines (new ids)
    const fx0 = Number(data.rate) || COMPANY_FX();
    return (data.lines || []).map((l) => {
      const bc = l.bc || 'AED', sc = l.sc || 'AED';
      const bx = bc === 'USD' ? fxTxt(l.bx || fx0) : '', sx = sc === 'USD' ? fxTxt(l.sx || fx0) : '';
      const basis = l.basis || 'SHIP', qty = l.qty === 0 ? '0' : numTxt(l.qty) || '1';
      return { id: newLineId(), charge: l.charge, vendor: l.vendor || '', basis, qty: ['BOX', 'B20', 'B40'].includes(basis) ? costQtyFor(j, basis, qty) : qty, bc, br: numTxt(l.br), bx, sc, sr: numTxt(l.sr), sx, bxAuto: !bx || num6(bx) === vendorFx(l.vendor), was912: qty };
    });
  }
  const cpBuild912 = (j) => () => {
    const P = cp912(), C = costFor(j.jobNo), have = C && C.draft ? C.draft.lines.filter((l) => String(l.charge || '').trim()).length : 0;
    if (P.step === 'pick') {
      return '<div class="pop-title">Copy charges from a job</div><p class="pop-text cp912-lead">Its lines come in as this job’s draft — change anything, then Save.</p>' +
        '<label class="search cp912-q">' + icon('search', 16) + '<input type="search" id="cp912Q" autocomplete="off" spellcheck="false" placeholder="Job number or customer" aria-label="Find a job" value="' + esc(P.q) + '"></label>' +
        '<div class="cp912-list" id="cp912List">' + cpList912(j) + '</div>';
    }
    const back = '<button type="button" class="link-btn cp912-back" data-cp912-back>' + icon('l912', 14) + 'Pick another job</button>';
    if (P.step === 'load') return back + '<div class="cp912-src is-loading"><span class="sk"></span><span class="sk"></span><span class="sk short"></span></div>';
    if (P.step === 'err') return back + '<div class="cp912-none is-err">' + esc(P.err || 'Could not open that costing.') + '</div><button type="button" class="btn-ghost pop-wide" data-cp912="' + esc(P.src) + '">Try again</button>';
    const D = P.data, x = findJob(P.src), lines = cpDraft912(j, D), t = costTotals(lines), moved = lines.filter((l) => l.qty !== l.was912).length;
    const head = '<div class="cp912-src"><div class="cp912-a"><b>' + esc(P.src) + '</b><i>' + esc((x && x.type) || D.type || '') + '</i><span class="cp912-st">' + (D.closed ? 'CLOSED JOB' : D.status === 'LOCKED' ? 'COSTING DONE' : 'DRAFT · V' + esc(D.version)) + '</span></div>' +
      '<div class="cp912-c">' + esc((x && x.customer) || D.customer || '') + '</div>' + (x ? '<div class="cp912-d">' + esc(nice(x.route)) + '</div>' : '') + '</div>';
    if (!lines.length) return back + head + '<div class="cp912-none">This costing has no charges to copy.</div>';
    const amt = (l, k) => (k === 's' && !num6(l.sr) ? 'incl.' : l[k + 'c'] + ' ' + money(num6(l[k + 'r']) || 0));
    return back + head +
      '<ol class="cp912-lines">' + lines.map((l) => '<li><span class="cp912-ln">' + esc(l.charge) + '</span><span class="cp912-lv">' + esc((l.vendor ? l.vendor + ' · ' : '') + (BASIS_SHORT[l.basis] || l.basis) + ' × ' + l.qty) + '</span>' +
        '<span class="cp912-lm"><em>BUY</em>' + esc(amt(l, 'b')) + '<em>SELL</em>' + esc(amt(l, 's')) + '</span></li>').join('') + '</ol>' +
      '<div class="cp912-tot"><span><em>BUYING</em>' + money(t.buy) + '</span><span><em>SELLING</em>' + money(t.sell) + '</span><span class="' + (t.profit < 0 ? 'is-loss' : '') + '"><em>PROFIT · AED</em>' + money(t.profit) + '</span></div>' +
      (moved ? '<p class="pop-text cp912-note">Box quantities follow this job (' + esc(j.cargo || boxesOf(j) + ' boxes') + ').</p>' : '') +
      (have ? '<div class="pop-label">The ' + have + (have === 1 ? ' charge' : ' charges') + ' already here</div><div class="seg seg-mini cp912-mode" role="group" aria-label="The charges already here">' +
        '<button type="button" data-cp912-mode="replace" aria-pressed="' + (P.mode !== 'add') + '">Replace them</button><button type="button" data-cp912-mode="add" aria-pressed="' + (P.mode === 'add') + '">Keep and add</button></div>' : '') +
      '<button type="button" class="btn-brutal pop-main" data-primary data-cp912-use>COPY ' + lines.length + (lines.length === 1 ? ' CHARGE' : ' CHARGES') + '</button>' +
      '<div class="pop-note">NOTHING IS SAVED UNTIL YOU PRESS SAVE</div>';
  };
  function cpOpen912(anchor, j) {
    state.cp912 = { q: '', step: 'pick', mode: 'replace' };
    openPop(anchor, 'COPY FROM JOB', cpBuild912(j));
    setTimeout(() => { const q = $('#cp912Q'); if (q && !isTouch()) q.focus(); }, 40);
  }
  async function cpPick912(j, no) {
    const P = cp912(), K = String(no).toUpperCase();
    Object.assign(P, { step: 'load', src: K, data: null, err: '' }); refreshOverlay();
    try {
      const res = await api.call('ethixCosting', [K]);
      if (state.cp912 !== P || P.src !== K) return;
      if (res && res.ok && res.costing) { P.data = res.costing; P.step = 'preview'; }
      else { P.step = 'err'; P.err = (res && res.error) || 'Could not open that costing.'; }
    } catch (e) { if (state.cp912 !== P) return; P.step = 'err'; P.err = e.kind === 'auth' ? 'Please sign in again.' : e.message; }
    refreshOverlay();
    const b = $('[data-cp912-use]'); if (b && !isTouch()) b.focus({ preventScroll: true });
  }
  function cpUse912(j) {
    const P = cp912(), C = costFor(j.jobNo); if (!P.data || !C || !C.draft || !costCanEdit(j, C.data)) return;
    const lines = cpDraft912(j, P.data).map((l) => { delete l.was912; return l; });
    const before = C.draft.lines.slice(), wasDirty = C.dirty, src = P.src;
    const keep = before.filter((l) => String(l.charge || '').trim() || num6(l.br) || num6(l.sr));
    C.draft.lines = P.mode === 'add' && keep.length ? keep.concat(lines) : lines;
    C.dirty = true;
    state.cp912 = null; closeOverlays(true); rerender();
    const row = document.querySelector('.ct-row[data-line="' + lines[0].id + '"]'); if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    $$('.ct-row').forEach((r) => { if (lines.some((l) => l.id === r.dataset.line)) r.classList.add('is-new912'); });
    toast(lines.length + (lines.length === 1 ? ' charge' : ' charges') + ' copied from ' + src + ' · not saved yet', { action: { label: 'Undo', fn: () => { const C2 = costFor(j.jobNo); if (!C2 || !C2.draft) return; C2.draft.lines = before; C2.dirty = wasDirty; rerender(); } } });
  }
  function initCopy912() {
    $('#view').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act="cost-copy912"]'); if (!b) return;
      const r = state.route; if (!r || r.name !== 'costjob') return;
      const j = findJob(r.jobNo), C = j && costFor(j.jobNo); if (!C || !C.draft || !costCanEdit(j, C.data)) return;
      cpOpen912(b, j);
    });
    const onPop = (e) => {
      if (!state.cp912) return;
      const r = state.route, j = r && r.name === 'costjob' ? findJob(r.jobNo) : null; if (!j) return;
      const pk = e.target.closest('[data-cp912]'); if (pk) { e.stopPropagation(); cpPick912(j, pk.dataset.cp912); return; }
      if (e.target.closest('[data-cp912-back]')) { e.stopPropagation(); const P = cp912(); P.step = 'pick'; P.data = null; refreshOverlay(); const q = $('#cp912Q'); if (q && !isTouch()) q.focus(); return; }
      const md = e.target.closest('[data-cp912-mode]'); if (md) { e.stopPropagation(); cp912().mode = md.dataset.cp912Mode; refreshOverlay(); return; }
      if (e.target.closest('[data-cp912-use]')) { e.stopPropagation(); cpUse912(j); }
    };
    $('#pop').addEventListener('click', onPop, true);
    $('#drawerBody').addEventListener('click', onPop, true);
    const onInput = (e) => {
      if (!e.target || e.target.id !== 'cp912Q' || !state.cp912) return;
      const r = state.route, j = r && r.name === 'costjob' ? findJob(r.jobNo) : null; if (!j) return;
      state.cp912.q = e.target.value; const L = $('#cp912List'); if (L) L.innerHTML = cpList912(j);
    };
    $('#pop').addEventListener('input', onInput);
    $('#drawerBody').addEventListener('input', onInput);
    const onKey = (e) => { if (e.key === 'Enter' && e.target && e.target.id === 'cp912Q') { e.preventDefault(); const f = $('#cp912List [data-cp912]'); if (f) f.click(); } };
    $('#pop').addEventListener('keydown', onKey);
    $('#drawerBody').addEventListener('keydown', onKey);
  }

  function applyBoot912(boot) { if (boot && Array.isArray(boot.holAE)) state.holAE912 = boot.holAE; }
  function initV2912() {
    initCal912();
    initCopy912();
    $('#view').addEventListener('click', (e) => {
      const f = e.target.closest('[data-mi912-fill]'); if (f) { e.stopPropagation(); fill912(f.dataset.mi912Fill, f.dataset.mi912F); return; }
      if (e.target.closest('[data-mi912-more]')) { e.stopPropagation(); state.mi912All = !state.mi912All; rerender(); }
    }, true);
  }

  // ==================================================================== v2.9.13 — admin and safety (6 Nov 2026)
  // 5 System health · 6 the yearly archive · 7 the problem log · 8 customer names tidy-up (admin) · 9 calendar cutoffs open / done
  I.health913 = '<path d="M3 12.5h4.2l2.3-5.5 4 11 2.4-5.5H21"/>';
  I.names913 = '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16.2a3.4 3.4 0 0 1 6.4 0M14.5 10h4M14.5 13.5h3"/>';
  I.arch913 = '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>';
  const n913 = (v) => Number(v || 0).toLocaleString('en-US');
  const p2913 = (v) => String(v).padStart(2, '0');
  // a moment as Dubai reads it: "Today 02:14" · "Yesterday 08:31" · "Wed 4 Nov 16:42" (+ the year when not this year)
  function when913(t, noDay) {
    if (!t) return '';
    const d = dxb(t), d0 = new Date(d); d0.setHours(0, 0, 0, 0);
    const n = days(d0, today0()), hm = p2913(d.getHours()) + ':' + p2913(d.getMinutes());
    const day = n === 0 ? 'Today' : n === 1 ? 'Yesterday' : DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON91[d.getMonth()] + (d.getFullYear() !== today0().getFullYear() ? ' ' + d.getFullYear() : '');
    return noDay ? hm : day + ' ' + hm;
  }
  const logWhen913 = (t) => { const d = dxb(t); return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON91[d.getMonth()] + ' ' + p2913(d.getHours()) + ':' + p2913(d.getMinutes()); };

  // -------------------------------------------------------------------- 7 · the problem log — what the app saw
  // No connection / no answer in time (sent once it works again), an error page from Google instead of an answer, an app
  // error. Background reads that fail while a laptop sleeps are not problems; nothing typed and no password is ever sent.
  const QUIET913 = ['ethixPing', 'ethixBootstrap', 'ethixNotifications', 'ethixNotifMore', 'ethixSeen', 'ethixSeenAll', 'ethixLogProblem', 'ethixSearchText', 'ethixArchiveSearch',
    'ethixLists', 'ethixReminders', 'ethixJobStory', 'ethixFollowHistory', 'ethixAdminList', 'ethixAdminActivity', 'ethixAdminHealth', 'ethixAdminNames'];
  const P913 = { q: (() => { const v = store.get('ethix.p913', []); return Array.isArray(v) ? v : []; })(), down: null, sent: 0, busy: false, errs: 0, seen: {} };
  const dev913 = () => { const u = navigator.userAgent || ''; return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac/.test(u) ? 'Mac' : 'Browser'; };
  const job913 = (a) => { const v = Array.isArray(a) ? a[0] : ''; const t = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''; return /^[A-Z0-9][A-Z0-9\-\/]{3,19}$/i.test(t) && /\d/.test(t) ? t.toUpperCase() : ''; };
  const dur913 = (ms) => { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? s + ' s' : s < 3600 ? Math.round(s / 60) + ' min' : Math.floor(s / 3600) + ' h ' + Math.round((s % 3600) / 60) + ' min'; };
  function p913Push(x) { P913.q.push(x); if (P913.q.length > 20) P913.q = P913.q.slice(-20); store.set('ethix.p913', P913.q); }
  function p913Flush() {
    if (P913.busy || !P913.q.length || !api.token || !api.connected) return;
    const wait = 15000 - (Date.now() - P913.sent);
    if (wait > 0) { clearTimeout(P913.t); P913.t = setTimeout(p913Flush, wait + 50); return; }   // at most one report every 15 s
    P913.busy = true; P913.sent = Date.now();
    const batch = P913.q.slice(0, 10);
    api.call('ethixLogProblem', [batch, dev913()]).then(() => { P913.q = P913.q.slice(batch.length); store.set('ethix.p913', P913.q); }).catch(() => {}).finally(() => { P913.busy = false; });
  }
  function p913Fail(fn, args, e) {
    if (fn === 'ethixLogProblem' || !e) return;
    if (e.kind === 'network') {
      const slow = /too long/i.test(e.message);
      if (QUIET913.includes(fn)) { if (!P913.down) P913.down = { t: Date.now(), fn: '', job: '', slow, quiet: true }; return; }
      if (!P913.down || P913.down.quiet) P913.down = { t: P913.down ? P913.down.t : Date.now(), fn, job: job913(args), slow };
      return;
    }
    if (e.kind === 'server' && /unexpected reply/i.test(e.message)) { p913Push({ t: Date.now(), fn, job: job913(args), what: 'Google sent an error page instead of an answer' }); setTimeout(p913Flush, 1500); }
  }
  function p913Ok(fn) {
    const d = P913.down;
    if (d) { P913.down = null; if (!d.quiet) p913Push({ t: d.t, fn: d.fn, job: d.job, what: (d.slow ? 'No answer from Google in time' : 'No connection') + ' — worked again after ' + dur913(Date.now() - d.t) }); }
    if (P913.q.length) setTimeout(p913Flush, fn === 'ethixSignIn' ? 4000 : 600);
  }
  const call0913 = api.call;
  api.call = async function (fn, args = [], opts = {}) {
    let r;
    try { r = await call0913.call(this, fn, args, opts); } catch (e) { p913Fail(fn, args, e); throw e; }
    if (fn !== 'ethixLogProblem') p913Ok(fn);
    return r;
  };
  function p913Err(msg, where) {
    msg = String(msg || '').replace(/^Uncaught\s+/, '').replace(/^(Error|TypeError|ReferenceError|RangeError|SyntaxError):\s*/, '');
    if (P913.errs >= 3 || !msg || P913.seen[msg] || /ResizeObserver|^Script error/i.test(msg)) return;
    P913.errs++; P913.seen[msg] = 1;
    p913Push({ t: Date.now(), doing: 'Using EWS' + (state.route ? ' · ' + state.route.name : ''), what: 'App error: ' + msg.slice(0, 120), details: ('v2.9.13 · ' + String(where || '')).slice(0, 500) });
    setTimeout(p913Flush, 1500);
  }
  window.addEventListener('error', (e) => {
    if (!e || (e.filename && !/\/v2\/|app\.js|config\.js/.test(e.filename))) return;
    p913Err(e.message, String(e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno + (e.error && e.error.stack ? ' | ' + String(e.error.stack).split('\n').slice(0, 3).join(' / ') : ''));
  });
  window.addEventListener('unhandledrejection', (e) => { const r = e && e.reason; if (!r || r instanceof ApiError) return; p913Err(r.message || String(r), r.stack ? String(r.stack).split('\n').slice(0, 3).join(' / ') : ''); });

  // -------------------------------------------------------------------- 5 · System health (admin)
  const h913 = () => state.h913 || (state.h913 = { data: null, loading: false, err: '', all: false, more: false, run: null });
  function loadHealth913(force) {
    const H = h913(); if (H.loading) return;
    H.loading = true; H.err = '';
    if (state.route && state.route.name === 'health') rerender();
    api.call('ethixAdminHealth', [!!force], { timeout: 60000 }).then((d) => { H.data = d; H.got = Date.now(); })
      .catch((e) => { H.err = /not available/i.test(e.message) ? 'System health needs the v2.9.13 Code.gs.' : e.message; })
      .finally(() => { H.loading = false; if (state.route && state.route.name === 'health') rerender(); });
  }
  function tone913(D) {   // the four cards: [tone, big, sub]
    const t0 = today0(), now = dxb(), pct = D.cells / D.max * 100;
    const size = [pct < 50 ? 'ok' : pct < 80 ? 'warn' : 'bad', (pct > 0 && pct < 1 ? '<1' : Math.round(pct)) + '%',
      (D.cells >= 1e6 ? (D.cells / 1e6).toFixed(1) + ' million' : n913(Math.round(D.cells / 1000)) + ' thousand') + ' of ' + (D.max / 1e6) + ' million cells'];
    const B = D.backup || {}, age = B.t ? (Date.now() - B.t) / 36e5 : 1e9;
    const backup = [B.on === false && !B.t ? 'bad' : age <= 30 ? 'ok' : age <= 54 ? 'warn' : 'bad', B.t ? when913(B.t) : 'None yet',
      B.on === false ? 'nightly backup not switched on' : n913(B.copies) + (B.copies === 1 ? ' copy' : ' copies') + ' kept · ETHIX BACKUPS'];
    const M = D.mail || {}, sentDay = M.t ? isoOf((() => { const d = dxb(M.t); d.setHours(0, 0, 0, 0); return d; })()) : M.day || '';
    const sentToday = sentDay === isoOf(t0), late = !M.off && !sentToday && (now.getHours() * 60 + now.getMinutes()) >= 9 * 60 + 30;
    const part = M.n !== null && M.n !== undefined && M.of && M.n < M.of;
    const big = M.t ? when913(M.t) : M.day ? (() => { const d = parseDate(M.day); const n = d ? days(d, t0) : 9; return n === 0 ? 'Today' : n === 1 ? 'Yesterday' : d ? DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON91[d.getMonth()] : 'Not yet'; })() : 'Not yet';
    const sub = M.on === false ? 'not switched on' : late ? 'not sent yet today' : M.off && !sentToday ? 'none today · ' + (M.off === 'weekend' ? 'weekend' : M.off) :
      M.n === null || M.n === undefined ? (M.day ? 'sent' : 'starts on the next working day') : 'sent to ' + (part ? M.n + ' of ' + M.of : M.n) + (M.of === 1 && !part ? ' person' : ' people');
    const mail = [M.on === false || late || part ? 'warn' : 'ok', big, sub];
    const p = D.problems || 0;
    const probs = [p === 0 ? 'ok' : p < 10 ? 'warn' : 'bad', String(p), p === 0 ? 'nothing went wrong' : p === 1 ? 'in the log below' : p === 2 ? 'both in the log below' : 'all in the log below'];
    return { size, backup, mail, probs };
  }
  function healthHead913(anim) {
    return '<header class="hl913-head' + anim + '"><div><div class="hl913-kick">ADMIN</div><h1>System health</h1>' +
      '<p class="hl913-sub">How EWS is doing today — checked every hour. All good unless something is amber or red.</p></div>' +
      '<button type="button" class="btn-ghost hl913-ref" data-h913="refresh" aria-label="Check again"><span class="spin">' + icon('refresh', 16) + '</span><span class="btn-label">Check again</span></button></header>';
  }
  function renderHealth913(first) {
    const H = h913(), D = H.data, anim = first ? ' reveal' : '';
    if (!D && !H.loading && !H.err) setTimeout(() => loadHealth913(false), 0);
    else if (D && first && Date.now() - (H.got || 0) > 5 * 60000) setTimeout(() => loadHealth913(false), 0);
    const view = $('#view');
    if (!D) {
      view.innerHTML = '<div class="hl913-pg">' + healthHead913(anim) + (H.err ? '<section class="hl913-card hl913-msg">' + empty('alert', H.err) + '<button type="button" class="btn-ghost" data-h913="refresh">Try again</button></section>'
        : '<div class="hl913-row is-wait">' + [0, 1, 2, 3].map(() => '<div class="hl913-t is-wait"><small></small><b></b><span></span></div>').join('') + '</div>') + '</div>';
      view.classList.toggle('is-busy913', !!H.loading);
      return;
    }
    const T = tone913(D);
    const tile = (k, x) => '<div class="hl913-t is-' + x[0] + '" role="group" aria-label="' + esc(k + ': ' + x[1] + ', ' + x[2]) + '"><small>' + k + '</small><b>' + esc(x[1]) + '</b><span>' + esc(x[2]) + '</span></div>';
    // TABS: JOBS (live) first, then the biggest
    const tabs = D.tabs || [], live = tabs.filter((t) => t.live), rest = tabs.filter((t) => !t.live && t.rows > 0).sort((a, b) => b.rows - a.rows);
    const shown = live.concat(H.all ? rest : rest.slice(0, 5));
    const bar = (t) => { const w = t.rows ? Math.max(2, Math.min(100, Math.round(t.rows / t.cap * 100))) : 0; return '<div class="hl913-bar' + (w >= 80 ? ' is-full' : '') + '" title="' + esc(n913(t.rows) + ' of a comfortable ' + n913(t.cap)) + '"><i style="width:' + w + '%"></i></div>'; };
    const tabsCard = '<section class="hl913-card hl913-tabs"><div class="hl913-h"><b>TABS</b><span>rows used</span>' + (rest.length > 5 ? '<button type="button" class="hl913-link" data-h913="tabs">' + (H.all ? 'Fewer' : 'All ' + (rest.length + live.length) + ' tabs') + '</button>' : '') + '</div>' +
      shown.map((t) => '<div class="hl913-tb"><span>' + esc(t.name) + '</span><em>' + n913(t.rows) + '</em>' + bar(t) + '</div>').join('') +
      '<p class="hl913-note">Opening the app reads only the live tabs, so speed depends on JOBS and the last weeks of FOLLOWUPS — not on the archive.</p></section>';
    // YEARLY ARCHIVE
    const Y = D.year || { n: 0, files: [] }, R = H.run, mins = Math.max(1, Math.round((Y.n || 0) / 600));
    const files = (Y.files || []).filter((f) => f.n > 0);
    const filesLine = files.length ? '<div class="hl913-files">' + files.map((f) => '<a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + icon('arch913', 14) + '<span>' + esc(f.name) + '</span><em>' + n913(f.n) + (f.n === 1 ? ' job' : ' jobs') + '</em></a>').join('') + '</div>' : '';
    let act;
    if (R) {
      const pc = R.total ? Math.round(R.moved / R.total * 100) : 0;
      act = '<div class="hl913-prog" role="status" aria-live="polite"><div class="hl913-pb"><i style="width:' + (R.phase === 'backup' ? 4 : Math.max(6, pc)) + '%"></i></div><span>' +
        esc(R.phase === 'backup' ? 'Taking the backup first…' : 'Moving… ' + n913(R.moved) + ' of ' + n913(R.total)) + '</span></div>';
    } else act = Y.n ? '<div class="hl913-act"><button type="button" class="hl913-btn" data-h913="arch">Move ' + n913(Y.n) + (Y.n === 1 ? ' job' : ' jobs') + ' to ' + esc(Y.name) + '</button><span>Every November · about ' + mins + (mins === 1 ? ' minute' : ' minutes') + '</span></div>'
      : '<div class="hl913-act"><span>Every November</span></div>';
    const archCard = '<section class="hl913-card hl913-arch"><div class="hl913-h"><b>YEARLY ARCHIVE</b><span>keeps EWS fast for years</span></div>' +
      '<div class="hl913-ab"><span class="hl913-ai">' + icon('arch913', 18) + '</span><div><b>' + (Y.n ? n913(Y.n) + (Y.n === 1 ? ' closed job is' : ' closed jobs are') + ' older than 12 months' : 'No closed job is older than 12 months') + '</b>' +
        '<span>closed before ' + esc(Y.cut || '') + (Y.n ? ' · with their follow-ups, notes and history' : ' — nothing to move') + '</span></div></div>' +
      '<ul class="hl913-ul"><li>They move to a separate Google Sheet: <b>' + esc(Y.name || '') + '</b></li><li>Search still finds them — they open read-only, marked ' + esc(String(Y.name || '').replace(/^EWS /, '')) + '</li><li>A backup is taken first; nothing is deleted</li></ul>' +
      filesLine + act + '</section>';
    // PROBLEM LOG
    const L = D.log || [], cut = H.more ? L : L.slice(0, 8);
    const ph = !usePop();
    const rows = cut.map((x, i) => ph
      ? '<li class="hl913-lr"><div><b>' + esc(logWhen913(x.t)) + '</b><span>' + esc(x.who) + '</span></div><p>' + esc(x.doing) + '</p><p class="is-what">' + esc(x.what) + '</p><button type="button" class="hl913-link" data-h913="det" data-i="' + i + '">Details</button></li>'
      : '<tr><td class="m">' + esc(logWhen913(x.t)) + '</td><td>' + esc(x.who) + '</td><td>' + esc(x.doing) + '</td><td>' + esc(x.what) + '</td><td><button type="button" class="hl913-link" data-h913="det" data-i="' + i + '">Details</button></td></tr>').join('');
    const logCard = '<section class="hl913-card hl913-log"><div class="hl913-h"><b>PROBLEM LOG</b><span>the LOG tab · last 7 days</span>' + (L.length ? '<button type="button" class="hl913-link hl913-cp" data-h913="copy">' + icon('copy', 14) + 'Copy for Claude</button>' : '') + '</div>' +
      (!L.length ? '<div class="hl913-none">' + icon('check', 18) + '<span>Nothing went wrong in the last 7 days.</span></div>'
        : ph ? '<ul class="hl913-ll">' + rows + '</ul>'
        : '<table class="hl913-tbl"><thead><tr><th>WHEN</th><th>WHO</th><th>DOING</th><th>WHAT HAPPENED</th><th><span class="sr-only">Details</span></th></tr></thead><tbody>' + rows + '</tbody></table>') +
      (L.length > 8 && !H.more ? '<button type="button" class="hl913-link hl913-all" data-h913="more">Show all ' + L.length + '</button>' : '') + '</section>';
    view.innerHTML = '<div class="hl913-pg">' + healthHead913(anim) +
      '<div class="hl913-row' + anim + '" style="--d:40ms">' + tile('SHEET SIZE', T.size) + tile('LAST BACKUP', T.backup) + tile('MORNING EMAIL', T.mail) + tile('PROBLEMS · 7 DAYS', T.probs) + '</div>' +
      '<div class="hl913-2' + anim + '" style="--d:80ms">' + tabsCard + archCard + '</div>' +
      '<div class="' + anim.trim() + '" style="--d:120ms">' + logCard + '</div></div>';
    view.classList.toggle('is-busy913', !!H.loading);
  }
  function copyText913() {   // the problem log for Claude: health in one line, then every problem with its details
    const D = h913().data; if (!D) return '';
    const T = tone913(D), d = dxb();
    const head = 'EWS v2.9.13 — problem log, last 7 days (copied ' + DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON91[d.getMonth()] + ' ' + d.getFullYear() + ' ' + p2913(d.getHours()) + ':' + p2913(d.getMinutes()) + ' Dubai)';
    const health = 'System health: sheet ' + T.size[1] + ' (' + T.size[2] + ') · last backup ' + T.backup[1] + ' (' + T.backup[2] + ') · morning email ' + T.mail[1] + ' (' + T.mail[2] + ') · ' + (D.problems || 0) + ' problems';
    const lines = (D.log || []).map((x, i) => (i + 1) + '. ' + logWhen913(x.t) + ' · ' + x.who + ' · ' + x.from + ' · ' + x.doing + ' — ' + x.what + (x.details ? '\n   details: ' + x.details : ''));
    return [head, health, ''].concat(lines).join('\n');
  }
  function detPop913(i) {
    const x = ((h913().data || {}).log || [])[i]; if (!x) return '';
    const d = dxb(x.t), full = DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON91[d.getMonth()] + ' ' + d.getFullYear() + ' · ' + p2913(d.getHours()) + ':' + p2913(d.getMinutes()) + ':' + p2913(d.getSeconds()) + ' Dubai';
    const r = (k, v) => v ? '<div class="hl913-dr"><small>' + k + '</small><span>' + esc(v) + '</span></div>' : '';
    return '<div class="hl913-det">' + r('WHEN', full) + r('WHO', x.who) + r('FROM', x.from) + r('DOING', x.doing) + r('WHAT HAPPENED', x.what) +
      (x.details ? '<div class="hl913-dr"><small>DETAILS</small><pre>' + esc(x.details) + '</pre></div>' : '') + '</div>';
  }
  function archPop913() {
    const Y = (h913().data || {}).year || {};
    return '<div class="hl913-cf"><b>Move ' + n913(Y.n) + ' closed ' + (Y.n === 1 ? 'job' : 'jobs') + ' to ' + esc(Y.name) + '?</b>' +
      '<p>Closed before ' + esc(Y.cut) + ', with their follow-ups, notes and history. A full backup of the tracker is taken first; EWS keeps working while they move.</p>' +
      '<div class="hl913-cfb"><button type="button" class="btn-ghost" data-act="pop-close">Cancel</button><button type="button" class="hl913-btn" data-h913="arch-go">Move now</button></div></div>';
  }
  async function runArch913() {
    const H = h913(), Y = (H.data || {}).year || {};
    if (H.run || !Y.n) return;
    closeOverlays(true);
    H.run = { phase: 'backup', moved: 0, total: Y.n };
    rerender();
    try {
      const b = await api.call('ethixAdminYearArchive', [{ phase: 'backup' }], { timeout: 300000 });
      if (!b || b.ok === false) throw new Error((b && b.error) || 'The backup did not finish.');
      H.run = { phase: 'move', moved: 0, total: b.left || Y.n, name: b.name };
      if (state.route && state.route.name === 'health') rerender();
      for (let k = 0; k < 400; k++) {
        const r = await api.call('ethixAdminYearArchive', [{ phase: 'move' }], { timeout: 300000 });
        if (!r || r.ok === false) throw new Error((r && r.error) || 'The move stopped.');
        H.run.moved += r.moved || 0;
        if (state.route && state.route.name === 'health') rerender();
        if (!r.left || !r.moved) break;
      }
      const n = H.run.moved, name = H.run.name;
      H.run = null;
      toast(n913(n) + (n === 1 ? ' job' : ' jobs') + ' moved to ' + name);
    } catch (e) {
      const moved = H.run ? H.run.moved : 0;
      H.run = null;
      if (e.kind !== 'auth') toast((moved ? n913(moved) + ' moved, then: ' : '') + e.message + ' Nothing was lost.', { error: true });
    }
    loadHealth913(true);
  }

  // -------------------------------------------------------------------- 8 · customer names tidy-up (admin)
  const nm913 = () => state.n913 || (state.n913 = { data: null, loading: false, err: '', tab: 'check', open: {}, pick: {}, keep: {}, busy: '' });
  function loadNames913() {
    const N = nm913(); if (N.loading) return;
    N.loading = true; N.err = '';
    api.call('ethixAdminNames', [], { timeout: 90000 }).then((d) => { N.data = d; N.got = Date.now(); })
      .catch((e) => { N.err = /not available/i.test(e.message) ? 'Customer names needs the v2.9.13 Code.gs.' : e.message; })
      .finally(() => { N.loading = false; if (state.route && state.route.name === 'names') rerender(); });
  }
  const keepOf913 = (g) => { const N = nm913(); return N.keep[g.key] !== undefined ? N.keep[g.key] : (N.pick[g.key] || g.names[0].name); };
  function nameGroup913(g, i) {
    const N = nm913(), open = N.open[g.key] !== undefined ? N.open[g.key] : i < 2, keep = keepOf913(g), busy = N.busy === g.key;
    const head = '<div class="nm913-gh"><small>LOOKS LIKE ONE CUSTOMER</small><span>' + (open ? g.names.length + ' spellings · ' + n913(g.jobs) + (g.jobs === 1 ? ' job' : ' jobs')
      : esc(g.names.slice(0, 2).map((x) => x.name).join(' · ')) + (g.names.length > 2 ? ' · ' + (g.names.length - 2) + ' more' : '')) + '</span>' +
      (open ? '' : '<button type="button" class="hl913-link" data-n913-open="' + esc(g.key) + '">Open</button>') + '</div>';
    if (!open) return '<section class="hl913-card nm913-g is-min">' + head + '</section>';
    const rows = g.names.map((x, k) => '<button type="button" class="nm913-o' + (x.name === keep ? ' is-on' : '') + '" role="radio" aria-checked="' + (x.name === keep) + '" data-n913-pick="' + esc(g.key) + '" data-i="' + k + '">' +
      '<span class="nm913-r" aria-hidden="true"></span><b>' + esc(x.name) + '</b><em>' + n913(x.jobs) + (x.jobs === 1 ? ' job' : ' jobs') + '</em></button>').join('');
    return '<section class="hl913-card nm913-g' + (busy ? ' is-busy' : '') + '" data-n913-g="' + esc(g.key) + '">' + head +
      '<div class="nm913-os" role="radiogroup" aria-label="The right spelling">' + rows + '</div>' +
      '<div class="nm913-keep"><label for="nk913-' + i + '">Keep as</label><input id="nk913-' + i + '" type="text" autocomplete="off" spellcheck="false" maxlength="80" data-n913-keep="' + esc(g.key) + '" value="' + esc(keep) + '"' + (busy ? ' disabled' : '') + '>' +
        '<button type="button" class="hl913-btn" data-n913-go="' + esc(g.key) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Making one name…' : 'Make all ' + n913(g.jobs) + (g.jobs === 1 ? ' job' : ' jobs') + ' one name') + '</button>' +
        '<button type="button" class="hl913-link is-muted" data-n913-not="' + esc(g.key) + '"' + (busy ? ' disabled' : '') + '>Not the same</button></div></section>';
  }
  function renderNames913(first) {
    const N = nm913(), D = N.data, anim = first ? ' reveal' : '';
    if (!D && !N.loading && !N.err) setTimeout(loadNames913, 0);
    else if (D && first && Date.now() - (N.got || 0) > 5 * 60000) setTimeout(loadNames913, 0);
    const G = D ? D.groups : [], done = D ? D.done : [];
    const head = '<header class="hl913-head' + anim + '"><div><div class="hl913-kick">ADMIN</div><h1>Customer names</h1>' +
      '<p class="hl913-sub">EWS found names that look like the same customer. Pick the right spelling — every job, briefing and follow-up moves to it.</p></div></header>';
    const tabs = '<div class="nm913-tabs' + anim + '" role="tablist">' + [['check', 'To check · ' + G.length], ['done', 'Done · ' + done.length]].map(([k, l]) =>
      '<button type="button" role="tab" class="' + (N.tab === k ? 'is-on' : '') + '" aria-selected="' + (N.tab === k) + '" data-n913-tab="' + k + '">' + l + '</button>').join('') + '</div>';
    let body;
    if (!D) body = N.err ? '<section class="hl913-card hl913-msg">' + empty('alert', N.err) + '<button type="button" class="btn-ghost" data-n913-reload>Try again</button></section>'
      : '<section class="hl913-card nm913-wait"><span class="spin">' + icon('refresh', 16) + '</span>Looking through every customer name…</section>';
    else if (N.tab === 'done') body = done.length ? '<section class="hl913-card nm913-done"><ul>' + done.map((d) => '<li><div><b>' + esc(d.to) + '</b><span>was ' + esc(d.from.join(' · ')) + '</span></div><em>' + n913(d.n) + (d.n === 1 ? ' job' : ' jobs') + ' · ' + esc(d.by === 'MASTER' ? 'ADMIN' : d.by) + ' · ' + esc(logWhen913(d.t)) + '</em></li>').join('') + '</ul></section>'
      : '<section class="hl913-card hl913-none">' + icon('check', 18) + '<span>Nothing tidied yet.</span></section>';
    else body = G.length ? G.map(nameGroup913).join('') : '<section class="hl913-card hl913-none">' + icon('check', 18) + '<span>Every customer has one spelling.</span></section>';
    $('#view').innerHTML = '<div class="hl913-pg nm913-pg">' + head + (D ? tabs : '') + '<div class="' + anim.trim() + '" style="--d:60ms">' + body + '</div>' +
      '<p class="hl913-note nm913-foot">Only admin sees this page. Sales and CS keep working while it runs; a backup is taken first.</p></div>';
  }
  async function mergeNames913(key) {
    const N = nm913(), g = N.data && N.data.groups.find((x) => x.key === key); if (!g || N.busy) return;
    const to = String(keepOf913(g)).replace(/\s+/g, ' ').trim().toUpperCase();
    if (to.length < 2) { toast('Type the name to keep.', { error: true }); const f = $('[data-n913-keep="' + key + '"]'); if (f) f.focus(); return; }
    N.busy = key; rerender();
    try {
      const r = await api.call('ethixAdminNamesMerge', [g.names.map((x) => x.name), to], { timeout: 180000 });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'Not changed.');
      N.data.groups = N.data.groups.filter((x) => x.key !== key);
      N.data.done.unshift({ t: Date.now(), by: state.user, to: r.to, from: r.from, n: r.n });
      delete N.keep[key]; delete N.pick[key];
      toast(n913(r.n) + (r.n === 1 ? ' job is' : ' jobs are') + ' now ' + r.to);
    } catch (e) { if (e.kind !== 'auth') toast(e.message, { error: true }); }
    N.busy = ''; rerender();
  }
  async function notSame913(key) {
    const N = nm913(), g = N.data && N.data.groups.find((x) => x.key === key); if (!g || N.busy) return;
    const was = N.data.groups.slice();
    N.data.groups = N.data.groups.filter((x) => x.key !== key); rerender();
    try { const r = await api.call('ethixAdminNamesNot', [key, g.names.map((x) => x.name)]); if (r && r.ok === false) throw new Error(r.error); toast('Kept apart — not suggested again'); }
    catch (e) { N.data.groups = was; rerender(); if (e.kind !== 'auth') toast(e.message, { error: true }); }
  }

  function initV2913() {
    document.addEventListener('click', (e) => {
      if (!isAdmin()) return;
      const h = e.target.closest('[data-h913]');
      if (h) {
        const a = h.dataset.h913, H = h913();
        if (a === 'refresh') loadHealth913(true);
        else if (a === 'tabs') { H.all = !H.all; rerender(); }
        else if (a === 'more') { H.more = true; rerender(); }
        else if (a === 'copy') { const t = copyText913(); (async () => { let ok = false; try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(t); ok = true; } } catch (x) { ok = false; }
          if (!ok) { const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;'; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch (x) { ok = false; } ta.remove(); }
          toast(ok ? 'Copied — paste it to Claude' : 'Could not copy', ok ? {} : { error: true }); })(); }
        else if (a === 'det') openPop(h, 'PROBLEM', () => detPop913(+h.dataset.i));
        else if (a === 'arch') openPop(h, 'YEARLY ARCHIVE', archPop913);
        else if (a === 'arch-go') runArch913();
        return;
      }
      const N = nm913(), t = e.target;
      const tab = t.closest('[data-n913-tab]'); if (tab) { N.tab = tab.dataset.n913Tab; rerender(); return; }
      const op = t.closest('[data-n913-open]'); if (op) { N.open[op.dataset.n913Open] = true; rerender(); const i = $('[data-n913-g="' + op.dataset.n913Open + '"] .nm913-o'); if (i) i.focus(); return; }
      const pk = t.closest('[data-n913-pick]');
      if (pk && N.data) {
        const g = N.data.groups.find((x) => x.key === pk.dataset.n913Pick); if (!g || N.busy) return;
        N.pick[g.key] = g.names[+pk.dataset.i].name; delete N.keep[g.key]; rerender();
        const b = $('[data-n913-g="' + g.key + '"] .nm913-o.is-on'); if (b) b.focus(); return;
      }
      const go = t.closest('[data-n913-go]'); if (go) { mergeNames913(go.dataset.n913Go); return; }
      const no = t.closest('[data-n913-not]'); if (no) { notSame913(no.dataset.n913Not); return; }
      if (t.closest('[data-n913-reload]')) { N.err = ''; loadNames913(); rerender(); }
    });
    document.addEventListener('input', (e) => {
      const f = e.target.closest && e.target.closest('[data-n913-keep]'); if (!f || !isAdmin()) return;
      const N = nm913(), k = f.dataset.n913Keep, v = f.value.toUpperCase();
      if (f.value !== v) { const p = f.selectionStart; f.value = v; try { f.setSelectionRange(p, p); } catch (x) { /* ignore */ } }
      N.keep[k] = v;
      $$('[data-n913-g="' + k + '"] .nm913-o').forEach((o) => { const on = o.querySelector('b').textContent === v.replace(/\s+/g, ' ').trim(); o.classList.toggle('is-on', on); o.setAttribute('aria-checked', on); });
    });
    document.addEventListener('keydown', (e) => { const f = e.target.closest && e.target.closest('[data-n913-keep]'); if (f && e.key === 'Enter') { e.preventDefault(); mergeNames913(f.dataset.n913Keep); } });
  }

  // -------------------------------------------------------------------- 6 · a job in the yearly archive: read-only, marked
  const arch913Tag = (j) => (j && j.closed && j.closed.arch ? '<span class="arch913" title="In the yearly archive — read-only">' + icon('arch913', 12) + esc(j.closed.arch) + '</span>' : '');
  function closedActions(j) {
    const c = j.closed || {};
    if (c.arch) return '<div class="vh-actions is-ro is-closed"><span class="ro-chip closed-chip is-arch913">' + icon('arch913', 14) + '<span>' + esc(c.arch) + ' · CLOSED' + (c.at ? ' ' + esc(c.at) : '') + (c.by ? ' · ' + esc(c.by) : '') + '</span></span><span class="ro-note913">Read-only</span></div>';
    return '<div class="vh-actions is-ro is-closed"><span class="ro-chip closed-chip">' + icon('lock', 14) + '<span>CLOSED' + (c.at ? ' ' + esc(c.at) : '') + (c.by ? ' · ' + esc(c.by) : '') + '</span></span>' +
      (canEdit() && mayEdit911(j) ? '<button type="button" class="btn-brutal" data-act="reopen">REOPEN JOB</button>' : '') + '</div>';
  }

  // -------------------------------------------------------------------- 9 · calendar cutoffs: open (solid dot) and done (hollow ring)
  // Every SI / ED / DG cutoff of your jobs (+ the colleague you cover): open = empty or PENDING; done = SUBMITTED / APPROVED /
  // PASSED/PAID; NOT APPLICABLE is not shown. A job's open and done cutoffs on one day are two rows; open rows first.
  function calEvents912() {
    const map = new Map();
    const add = (d, k, j, say, done) => {
      if (!d) return;
      const key = isoOf(d); let e = map.get(key); if (!e) map.set(key, e = { sail: [], arr: [], cut: [], free: [] });
      const x = e[k].find((y) => y.j === j && !!y.done === !!done);
      if (x) { if (say && !x.say.includes(say)) x.say.push(say); } else e[k].push({ j, say: say ? [say] : [], done: !!done });
    };
    const open = (v) => !v || v === 'PENDING';
    const isDone = (v) => v === 'SUBMITTED' || v === 'APPROVED' || v === 'PASSED/PAID';
    scoped().forEach((j) => {
      if (!j.active || j.mode === 'misc') return;
      add(j.etd, 'sail', j); add(j.eta, 'arr', j);
      if ((j.cat === 'EXPORT' || j.cat === 'CROSS') && j.type !== 'CRR') {
        const cut = (d, v, name, raw) => { if (open(v)) add(d, 'cut', j, name + cutTime912(raw)); else if (isDone(v)) add(d, 'cut', j, name + cutTime912(raw), true); };
        cut(j.siCut, j.sido, 'SI cutoff', j.raw.siCut);
        if (j.cat === 'EXPORT') cut(j.edCut, j.ed, 'ED cutoff', j.raw.edCut);
        if (j.cat === 'EXPORT' && j.dg === 'DG') { if (j.mode !== 'sea') add(j.dgCut, 'cut', j, 'DG cutoff' + cutTime912(j.raw.dgCut)); else cut(j.dgCut, j.dgpc, 'DG cutoff', j.raw.dgCut); }
      }
      if (j.cat === 'IMPORT' && !j.delivery) { add(j.lineFreeEnd, 'free', j, 'Line free time'); add(j.portFreeEnd, 'free', j, 'Port free time'); }
    });
    map.forEach((e) => { e.cut.sort((a, b) => a.done - b.done); });
    return map;
  }
  const cutN913 = (e) => (e ? { open: e.cut.filter((x) => !x.done).length, done: e.cut.filter((x) => x.done).length } : { open: 0, done: 0 });
  function calDayList912(iso, e, f, t0) {
    const d = parseDate(iso), n = d ? days(t0, d) : 0, past = n < 0;
    const keys = f === 'all' ? KEYS912 : [f];
    const row = (x, k) => {
      const j = x.j, sub = k === 'cut' ? x.say.join(' · ') + ' · ' + nice(j.route) : k === 'free' ? x.say.join(' · ') + (x.say.length > 1 ? ' end' : ' ends') + ' · ' + nice(j.route) : nice(j.route);
      const st = k !== 'cut' ? '' : x.done ? '<strong class="c913-st is-done">Done ✓</strong>' : past ? '<strong class="c913-st is-missed">Missed</strong>' : '<strong class="c913-st is-open">Open</strong>';
      return '<button type="button" class="c912-r' + (k === 'cut' ? ' is-cut913' + (x.done ? ' is-done913' : '') : '') + '" data-c912-job="' + esc(j.jobNo) + '" title="' + esc('Open ' + j.jobNo) + '"><b>' + esc(j.jobNo) + '</b><i>' + esc(j.type) + '</i><span>' + esc(j.customer || '—') + '</span><em>' + esc(sub) + '</em>' + st + '</button>';
    };
    const head = (k, L) => {
      const air = L.filter((x) => x.j.mode === 'air').length, all = air === L.length;
      const w = k === 'sail' ? (past ? (all ? 'DEPARTED' : air ? 'SAILED · DEPARTED' : 'SAILED') : (all ? 'DEPARTS' : air ? 'SAILS · DEPARTS' : 'SAILS'))
        : k === 'arr' ? (past ? 'ARRIVED' : 'ARRIVES') : k === 'cut' ? 'CUTOFFS' : (past ? 'FREE TIME ENDED' : 'FREE TIME ENDS');
      return '<div class="c912-gh"><i class="k912-' + k + '"></i>' + w + '<span>' + L.length + '</span></div>';
    };
    const out = keys.filter((k) => e && e[k].length).map((k) => '<div class="c912-g" role="group">' + head(k, e[k]) + e[k].map((x) => row(x, k)).join('') + '</div>').join('');
    if (out) return out;
    const what = f === 'all' ? (past ? 'Nothing sailed, arrived or was due on this day.' : 'Nothing sails, arrives or is due on this day.')
      : { sail: past ? 'Nothing sailed on this day.' : 'Nothing sails on this day.', arr: past ? 'Nothing arrived on this day.' : 'Nothing arrives on this day.', cut: 'No cutoffs on this day.', free: 'No free time ends on this day.' }[f];
    return '<div class="c912-none">' + icon('cal912', 22) + '<span>' + esc(what) + '</span></div>';
  }
  function calHtml912() {
    const C = cal912(), t0 = today0(), ph = isPh912(), f = C.f || 'all', ev = calEvents912();
    const first = new Date(C.y, C.m, 1), start = addDays(first, -((first.getDay() + 6) % 7));
    const keys = f === 'all' ? KEYS912 : [f];
    const ring = '<i class="k912-cut is-ring913"></i>';
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i), iso = isoOf(d), inM = d.getMonth() === C.m, e = ev.get(iso), cn = cutN913(e);
      const c = keys.map((k) => [k, k === 'cut' ? cn.open : e ? e[k].length : 0]).filter((x) => x[1]), n = c.reduce((a, x) => a + x[1], 0);   // the tint counts open cutoffs only
      const dn = keys.includes('cut') ? cn.done : 0;
      const we = d.getDay() === 0 || d.getDay() === 6, hol = holAE912(iso), today = +d === +t0, sel = iso === C.sel;
      const parts = c.map(([k, v]) => v + ' ' + (k === 'cut' ? (v === 1 ? 'cutoff open' : 'cutoffs open') : LEG912[k].toLowerCase())).concat(dn ? [dn + (dn === 1 ? ' cutoff done' : ' cutoffs done')] : []);
      const say = DOW[d.getDay()] + ' ' + dm912(d) + (today ? ', today' : '') + (hol.length ? ', ' + hol.join(', ') : '') + ' — ' + (parts.length ? parts.join(', ') : 'nothing');
      const inner = !inM ? '' : ph ? '<span class="c912-dots">' + c.map(([k]) => '<i class="k912-' + k + '"></i>').join('') + (dn ? ring : '') + '</span>'
        : '<span class="c912-ks">' + c.map(([k, v]) => '<span class="c912-k"><i class="k912-' + k + '"></i>' + v + '</span>').join('') + (dn ? '<span class="c912-k is-done913">' + ring + dn + '</span>' : '') + '</span>';
      cells += '<button type="button" class="c912-d' + (inM ? '' : ' is-out') + (we ? ' is-we' : '') + (hol.length && inM ? ' is-hol' : '') + (today ? ' is-today' : '') + (sel ? ' is-sel' : '') + '" data-c912-day="' + iso + '" style="--b:' + (inM ? Math.min(n, 9) : 0) + '" aria-pressed="' + sel + '" aria-label="' + esc(say) + '"' + (sel ? '' : ' tabindex="-1"') + (hol.length ? ' title="' + esc(hol.join(' · ') + ' — UAE public holiday') + '"' : '') + '>' +
        '<b>' + d.getDate() + '</b>' + (hol.length && inM && !ph ? '<span class="c912-hol">' + esc(holShort912(hol[0])) + '</span>' : '') + inner + '</button>';
    }
    const wd = (ph ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']).map((x) => '<span aria-hidden="true">' + x + '</span>').join('');
    const chips = '<div class="c912-chips" role="group" aria-label="Show">' + Object.keys(CHIP912).map((k) => '<button type="button" class="c912-chip' + (f === k ? ' is-on' : '') + '" data-c912-f="' + k + '" aria-pressed="' + (f === k) + '">' + (k === 'all' ? '' : '<i class="k912-' + k + '"></i>' + (k === 'cut' ? ring : '')) + CHIP912[k] + '</button>').join('') + '</div>';
    const title = ph ? MONTHS912[C.m] + ' ' + C.y : MONTHS912[C.m].toUpperCase() + ' ' + C.y;
    const sd = parseDate(C.sel) || t0, sn = days(t0, sd), se = ev.get(C.sel);
    const jobsN = new Set(); if (se) keys.forEach((k) => se[k].forEach((x) => jobsN.add(x.j)));
    const sHol = holAE912(C.sel);
    const kick = DOW_UP[sd.getDay()] + ' ' + sd.getDate() + ' ' + MON91[sd.getMonth()].toUpperCase() + (sd.getFullYear() !== t0.getFullYear() ? ' ' + sd.getFullYear() : '') + (sn === 0 ? ' · TODAY' : sn === 1 ? ' · TOMORROW' : sn === -1 ? ' · YESTERDAY' : '');
    const nb = (dir) => '<button type="button" class="c912-rb" data-c912-mo="' + dir + '" aria-label="' + (dir < 0 ? 'Previous month' : 'Next month') + '">' + icon(dir < 0 ? 'l912' : 'r912', 16) + '</button>';
    const close = (cls) => '<button type="button" class="c912-rb' + (cls || '') + '" data-c912-close aria-label="Close">' + icon('x912', 16) + '</button>';
    const legend = KEYS912.map((k) => k === 'cut' ? '<span><i class="k912-cut"></i>Cutoff open</span><span>' + ring + 'Cutoff done</span>' : '<span><i class="k912-' + k + '"></i>' + LEG912[k] + '</span>').join('');
    return '<div class="c912-m">' + (ph ? '<div class="c912-grab" data-c912-grab aria-hidden="true"></div>' : '') +
        '<div class="c912-mh"><h2 id="c912Title">' + title + '</h2>' + nb(-1) + nb(1) + '<button type="button" class="c912-pill" data-c912-today>Today</button>' + (ph ? close(' c912-xph') : '') + '</div>' + chips +
        '<div class="c912-wd">' + wd + '</div><div class="c912-grid" role="group" aria-label="' + esc(MONTHS912[C.m] + ' ' + C.y) + '">' + cells + '</div>' +
        (ph ? '' : '<div class="c912-lg">' + legend + '<span class="c912-lgh"><i></i>UAE holiday</span><em>Deeper colour = busier day</em></div>') +
      '</div>' +
      '<div class="c912-dp"><div class="c912-dph"><small>' + esc(kick) + '</small><h3>' + (jobsN.size ? jobsN.size + (jobsN.size === 1 ? ' job' : ' jobs') : 'No jobs') + '</h3>' +
          (sHol.length ? '<span class="c912-holchip">' + icon('hol912', 13) + esc(sHol.map(holShort912).join(' · ')) + ' · UAE holiday</span>' : '') + (ph ? '' : close(' c912-x')) + '</div>' +
        '<div class="c912-dl">' + calDayList912(C.sel, se, f, t0) + '</div></div>';
  }

  // ==================================================================================================================== v2.9.14
  // 10 · Arrange Home: each person's order of the five counters and the three tiles, and which are hidden (kept on the server,
  //      so the laptop and the phone show the same Home). Arrange mode: dashed outlines, ⋮⋮ to drag (or the arrow keys), the
  //      eye hides a tile, Reset / Done.
  // (11 · Face ID / fingerprint unlock was removed in v2.9.16)
  // ====================================================================================================================
  I.grip914 = '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></g>';
  I.eye914 = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
  I.arrange914 = '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2" stroke-dasharray="2.4 2.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>';

  // ------------------------------------------------------------------------------------------------ 10 · Arrange Home
  const HK914 = ['active', 'costing', 'sied', 'free', 'hold'], HT914 = ['watch', 'week', 'day'];
  const H914 = { home: null, on: false, drag: null, timer: 0, savedKey: '', pend: false, scroll: 0 };
  const hName914 = (id) => ({ active: 'Active jobs', costing: 'Costing due', sied: 'SI / ED due', free: 'Free time', hold: 'On hold', watch: 'Today’s watch', week: 'This week', day: canNote() ? 'My day' : 'Recent activity' }[id] || id);
  function home914() {
    const h = H914.home || {};
    const fix = (a, all) => { const o = (Array.isArray(a) ? a : []).filter((x, i, s) => all.includes(x) && s.indexOf(x) === i); all.forEach((x) => { if (!o.includes(x)) o.push(x); }); return o; };
    return { k: fix(h.k, HK914), t: fix(h.t, HT914), h: (Array.isArray(h.h) ? h.h : []).filter((x, i, s) => (HK914.includes(x) || HT914.includes(x)) && s.indexOf(x) === i) };
  }
  const homeKey914 = (H) => JSON.stringify({ k: H.k, t: H.t, h: H.h });
  function applyBoot914(boot) {
    if (!H914.on && !H914.timer) { H914.home = boot.home914 || null; H914.savedKey = homeKey914(home914()); }
  }
  const ctl914 = (id, hid) => '<span class="a914-ctl"><button type="button" class="a914-eye' + (hid ? ' is-on' : '') + '" data-a914-eye="' + id + '" aria-pressed="' + hid + '" aria-label="' + (hid ? 'Show ' : 'Hide ') + esc(hName914(id)) + '" title="' + (hid ? 'Hidden — show it' : 'Hide') + '">' + icon('eye914', 15) + '</button>' +
    '<button type="button" class="a914-grip" data-a914-grip="' + id + '" aria-label="Move ' + esc(hName914(id)) + ' — drag it, or use the arrow keys" title="Drag to move">' + icon('grip914', 16) + '</button></span>';
  // the five counters (v2.9.1) in this person's order; hidden ones only in Arrange mode
  function kpiTiles91(m, anim) {
    const t0 = today0(), wk = addDays(t0, 6), H = home914(), on = H914.on;
    const holdSoon = m.hold.filter((j) => j.etd && j.etd >= t0 && j.etd <= wk).length;
    const D = {
      active: ['ACTIVE JOBS', m.active.length, m.atSea.length + ' at sea now', false],
      costing: ['COSTING DUE', m.costingDue.length, m.costing.length ? 'of ' + m.costing.length + ' pending' : 'nothing pending', false],   // v2.9.9: what is due now
      sied: ['SI / ED DUE', m.siedDue.length, m.sied.length ? 'of ' + m.sied.length + ' pending' : 'nothing pending', false],
      free: ['FREE TIME', m.freeJobs.length, m.freeJobs.length ? 'ending in ≤ 2 days' : 'all clear', m.freeJobs.length > 0],
      hold: ['ON HOLD', m.hold.length, !m.hold.length ? 'all jobs moving' : holdSoon ? holdSoon + ' due to sail this week' : 'none due to sail this week', false]
    };
    const ids = H.k.filter((id) => on || !H.h.includes(id));
    const k = (id, i) => {
      const x = D[id], hid = H.h.includes(id), inner = '<span class="kpi-label">' + x[0] + '</span><span class="kpi-num">' + x[1] + '</span><span class="kpi-sub">' + esc(x[2]) + '</span>';
      if (!on) return '<button type="button" class="kpi' + (x[3] ? ' is-urgent' : '') + anim + '" style="--d:' + (100 + i * 30) + 'ms" data-list="' + id + '">' + inner + '</button>';
      return '<div class="kpi is-a914' + (x[3] ? ' is-urgent' : '') + (hid ? ' is-hid914' : '') + anim + '" style="--d:' + (100 + i * 30) + 'ms" data-h914="' + id + '">' + inner + ctl914(id, hid) + '</div>';
    };
    return '<div class="kpis is-5' + (ids.length !== 5 ? ' h914-k' + ids.length : '') + '">' + ids.map(k).join('') + '</div>';
  }
  const AREA914 = { watch: 'watch', week: 'week', day: 'act' };
  function vars914(t, hasK) {   // the grid for this order: wide (counters across, tiles side by side) and narrow (one column)
    const n = t.length;
    const w = (hasK ? '"' + (n ? t.map(() => 'kpis').join(' ') : 'kpis') + '"' : '') + (hasK && n ? ' ' : '') + (n ? '"' + t.map((id) => AREA914[id]).join(' ') + '"' : '');
    return {
      '--h914-w': w || 'none',
      '--h914-c': n ? t.map((id) => (id === 'watch' ? 'minmax(0, 1.12fr)' : 'minmax(0, 1fr)')).join(' ') : 'minmax(0, 1fr)',
      '--h914-r': (hasK ? 'auto' : '') + (hasK && n ? ' ' : '') + (n ? 'minmax(0, 1fr)' : '') || 'auto',
      '--h914-n': ((hasK ? '"kpis" ' : '') + t.map((id) => '"' + AREA914[id] + '"').join(' ')).trim() || 'none'
    };
  }
  const bentoVars914 = (t, hasK) => { const v = vars914(t, hasK); return " style='" + Object.keys(v).map((k) => k + ': ' + v[k]).join('; ') + "'"; };
  // Home's tiles in this person's order (Arrange mode: every tile, with its handles)
  function bento914(m, anim) {
    const H = home914(), on = H914.on;
    const make = { watch: () => watchTile91(m, anim), week: () => weekTile91(m, anim), day: () => (canNote() ? myDayTile(anim) : activityTile(anim)) };
    const shown = H.t.filter((id) => on || !H.h.includes(id)), hasK = H.k.some((id) => on || !H.h.includes(id));
    const custom = on || H.t.join() !== HT914.join() || H.h.length > 0;
    const html = (hasK ? kpiTiles91(m, anim) : '') + shown.map((id) => {
      const s = make[id]();
      if (!on) return s;
      const hid = H.h.includes(id);
      return s.replace(/^<section class="tile/, '<section data-h914="' + id + '" class="tile is-a914' + (hid ? ' is-hid914' : '')).replace(/^(<section[^>]*>)/, '$1' + ctl914(id, hid));
    }).join('');
    return '<div class="bento' + (custom ? ' is-h914' : '') + (on ? ' is-arr914' : '') + '"' + (custom ? bentoVars914(shown, hasK) : '') + '>' + html + '</div>';
  }
  const arrBtn914 = () => (canNote() || isSales() ? '<button type="button" class="btn-ghost a914-btn" data-a914="on" aria-label="Arrange Home" title="Arrange Home">' + icon('arrange914', 16) + '</button>' : '');
  const arrGo914 = () => '<button type="button" class="acct-go" data-a914="on">' + icon('arrange914', 18) + '<span>Arrange Home</span></button>';

  function arrange914(on) {
    if (on === H914.on) return;
    H914.on = on;
    document.body.classList.toggle('is-arranging914', on);
    const old = $('#a914Bar'); if (old) old.remove();
    if (on) {
      closeOverlays(true);
      document.body.insertAdjacentHTML('beforeend', '<div class="a914-bar" id="a914Bar" role="toolbar" aria-label="Arrange your Home"><span class="a914-txt"><b>ARRANGE YOUR HOME</b><span class="a914-hint"><span class="is-l914">Drag a tile to move it · the eye hides it</span><span class="is-s914">Drag a tile · the eye hides it</span></span></span>' +
        '<button type="button" class="a914-reset" data-a914="reset">Reset</button><button type="button" class="a914-done" data-a914="done">Done</button></div>');
      if (!state.route || state.route.name !== 'home') { go('#/home'); } else rerender();
      const v = $('#view'); if (v && v.scrollTop) v.scrollTop = 0; window.scrollTo(0, 0);
      setTimeout(() => { const g = $('#view .a914-grip'); if (g && !isTouch()) g.focus({ preventScroll: true }); }, 60);
    } else {
      a914Save();
      if (state.route && state.route.name === 'home') rerender();
      const b = $('#view [data-a914="on"]'); if (b) b.focus({ preventScroll: true });
    }
  }
  function a914Dirty() { clearTimeout(H914.timer); H914.timer = setTimeout(a914Save, 900); }
  async function a914Save() {
    clearTimeout(H914.timer); H914.timer = 0;
    const H = home914(), key = homeKey914(H);
    if (key === H914.savedKey) return;
    H914.savedKey = key;
    try { await api.call('ethixHomeSave', [{ k: H.k, t: H.t, h: H.h }], { timeout: 30000 }); }
    catch (e) { H914.savedKey = ''; if (e.kind !== 'auth') toast('Your Home layout was not saved — ' + e.message, { error: true }); }
  }
  const items914 = (grp) => $$(grp === 'k' ? '#view .home .kpis > [data-h914]' : '#view .home .bento > [data-h914]');
  // put the group in the new order: counters by moving the others around the one held (it keeps its pointer), tiles by grid areas
  function a914Apply(grp, held) {
    const H = home914();
    if (grp === 'k') {
      const box = $('#view .home .kpis'); if (!box) return;
      const els = {}; items914('k').forEach((x) => { els[x.dataset.h914] = x; });
      const order = H.k.filter((id) => els[id]), at = held ? order.indexOf(held.dataset.h914) : -1;
      if (at < 0) { order.forEach((id) => box.appendChild(els[id])); return; }
      order.slice(0, at).forEach((id) => box.insertBefore(els[id], held));
      order.slice(at + 1).forEach((id) => box.appendChild(els[id]));
    } else {
      const b = $('#view .home .bento'); if (!b) return;
      const v = vars914(H.t, !!$('#view .home .kpis'));
      Object.keys(v).forEach((k) => b.style.setProperty(k, v[k]));
    }
  }
  function a914Move(id, to, held) {   // move one tile to a place in its group; the others glide to theirs
    const grp = HK914.includes(id) ? 'k' : 't', H = home914(), arr = grp === 'k' ? H.k : H.t, from = arr.indexOf(id);
    to = Math.max(0, Math.min(arr.length - 1, to));
    if (from < 0 || from === to) return false;
    const others = items914(grp).filter((x) => x !== held), before = new Map(others.map((x) => [x, x.getBoundingClientRect()]));
    arr.splice(from, 1); arr.splice(to, 0, id);
    H914.home = H;
    a914Apply(grp, held || items914(grp).find((x) => x.dataset.h914 === id));
    before.forEach((r0, x) => {
      const r1 = x.getBoundingClientRect(), dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      x.style.transition = 'none'; x.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
      void x.offsetWidth;
      x.style.transition = ''; x.style.transform = '';
    });
    a914Dirty();
    return true;
  }
  function a914Place(D) {   // the lifted tile follows the finger — and always stays on the board, whole
    const el = D.el; el.style.transform = 'none';
    const r = el.getBoundingClientRect(), v = $('#view').getBoundingClientRect();
    let x = D.px - D.ox, y = D.py - D.oy;
    x = Math.max(v.left + 8, Math.min(v.right - r.width - 8, x));
    const bar = $('#a914Bar'), top = Math.max(v.top, bar ? bar.getBoundingClientRect().bottom : 0) + 18;
    if (r.height < v.bottom - top - 20) y = Math.max(top, Math.min(v.bottom - r.height - 10, y));
    el.style.transform = 'translate(' + Math.round(x - r.left) + 'px, ' + Math.round(y - r.top) + 'px) rotate(-1.4deg)';
  }
  function a914Hit(D) {
    const over = items914(D.grp).find((x) => { if (x === D.el) return false; const r = x.getBoundingClientRect(); return D.px >= r.left && D.px <= r.right && D.py >= r.top && D.py <= r.bottom; });
    if (over && over !== D.last) {
      D.last = over;
      const H = home914(), arr = D.grp === 'k' ? H.k : H.t;
      if (a914Move(D.id, arr.indexOf(over.dataset.h914), D.el)) a914Place(D);
    } else if (!over) D.last = null;
  }
  function a914Edge(D) {   // near the top or bottom of the screen: the page scrolls while a tile is held
    cancelAnimationFrame(H914.scroll);
    const vh = window.innerHeight, dy = D.py < 90 ? -Math.ceil((90 - D.py) / 6) : D.py > vh - 110 ? Math.ceil((D.py - vh + 110) / 6) : 0;
    if (!dy || !H914.drag) return;
    H914.scroll = requestAnimationFrame(() => {
      if (!H914.drag) return;
      const v = $('#view'), sc = v && v.scrollHeight > v.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(v).overflowY) ? v : document.scrollingElement;
      const y = sc.scrollTop; sc.scrollTop = y + dy;
      if (sc.scrollTop !== y) { a914Place(D); a914Hit(D); }
      a914Edge(D);
    });
  }
  function a914End(e) {
    const D = H914.drag; if (!D || (e && e.pointerId !== D.pid)) return;
    H914.drag = null; cancelAnimationFrame(H914.scroll);
    document.body.classList.remove('is-drag914');
    window.removeEventListener('pointermove', a914PMove); window.removeEventListener('pointerup', a914End); window.removeEventListener('pointercancel', a914End);
    if (D.live) {
      const el = D.el;
      el.classList.add('is-drop914'); el.classList.remove('is-lift914'); void el.offsetWidth; el.style.transform = '';
      setTimeout(() => el.classList.remove('is-drop914'), 360);
      const g = el.querySelector('.a914-grip'); if (g && !isTouch()) g.focus({ preventScroll: true });
    }
    if (H914.pend) { H914.pend = false; setTimeout(rerender, 380); }
  }
  function a914PMove(e) {
    const D = H914.drag; if (!D || e.pointerId !== D.pid) return;
    D.px = e.clientX; D.py = e.clientY;
    if (!D.live) {
      if (Math.hypot(D.px - D.x0, D.py - D.y0) < 5) return;
      D.live = true; D.el.classList.add('is-lift914'); document.body.classList.add('is-drag914');
    }
    e.preventDefault();
    a914Place(D); a914Hit(D); a914Edge(D);
  }
  function initArrange914() {
    document.addEventListener('pointerdown', (e) => {
      const g = e.target.closest && e.target.closest('[data-a914-grip]');
      if (!g || !H914.on || H914.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const el = g.closest('[data-h914]'); if (!el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      H914.drag = { id: el.dataset.h914, el, grp: HK914.includes(el.dataset.h914) ? 'k' : 't', pid: e.pointerId, x0: e.clientX, y0: e.clientY, px: e.clientX, py: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, live: false, last: null };
      window.addEventListener('pointermove', a914PMove, { passive: false }); window.addEventListener('pointerup', a914End); window.addEventListener('pointercancel', a914End);
    });
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('[data-a914]');
      if (a) {
        const k = a.dataset.a914;
        if (k === 'on') { arrange914(true); return; }
        if (k === 'done') { arrange914(false); return; }
        if (k === 'reset') {
          const was = H914.home;
          H914.home = null; rerender(); a914Dirty();
          toast('Home is back to the standard layout', { action: { label: 'Undo', fn: () => { H914.home = was; rerender(); a914Dirty(); } } });
        }
        return;
      }
      const eye = e.target.closest && e.target.closest('[data-a914-eye]');
      if (eye && H914.on) {
        const id = eye.dataset.a914Eye, H = home914(), i = H.h.indexOf(id), hid = i < 0;
        if (hid) H.h.push(id); else H.h.splice(i, 1);
        H914.home = H;
        const el = eye.closest('[data-h914]'); if (el) el.classList.toggle('is-hid914', hid);
        eye.classList.toggle('is-on', hid); eye.setAttribute('aria-pressed', hid);
        eye.setAttribute('aria-label', (hid ? 'Show ' : 'Hide ') + hName914(id)); eye.title = hid ? 'Hidden — show it' : 'Hide';
        a914Dirty();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (!H914.on) return;
      const g = e.target.closest && e.target.closest('[data-a914-grip]');
      if (g && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
        e.preventDefault();
        const id = g.dataset.a914Grip, H = home914(), arr = HK914.includes(id) ? H.k : H.t;
        a914Move(id, arr.indexOf(id) + (/Left|Up/.test(e.key) ? -1 : 1));
        g.focus({ preventScroll: true });
        return;
      }
      if (e.key === 'Escape' && !H914.drag && !state.overlay) { e.preventDefault(); arrange914(false); }
    });
    window.addEventListener('hashchange', () => { if (H914.on && !/^#\/(home)?$/.test(location.hash || '#/')) arrange914(false); });
  }

  function initV2914() {
    initArrange914();
    try { ['ethix.v2.pk914', 'ethix.v2.pk914no'].forEach((k) => localStorage.removeItem(k)); sessionStorage.removeItem('ethix.pk914out'); } catch (e) { /* private mode */ }   // v2.9.16: Face ID removed
  }

  // ==================================================================== v2.9.15 / v2.9.16 — Document reader (Customer Service)
  // Drop invoices / packing lists (PDF, scan, phone photo, several at once). Pages become pictures here (pdf.js, on this
  // device). v2.9.16 — READ (free first): a PDF's own text, or Google's reading of a scan (Code.gs, Drive OCR), goes through
  // EWS's own rules (rdRules916); EWS checks itself and only invoice / packing-list pages with gaps go to Groq, as text.
  // The page picker: every page a thumbnail with a tick. Read with Groq stays (everything with Groq, as in v2.9.15).
  // Nothing is saved — the results live in this page's memory until Start again, Log out or closing the page.
  // Tabs: FOR THE SI · FOR DUBAI TRADE (v2.9.17: Dubai Trade's declaration boxes) · ALL TEXT.
  I.reader915 = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 13h7M8.5 16.5h4.5"/>';
  I.doc915 = '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
  I.scan915 = '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M7.5 12h9"/>';
  I.ok915 = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
  const PDFJS915 = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
  const RD_MAXP915 = 30, RD_MAXF915 = 12;
  const RD = { user: null, files: [], tab: 'si', busy: false, stop: false, msg: null, n: 0, until: 0, tick: null, tries: 0,
    tpm: 8000, rem: null, at: 0, q: Promise.resolve(), lib: null, done: 0, stage: '', how: null, gapOnly: false, fill: 0, fillN: 0 };
  try { const g = JSON.parse(localStorage.getItem('ethix.v2.groq915') || 'null'); if (g && g.tpm > 1000) RD.tpm = g.tpm; } catch (e) { /* private mode */ }
  const RD_KIND915 = { 'invoice': 'Invoice', 'packing list': 'Packing list', 'bill of lading': 'BL', 'eir': 'EIR', 'si': 'SI', 'certificate of origin': 'Certificate of origin' };
  const rdPl915 = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  function rd915Clear() {   // Log out / another person / Start again: everything read is forgotten
    RD.stop = true; RD.files = []; RD.msg = null; RD.tab = 'si'; RD.D = null; RD.tabSet = false; RD.paste = false; RD.BL = null; RD.user = state.user || null; RD.until = 0; RD.done = 0; RD.how = null; RD.stage = ''; RD.gapOnly = false;
    clearInterval(RD.tick); RD.tick = null;
  }

  // ==================================================================== v2.9.16 — EWS's own rules (no AI)
  // A page's text (the PDF's own text, or Google's reading of a scan) → the same answer Groq gives:
  // { kind, text, fields: { key: { v, sure } }, lines: [...], totals: [...] } — so rdMerge915 shows it the same way.
  // The rules only state what is printed; a guess is marked sure: false (CHECK). What they cannot find stays empty and
  // the page is offered to Groq (rdGaps916).
  const RU_PK916 = '(?:(?:JUMBO|WOODEN|PLASTIC|STEEL|HDPE|PP|PAPER|FIBRE|FIBER|EMPTY|NEW)\\s+)?(?:BAGS?|DRUMS?|DURMS|CARTONS?|CTNS?|PALLETS?|PLTS?|PKGS?|PACKAGES?|BOXES|BOX|ROLLS?|BALES?|CASES?|CRATES?|BUNDLES?|COILS?|IBCS?|PIECES|PCS|CANS?|BARRELS?|SACKS?|REELS?|TINS?)';
  const RU_PKC916 = new RegExp('^(\\d[\\d,]*)\\s+(' + RU_PK916 + ')$', 'i');
  const RU_WU916 = /^(KGS?|KILOS?|KILOGRAMS?|MTS?|MTONS?|TONS?|TONNES?|LBS?|GMS?|G)$/;
  const RU_CURS916 = /^(USD|US\$|\$|AED|DHS?|EUR|€|GBP|£|INR|CNY|RMB|SAR|JPY|OMR|QAR|KWD|BHD)$/;
  const ruCur916 = (t) => { const u = String(t || '').toUpperCase(); return /^(US\$|\$)$/.test(u) ? 'USD' : /^DHS?$/.test(u) ? 'AED' : u === '€' ? 'EUR' : u === '£' ? 'GBP' : u === 'RMB' ? 'CNY' : u; };
  function ruNum916(s) {   // "1,300.00" · "27.290 MT" · "41,003.77 USD" · "$ 34,320.00" → { n, u }
    const m = String(s).trim().match(/^(USD|US\$|\$|AED|EUR|€|GBP|£|INR|CNY|RMB|SAR)?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*([A-Za-z$€£%]{0,6})\.?$/);
    if (!m) return null;
    return { n: Number(m[2].replace(/,/g, '')), u: (m[3] || m[1] || '').toUpperCase(), dec: (m[2].split('.')[1] || '').length };
  }
  function ruType916(c) {   // what a table heading names
    const t = String(c).toUpperCase().replace(/\s+/g, ' ').trim();
    if (/^(SR|S|SL|SI|ITEM|LINE)?\.? ?(NO|#|NR)\.?$|^#$|^S\.?N\.?$/.test(t)) return 'sr';
    if (/NO\.? ?OF CONTAINERS?/.test(t)) return 'nc';
    if (/H\.?S\.? ?CODE|\bHSN\b|TARIFF/.test(t)) return 'hs';
    if (/ORIGIN/.test(t)) return 'origin';
    if (/CONTAINER|CNTR/.test(t)) return 'cont';
    if (/\bSEAL\b/.test(t)) return 'seal';
    if (/GROSS|\bG\.?W\b/.test(t)) return 'gross';
    if (/\bNET\b|\bN\.?W\b/.test(t)) return 'net';
    if (/\b(RATE|PRICE|U\/P)\b/.test(t)) return 'rate';
    if (/AMOUNT|VALUE|\bAMT\b|^TOTAL( USD| AED| US\$)?$/.test(t)) return 'value';
    if (/QTY|QUANTITY|^MT$|^PCS$|^KGS?$/.test(t)) return 'qty';
    if (/^UNITS?$|\bUOM\b/.test(t)) return 'unit';
    if (/PACKAGE|PACKING|PKGS|CARTONS|\bBAGS\b|DRUMS|PALLETS/.test(t)) return 'pk';
    if (/DESCRIPTION|PARTICULARS|COMMODITY|GOODS|PRODUCT|^ITEMS?$/.test(t)) return 'desc';
    return '';
  }
  const ruUnitIn916 = (c) => { const m = String(c).toUpperCase().match(/\(\s*([A-Z$]{1,6})\s*\)|\bIN\s+(KGS?|MTS?|USD|AED|LBS)\b|^(MT|KGS?|PCS)$|(US\$|USD|AED)(?:\/[A-Z]+)?$/); return m ? (m[1] || m[2] || m[3] || m[4]) : ''; };
  const RU_HEADISH916 = /^(IN\s+[A-Z$]{2,4}|\(?\s*(MT|KGS?|LBS|PCS|USD|AED|US\$|NOS|SETS?|UNITS?)\s*\)?|WEIGHT(\s*\([A-Z]+\))?|P\.?M\.?T\.?)$/i;
  const RU_STOP916 = /^(AMOUNT IN WORDS|INVOICE (AMT|AMOUNT|VALUE)|PAYMENT|BANK\b|PORT OF|VESSEL|FOR,|FOR AND ON|TERMS\b|DECLARATION|WE (HEREBY )?(DECLARE|CERTIFY)|PAGE ?\d|PREPARED|AUTHORI[SZ]ED|SIGNATURE|REMARKS|NOTE\b|E\.? ?& ?O\.? ?E)/i;
  const RU_KEY916 = /^(DATE|DATED|INVOICE|INV\b|PL NO|P\/L|BL NO|B\/L|PAYMENT|PRICE|POL|POD|CURRENCY|DISPATCH|COUNTRY OF|DELIVERY|DESTINATION|TERMS|SHIPMENT|MODE OF|SALES CONTRACT|CONTRACT|PO NO|P\.?O\.? NO|ORDER|TOTAL|PORT OF|VESSEL|LC NO|L\/C|REF\b|OUR REF|YOUR REF|PAGE|COMMERCIAL)/i;
  const RU_SHIP916 = /^(SELLER|SHIPPER|EXPORTER|CONSIGNOR|SUPPLIER|BENEFICIARY)(\s*[\/&]\s*(SELLER|SHIPPER|EXPORTER|SUPPLIER))?(\s+(NAME|DETAILS))?\s*:?\s*(.*)$/i;
  const RU_CONS916 = /^(BUYER|CONSIGNEE|IMPORTER|CUSTOMER|BILL TO|SOLD TO|SHIP TO|CONSIGNED TO|MESSRS\.?|M\/S\.?|TO)(\s*[\/&]\s*(BUYER|CONSIGNEE|IMPORTER|SHIP TO))?(\s+(NAME|DETAILS))?\s*:?\s*(.*)$/i;
  const RU_NOTI916 = /^(NOTIFY(\s+PARTY)?(\s+\d)?)()()()\s*:?\s*(.*)$/i;
  const RU_INCO916 = /\b(EXW|EX[- ]?WORKS|FCA|FAS|FOB|CFR|CNF|C&F|C ?& ?F|CIF|CPT|CIP|DAP|DPU|DAT|DDP)\b[\s,:-]*(.*)$/i;
  function ruDate916(v) {   // 24-Sep-26 · 08/10/2026 (day first) · 2026-10-08 · 8 October 2026 → YYYY-MM-DD
    const t = String(v || '').trim(), MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const out = (y, m, d, sure) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { v: (y < 100 ? 2000 + y : y) + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'), sure } : null);
    let m = t.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/); if (m) return out(+m[1], +m[2], +m[3], true);
    m = t.match(/^(\d{1,2})[-\/. ]([A-Za-z]{3,9})[-\/., ]+(\d{2,4})$/); if (m) return out(+m[3], MON.indexOf(m[2].slice(0, 3).toUpperCase()) + 1, +m[1], true);
    m = t.match(/^([A-Za-z]{3,9})[-\/. ]+(\d{1,2})[-\/., ]+(\d{2,4})$/); if (m) return out(+m[3], MON.indexOf(m[1].slice(0, 3).toUpperCase()) + 1, +m[2], true);
    m = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/); if (m) return +m[2] > 12 ? out(+m[3], +m[1], +m[2], true) : out(+m[3], +m[2], +m[1], true);
    return null;
  }
  function ruKind916(L) {
    const title = (s) => (/EQUIPMENT\s+INTERCHANGE/i.test(s) ? 'eir' : /SHIPPING\s+INSTRUCTIONS?\b/i.test(s) ? 'si' : /PACKING\s+(LIST|SLIP)|WEIGHT\s+LIST|PACKING\s*\/\s*WEIGHT/i.test(s) && !/INVOICE\s*(&|AND|CUM)\s*PACKING/i.test(s) ? 'packing list'
      : /\bINVOI[CV]E\b/i.test(s) && !/INVOICE\s*(NO|DATE|NUMBER|VALUE|AMT|AMOUNT|#|REF)/i.test(s) ? 'invoice'
      : /BILL\s+OF\s+LADING|SEA\s?WAY\s?BILL|AIR\s?WAY\s?BILL/i.test(s) ? 'bill of lading' : /CERTIFICATE\s+OF\s+ORIGIN/i.test(s) ? 'certificate of origin' : '');
    for (let i = 0; i < Math.min(L.length, 14); i++) { const s = L[i].s.trim(); if (s.length <= 60) { const k = title(s); if (k) return k; } }
    for (let i = 0; i < L.length; i++) { const s = L[i].s.trim(); if (s.length <= 46) { const k = title(s); if (k) return k; } }
    const all = L.map((x) => x.s).join('\n');   // v2.9.19: a BL draft printed on the line's form (no title) — its B/L number and containers
    if (/\bB\s*\/\s*L\s*(NO|NUMBER)\b|BILLS?\s+OF\s+LADING|SHIPPED\s+ON\s+BOARD/i.test(all) && /\b[A-Z]{3}[UJZ]\s?\d{6}\s?\d\b/.test(all)) return 'bill of lading';
    return 'other';
  }
  function rdRules916(text, cols) {
    const split = cols === false ? /\t|\s{2,}|\s+\|\s+/ : /\t|\s{3,}|\s+\|\s+/;
    let gap = false;
    const L = String(text || '').replace(/\r/g, '').split('\n').map((s) => ({ s: s.trim(), c: s.trim().split(split).map((x) => x.trim()).filter(Boolean) })).filter((l) => { if (!l.c.length) { gap = true; return false; } l.gap = gap; gap = false; return true; });
    const ocr = cols === false;
    const res = { kind: ruKind916(L), text: '', fields: {}, lines: [], totals: [] };
    const F = res.fields, set = (k, v, sure) => { v = String(v || '').trim(); if (v && !F[k]) F[k] = { v, sure: sure !== false }; };
    const all = L.map((l) => l.s).join('\n'), U = all.toUpperCase();
    const paper = res.kind === 'invoice' || res.kind === 'packing list';
    // ---------- tables ----------
    const isHead = (l) => { if (l.c.length < 3) return null; const ty = l.c.map(ruType916), d = [...new Set(ty.filter(Boolean))]; return d.length >= 2 && (ty.includes('desc') || (ty.includes('cont') && (ty.includes('gross') || ty.includes('net')))) ? ty : null; };
    const headish = (l) => l.c.every((c) => RU_HEADISH916.test(c) || (ruType916(c) && !/\d{3}/.test(c) && !/:/.test(c)));
    const tables = [], used = new Set();
    let cur = '';
    for (let i = 0; i < L.length; i++) {
      const ty = isHead(L[i]); if (!ty) continue;
      const H = { ty, n: L[i].c.length, u: L[i].c.map(ruUnitIn916), units: [], order: [] };
      const hl = [L[i]]; used.add(i);
      for (let b = i - 1; b >= Math.max(0, i - 2) && headish(L[b]) && !isHead(L[b]); b--) { hl.unshift(L[b]); used.add(b); }
      let j = i + 1;
      while (j < L.length && headish(L[j]) && !isHead(L[j])) { hl.push(L[j]); used.add(j); j++; }
      hl.forEach((l) => l.c.forEach((c) => { const u = ruUnitIn916(c); if (u) H.units.push(u); const t = ruType916(c); if (/^(qty|net|gross|rate|value)$/.test(t)) H.order.push(t); }));
      H.wu = H.units.find((u) => RU_WU916.test(u)) || ''; H.cur = ruCur916(H.units.find((u) => RU_CURS916.test(u)) || '');
      if (H.cur) cur = cur || H.cur;
      const T = { H, items: [], tot: null, closed: false }; tables.push(T);
      let item = null, group = { desc: '', hs: '', origin: '' }, prevRow = false;
      const prev = tables.length > 1 ? tables[tables.length - 2].items.slice(-1)[0] : null;
      if (prev) group = { desc: prev.desc, hs: prev.hs, origin: prev.origin };
      const sums = (k) => T.items.reduce((n, x) => n + (typeof x[k] === 'number' ? x[k] : 0), 0);
      const near = (a, b) => Math.abs(a - b) <= Math.max(0.006, Math.abs(b) * 0.00002);
      const tot = () => (T.tot = T.tot || { qty: null, unit: '', packages: '', gross: null, net: null, wu: '', cbm: null, goods: null, charges: [], total: null, cur: '' });
      const totalRow = (l, label) => {
        const t = tot(); let s = l.c.filter((c) => !RU_CURS916.test(c.toUpperCase())).join('   ');
        const pk = s.match(new RegExp('(\\d[\\d,]*)\\s+(' + RU_PK916 + ')\\b', 'i'));
        if (pk) { t.packages = t.packages || (pk[1] + ' ' + pk[2]).toUpperCase(); s = s.replace(pk[0], ' '); }
        const nums = []; const re = /(USD|US\$|\$|AED|EUR|GBP)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(USD|AED|EUR|GBP|MTS?|KGS?|TONS?|LBS?|PCS|NOS|SETS?|CBM|M3)\b)?/gi; let m;
        while ((m = re.exec(s))) { if (!m[1] && /[A-Za-z\/-]/.test(s.charAt(m.index + m[0].indexOf(m[2]) - 1))) continue; nums.push({ n: Number(m[2].replace(/,/g, '')), u: (m[3] || m[1] || '').toUpperCase(), dec: (m[2].split('.')[1] || '').length }); }
        const sub = /^SUB[- ]?TOTAL/i.test(label);
        nums.forEach((x, k) => {
          if (/^(CBM|M3)$/.test(x.u)) { t.cbm = x.n; return; }
          const money = RU_CURS916.test(x.u);
          if (money) { cur = cur || ruCur916(x.u); t.cur = t.cur || ruCur916(x.u); }
          const f = ['qty', 'net', 'gross', 'value'].find((q) => !x['_' + q] && T.items.length && T.items.some((it) => typeof it[q] === 'number') && near(sums(q), x.n) && (q === 'value' ? t.total === null || sub : t[q] === null) && !(money && q !== 'value') && !(RU_WU916.test(x.u) && q === 'value'));
          if (f === 'value' || (!f && (money || (k === nums.length - 1 && x.dec === 2 && T.items.some((it) => typeof it.value === 'number'))))) { if (sub) t.goods = x.n; else t.total = x.n; }
          else if (f) { t[f] = x.n; if (f === 'qty') t.unit = t.unit || x.u || (T.items[0] || {}).unit || ''; else t.wu = t.wu || (RU_WU916.test(x.u) ? x.u : '') || (T.items[0] || {}).wu || H.wu; }
          else if (RU_WU916.test(x.u) && t.qty === null && res.kind !== 'packing list') { t.qty = x.n; t.unit = x.u; }
        });
      };
      for (; j < L.length; j++) {
        const l = L[j]; if (isHead(l)) break;
        const cells = l.c.filter((c) => { if (RU_CURS916.test(c.toUpperCase())) { cur = cur || ruCur916(c); return false; } return true; });
        if (!cells.length) continue;
        const tl = l.c.find((c) => /^(GRAND\s+|SUB[- ]?|NET\s+)?TOTAL\b/i.test(c));
        if (tl) { totalRow(l, tl); T.closed = true; used.add(j); continue; }
        if (T.closed) {
          const ch = l.s.match(/^((?:SEA|OCEAN|AIR|INLAND)?\s*(?:FREIGHT|INSURANCE|DISCOUNT|VAT|TAX|HANDLING|DOCUMENTATION)[A-Za-z %().\/-]*?)[\s:$]*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*(?:USD|AED)?$/i);
          if (ch && res.kind === 'invoice') { const t = tot(); if (t.total !== null && t.goods === null) { t.goods = t.total; t.total = null; } t.charges.push({ what: ch[1].trim().replace(/\s+/g, ' '), n: Number(ch[2].replace(/,/g, '')) }); used.add(j); }
          continue;
        }
        if (RU_STOP916.test(l.s) || /^CONTAINER DETAILS/i.test(l.s)) { T.closed = true; continue; }
        used.add(j);
        // what each cell says about the goods (HS code, origin, weights, container, seal, packing)
        const R = [], A = {};
        cells.forEach((c) => {
          let m;
          if ((m = c.match(/^\(?\s*H\.?S\.?\s*(?:CODE|NO)?\.?\s*[:#-]?\s*(\d[\d .]{2,16}\d)\s*\)?$/i))) A.hs = m[1].replace(/[^0-9]/g, '');
          else if ((m = c.match(/^\(?\s*(?:COUNTRY OF ORIGIN|ORIGIN|MADE IN)\s*[:-]?\s*([A-Za-z .]{2,40}?)\s*\)?$/i))) A.origin = m[1].trim().toUpperCase();
          else if ((m = c.match(/^GROSS\s*(?:WEIGHT|WT)\.?\s*[:-]?\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]*)\.?$/i))) { A.gross = Number(m[1].replace(/,/g, '')); A.wu = m[2].toUpperCase(); }
          else if ((m = c.match(/^NET\s*(?:WEIGHT|WT)\.?\s*[:-]?\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]*)\.?$/i))) { A.net = Number(m[1].replace(/,/g, '')); A.wu = m[2].toUpperCase() || A.wu; }
          else if ((m = c.match(/^(?:CONTAINER|CNTR)(?:\s*NO\.?)?\s*[:-]\s*([A-Z]{4}\s?\d{6,7})$/i))) { A.cont = m[1]; A.contLabel = true; }
          else if (/^[A-Z]{4}\s?\d{7}$/.test(c)) A.cont = c;
          else if (/^SEAL(?:\s*NO\.?)?\s*[:-]?\s*\w+$/i.test(c)) A.seal = 1;
          else if ((m = c.match(/^PACKING\s*[:-]\s*(.+)$/i))) { const q = m[1].match(/(\d[\d,]*)\s*([A-Za-z]+)/); if (q) A.pk = { n: Number(q[1].replace(/,/g, '')), u: q[2].toUpperCase() }; }
          else if ((m = c.match(RU_PKC916))) { A.pkTxt = c.toUpperCase().replace(/\s+/g, ' '); A.pk = A.pk || { n: Number(m[1].replace(/,/g, '')), u: m[2].toUpperCase().replace(/\s+/g, ' ') }; }
          else R.push(c);
        });
        const aligned = cells.length === H.n;
        let sr = false;
        if (R.length > 1 && /^\d{1,3}(\.0+)?\.?$/.test(R[0]) && (aligned ? H.ty[0] === 'sr' : true)) { sr = true; R.shift(); }
        const nums = R.map(ruNum916), texts = R.filter((c, k) => !nums[k] && /[A-Za-z]{2}/.test(c)), N = nums.filter(Boolean);
        const apply = (t) => { if (A.pkTxt) t.pkTxt = A.pkTxt; if (A.hs) t.hs = A.hs; if (A.origin) t.origin = A.origin; if (A.cont) t.cont = (t.cont || 0) + 1; if (A.pk) t.pk = A.pk;
          if (typeof A.gross === 'number') { t.gross = A.gross; t.wu = A.wu || t.wu; } if (typeof A.net === 'number') { t.net = A.net; t.wu = A.wu || t.wu; } };
        if (!N.length) {
          if (sr && texts.length) { item = { desc: texts[0], hs: group.hs, origin: group.origin, own: true, open: true, sure: true, n: 0 }; T.items.push(item); apply(item); prevRow = false; continue; }
          if (item) { apply(item); if (prevRow && texts.length === 1 && cells.length === 1 && !/:/.test(texts[0]) && texts[0].length < 70 && !Object.keys(A).length) item.desc += ' ' + texts[0]; }
          else { apply(group); if (texts.length && !group.own && !Object.keys(A).length) { group.desc = texts[0]; group.own = true; } }
          prevRow = false; continue;
        }
        // a row with numbers: a new line of goods, or more of the one before
        const numsOnly = !texts.length && !sr;
        if (numsOnly && !A.cont && T.items.length && !(item && item.open)) { totalRow(l, ''); continue; }   // only numbers under the rows: the table's own totals
        let target, more = false;
        if (item && item.open) { target = item; item.open = false; }
        else if (numsOnly && item && item.own && !A.contLabel) { target = item; more = true; }
        else { target = { desc: '', hs: group.hs, origin: group.origin, own: false, sure: true, n: 0 }; T.items.push(target); item = target; }
        const seen = [];
        const put = (k, x) => { if (!x) return; seen.push(k); target[k] = more && typeof target[k] === 'number' ? Math.round((target[k] + x.n) * 1e6) / 1e6 : x.n;
          if (k === 'qty') target.unit = target.unit || (x.u && !RU_CURS916.test(x.u) ? x.u : '') || H.u[H.ty.indexOf('qty')] || H.u[H.ty.indexOf('net')] || H.wu;
          if (k === 'gross' || k === 'net') target.wu = (RU_WU916.test(x.u) ? x.u : '') || H.u[H.ty.indexOf(k)] || target.wu || H.wu;
          if (k === 'value' && RU_CURS916.test(x.u)) cur = cur || ruCur916(x.u); };
        const hasQty = H.ty.includes('qty'), hasVal = H.ty.includes('value') || H.order.includes('value');
        if (aligned && !more) {
          cells.forEach((c, k) => {
            const t = H.ty[k], x = ruNum916(c);
            if (t === 'desc' && !ruNum916(c) && R.includes(c)) { target.desc = c; target.own = true; }
            else if (t === 'pk' && /\d/.test(c)) target.pkTxt = c.toUpperCase();
            else if (t === 'unit' && !x) target.unit = target.unit || (/^METRIC TON/i.test(c) ? 'MT' : c.toUpperCase());
            else if (x && /^(qty|gross|rate|value)$/.test(t)) put(t === 'rate' ? '_rate' : t, x);
            else if (x && t === 'net') put(!hasQty && hasVal ? 'qty' : 'net', x);
          });
          if (!target.own) target.desc = group.desc;
        } else {
          if (!more) { if (texts.length && !(texts.length === 1 && /^METRIC TON/i.test(texts[0]))) { target.desc = target.desc || texts[0]; target.own = target.own || !!texts[0]; } if (!target.desc) target.desc = group.desc; }
          texts.forEach((c) => { if (/^METRIC TON/i.test(c)) target.unit = target.unit || 'MT'; });
          const order = more && target.cols ? target.cols : null;
          if (order && order.length === N.length) order.forEach((k, q) => put(k, N[q]));
          else if (hasVal || res.kind === 'invoice') {
            const money = N.filter((x) => RU_CURS916.test(x.u)), wt = N.filter((x) => RU_WU916.test(x.u) || /^(PCS|NOS|SETS?|UNITS?|CTNS?)$/.test(x.u));
            let q = null, r = null, v = null;
            if (money.length && wt.length) { q = wt[0]; v = money[money.length - 1]; r = money.length > 1 ? money[money.length - 2] : null; }
            else {
              for (let a = 0; a < N.length - 2 && !v; a++) for (let b = a + 1; b < N.length - 1 && !v; b++) for (let c2 = b + 1; c2 < N.length && !v; c2++) if (Math.abs(N[a].n * N[b].n - N[c2].n) <= Math.max(0.02, N[c2].n * 0.0006)) { q = N[a]; r = N[b]; v = N[c2]; }
              if (!v && N.length === 2 && !H.order.includes('rate')) { q = N[0]; v = N[1]; }
              else if (!v) { v = N[N.length - 1]; if (N.length > 1) { q = N[0]; target.sure = false; } }
            }
            put('qty', q); put('_rate', r); put('value', v);
          } else {
            const o = H.order.filter((k) => k !== 'rate' && k !== 'value');
            if (o.length === N.length) o.forEach((k, q) => put(k, N[q]));
            else if (N.length === 1 && o.includes('qty')) put('qty', N[0]);
            else if (N.length === 2 && o.includes('gross') && o.includes('net')) { const g = o.filter((k) => k === 'gross' || k === 'net'); put(g[0], N[0]); put(g[1], N[1]); }
            else target.sure = false;
          }
        }
        if (!more) target.cols = seen.slice();
        apply(target); target.n++; prevRow = true;
      }
      i = j - 1;
    }
    // ---------- the goods lines: the table with the most rows ----------
    const best = tables.filter((t) => t.items.length).sort((a, b) => b.items.length - a.items.length)[0];
    if (best && paper) {
      const inv = res.kind === 'invoice';
      res.lines = best.items.map((it) => {
        const hs = String(it.hs || ''), l = { hs: hs.length === 12 ? hs.slice(0, 8) : hs, desc: String(it.desc || '').replace(/\s+/g, ' ').trim(), origin: it.origin || '', sure: it.sure !== false };
        if (typeof it.qty === 'number') { l.qty = it.qty; l.unit = it.unit || ''; }
        if (typeof it.gross === 'number') l.gross = it.gross;
        if (typeof it.net === 'number') l.net = it.net;
        if (l.gross !== undefined || l.net !== undefined) l.wu = it.wu || best.H.wu || '';
        if (typeof it.value === 'number') l.value = it.value; else if (inv) l.sure = false;
        if (!l.desc) l.sure = false;
        if (it.pk) l._pk = it.pk;
        return l;
      });
    }
    if (!res.lines.length && res.kind === 'invoice') {   // a scan read by Google: rows on one line each — kept only when qty × price = amount
      const unit = (U.match(/\((PCS|MTS?|KGS?|SETS?|NOS|CTNS?|ROLLS?|UNITS?)\)/) || [])[1] || '';
      const T = { qty: null, unit: '', packages: '', gross: null, net: null, wu: '', cbm: null, goods: null, charges: [], total: null, cur: '' }, n = (x) => Number(String(x).replace(/,/g, ''));
      L.forEach((l) => {
        const s = l.s.replace(/\s*\|\s*/g, ' ');
        const m = s.match(/^(.*?[A-Za-z].*?)\s+(\d[\d,]*(?:\.\d+)?)\s*(?:[A-Za-z]{2,5}\s+)?(?:USD|US\$|\$)?\s*(\d[\d,]*\.\d{1,4})\s+(?:USD|US\$|\$)?\s*(\d[\d,]*\.\d{2})$/);
        if (m && !/TOTAL/i.test(m[1]) && T.total === null && Math.abs(n(m[2]) * n(m[3]) - n(m[4])) <= Math.max(0.02, n(m[4]) * 0.0006)) { res.lines.push({ hs: '', desc: m[1].trim(), origin: '', qty: n(m[2]), unit, value: n(m[4]), sure: true }); return; }
        if (!res.lines.length) return;
        const t = s.match(/^(.*?)[\s:=})\]-]*(?:USD|US\$|\$)?\s*(\d[\d,]*\.\d{2})$/); if (!t) return;
        const sum = res.lines.reduce((a, x) => a + x.value, 0);
        if (/SUB[- ]?TOTAL/i.test(t[1]) || (T.goods === null && T.total === null && !/[A-Za-z]{3}/.test(t[1]))) T.goods = n(t[2]);   // the numbers under the rows
        else if (/^(GRAND\s+|NET\s+)?TOTAL\b/i.test(t[1])) T.total = n(t[2]);
        else if (/FREIGHT|INSURANCE|DISCOUNT|\bVAT\b/i.test(t[1])) { if (T.total !== null && T.goods === null) { T.goods = T.total; T.total = null; } T.charges.push({ what: t[1].replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim(), n: n(t[2]) }); }
        else if (/TOTAL/i.test(t[1])) T.total = n(t[2]);
      });
      if (T.total !== null || T.goods !== null) res.totals.push(T);
    }
    tables.forEach((t) => { if (t.tot && paper) { const x = t.tot; if (x.qty !== null || x.gross !== null || x.net !== null || x.total !== null || x.goods !== null || x.packages || x.cbm !== null) res.totals.push(x); } });
    // ---------- labels anywhere on the page ----------
    const lab = (re, fn) => { for (let i = 0; i < L.length; i++) for (let k = 0; k < L[i].c.length; k++) { const m = L[i].c[k].match(re); if (!m) continue; const v = ((m[m.length - 1] || '').trim() || (L[i].c[k + 1] || '')).replace(/^[\s—–:#|.-]+/, '').trim(); if (fn(v, i, k) === true) return; } };
    lab(/^(?:COMMERCIAL\s+|TAX\s+|PROFORMA\s+)?INV(?:OICE)?\.?\s*(?:NO|NUMBER|#|REF)\.?\s*[:#]?\s*(.*)$/i, (v) => { if (/\d/.test(v) && v.length <= 40 && !/^DATE/i.test(v)) { set('invoice_no', v); return true; } });
    lab(res.kind === 'invoice' ? /^(?:INVOICE\s+|INV\.?\s+)?DATED?\.?\s*:?\s*(.*)$/i : /^(?:INVOICE\s+|INV\.?\s+)DATED?\.?\s*:?\s*(.*)$/i, (v) => { const d = ruDate916(v); if (d) { set('invoice_date', d.v, d.sure); return true; } });
    lab(/^CURRENCY\s*:?\s*(.*)$/i, (v) => { if (/^[A-Za-z$]{1,3}$/.test(v)) { cur = ruCur916(v.toUpperCase()); F.currency = { v: cur, sure: true }; return true; } });
    let inco = null;
    lab(/^(?:(?:SHIPMENT|DELIVERY|PRICE|TRADE|INCO|SALES?)\s*TERMS?|TERMS?\s+OF(?:\s+(?:DELIVERY|SHIPMENT|SALE|TRADE))?|INCOTERMS?)\s*:?\s*(.*)$/i, (v, i, k) => {
      const m = (v + ' ' + (L[i].c[k + 1] && v ? '' : '')).match(RU_INCO916) || ((L[i].c[k + 1] || '').match(RU_INCO916)); if (m) { inco = { m, sure: true }; return true; } });
    if (!inco && paper) { const m = all.match(new RegExp('(?:^|[\\s:(])' + RU_INCO916.source.replace('\\b[\\s,:-]*(.*)$', '\\b[ ,:-]*([^\\n]*)'), 'im')); if (m && !/^EX$/i.test(m[1])) inco = { m, sure: /^[A-Z]/.test(m[2] || '') && (m[2] || '').length < 40 }; }
    if (inco) {
      const code = inco.m[1].toUpperCase().replace(/[^A-Z&]/g, ''), c3 = /^EXW/.test(code) ? 'EXW' : /^(CNF|C&F|CF)$/.test(code) ? 'CFR' : code;
      set('incoterm', c3, inco.sure);
      const place = String(inco.m[2] || '').split(/\s{3,}/)[0].replace(/\s+(USD|AED|EUR|GBP|INR|CNY|RMB|SAR|US\$|BY|VIA|PER|PAYMENT|PRICE|TERMS?|INCOTERMS?)\b.*$|\s+\d.*$/i, '').replace(/^[\s,:-]+|[\s,.;:-]+$/g, ''); if (place && place.length <= 50 && /[A-Za-z]{3}/.test(place) && !/^(DELIVERY|BASIS|TERMS?)$/i.test(place)) set('place', place.toUpperCase(), inco.sure);
    }
    const fr = U.match(/FREIGHT\s*:?\s*(PREPAID|COLLECT)|(PREPAID|COLLECT)\s+FREIGHT/); if (fr && paper) set('freight', fr[1] || fr[2]);
    lab(/^(?:SHIPPING\s+)?MARKS?(?:\s*(?:&|AND)\s*(?:NOS?|NUMBERS?))?\.?\s*:\s*(.*)$/i, (v) => { if (v && v.length <= 200) { set('marks', v); return true; } });
    if (paper) lab(/^\(?\s*(?:COUNTRY OF ORIGIN|ORIGIN OF GOODS|MADE IN)\s*[:-]?\s*([A-Za-z .]{0,40}?)\s*\)?$/i, (v) => { if (/^[A-Za-z .]{2,40}$/.test(v)) { set('origin', v.toUpperCase()); return true; } });
    // total weights / packages printed outside the goods rows
    if (paper) {
      const T0 = { qty: null, unit: '', packages: '', gross: null, net: null, wu: '', cbm: null, goods: null, charges: [], total: null, cur: '' };
      const docWu = (tables.find((t) => t.H.wu) || { H: {} }).H.wu || '';
      const wt = (k, re) => lab(re, (v, i) => { if (used.has(i) && !/TOTAL/i.test(L[i].s)) return; const x = ruNum916(v); if (x && x.n > 0) { T0[k] = x.n; T0.wu = T0.wu || (RU_WU916.test(x.u) ? x.u : '') || docWu; return true; } });
      wt('gross', /^(?:TOTAL\s+)?GROSS\s*(?:WEIGHT|WT)\.?(?:\s*\(?(?:KGS?|MTS?)\)?)?\s*:?\s*(.*)$/i);
      wt('net', /^(?:TOTAL\s+)?NET\s*(?:WEIGHT|WT)\.?(?:\s*\(?(?:KGS?|MTS?)\)?)?\s*:?\s*(.*)$/i);
      lab(/^(?:TOTAL\s+)?(?:VOLUME|CBM|MEASUREMENT)\s*(?:\(CBM\))?\s*:?\s*(.*)$/i, (v, i) => { if (used.has(i) && !/TOTAL/i.test(L[i].s)) return; const x = ruNum916(v); if (x && x.n > 0 && (!x.u || /^(CBM|M3)$/.test(x.u))) { T0.cbm = x.n; return true; } });
      lab(/^TOTAL\s+(?:NO\.?\s*OF\s+)?(?:PACKAGES?|PKGS)\s*:?\s*(.*)$/i, (v) => { if (/^\d/.test(v) && v.length < 40) { T0.packages = v.toUpperCase(); return true; } });
      if (T0.gross !== null || T0.net !== null || T0.cbm !== null || T0.packages) res.totals.unshift(T0);
      // packages: a printed total first; else the largest count that the others add up to
      let pk = (res.totals.find((t) => t.packages) || {}).packages || '';
      if (!pk) {
        const c = []; const re = new RegExp('(?:^|[\\s:(])(\\d[\\d,]*)\\s+(' + RU_PK916 + ')\\b', 'gi'); let m;
        while ((m = re.exec(U))) c.push({ n: Number(m[1].replace(/,/g, '')), u: m[2].replace(/\s+/g, ' ') });
        const top = c.slice().sort((a, b) => b.n - a.n)[0];
        if (top) { const rest = c.filter((x) => x !== top && x.u === top.u && x.n < top.n).reduce((n, x) => n + x.n, 0); if (rest === top.n) pk = top.n + ' ' + top.u; }
      }
      if (pk) set('packages', pk);
    }
    if (!F.currency && paper) {
      const n = (re) => (U.match(re) || []).length, c = [['USD', n(/\bUSD\b|US\$|US DOLLARS?/g)], ['AED', n(/\bAED\b|\bDHS\b|DIRHAMS?/g)], ['EUR', n(/\bEUR\b|€/g)], ['GBP', n(/\bGBP\b|£/g)], ['INR', n(/\bINR\b|RUPEES/g)], ['CNY', n(/\bCNY\b|\bRMB\b/g)], ['SAR', n(/\bSAR\b/g)]].sort((a, b) => b[1] - a[1]);
      if (c[0][1] > 0) set('currency', c[0][0], c[0][1] > c[1][1]); else if (cur) set('currency', cur, false); else if (/\$/.test(U)) set('currency', 'USD', false);
    }
    res.totals.forEach((t) => { if ((t.total !== null || t.goods !== null) && !t.cur && F.currency) t.cur = F.currency.v; });
    // ---------- the parties ----------
    if (paper) {
      const block = (re, key) => {
        for (let i = 0; i < L.length; i++) {
          const m = L[i].c[0].match(re); if (!m || used.has(i)) continue;
          const first = (m[m.length - 1] || '').trim(); if (/^TO$/i.test(m[1]) && !/:/.test(L[i].c[0])) continue;
          if (first && (RU_KEY916.test(first) || first.length > 90 || /:/.test(first))) continue;
          const out = first ? [first] : [];
          let clean = true;
          for (let j = i + 1; j < L.length && out.length < (ocr ? 5 : 7) && j < i + 12; j++) {
            const c = L[j].c[0];
            if (ocr && out.length && (L[j].gap || RU_KEY916.test(c) || /^(CONTAINER|SHIPPING|MARKS?|FROM|ISSUED|L\/C|PER|VIA|SAILING|SHIPPED)\b/i.test(c))) break;
            if (ocr && ((c.match(/\d+\.\d{2}\b/g) || []).length >= 2 || L[j].s.split(/\s+/).filter(ruType916).length >= 3 || /^(FROM|ISSUED|SHIPPED|PER|VIA)\b/i.test(c))) { clean = out.length > 0; break; }
            if (used.has(j) || RU_SHIP916.test(c) && !/^TO\b/i.test(c) || /^(BUYER|CONSIGNEE|IMPORTER|NOTIFY|BILL TO|SOLD TO|SHIP TO)\b/i.test(c) || isHead(L[j])) break;
            if (RU_KEY916.test(c)) continue;
            if (cols !== false && L[j].c.length > 1 && ruType916(c)) break;
            out.push(c);
          }
          if (out.length && /[A-Za-z]{3}/.test(out[0]) && clean) { set(key, out.join('\n').slice(0, 600), !ocr || out.length <= 5); return; }
        }
      };
      block(RU_SHIP916, 'shipper'); block(RU_CONS916, 'consignee'); block(RU_NOTI916, 'notify');
      if (!F.shipper) {   // no label: a company name printed as the letterhead
        const co = /\b(L\.?L\.?C|LTD|LIMITED|CO\.|FZE|FZCO|FZC|INC|CORP|CORPORATION|TRADING|INDUSTRIES|ENTERPRISES?|GMBH|PVT|COMPANY|IMPORT|EXPORT)\b/i;
        for (let i = 0; i < Math.min(L.length, 4); i++) { const c = L[i].c[0]; if (co.test(c) && !/INVOICE|PACKING/i.test(c) && c.length < 90) { set('shipper', c, false); break; } }
      }
      const ds = [...new Set(res.lines.map((l) => l.desc.toUpperCase()).filter(Boolean))];
      if (ds.length) set('description', ds.slice(0, 4).join(', ').slice(0, 300), ds.length <= 4);
      if (!F.origin) { const o = [...new Set(res.lines.map((l) => l.origin).filter(Boolean))]; if (o.length === 1) set('origin', o[0]); }
    }
    return res;
  }

  // ---------- files → pages (on this device) ----------
  function rdLib915() {
    if (RD.lib) return RD.lib;
    RD.lib = new Promise((ok, no) => {
      if (window.pdfjsLib) return ok(window.pdfjsLib);
      const s = document.createElement('script'); s.src = PDFJS915 + 'pdf.min.js'; s.async = true;
      s.onload = () => { if (!window.pdfjsLib) return no(new Error('pdf')); window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS915 + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
      s.onerror = () => { RD.lib = null; no(new Error('The PDF reader could not load — check the internet and add the file again.')); };
      document.head.appendChild(s);
    });
    return RD.lib;
  }
  const rdPages915 = () => RD.files.reduce((n, f) => n + f.pages.length, 0);
  function rdAdd915(list) {
    const files = [...(list || [])].filter((f) => f && f.size !== 0);
    if (!files.length) return;
    let skipped = 0;
    files.forEach((file) => {
      if (RD.files.length >= RD_MAXF915) { skipped++; return; }
      const f = { id: ++RD.n, name: file.name || 'Pasted picture', st: 'prep', pages: [], meta: '', thumb: '', err: '', total: 0 };
      RD.files.push(f);
      RD.q = RD.q.then(() => rdPrep915(f, file));
    });
    RD.msg = null;
    if (skipped) toast('Twelve files at a time — read these first, or Start again.');
    rdDraw915();
  }
  async function rdPrep915(f, file) {
    if (!RD.files.includes(f)) return;
    try {
      const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(f.name);
      const isImg = /^image\//i.test(file.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(f.name);
      const isXls = /\.(xlsx?|xlsm|xlsb|csv)$/i.test(f.name) || /spreadsheet|ms-excel|text\/csv/i.test(file.type);   // v2.9.19: the SI in Excel
      if (!isPdf && !isImg && !isXls) throw new Error('Only PDFs, photos and Excel files can be read.');
      if (rdPages915() >= RD_MAXP915) throw new Error('Thirty pages at a time — read these first, or Start again.');
      if (isXls && !isPdf) await rdSheet919(f, file); else if (isPdf) await rdPdf915(f, file); else await rdImg915(f, file);
      f.st = 'ready';
    } catch (e) {
      f.st = 'err'; f.pages = [];
      const m = String(e && (e.message || e.name) || '');
      f.err = /password/i.test(m + (e && e.name)) ? 'This PDF has a password — open it, save it without one, and add it again.'
        : /Invalid PDF|corrupt|bad XRef|Missing PDF/i.test(m) ? 'This PDF could not be opened — it may be damaged.'
        : /photo type|decode|load|image/i.test(m) && !/PDF reader|Excel/.test(m) ? 'This photo type cannot be opened here — save it as JPG and add it again.'
        : m.length < 140 && /[a-z]/.test(m) && !/^(TypeError|Error)\b/.test(m) ? m : 'This file could not be opened.';
    }
    rdDraw915();
  }
  async function rdPdf915(f, file) {
    const lib = await rdLib915();
    const buf = new Uint8Array(await file.arrayBuffer());
    const doc = await lib.getDocument({ data: buf, isEvalSupported: false, disableAutoFetch: true, disableStream: true }).promise;
    try {
      const room = Math.max(0, RD_MAXP915 - rdPages915());
      const n = Math.min(doc.numPages, room);
      f.total = doc.numPages; f.more = doc.numPages - n;
      let scans = 0;
      for (let i = 1; i <= n; i++) {
        if (!RD.files.includes(f)) return;
        const pg = await doc.getPage(i);
        const p = { id: f.id + '.' + i, f, n: i, img: null, text: null, st: 'new', res: null, on: true, kind: '', thumb: '' };
        p.text = await rdText915(pg);
        if (!p.text) { p.img = await rdRender915(pg, 1500, 0.82); scans++; } else p.kind = rdRules916(p.text).kind;
        p.thumb = await rdRender915(pg, 132, 0.72); if (i === 1) f.thumb = p.thumb;
        f.pages.push(p);
        pg.cleanup();
        if (n > 2) rdDraw915();
      }
      f.meta = (scans === 0 ? 'text PDF' : scans === n ? 'scanned' : 'PDF') + ' · ' + rdPl915(doc.numPages, 'page');
    } finally { doc.destroy(); }
  }
  async function rdText915(pg) {   // the PDF's own text, laid out line by line (null when it is a scan)
    let tc; try { tc = await pg.getTextContent(); } catch (e) { return null; }
    const items = tc.items.filter((it) => it.str && it.str.trim());
    const flat = items.map((it) => it.str).join('').replace(/\s/g, '');
    if (flat.length < 40 || (flat.match(/[A-Za-z0-9]/g) || []).length / flat.length < 0.55) return null;
    const rows = [];
    items.forEach((it) => {
      const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
      let r = rows.find((q) => Math.abs(q.y - y) < Math.max(2, Math.min(q.h, h) * 0.5));
      if (!r) rows.push(r = { y, h, items: [] });
      r.items.push({ x, w: it.width || 0, s: it.str });
    });
    rows.sort((a, b) => b.y - a.y);
    return rows.map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      r.items.forEach((it) => { if (end !== null) { const gap = it.x - end; out += gap > r.h * 1.1 ? '   ' : gap > r.h * 0.12 && !/\s$/.test(out) && !/^\s/.test(it.s) ? ' ' : ''; } out += it.s; end = it.x + it.w; });
      return out.replace(/\s+$/, '');
    }).filter(Boolean).join('\n').slice(0, 20000);
  }
  async function rdRender915(pg, long, q) {
    const v1 = pg.getViewport({ scale: 1 }), sc = long / Math.max(v1.width, v1.height), vp = pg.getViewport({ scale: sc });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: x, viewport: vp }).promise;
    let u = c.toDataURL('image/jpeg', q); if (u.length > 1250000) u = c.toDataURL('image/jpeg', 0.66);
    c.width = c.height = 0;
    return u;
  }
  function rdImgEl915(file) {
    return new Promise((ok, no) => {
      const u = URL.createObjectURL(file), im = new Image();
      im.onload = () => { ok(im); setTimeout(() => URL.revokeObjectURL(u), 2000); };
      im.onerror = () => { URL.revokeObjectURL(u); no(new Error('This photo type cannot be opened here — save it as JPG and add it again.')); };
      im.src = u;
    });
  }
  function rdDraw915Img(src, w0, h0, long, q, cover) {
    const c = document.createElement('canvas');
    if (cover) { c.width = 76; c.height = 96; } else { const sc = Math.min(1, long / Math.max(w0, h0)); c.width = Math.round(w0 * sc); c.height = Math.round(h0 * sc); }
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    if (cover) { const sc = Math.max(c.width / w0, c.height / h0), w = w0 * sc, h = h0 * sc; x.drawImage(src, (c.width - w) / 2, (c.height - h) / 2, w, h); }
    else x.drawImage(src, 0, 0, c.width, c.height);
    let u = c.toDataURL('image/jpeg', q); if (!cover && u.length > 1250000) u = c.toDataURL('image/jpeg', 0.66);
    c.width = c.height = 0;
    return u;
  }
  async function rdImg915(f, file) {
    const im = await rdImgEl915(file);
    const w = im.naturalWidth, h = im.naturalHeight;
    if (!w || !h) throw new Error('This photo type cannot be opened here — save it as JPG and add it again.');
    f.thumb = rdDraw915Img(im, w, h, 0, 0.72, true);
    f.pages.push({ id: f.id + '.1', f, n: 1, img: rdDraw915Img(im, w, h, 1600, 0.84), text: null, st: 'new', res: null, on: true, kind: '', thumb: f.thumb });
    f.total = 1; f.meta = 'photo · 1 page';
  }

  // ---------- Read with Groq: one to three pages a call, paced to the plan's tokens a minute ----------
  const rdTodo915 = () => RD.files.filter((f) => f.st === 'ready').flatMap((f) => f.pages.filter((p) => p.on && (p.st === 'new' || p.st === 'wait') && (!RD.gapOnly || p.keep)));
  const rdOn916 = () => RD.files.filter((f) => f.st === 'ready').flatMap((f) => f.pages.filter((p) => p.on));
  const rdTx916 = (p) => p.text || (p.keep && !p.full && p.ocrOk ? p.ocr : null);   // what Groq gets: text when there is good text (a third of a picture's tokens)
  function rdCost915(p) { const t = rdTx916(p); return !t ? { in: 2100, out: p.short ? 1500 : 1900 } : { in: Math.ceil(t.length / 3.2) + 40, out: p.keep ? 1100 : 700 }; }
  function rdNeed915(b) {
    let i = 1000, o = 300; b.forEach((p) => { const c = rdCost915(p); i += c.in; o += c.out; });
    o = Math.min(o, 6000); return { in: i, out: o, total: i + o, likely: i + Math.round(o * 0.7) };
  }
  function rdBatch915() {
    const todo = rdTodo915(); if (!todo.length) return [];
    const b = [todo[0]], cap = RD.tpm * 0.9;
    if (!todo[0].solo) for (const p of todo.slice(1)) { if (b.length >= 3 || p.solo || rdNeed915(b.concat(p)).total > cap) break; b.push(p); }
    return b;
  }
  function rdLim915(l) {
    if (!l) return;
    if (l.tpm > 1000) { RD.tpm = l.tpm; try { localStorage.setItem('ethix.v2.groq915', JSON.stringify({ tpm: l.tpm })); } catch (e) { /* private mode */ } }
    if (typeof l.rem === 'number') { RD.rem = l.rem; RD.at = Date.now(); }
  }
  function rdWaitFor915(need) {
    if (RD.rem === null) return 0;
    const have = Math.min(RD.tpm, RD.rem + (Date.now() - RD.at) / 60000 * RD.tpm);
    return have >= need ? 0 : Math.min(65, Math.ceil((need - have) / RD.tpm * 60) + 1);
  }
  function rdSleep915(sec) {
    RD.until = Date.now() + sec * 1000; rdDraw915();
    return new Promise((ok) => {
      clearInterval(RD.tick);
      RD.tick = setInterval(() => {
        if (RD.stop) { clearInterval(RD.tick); RD.until = 0; return ok(false); }
        if (Date.now() >= RD.until) { clearInterval(RD.tick); RD.until = 0; return ok(true); }
        $$('[data-rd915-left]').forEach((e) => { e.textContent = rdLeft915(); });
      }, 500);
    });
  }
  const rdLeft915 = () => { const s = Math.max(0, Math.ceil((RD.until - Date.now()) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function rdEta915(pages) {   // the whole read, in words
    const tok = pages.reduce((n, p) => { const c = rdCost915(p); return n + c.in + c.out * 0.7 + 350; }, 0);
    const min = tok / RD.tpm, calls = Math.ceil(pages.filter((p) => !rdTx916(p)).length + pages.filter((p) => rdTx916(p)).length / 3);
    const sec = Math.max(min * 60, calls * 7);
    return sec < 50 ? 'under a minute' : sec < 90 ? 'about a minute' : 'about ' + Math.round(sec / 60) + ' minutes';
  }
  async function rdRead915(mode) {
    if (RD.busy) { RD.stop = true; rdDraw915(); return; }
    await RD.q;
    mode = mode || 'groq';
    const again = (P) => P.forEach((p) => { p.keep = p.res; p.st = 'new'; });
    if (mode === 'groq' && !rdTodo915().length) { const P = rdOn916().filter((p) => p.st === 'done' && p.by !== 'groq'); P.forEach((p) => { p.full = true; }); again(P); }   // read again, everything with Groq
    if (mode === 'gaps') again(rdOn916().filter((p) => p.st === 'done' && p.gap));
    if (!rdTodo915().length) return;
    RD.busy = true; RD.stop = false; RD.msg = null; RD.tries = 0; RD.user = state.user; RD.how = null; RD.fill = 0; RD.fillN = 0;
    RD.stage = mode === 'smart' ? 'free' : 'groq';
    rdDraw915();
    let fail = null, read = 0, free = 0, scans = 0;
    try {
      if (mode === 'smart') {
        const r = await rdFree916(); fail = r.fail; free = r.read; scans = r.scans;
        if (fail && fail.auth) return;
        const G = fail || RD.stop ? [] : rdGaps916();
        G.forEach((p) => { p.gap = true; });
        if (G.length) { again(G); mode = 'gaps'; } else mode = '';
      }
      RD.gapOnly = mode === 'gaps'; RD.stage = mode ? 'groq' : ''; RD.fillN = RD.gapOnly ? rdTodo915().length : 0;
      if (mode) rdDraw915();
      while (mode && !RD.stop) {
        const batch = rdBatch915(); if (!batch.length) break;
        const need = rdNeed915(batch), wait = rdWaitFor915(need.likely);
        if (wait > 0) { batch.forEach((p) => { p.st = 'wait'; }); if (!(await rdSleep915(wait))) { batch.forEach((p) => { p.st = 'new'; }); break; } }
        batch.forEach((p) => { p.st = 'read'; }); rdDraw915();
        let res;
        try {
          res = await api.call('ethixReadGroq', [{ pages: batch.map((p) => { const t = rdTx916(p); return !t ? { img: p.img } : p.text ? { text: t } : { text: t, ocr: true }; }), out: need.out, short: batch.some((p) => p.short) }], { timeout: 150000 });
        } catch (e) { batch.forEach((p) => { p.st = 'new'; }); if (e && e.kind === 'auth') return; fail = { err: (e && e.message) || 'Could not reach EWS — try again.' }; break; }
        if (!RD.files.some((f) => batch.some((p) => p.f === f))) continue;   // Start again while it was reading
        res = res || {};
        rdLim915(res.lim);
        if (res.error) { batch.forEach((p) => { p.st = 'new'; }); fail = { err: res.error }; break; }
        if (res.busy) {
          batch.forEach((p) => { p.st = 'new'; });
          if (res.wait && res.wait <= 65 && RD.tries < 3) {
            RD.tries++; batch.forEach((p) => { p.st = 'wait'; });
            const go = await rdSleep915(res.wait + 1); batch.forEach((p) => { p.st = 'new'; }); if (!go) break; continue;
          }
          fail = { busy: true, why: res.why }; break;
        }
        if (res.big || res.cut) {
          if (batch.length > 1) { batch.forEach((p) => { p.solo = true; p.st = 'new'; }); continue; }
          const p = batch[0];
          if (!p.short) { p.short = true; p.st = 'new'; continue; }
          if (p.keep) { p.res = p.keep; p.keep = null; p.full = false; p.st = 'done'; continue; }   // the rules' reading stays, its gaps marked
          p.st = 'err'; p.why = 'Too much on this page for one read — try a clearer scan or photo.'; continue;
        }
        RD.tries = 0;
        batch.forEach((p, i) => {
          const x = (res.pages || [])[i] || { kind: 'other', text: '' };
          p.old = p.keep || null; p.keep = null;
          p.res = { kind: x.kind || 'other', text: p.text ? '' : String(x.text || '') || p.ocr || '', fields: x.fields || {}, lines: [], totals: [] };
          p.st = 'done'; p.by = 'groq'; p.gap = false; read++; RD.fill++;
        });
        (res.lines || []).forEach((l) => { const p = batch[(l.p || 1) - 1]; if (p) p.res.lines.push(l); });
        (res.totals || []).forEach((t) => { const p = batch[(t.p || 1) - 1]; if (p) p.res.totals.push(t); });
        batch.forEach((p) => {   // a gap fill: what the rules found and Groq left out stays
          const o = p.old; p.old = null;
          if (o && !p.full) { Object.keys(o.fields).forEach((k) => { if (!p.res.fields[k]) p.res.fields[k] = o.fields[k]; }); if (p.res.kind === 'other') p.res.kind = o.kind; if (!p.res.lines.length) p.res.lines = o.lines; if (!p.res.totals.length) p.res.totals = o.totals; }
          p.full = false; p.kind = p.res.kind;
        });
        if (RD.files.some((f) => f.pages.some((p) => p.st === 'done')) && !RD.done) RD.done = 1;
        rdDraw915();
      }
    } finally {
      RD.busy = false; RD.until = 0; clearInterval(RD.tick); RD.gapOnly = false; RD.stage = '';
      RD.files.forEach((f) => f.pages.forEach((p) => {
        if (p.keep) { p.res = p.keep; p.keep = null; p.full = false; p.st = 'done'; }   // not reached: the reading it had stays
        else if (p.st === 'read' || p.st === 'wait') p.st = 'new';
      }));
    }
    const left = rdOn916().filter((p) => p.st === 'done' && p.gap).length, was = mode === 'gaps';
    if (free || read) RD.how = { free: free, scans: scans, groq: read, left: left };
    if (fail && fail.busy) {
      const t = fail.why === 'google' ? 'Google is busy reading — try again in a minute.' : fail.why === 'day' ? 'Groq’s free plan is used up for today — try again tomorrow.' : fail.why === 'hour' ? 'You have read a lot this hour — try again in a little while.' : 'Groq is busy — try again in a minute.';
      RD.msg = { kind: 'busy', text: was && left && fail.why !== 'google' ? t.replace(' — try again', ' — the gaps are marked CHECK. Try again') : t };
      rdNote915(RD.msg.text);
    } else if (fail) { RD.msg = { kind: 'err', text: fail.err }; toast(fail.err, { error: true }); }
    else if ((read || free) && !RD.stop && !(state.route && state.route.name === 'reader')) toast('Document reader — ' + rdPl915(free || read, 'page') + ' read');
    RD.stop = false;
    rdDraw915();
  }
  function rdNote915(text) {   // the capsule with an amber hourglass (a wait, not a success)
    note99(text, {});
    const pill = $('#savePill'), t = $('#savePillText'); if (!pill || !t) return;
    pill.classList.add('is-wait915');
    const off = () => { pill.classList.remove('is-wait915'); mo.disconnect(); };
    const mo = new MutationObserver(() => { if (t.textContent !== text) off(); });
    mo.observe(t, { childList: true, characterData: true, subtree: true });
    setTimeout(off, 4000);
  }
  function rdDraw915() { if (state.signedIn && state.route && state.route.name === 'reader') rerender(); }

  // ---------- what was read → the SI, the BOE, all text ----------
  const rdDone915 = () => RD.files.flatMap((f) => f.pages.filter((p) => p.on && p.res && (p.st === 'done' || p.keep)));
  const rdNum915 = (n, d) => (n === null || n === undefined || !isFinite(n) ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  function rdKg915(n, u) {
    if (n === null || n === undefined || !isFinite(n)) return null;
    const t = String(u || '').toUpperCase().replace(/[^A-Z]/g, '');
    const k = /^(MT|MTS|MTON|TON|TONS|TONNE|TONNES|TNE|T)$/.test(t) ? 1000 : /^(LB|LBS|POUNDS?)$/.test(t) ? 0.45359237 : /^(G|GM|GMS|GRAMS?)$/.test(t) ? 0.001 : 1;
    return Math.round(n * k * 1000) / 1000;
  }
  function rdSrc915(p, total) {
    const k = RD_KIND915[p.res.kind];
    if (total) return (k || p.f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 22)) + ' total';
    return (k || p.f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 22)) + ' p' + p.n;
  }
  const RD_PARTY915 = ['invoice', 'packing list', 'bill of lading', 'certificate of origin', 'other', 'si', 'eir'];
  const RD_PACK915 = ['packing list', 'invoice', 'bill of lading', 'certificate of origin', 'other', 'si', 'eir'];
  function rdRank915(list, order) { return list.map((x, i) => [x, i]).sort((a, b) => (order.indexOf(a[0].p.res.kind) - order.indexOf(b[0].p.res.kind)) || a[1] - b[1]).map((x) => x[0]); }
  function rdCands915(key) { return rdDone915().filter((p) => p.res.fields[key] && p.res.fields[key].v).map((p) => ({ p, v: String(p.res.fields[key].v), sure: p.res.fields[key].sure !== false && !p.gap })); }
  const rdKey915 = (v) => String(v || '').toUpperCase().split('\n')[0].replace(/\b(LLC|L\.L\.C|FZE|FZCO|FZC|FZ|LTD|LIMITED|PVT|CO|INC)\b\.?/g, '').replace(/[^A-Z0-9]/g, '').slice(0, 24);
  function rdPick915(key, order, same) {
    const c = rdRank915(rdCands915(key), order); if (!c.length) return null;
    const top = c[0], cmp = same || ((v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, ''));
    const other = c.find((x) => (x.p.res.kind !== top.p.res.kind || x.p.f !== top.p.f) && cmp(x.v) && cmp(x.v) !== cmp(top.v));   // another document, or another file
    return { v: top.v, src: rdSrc915(top.p), f: top.p.f, chk: !top.sure || !!other, why: other ? rdSrc915(other.p) + ' says ' + String(other.v).split('\n')[0] : '' };
  }
  function rdTot915(field, order) {   // a total weight / volume: the packing list first; another document that disagrees → CHECK
    const c = [];
    rdDone915().forEach((p) => p.res.totals.forEach((t) => { const v = field === 'cbm' ? t.cbm : rdKg915(t[field], t.wu); if (v) c.push({ p, v }); }));
    const r = rdRank915(c, order); if (!r.length) return null;
    const top = r[0], other = r.find((x) => (x.p.res.kind !== top.p.res.kind || x.p.f !== top.p.f) && Math.abs(x.v - top.v) > Math.max(0.0015, top.v * 0.0005));
    return { v: top.v, src: rdSrc915(top.p, true), chk: !!other, why: other ? rdSrc915(other.p, true) + ' says ' + rdNum915(other.v, 3) + (field === 'cbm' ? ' CBM' : ' KGS') : '' };
  }
  const RD_ISO915 = { INDIA: 'IN', CHINA: 'CN', 'PEOPLES REPUBLIC OF CHINA': 'CN', PRC: 'CN', TAIWAN: 'TW', 'UNITED ARAB EMIRATES': 'AE', UAE: 'AE', 'U.A.E': 'AE', 'U.A.E.': 'AE', PAKISTAN: 'PK', BANGLADESH: 'BD', 'SRI LANKA': 'LK', TURKEY: 'TR', TURKIYE: 'TR', ITALY: 'IT', GERMANY: 'DE', SPAIN: 'ES', FRANCE: 'FR', 'UNITED KINGDOM': 'GB', UK: 'GB', 'UNITED STATES': 'US', USA: 'US', JAPAN: 'JP', KOREA: 'KR', 'SOUTH KOREA': 'KR', VIETNAM: 'VN', 'VIET NAM': 'VN', THAILAND: 'TH', MALAYSIA: 'MY', INDONESIA: 'ID', SINGAPORE: 'SG', 'SAUDI ARABIA': 'SA', OMAN: 'OM', EGYPT: 'EG', AFGHANISTAN: 'AF', IRAN: 'IR', BRAZIL: 'BR' };
  const rdIso915 = (v) => { const t = String(v || '').toUpperCase().replace(/^MADE IN\s+/, '').trim(); return /^[A-Z]{2}$/.test(t) ? t : RD_ISO915[t] || RD_ISO915[t.replace(/\./g, '')] || t; };
  function rdDate915(v) { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '-' + m[2] + '-' + m[1] : String(v || ''); }
  function rdPkg915(v) { return String(v || '').toUpperCase().replace(/\d{4,}(\.\d+)?/g, (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 })); }
  function rdMerge915() {
    const done = rdDone915(), F = {};
    const field = (k, label, v, extra) => { F[k] = Object.assign({ k, label, v: v ? v.v : '', src: v ? v.src : '', chk: !!(v && v.chk), why: v ? v.why || '' : '' }, extra || {}); };
    const party = (k, alt) => rdPick915(k, RD_PARTY915, rdKey915) || (alt ? rdPick915(alt, RD_PARTY915, rdKey915) : null);
    const up = (x) => (x ? Object.assign({}, x, { v: String(x.v).toUpperCase() }) : x);
    field('shipper', 'SHIPPER', up(party('shipper', 'exporter')));
    field('consignee', 'CONSIGNEE', up(party('consignee', 'importer')));
    field('notify', 'NOTIFY PARTY', up(party('notify')));
    field('marks', 'MARKS & NUMBERS', up(rdPick915('marks', RD_PACK915)));
    // lines (the BOE) — the invoice's own lines; weights from the packing list when the invoice has none and the lines match
    const inv = done.filter((p) => p.res.kind === 'invoice').flatMap((p) => p.res.lines.map((l) => Object.assign({ pg: p }, l)));
    const pl = done.filter((p) => p.res.kind === 'packing list').flatMap((p) => p.res.lines.map((l) => Object.assign({ pg: p }, l)));
    const other = done.filter((p) => p.res.kind !== 'invoice' && p.res.kind !== 'packing list').flatMap((p) => p.res.lines.map((l) => Object.assign({ pg: p }, l)));
    const base = inv.length ? inv : pl.length ? pl : other;
    const origAll = rdCands915('origin'), origOne = [...new Set(origAll.map((x) => rdIso915(x.v)))];
    const origOf = (f) => { const x = origAll.find((o) => o.p.f === f); return x ? x.v : origOne.length === 1 ? origOne[0] : ''; };   // the same file's origin; another file's only when all agree
    let wFrom = '';
    const lines = base.map((l) => ({ hs: String(l.hs || '').replace(/[^0-9]/g, ''), hsRaw: l.hs || '', desc: l.desc || '', origin: rdIso915(l.origin || origOf(l.pg.f)), qty: l.qty, unit: String(l.unit || '').toUpperCase(),
      gross: rdKg915(l.gross, l.wu), net: rdKg915(l.net, l.wu), value: base === inv ? l.value : null, sure: l.sure !== false && !l.pg.gap, src: rdSrc915(l.pg), pf: l.pg.f }));
    if (base === inv && pl.length === inv.length && lines.every((l) => l.gross === null && l.net === null)) {
      lines.forEach((l, i) => { l.gross = rdKg915(pl[i].gross, pl[i].wu); l.net = rdKg915(pl[i].net, pl[i].wu); }); wFrom = 'pl';
    }
    // description: the invoice's words + its HS codes
    const desc = rdPick915('description', RD_PARTY915);
    if (desc) {
      const hs = [...new Set(lines.filter((l) => l.pf === desc.f).map((l) => String(l.hsRaw || '').trim()).filter((x) => /\d{4}/.test(x)))];
      const have = desc.v.replace(/[^0-9]/g, '');
      const add = hs.filter((x) => have.indexOf(x.replace(/[^0-9]/g, '')) < 0);
      desc.v = desc.v.toUpperCase() + (add.length ? '\nHS CODE ' + add.join(', ') : '');
      const kinds = [...new Set(rdCands915('description').map((x) => x.p.res.kind))].filter((k) => RD_KIND915[k] && desc.src.indexOf(RD_KIND915[k]) !== 0);
      if (kinds.length) desc.src += ' · ' + kinds.map((k) => RD_KIND915[k]).join(' · ');
    }
    field('description', 'DESCRIPTION OF GOODS', desc, { wide: true });
    // packages, weights, volume — the packing list's totals first
    let pk = rdPick915('packages', RD_PACK915);
    if (!pk) { const c = []; done.forEach((p) => p.res.totals.forEach((t) => { if (t.packages) c.push({ p, v: t.packages }); })); const r = rdRank915(c, RD_PACK915); if (r.length) pk = { v: r[0].v, src: rdSrc915(r[0].p, true), chk: false }; }
    if (pk) pk.v = rdPkg915(pk.v);
    field('packages', 'PACKAGES', pk);
    const sum = (k) => (lines.length && lines.every((l) => typeof l[k] === 'number') ? Math.round(lines.reduce((n, l) => n + l[k], 0) * 1000) / 1000 : null);
    const kg = (k) => { const t = rdTot915(k, RD_PACK915); if (t) return Object.assign(t, { v: rdNum915(t.v, 3) + ' KGS', n: t.v }); const s = sum(k); return s ? { v: rdNum915(s, 3) + ' KGS', n: s, src: 'Lines added up', chk: false, why: '' } : null; };
    const g = kg('gross'), n = kg('net');
    if (g && n && n.n > g.n + 0.0005) { n.chk = true; n.why = n.why || 'Net is more than gross'; }
    field('gross', 'GROSS WEIGHT', g); field('net', 'NET WEIGHT', n);
    const vol = rdTot915('cbm', RD_PACK915); if (vol) vol.v = rdNum915(vol.v, 3) + ' CBM';
    field('volume', 'VOLUME', vol);
    const ino = rdPick915('invoice_no', RD_PARTY915), idt = rdPick915('invoice_date', RD_PARTY915);
    field('invoice', 'INVOICE NO. / DATE', ino || idt ? { v: [ino ? ino.v.toUpperCase() : '', idt ? rdDate915(idt.v) : ''].filter(Boolean).join(' · '), src: (ino || idt).src, chk: !!((ino && ino.chk) || (idt && idt.chk)), why: (ino && ino.why) || (idt && idt.why) || '' } : null);
    const inc = rdPick915('incoterm', RD_PARTY915), plc = rdPick915('place', RD_PARTY915), fr = rdPick915('freight', RD_PARTY915);
    const incT = inc ? inc.v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) : '';
    const frT = fr ? fr.v.toUpperCase().replace(/^FREIGHT\s+/, '') : /^(C|D)/.test(incT) ? 'PREPAID' : /^(E|F)/.test(incT) ? 'COLLECT' : '';
    field('freight', 'FREIGHT TERMS', inc || fr ? { v: [incT + (plc ? ' ' + plc.v.toUpperCase() : ''), frT ? 'FREIGHT ' + frT : ''].filter((x) => x.trim()).join(' · '), src: (inc || fr).src, chk: !!((inc && inc.chk) || (fr && fr.chk)), why: (inc && inc.why) || '' } : null);
    // the BOE: lines, totals checked against the invoice
    const cur = rdPick915('currency', RD_PARTY915);
    const tots = done.filter((p) => p.res.kind === 'invoice').flatMap((p) => p.res.totals);
    const curT = (cur ? cur.v : (tots.find((t) => t.cur) || {}).cur || '').toUpperCase().slice(0, 3);
    const qtyUnits = [...new Set(lines.map((l) => l.unit))];
    const T = { qty: qtyUnits.length === 1 && lines.every((l) => typeof l.qty === 'number') ? lines.reduce((s, l) => s + l.qty, 0) : null, unit: qtyUnits.length === 1 ? qtyUnits[0] : '',
      gross: sum('gross'), net: sum('net'), value: lines.length && lines.every((l) => typeof l.value === 'number') ? Math.round(lines.reduce((s, l) => s + l.value, 0) * 100) / 100 : null };
    let wTot = false;
    if (T.gross === null && g) { T.gross = g.n; wTot = true; }
    if (T.net === null && n) { T.net = n.n; wTot = true; }
    const money = (x) => (curT ? curT + ' ' : '') + rdNum915(x, 2);
    let t0 = tots.find((t) => t.goods !== null || t.total !== null) || null;
    const invF = [...new Set(done.filter((p) => p.res.kind === 'invoice').map((p) => p.f))];
    if (invF.length > 1) {   // v2.9.16: two invoices dropped together — their totals added up
      const per = invF.map((f) => done.filter((p) => p.f === f && p.res.kind === 'invoice').flatMap((p) => p.res.totals).find((t) => t.goods !== null || t.total !== null));
      const r2 = (x) => Math.round(x * 100) / 100, gd = (t) => (t.goods !== null ? t.goods : (t.charges || []).length ? null : t.total);
      if (per.every((t) => t && gd(t) !== null)) t0 = { goods: r2(per.reduce((n, t) => n + gd(t), 0)), total: per.every((t) => t.total !== null) ? r2(per.reduce((n, t) => n + t.total, 0)) : null, charges: per.flatMap((t) => t.charges || []), cur: per[0].cur };
    }
    let check = { ok: null, text: '' };
    if (T.value !== null && t0) {
      const ch = t0.charges || [], chSum = ch.reduce((s, c) => s + (c.n || 0), 0), goods = t0.goods !== null ? t0.goods : t0.total !== null && !ch.length ? t0.total : null;
      const eq = (a, b) => Math.abs(a - b) < Math.max(0.015, lines.length * 0.005 + 0.001);
      if (goods !== null && eq(T.value, goods)) {
        check = ch.length && t0.total !== null && eq(goods + chSum, t0.total)
          ? { ok: true, text: 'Totals checked: the lines add up to ' + money(T.value) + '; with ' + ch.map((c) => (c.what || 'charges').toLowerCase() + ' ' + money(c.n)).join(' and ') + ' that is the invoice total, ' + money(t0.total) + '.' }
          : { ok: true, text: 'Totals checked: the lines add up to the invoice total.' };
      } else if (goods !== null) check = { ok: false, text: 'Check the lines: they add up to ' + money(T.value) + ' — the invoice says ' + money(goods) + '.' };
      else if (t0.total !== null) check = { ok: false, text: 'Check the lines: they add up to ' + money(T.value) + ' — the invoice total is ' + money(t0.total) + (ch.length ? ' with ' + ch.map((c) => (c.what || 'charges').toLowerCase()).join(', ') : '') + '.' };
    } else if (T.value !== null && lines.length) check = { ok: null, text: 'The invoice total was not found — the lines add up to ' + money(T.value) + '.' };
    const plG = rdTot915('gross', ['packing list']);
    if (!wTot && invF.length <= 1 && T.gross !== null && plG && Math.abs(plG.v - T.gross) > Math.max(0.0015, T.gross * 0.0005)) check = { ok: false, text: (check.text ? check.text + ' ' : '') + 'Gross weights add up to ' + rdNum915(T.gross, 3) + ' KGS — the packing list says ' + rdNum915(plG.v, 3) + ' KGS.' };
    const nameOf = (x) => (x ? Object.assign({}, x, { v: String(x.v).split('\n')[0].toUpperCase(), chk: !!x.chk }) : null);
    const cards = [
      Object.assign({ k: 'importer', label: 'IMPORTER' }, rdCard915(nameOf(rdPick915('importer', RD_PARTY915, rdKey915) || party('consignee')))),
      Object.assign({ k: 'exporter', label: 'EXPORTER' }, rdCard915(nameOf(rdPick915('exporter', RD_PARTY915, rdKey915) || party('shipper')))),
      Object.assign({ k: 'incoterm', label: 'INCOTERMS' }, rdCard915(inc ? Object.assign({}, inc, { v: incT }) : null)),
      Object.assign({ k: 'currency', label: 'INVOICE CURRENCY' }, rdCard915(curT ? { v: curT, src: cur ? cur.src : t0 ? 'Invoice total' : '', chk: !!(cur && cur.chk) } : null))];
    const text = RD.files.flatMap((f) => f.pages.filter((p) => p.on && (p.st === 'done' || p.keep || (p.text && p.st !== 'err'))).map((p) => ({ p, kind: p.res ? (RD_KIND915[p.res.kind] || 'Other') : 'Text', text: p.text || p.ocr || (p.res && p.res.text) || '' }))).filter((x) => x.text);
    return { any: done.length > 0, F, lines, T, wFrom, wTot, check, cards, cur: curT, ino: ino ? ino.v.toUpperCase() : '', inc: incT, text, nInv: invF.length };
  }
  function rdCard915(x) { return x ? { v: x.v, src: x.src || '', chk: !!x.chk, why: x.why || '' } : { v: '', src: '', chk: false, why: '' }; }
  const RD_SI915 = ['shipper', 'consignee', 'notify', 'marks', 'description', 'packages', 'gross', 'net', 'volume', 'invoice', 'freight'];
  function rdSiText915(M) { return RD_SI915.map((k) => M.F[k]).filter((f) => f.v).map((f) => f.label + ':\n' + f.v).join('\n\n'); }
  function rdLineText915(l, cur) { return [l.hs, l.desc, l.origin, l.qty === null || l.qty === undefined ? '' : l.qty, l.unit, l.gross === null ? '' : l.gross.toFixed(3), l.net === null ? '' : l.net.toFixed(3), l.value === null || l.value === undefined ? '' : Number(l.value).toFixed(2), l.value === null || l.value === undefined ? '' : cur].join('\t'); }

  // ---------- the page ----------
  function rdFileSt915(f) {
    if (f.st === 'prep') return ['is-prep', 'OPENING…'];
    if (f.st === 'err') return ['is-err', 'CAN’T OPEN'];
    const P = f.pages.filter((p) => p.on), d = P.filter((p) => p.st === 'done').length;
    if (!P.length) return ['is-new', 'NOT TICKED'];
    if (P.some((p) => p.st === 'read')) return ['is-read', 'READING' + (P.length > 1 ? ' P' + P.find((p) => p.st === 'read').n : '')];
    if (P.some((p) => p.st === 'wait') && RD.until) return ['is-wait', 'WAITING <span data-rd915-left>' + rdLeft915() + '</span>'];
    if (P.length && d === P.length) return ['is-done', 'READ ' + icon('ok915', 11)];
    if (P.some((p) => p.st === 'err') && d + P.filter((p) => p.st === 'err').length === P.length) return ['is-err', d ? d + ' OF ' + P.length + ' READ' : 'NOT READ'];
    if (d) return ['is-part', d + ' OF ' + P.length + ' READ'];
    return ['is-new', 'READY'];
  }
  function rdFileRow915(f) {
    const st = rdFileSt915(f), P = f.pages.filter((p) => p.on), d = P.filter((p) => p.st === 'done').length;
    const one = f.pages.length === 1 && f.pages[0].kind ? ' · ' + rdKd916(f.pages[0].kind) : '';
    const meta = f.st === 'err' ? f.err : f.st === 'prep' ? 'getting the pages ready' : f.meta + (f.more ? ' · first ' + f.pages.length + ' opened' : '') + (f.pages.length > 1 && P.length < f.pages.length ? ' · ' + P.length + ' ticked' : '') + one;
    const bar = RD.busy && P.length > 1 && d < P.length && f.st === 'ready' ? '<i class="rd915-bar"><b style="width:' + Math.round(d / P.length * 100) + '%"></b></i>' : '';
    return '<div class="rd915-file ' + st[0] + '" data-f="' + f.id + '">' +
      '<span class="rd915-th">' + (f.thumb ? '<img src="' + f.thumb + '" alt="">' : '') + '</span>' +
      '<div class="rd915-fn"><b title="' + esc(f.name) + '">' + esc(f.name) + '</b><small>' + esc(meta.replace(/(\d) (pages?|ticked|opened)\b/g, '$1\u00a0$2').replace(/PACKING LIST/g, 'PACKING\u00a0LIST')) + '</small>' + bar + '</div>' +
      '<span class="rd915-st">' + st[1] + '</span>' +
      (RD.busy && f.pages.some((p) => p.st === 'read') ? '' : '<button type="button" class="rd915-x" data-rd915="rm" data-f="' + f.id + '" aria-label="Remove ' + esc(f.name) + '">' + icon('close', 13) + '</button>') + '</div>' + rdStrip916(f);
  }
  function rdLeftCard915() {
    const todo = rdTodo915(), prep = RD.files.some((f) => f.st === 'prep'), total = RD.files.reduce((n, f) => n + f.pages.length, 0), on = rdOn916().length;
    const done = rdOn916().filter((p) => p.st === 'done').length, anyDone = done > 0;
    const ph = isTouch();
    let act = '';
    if (RD.busy) {
      const cur = RD.files.flatMap((f) => f.pages).filter((p) => p.st === 'read');
      act = '<div class="rd915-run" role="status">' + (RD.until ? '<span class="rd915-dot is-wait"></span>Waiting for Groq’s free plan · <b data-rd915-left>' + rdLeft915() + '</b>'
        : RD.stage === 'free' ? '<span class="rd915-dot"></span>' + rdFreeSay916()
        : RD.gapOnly ? '<span class="rd915-dot"></span>Groq is filling the gaps · page ' + Math.min(RD.fillN, RD.fill + 1) + (cur.length > 1 ? '–' + Math.min(RD.fillN, RD.fill + cur.length) : '') + ' of ' + RD.fillN + '…'
        : '<span class="rd915-dot"></span>Groq is reading ' + (cur.length > 1 ? 'pages ' : 'page ') + (done + 1) + (cur.length > 1 ? '–' + (done + cur.length) : '') + ' of ' + on + '…') + '</div>' +
        '<button type="button" class="btn-ghost rd915-stop" data-rd915="read">Stop</button>';
    } else if (RD.files.length) {
      const label = prep ? 'Getting the pages ready…' : RD.msg && todo.length ? 'Try again' : todo.length && anyDone ? 'Read ' + rdPl915(todo.length, 'new page') : 'Read';
      const gaps = rdOn916().filter((p) => p.st === 'done' && p.gap).length, canAgain = rdOn916().some((p) => p.st === 'done' && p.by !== 'groq');
      const how = RD.how && !todo.length ? (RD.how.groq && RD.how.free ? 'Groq filled the gaps on ' + rdPl915(RD.how.groq, 'page') : RD.how.groq ? 'Read with Groq' : RD.how.left ? '' : (RD.how.scans ? 'Read here and by Google' : 'Read here') + ' — Groq was not needed') : '';
      act = (RD.msg ? '<div class="rd915-msg is-' + RD.msg.kind + '" role="alert">' + esc(RD.msg.text) + '</div>' : '') +
        (todo.length || prep ? '<button type="button" class="rd915-go" data-rd915="smart"' + (prep ? ' disabled' : '') + '>' + icon('scan915', 17) + '<span>' + label + '</span></button>' +
          (!prep && todo.length && !RD.msg ? '<div class="rd915-eta">' + rdPl915(todo.length, 'page') + ' · ' + rdEta916(todo) + '</div>' : '')
        : anyDone ? '<div class="rd915-all-done">' + icon('ok915', 14) + '<span>' + (done === on && on > 1 ? 'All ' + on + ' pages read' : rdPl915(done, 'page') + ' read') + '</span></div>' +
          (how ? '<div class="rd916-how">' + esc(how) + '</div>' : '') +
          (gaps ? '<button type="button" class="rd915-go rd916-fill" data-rd915="gaps">' + icon('scan915', 17) + '<span>Fill the gaps with Groq</span></button><div class="rd915-eta">' + rdPl915(gaps, 'page') + ' with gaps · marked CHECK until then</div>' : '')
        : !on && total ? '<div class="rd916-none">Tick the pages to read.</div>' : '') +
        (!prep && (todo.length || canAgain) ? '<button type="button" class="rd916-alt" data-rd915="read">' + (todo.length ? 'Read with Groq' : 'Read again with Groq') + '<small>' + (todo.length ? rdEta915(todo) : rdEta915(rdOn916().filter((p) => p.st === 'done' && p.by !== 'groq'))) + (RD.tpm <= 12000 ? ' on its free plan' : '') + '</small></button>' : '');
    }
    return '<section class="rd915-card">' +
      '<button type="button" class="rd915-drop" data-rd915="pick" aria-label="Add invoices, packing lists, BL drafts, EIRs or the SI"><span class="rd915-dic">' + icon('doc915', 19) + '</span>' +
        '<b>' + (ph ? 'Add invoice, packing list, BL…' : 'Drop invoice, packing list, BL…') + '</b><small>' + (ph ? 'PDF, Excel, scan or take a photo · several at once' : 'PDF, Excel, scan or phone photo · several at once') + '</small></button>' +
      (RD.files.length ? '<div class="rd915-files">' + RD.files.map(rdFileRow915).join('') + '</div>' : '') +
      (act ? '<div class="rd915-act">' + act + '</div>' : '') +
      '<div class="rd915-safe">' + icon('lock', 14) + '<span>Nothing is saved. Scans are read in the EWS Google account and deleted at once; Groq sees only the pages Read cannot finish.</span></div>' +
      (RD.files.length && !RD.busy ? '<button type="button" class="rd915-again" data-rd915="clear">Start again</button>' : '') +
    '</section>';
  }
  function rdField915(f, ghost) {
    const empty = !f.v;
    if (empty && RD.busy) ghost = true;   // still reading: it may be on a page not read yet
    return '<div class="rd915-f' + (f.wide ? ' is-wide' : '') + (f.chk ? ' is-chk' : '') + (empty ? ' is-empty' : '') + '" data-k="' + f.k + '">' +
      '<small><span>' + f.label + '</span>' + (f.src ? '<em>' + esc(f.src) + '</em>' : '') + (f.chk ? '<span class="rd915-chk" title="' + esc(f.why || 'Not sure — check it on the document') + '">CHECK</span>' : '') + '</small>' +
      (ghost ? '<span class="rd915-sk"></span>' + (f.wide ? '<span class="rd915-sk is-s"></span>' : '') : empty ? '<pre class="is-none">' + (rdDone915().length ? 'Not on these documents' : '—') + '</pre>' : '<pre>' + esc(f.v) + '</pre>') +
      (f.chk && f.why ? '<div class="rd915-why">' + esc(f.why) + '</div>' : '') +
      (empty || ghost ? '' : '<button type="button" class="rd915-cp" data-rd915="cp" data-k="' + f.k + '" aria-label="Copy ' + esc(f.label.toLowerCase()) + '">' + icon('copy', 15) + '</button>') + '</div>';
  }
  function rdSiHtml915(M) {
    const ghost = !M.any && RD.busy;
    return '<div class="rd915-fl">' + RD_SI915.map((k) => rdField915(M.F[k], ghost)).join('') + '</div>';
  }
  // ==================================================================== v2.9.17 / v2.9.18 — FOR DUBAI TRADE (BOE / ED)
  // What was read, laid out like Dubai Trade's "Customs Declaration": its boxes, in its order, with its box numbers — every
  // value ready to copy. Every box comes from the documents only (no job link); values and currency exactly as on the invoice
  // (no rate, no AED). Lines with the same 8-digit HS code, description and origin become one declaration line — per invoice.
  // v2.9.18 (Amal, 12 Nov — an import came out as an export): no declaration type; only the boxes the documents fill —
  // 6 · 7 · 20 · 21 · 23 · 25 ("INV REF : …"), containers 26–28, invoices 30–37, lines 61–70.
  const DT_TERMS917 = { EXW: 'Ex Works', FCA: 'Free Carrier', FAS: 'Free Alongside Ship', FOB: 'Free on Board', CFR: 'Cost and Freight', CNF: 'Cost and Freight', CIF: 'Cost, Insurance & Freight',
    CPT: 'Carriage Paid To', CIP: 'Carriage and Insurance Paid To', DAP: 'Delivered at Place', DPU: 'Delivered at Place Unloaded', DDP: 'Delivered Duty Paid' };
  const DT_CTRY917 = { AE: 'UNITED ARAB EMIRATES', IN: 'INDIA', CN: 'CHINA', TW: 'TAIWAN', PK: 'PAKISTAN', BD: 'BANGLADESH', LK: 'SRI LANKA', TR: 'TURKEY', IT: 'ITALY', DE: 'GERMANY',
    ES: 'SPAIN', FR: 'FRANCE', GB: 'UNITED KINGDOM', US: 'UNITED STATES', JP: 'JAPAN', KR: 'KOREA', VN: 'VIETNAM', TH: 'THAILAND', MY: 'MALAYSIA', ID: 'INDONESIA', SG: 'SINGAPORE',
    SA: 'SAUDI ARABIA', OM: 'OMAN', EG: 'EGYPT', AF: 'AFGHANISTAN', IR: 'IRAN', BR: 'BRAZIL' };
  const DT_PKU917 = [[/^(?:BAGS?|SACKS?)$/, 'BAGS'], [/^(?:DRUMS?|DURMS)$/, 'DRUMS'], [/^(?:CARTONS?|CTNS?)$/, 'CARTONS'], [/^(?:PALLETS?|PLTS?)$/, 'PALLETS'], [/^(?:PKGS?|PACKAGES?)$/, 'PACKAGES'],
    [/^BOX(?:ES)?$/, 'BOXES'], [/^ROLLS?$/, 'ROLLS'], [/^BALES?$/, 'BALES'], [/^CASES?$/, 'CASES'], [/^CRATES?$/, 'CRATES'], [/^BUNDLES?$/, 'BUNDLES'], [/^COILS?$/, 'COILS'], [/^IBCS?$/, 'IBCS'],
    [/^(?:PIECES|PCS)$/, 'PIECES'], [/^CANS?$/, 'CANS'], [/^BARRELS?$/, 'BARRELS'], [/^REELS?$/, 'REELS'], [/^TINS?$/, 'TINS']];
  const DT_BOX917 = [['b6', '6', 'CONSIGNEE / IMPORTER / BUYER / TRANSFEREE'], ['b7', '7', 'CONSIGNOR / EXPORTER / SELLER / TRANSFEROR'],
    ['b20', '20', 'NET WEIGHT'], ['b21', '21', 'GROSS WEIGHT'], ['b23', '23', 'NUMBER OF PACKAGES'], ['b25', '25', 'MARKS & NUMBER']];
  const dtN917 = (n, d) => (n === null || n === undefined || !isFinite(n) ? '' : String(Math.round(n * Math.pow(10, d || 2)) / Math.pow(10, d || 2)));   // Dubai Trade style: 327600 · 164525.94
  const dtKg917 = (n) => (n === null || n === undefined || !isFinite(n) ? '' : dtN917(n, 3) + ' kg');
  const dtIno917 = (v) => String(v || '').toUpperCase().replace(/\s*([-/])\s*/g, '$1').trim();
  const dtKey917 = (p) => { const f = p.res.fields.invoice_no; const v = f && f.v ? dtIno917(f.v).replace(/[^A-Z0-9]/g, '') : ''; return v || 'f' + p.f.id; };
  function dtTexts917() {   // each page's text, the invoice first
    return rdRank915(rdDone915().map((p) => ({ p, t: String(p.text || (typeof p.ocr === 'string' ? p.ocr : '') || (p.res && p.res.text) || '') })).filter((x) => x.t), RD_PARTY915);
  }
  function dtPk917(v) {   // "LOADED IN 80 PALLETS 160 JUMBO BAGS" → { n: 160, u: 'BAGS' } — the goods' own packing before the pallets
    const all = [...String(v || '').toUpperCase().matchAll(/(\d[\d,]*)\s+(?:[A-Z]+\s+)?([A-Z]+)\b/g)].map((m) => { const u = (DT_PKU917.find((x) => x[0].test(m[2])) || [])[1]; return u ? { n: Number(m[1].replace(/,/g, '')), u } : null; }).filter(Boolean);
    return all.find((x) => x.u !== 'PALLETS') || all[0] || null;
  }
  const dtF917 = (f) => (f && f.v ? Number(String(f.v).replace(/[^0-9.]/g, '')) || null : null);   // "218,400.000 KGS" → 218400
  function dtBuild917(M) {
    const done = rdDone915(), B = {}, texts = dtTexts917(), ALL = texts.map((x) => x.t).join('\n').toUpperCase();
    DT_BOX917.forEach(([k, no, label]) => { B[k] = { k, no, label, v: '', src: '', chk: false, why: '' }; });
    const put = (k, v, src, chk, why) => { if (v) Object.assign(B[k], { v: String(v), src: src || '', chk: !!chk, why: why || '' }); };
    const first = (x) => String(x || '').split('\n')[0].trim().replace(/[\s,;:]+$/, '').toUpperCase();   // "RUBAMIN PRIVATE LIMITED," → no comma
    if (M.F.shipper.v) put('b7', first(M.F.shipper.v), M.F.shipper.src, M.F.shipper.chk, M.F.shipper.why);
    if (M.F.consignee.v) put('b6', first(M.F.consignee.v), M.F.consignee.src, M.F.consignee.chk, M.F.consignee.why);
    // containers
    const cont = []; texts.forEach((x) => { (x.t.toUpperCase().match(/\b[A-Z]{3}[UJZ]\s?\d{7}\b/g) || []).forEach((c) => { c = c.replace(/\s/g, ''); if (!cont.includes(c)) cont.push(c); }); });
    const sizes = [...new Set((ALL.match(/(?:\b\d{1,2}\s*X\s*|\b)(20|40|45)\s*(?:'|’|FT\b|FEET|GP\b|HC\b|HQ\b|DV\b|STD\b|FCL\b)/g) || []).map((s) => s.match(/(20|40|45)\s*(?:'|’|F|G|H|D|S)/)[1]))];
    const size = sizes.length === 1 ? sizes[0] : '';
    const conts = cont.map((n, i) => ({ sl: i + 1, type: 'Standard', size, no: n }));
    // invoices and their lines — one group per invoice
    const groups = [];
    M.lines.forEach((l) => {
      const pg = done.find((p) => p.f === l.pf && p.res.kind === 'invoice') || done.find((p) => p.f === l.pf);
      const key = pg ? dtKey917(pg) : 'f' + l.pf.id;
      let g = groups.find((x) => x.key === key);
      if (!g) groups.push(g = { key, f: l.pf, pg, src: [], items: [] });
      g.src.push(l);
    });
    const fOf = (g, k) => { const x = rdRank915(done.filter((q) => (q.f === g.f || dtKey917(q) === g.key) && q.res.fields[k] && q.res.fields[k].v).map((p) => ({ p })), RD_PARTY915)[0]; return x ? String(x.p.res.fields[k].v) : ''; };
    const totOf = (g, k) => { for (const { p } of rdRank915(done.filter((q) => dtKey917(q) === g.key || q.f === g.f).map((p) => ({ p })), RD_PACK915)) for (const t of p.res.totals) { const v = rdKg915(t[k], t.wu); if (v) return v; } return null; };
    groups.forEach((g) => {
      g.ino = dtIno917(fOf(g, 'invoice_no'));
      const inc = fOf(g, 'incoterm').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
      g.terms = DT_TERMS917[inc] || inc;
      g.cur = (fOf(g, 'currency') || M.cur || '').toUpperCase().slice(0, 3);
      const it = [];
      g.src.forEach((l) => {
        const k = [l.hs.slice(0, 8), String(l.desc || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), l.origin].join('|');
        let x = it.find((y) => y.k === k);
        if (!x) it.push(x = { k, hs: l.hs.slice(0, 8), desc: String(l.desc || '').toUpperCase().replace(/\s+/g, ' ').trim(), origin: l.origin, L: [], sure: true });
        x.L.push(l); if (!l.sure) x.sure = false;
      });
      const kgQ = (l) => (/^(MT|MTS|MTON|TONS?|TONNES?|KGS?|KILOS?)$/.test(l.unit) && typeof l.qty === 'number' ? rdKg915(l.qty, l.unit) : null);
      it.forEach((x) => {
        const sum = (f) => (x.L.every((l) => typeof f(l) === 'number') ? x.L.reduce((n, l) => n + f(l), 0) : null);
        x.net = sum((l) => l.net); if (x.net === null) x.net = sum(kgQ);
        x.gross = sum((l) => l.gross);
        x.value = sum((l) => (typeof l.value === 'number' ? l.value : null));
      });
      if (it.length === 1) {   // one declaration line: the invoice's (or its packing list's) totals fill what the lines do not say
        if (it[0].net === null) it[0].net = totOf(g, 'net'); if (it[0].gross === null) it[0].gross = totOf(g, 'gross');
        if (groups.length === 1) { if (it[0].net === null && dtF917(M.F.net)) it[0].net = dtF917(M.F.net); if (it[0].gross === null && dtF917(M.F.gross)) it[0].gross = dtF917(M.F.gross); }
      }
      g.items = it;
      const tt = done.filter((p) => p.f === g.f && p.res.kind === 'invoice').flatMap((p) => p.res.totals).find((t) => t.goods !== null || t.total !== null);
      const ch2 = tt ? tt.charges || [] : [], chg = (re) => { const c = ch2.find((x) => re.test(String(x.what || ''))); return c ? c.n : null; };
      g.value = tt ? (tt.goods !== null ? tt.goods : !ch2.length ? tt.total : null) : null;
      if (g.value === null && it.every((x) => x.value !== null)) g.value = it.reduce((n, x) => n + x.value, 0);
      g.freight = chg(/FREIGHT/i); g.ins = chg(/INSUR/i);
      if (it.length === 1 && g.value !== null && it[0].value !== null && Math.abs(it[0].value - g.value) <= it[0].L.length * 0.005 + 0.001) it[0].value = g.value;   // one line: the invoice's own total (no cent lost to rounding)
    });
    const invs = groups.map((g, i) => ({ sl: i + 1, no: g.ino, type: 'Commercial Invoice', terms: g.terms, value: g.value === null ? '' : (g.cur ? g.cur + ' ' : '') + dtN917(g.value), freight: g.freight === null ? '' : dtN917(g.freight), ins: g.ins === null ? '' : dtN917(g.ins), pay: 'DAP(Doc against Payment)' }));
    const curs = [...new Set(groups.map((g) => g.cur))];
    const tot = groups.length && groups.every((g) => g.value !== null) && curs.length === 1 ? (curs[0] ? curs[0] + ' ' : '') + dtN917(groups.reduce((n, g) => n + g.value, 0)) : '';
    let n = 0;
    const lines = groups.map((g) => ({ ino: g.ino, items: g.items.map((x) => ({ n: ++n, hs: x.hs, desc: x.desc, qty: dtKg917(x.net), wt: dtKg917(x.gross), value: x.value === null ? '' : dtN917(x.value) + (g.cur ? ' ' + g.cur : ''), origin: DT_CTRY917[x.origin] || x.origin || '', sure: x.sure, srcN: x.L.length })) }));
    // cargo
    const items = groups.flatMap((g) => g.items);
    const net = items.length && items.every((x) => x.net !== null) ? items.reduce((s, x) => s + x.net, 0) : dtF917(M.F.net) || null;
    const gross = items.length && items.every((x) => x.gross !== null) ? items.reduce((s, x) => s + x.gross, 0) : dtF917(M.F.gross) || null;
    if (net) put('b20', dtKg917(net), M.F.net.src, M.F.net.chk && !items.length, M.F.net.why);
    if (gross) put('b21', dtKg917(gross), M.F.gross.src, M.F.gross.chk && !items.length, M.F.gross.why);
    const pkBy = {};
    rdRank915(rdCands915('packages'), RD_PACK915).forEach((c) => { const k = dtKey917(c.p); if (!pkBy[k]) pkBy[k] = c; });
    const pks = Object.values(pkBy).map((c) => Object.assign({ c }, dtPk917(c.v) || {})).filter((x) => x.u);
    if (pks.length && pks.every((x) => x.u === pks[0].u)) put('b23', pks.reduce((s, x) => s + x.n, 0) + '-' + pks[0].u, pks[0].c.src + (pks.length > 1 ? ' · ' + pks.length + ' invoices' : ''), pks.some((x) => !x.c.sure));
    else if (M.F.packages.v) { const x = dtPk917(M.F.packages.v); if (x) put('b23', x.n + '-' + x.u, M.F.packages.src, M.F.packages.chk); }
    const inos = groups.map((g) => g.ino).filter(Boolean);
    if (inos.length) put('b25', 'INV REF : ' + inos.join(' , '));
    return { B, conts, invs, tot, lines, nInv: groups.length };
  }
  function dtFlat917(D, k) {   // a copy key → its value
    if (D.B[k]) return D.B[k].v;
    const m = String(k).match(/^([cil])(\d+)\.(\w+)$/); if (!m) return '';
    const row = m[1] === 'c' ? D.conts[+m[2]] : m[1] === 'i' ? D.invs[+m[2]] : D.lines.flatMap((g) => g.items)[+m[2]];
    return row ? String(row[m[3]] || '') : '';
  }
  const DT_LCOLS917 = [['hs', '61', 'HS CODE'], ['desc', '62', 'GOODS DESCRIPTION'], ['qty', '63', 'STAT QTY./UNIT'], ['wt', '64a', 'WEIGHT/UNIT'], ['value', '65', 'GOODS VALUE IN FOREIGN CURRENCY'], ['origin', '70', 'ORIGIN']];
  const DT_ICOLS917 = [['no', '30', 'INVOICE NO.'], ['type', '31', 'INVOICE TYPE'], ['terms', '33', 'TERMS OF DELIVERY'], ['value', '34', 'INVOICE VALUE'], ['freight', '35', 'FREIGHT'], ['ins', '36', 'INSURANCE'], ['pay', '37', 'PAYMENT METHOD']];
  function dtLineText917(x) { return DT_LCOLS917.map((c) => x[c[0]] || '').join('\t'); }
  function dtAllText917(D) {
    const out = DT_BOX917.map(([k]) => D.B[k]).filter((b) => b.v).map((b) => b.label + ' (' + b.no + '): ' + b.v);
    if (D.conts.length) out.push('', 'CONTAINER DETAILS (26 · 27 · 28)', ...D.conts.map((c) => c.sl + '\t' + c.type + '\t' + c.size + '\t' + c.no));
    if (D.invs.length) out.push('', 'INVOICE (30 – 37)', ...D.invs.map((r) => r.sl + '\t' + DT_ICOLS917.map((c) => r[c[0]] || '').join('\t')), ...(D.nInv > 1 && D.tot ? ['TOTAL\t' + D.tot] : []));
    const L = D.lines.flatMap((g) => g.items);
    if (L.length) out.push('', 'INVOICE LINE ITEM DETAILS (61 – 70)', ...D.lines.flatMap((g) => (D.nInv > 1 ? ['INVOICE ' + g.ino] : []).concat(g.items.map((x) => x.n + '\t' + dtLineText917(x)))));
    return out.join('\n');
  }
  function rdDtHtml917(M) {
    const D = dtBuild917(M); RD.D = D;
    const ghost = !M.any && RD.busy;
    const cp = (k, v, cls) => (ghost ? '<span class="rd915-sk"></span>' : v
      ? '<button type="button" class="dt917-v' + (cls ? ' ' + cls : '') + '" data-rd915="dt" data-k="' + k + '" aria-label="Copy ' + esc(v) + '"><span>' + esc(v) + '</span>' + icon('copy', 13) + '</button>'
      : '<span class="dt917-v is-none">—</span>');
    const box = (k, span) => {
      const b = D.B[k];
      return '<div class="dt917-b' + (span ? ' is-' + span : '') + (b.chk ? ' is-chk' : '') + (b.v ? '' : ' is-empty') + '" data-k="' + k + '"' + (b.src ? ' title="' + esc(b.src) + '"' : '') + '>' +
        '<small>' + esc(b.label) + '<sup>' + b.no + '</sup>' + (b.chk ? '<span class="rd915-chk" title="' + esc(b.why || 'Not sure — check it on the document') + '">CHECK</span>' : '') + '</small>' +
        cp(k, b.v) + '</div>';
    };
    const sec = (title, nos, inner) => '<section class="dt917-s"><h3><span>' + title + '</span>' + (nos ? '<em>' + nos + '</em>' : '') + '</h3>' + inner + '</section>';
    const bill = '<div class="dt917-g is-6">' + box('b6', 3) + box('b7', 3) + box('b20', 2) + box('b21', 2) + box('b23', 2) + '</div>';
    const th = (no, label, cls) => '<th' + (cls ? ' class="' + cls + '"' : '') + '>' + label + (no ? '<sup>' + no + '</sup>' : '') + '</th>';
    const td = (k, v, l, cls) => '<td data-l="' + esc(l) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + cp(k, v) + '</td>';
    const emptyRow = (n, text) => (ghost ? [0, 1].map(() => '<tr class="is-sk"><td colspan="' + n + '"><span class="rd915-sk"></span></td></tr>').join('') : '<tr class="is-empty"><td colspan="' + n + '">' + text + '</td></tr>');
    const contT = '<div class="rd915-tw dt917-tw is-c"><table class="rd915-tb dt917-tb is-c"><thead><tr>' + th('', 'SL NO') + th('26', 'CONTAINER TYPE') + th('27', 'CONTAINER SIZE') + th('28', 'CONTAINER NUMBER') + '</tr></thead><tbody>' +
      (D.conts.length ? D.conts.map((c, i) => '<tr><td class="rd915-n" data-l="SL NO">' + c.sl + '</td>' + td('c' + i + '.type', c.type, 'CONTAINER TYPE') + td('c' + i + '.size', c.size, 'CONTAINER SIZE') + td('c' + i + '.no', c.no, 'CONTAINER NUMBER', 'm') + '</tr>').join('')
        : emptyRow(4, M.any ? 'No container numbers on these documents.' : 'Container numbers appear here.')) + '</tbody></table></div>';
    const invT = '<div class="rd915-tw dt917-tw is-i"><table class="rd915-tb dt917-tb is-i"><thead><tr>' + th('', 'SL NO') + DT_ICOLS917.map((c) => th(c[1], c[2])).join('') + '</tr></thead><tbody>' +
      (D.invs.length ? D.invs.map((r, i) => '<tr><td class="rd915-n" data-l="SL NO">' + r.sl + '</td>' + DT_ICOLS917.map((c) => td('i' + i + '.' + c[0], r[c[0]], c[2], c[0] === 'value' || c[0] === 'no' ? 'm' : '')).join('') + '</tr>').join('')
        : emptyRow(8, M.any ? 'No invoice on these documents.' : 'Each invoice appears here — one row per invoice.')) + '</tbody>' +
      (D.nInv > 1 ? '<tfoot><tr><td></td><td colspan="3">TOTAL · ' + D.nInv + ' invoices</td><td class="m" data-l="TOTAL">' + (D.tot ? '<button type="button" class="dt917-v" data-rd915="dtv" data-v="' + esc(D.tot) + '"><span>' + esc(D.tot) + '</span>' + icon('copy', 13) + '</button>' : '—') + '</td><td colspan="3"></td></tr></tfoot>' : '') + '</table></div>';
    let li = 0;
    const lineT = '<div class="rd915-tw dt917-tw is-l"><table class="rd915-tb dt917-tb is-l"><thead><tr>' + th('', 'LINE ITEM') + DT_LCOLS917.map((c) => th(c[1], c[2], c[0] === 'desc' ? 'rd915-d' : '')).join('') + '<th></th></tr></thead><tbody>' +
      (D.lines.some((g) => g.items.length) ? D.lines.map((g) => (D.nInv > 1 ? '<tr class="dt917-gh"><td colspan="8">INVOICE <b>' + esc(g.ino || '—') + '</b></td></tr>' : '') + g.items.map((x) => {
        const i = li++;
        return '<tr class="' + (x.sure ? '' : 'is-chk') + '"><td class="rd915-n" data-l="LINE ITEM">' + x.n + (x.srcN > 1 ? '<em class="dt917-from" title="' + x.srcN + ' lines on the invoice">' + x.srcN + ' → 1</em>' : '') + '</td>' +
          DT_LCOLS917.map((c) => td('l' + i + '.' + c[0], x[c[0]], c[2], (c[0] === 'desc' ? 'rd915-d' : c[0] === 'origin' ? '' : 'm') + (c[0] === 'hs' && x.hs && x.hs.length < 8 ? ' is-chk' : ''))).join('') +
          '<td class="rd915-lc"><button type="button" class="rd915-cp is-line" data-rd915="dtl" data-i="' + i + '" aria-label="Copy line ' + x.n + '">' + icon('copy', 14) + '</button></td></tr>';
      }).join('')).join('') : emptyRow(8, M.any ? 'No goods lines on these documents.' : 'The goods lines appear here — one line per HS code, per invoice.')) + '</tbody></table></div>';
    const L = D.lines.flatMap((g) => g.items), noHs = L.filter((x) => !x.hs).length;
    const hsNote = noHs ? (noHs === L.length ? 'No HS codes on the invoice — add them in Dubai Trade.' : rdPl915(noHs, 'line') + ' without an HS code — add ' + (noHs === 1 ? 'it' : 'them') + ' in Dubai Trade.') : '';
    const note = M.check.text || hsNote ? '<div class="rd915-note' + (M.check.ok === false ? ' is-chk' : '') + '">' + (M.check.text ? '<span>' + esc(M.check.text) + '</span>' : '') + (hsNote ? ' <b class="rd915-hsn">' + esc(hsNote) + '</b>' : '') + '</div>' : '';
    return '<div class="dt917">' +
      sec('CUSTOM BILL', '6 – 23', bill) +
      sec('MARKS &amp; NUMBER', '25', '<div class="dt917-g is-1">' + box('b25', 5) + '</div>') +
      sec('CONTAINER DETAILS', '26 – 28', contT) +
      sec('INVOICE', '30 – 37', invT) +
      sec('INVOICE LINE ITEM DETAILS', '61 – 70', lineT + note) + '</div>';
  }
  function rdTextHtml915(M) {
    if (!M.text.length) return '<div class="rd915-empty">' + icon('reader915', 22) + '<span>' + (RD.busy ? 'The text of each page appears here as it is read.' : 'The text of every page appears here once it is read — ready to copy.') + '</span></div>';
    return '<div class="rd915-pages">' + M.text.map((x, i) => '<article class="rd915-pgx"><header><b>' + esc(x.kind.toUpperCase()) + '</b><em>' + esc(x.p.f.name) + ' · p' + x.p.n + '</em>' +
      '<button type="button" class="rd915-cp" data-rd915="page" data-i="' + i + '" aria-label="Copy the text of this page">' + icon('copy', 15) + '</button></header><pre>' + esc(x.text) + '</pre></article>').join('') + '</div>';
  }
  // ==================================================================== v2.9.19 — BL CHECK (v2.9.20: word by word, spelling, no false alarms)
  // The BL draft checked against the SI (Excel file, PDF or pasted text) — or the invoice / packing list when there is no SI —
  // and the EIRs: the port marks the seal after the physical check, so the EIR's seal is the correct one. EWS tells, in plain
  // sentences, everything that does not match; one Copy takes the whole message. Nothing is saved. (Amal, 12 Nov 2026.)
  const SHEETJS919 = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  let RD_XLS919 = null;
  function rdXlsLib919() {
    if (RD_XLS919) return RD_XLS919;
    RD_XLS919 = new Promise((ok, no) => {
      if (window.XLSX) return ok(window.XLSX);
      const s = document.createElement('script'); s.src = SHEETJS919; s.async = true;
      s.onload = () => (window.XLSX ? ok(window.XLSX) : no(new Error('xls')));
      s.onerror = () => { RD_XLS919 = null; no(new Error('The Excel reader could not load — check the internet and add the file again.')); };
      document.head.appendChild(s);
    });
    return RD_XLS919;
  }
  function rdSheetThumb919(paste) {   // a small sheet / note picture for the file row and the page strip
    const c = document.createElement('canvas'); c.width = 66; c.height = 88; const g = c.getContext('2d');
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, 66, 88);
    g.fillStyle = '#0E7C7B'; g.fillRect(0, 0, 66, 12);
    g.strokeStyle = 'rgba(11,27,43,.14)'; g.lineWidth = 1;
    if (paste) { for (let y = 22; y < 84; y += 9) { g.beginPath(); g.moveTo(7, y + .5); g.lineTo(y % 2 ? 46 : 59, y + .5); g.stroke(); } }
    else {
      for (let y = 20; y < 88; y += 8) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(66, y + .5); g.stroke(); }
      [17, 38].forEach((x) => { g.beginPath(); g.moveTo(x + .5, 12); g.lineTo(x + .5, 88); g.stroke(); });
    }
    return c.toDataURL('image/png');
  }
  async function rdSheet919(f, file) {   // an Excel / CSV SI: one page per sheet, its cells kept as a grid
    const X = await rdXlsLib919();
    const wb = X.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    let n = 0;
    for (const name of wb.SheetNames.slice(0, 6)) {
      if (!RD.files.includes(f) || rdPages915() >= RD_MAXP915) break;
      const rows = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: true });
      const grid = rows.map((r) => (r || []).map((c) => String(c === null || c === undefined ? '' : c).replace(/\r/g, '').trim()));
      if (!grid.some((r) => r.some(Boolean))) continue;
      const text = grid.map((r) => r.filter(Boolean).map((c) => c.replace(/\s*\n\s*/g, ' ')).join('   ')).filter(Boolean).join('\n');
      n++;
      f.pages.push({ id: f.id + '.' + n, f, n, img: null, text, grid, st: 'new', res: null, on: true, kind: 'si', force: 'si', thumb: rdSheetThumb919(), sheet: name });
    }
    if (!n) throw new Error('This Excel file is empty.');
    f.thumb = f.pages[0].thumb; f.total = n; f.meta = 'Excel · ' + rdPl915(n, 'sheet');
  }
  function blPaste919(text) {   // the SI pasted as text (from the email, or cells copied from Excel)
    text = String(text || '').replace(/\r/g, '').replace(/ /g, ' ').trim();
    if (text.replace(/\s/g, '').length < 20) return false;
    if (RD.files.length >= RD_MAXF915) { toast('Twelve files at a time — Start again first.'); return false; }
    const grid = /\t/.test(text) ? text.split('\n').map((l) => l.split('\t').map((c) => c.trim())) : null;
    const flat = grid ? grid.map((r) => r.filter(Boolean).join('   ')).filter(Boolean).join('\n') : text;
    const f = { id: ++RD.n, name: 'SI · pasted text', st: 'ready', pages: [], meta: 'pasted text', thumb: rdSheetThumb919(true), err: '', total: 1 };
    const r = rdRules916(flat, !!grid); r.kind = 'si';
    f.pages.push({ id: f.id + '.1', f, n: 1, img: null, text: flat, grid, st: 'done', res: r, on: true, kind: 'si', force: 'si', thumb: f.thumb, by: 'ews' });
    RD.files.push(f); RD.msg = null;
    return true;
  }

  // ---------- reading a BL / SI / EIR ----------
  const blFold920 = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');   // v2.9.20: Ț → T, É → E everywhere
  const blTx919 = (p) => blFold920(p.text || (typeof p.ocr === 'string' ? p.ocr : '') || (p.res && p.res.text) || '');
  function blKind919(p) {
    if (p.force) return p.force;
    const t = blTx919(p).slice(0, 1600).toUpperCase();
    if (/EQUIPMENT\s+INTERCHANGE|\bEIR\s*NO\b/.test(t)) return 'eir';
    if (/SHIPPING\s+INSTRUCTIONS?\b/.test(t.slice(0, 500))) return 'si';
    return p.res ? p.res.kind : p.kind;
  }
  const BL_CN919 = /\b([A-Z]{3}[UJZ])\s?(\d{6})\s?(\d)\b/;
  const blCns919 = (s) => [...String(s || '').toUpperCase().matchAll(new RegExp(BL_CN919.source, 'g'))].map((m) => m[1] + m[2] + m[3]);
  const BL_CDV919 = '0123456789A?BCDEFGHIJK?LMNOPQRSTU?VWXYZ';
  function blCd919(c) { let s = 0; for (let i = 0; i < 10; i++) s += (/\d/.test(c[i]) ? +c[i] : BL_CDV919.indexOf(c[i])) * Math.pow(2, i); return (s % 11) % 10 === +c[10]; }
  const blSeal919 = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');
  const blNorm919 = (s) => blFold920(s).toUpperCase().replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '');
  const blKgS919 = (n) => Math.round(n * 1000) / 1000 === Math.round(n) ? Math.round(n).toLocaleString('en-US') + ' kg' : n.toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' kg';
  const BL_TYPE919 = /^(\d{2}\s*('|’|FT|FEET)?\s*(GP|HC|HQ|DV|SD|STD|RF|RH|OT|FR|TK|PL|NOR)?|\d{2}[A-Z]\d|\d{4}\/[A-Z]{2,4}|GP|HC|HQ|DV|STD|DRY)$/;
  const BL_PKW919 = /^(JUMBO|BAGS?|JBGS?|JBS|BGS|DRUMS?|DRS|DURMS|CARTONS?|CTNS?|PALLETS?|PLTS?|PKGS?|PACKAGES?|BOX(ES)?|ROLLS?|BALES?|CASES?|CRATES?|BUNDLES?|COILS?|IBCS?|PCS|PIECES|CANS?|BARRELS?|REELS?|TINS?|SACKS?)$/;
  const blNum919 = (t) => { const s = String(t || '').replace(/,/g, ''); return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null; };
  function blRows919(text) {   // the container rows: number · seal · packages · gross · net
    const L = String(text || '').toUpperCase().split('\n'), out = new Map();
    let order = 'gn';
    L.forEach((l, i) => {
      const hg = l.search(/\bGR(OSS)?\.?\s*(WEIGHT|WT|WGT)|\bGROSS\b/), hn = l.search(/\bN(ET|T)\.?\s*(WEIGHT|WT|WGT)|\bNET\b/);
      const cs = blCns919(l);
      if (hg >= 0 && hn >= 0 && !cs.length) order = hg < hn ? 'gn' : 'ng';
      if (cs.length !== 1) return;
      const m = BL_CN919.exec(l), cn = cs[0];
      let rest = l.slice(m.index + m[0].length).replace(/^\s*\/\s*\S*/, ' ');
      const tk = rest.trim().split(/\s+/).map((t) => t.replace(/[;,]+$/, '')).filter(Boolean);
      let seal = '', pk = null, sealAt = -1, pkAt = -1;
      const lab = rest.match(/SEAL\s*(?:NO\.?|NUMBER|#)?\s*[:.]?\s*([A-Z0-9][A-Z0-9-]{2,15})\b/);
      if (lab) seal = lab[1];
      for (let k = 0; k < tk.length; k++) {
        const t = tk[k], nx = tk[k + 1] || '', nx2 = tk[k + 2] || '';
        if (pkAt < 0 && /^\d[\d,]*$/.test(t) && (BL_PKW919.test(nx) || (/^(JUMBO|WOODEN|PLASTIC|STEEL|HDPE|PP)$/.test(nx) && BL_PKW919.test(nx2)))) { pk = blNum919(t); pkAt = k; continue; }
        if (seal || pkAt >= 0) continue;
        if (BL_TYPE919.test(t) || /^\d[\d,]*\.\d+$/.test(t) || /^\d{1,3}$/.test(t) || BL_PKW919.test(t) || /^(KGS?|MTS?|SEAL|NO\.?|STC|X|CBM)$/.test(t)) continue;
        if (/^\d+$/.test(t) && /^(KGS?|MTS?)$/.test(nx)) continue;
        if (/\d/.test(t) && /^[A-Z0-9][A-Z0-9-]{3,15}$/.test(t)) { seal = t; sealAt = k; }
      }
      if (!seal && L[i + 1] && !blCns919(L[i + 1]).length) { const s2 = L[i + 1].match(/SEAL\s*(?:NO\.?|NUMBER|#)?\s*[:.]?\s*([A-Z0-9][A-Z0-9-]{2,15})\b/); if (s2) seal = s2[1]; }
      const W = tk.map((t, k) => ({ t, k })).filter((x) => x.k > Math.max(sealAt, pkAt) && x.k !== pkAt && !BL_PKW919.test(tk[x.k + 1] || '') && blNum919(x.t) !== null && blNum919(x.t) >= 100).map((x) => blNum919(x.t));
      let gross = null, net = null;
      if (W.length >= 2) { const a = W[W.length - 2], b = W[W.length - 1]; if (order === 'gn') { gross = a; net = b; } else { net = a; gross = b; } }
      else if (W.length === 1) gross = W[0];
      const o = out.get(cn);
      if (!o) out.set(cn, { cn, seal: blSeal919(seal), pk, gross, net });
      else { if (!o.seal && seal) o.seal = blSeal919(seal); if (o.pk === null) o.pk = pk; if (o.gross === null) o.gross = gross; if (o.net === null) o.net = net; }
    });
    return out;
  }
  function blWts919(text) {   // weights with a label: "TOTAL GROSS WEIGHT: 92400 KGS" · "NET WEIGHT IN MT : 190.670 MT" · "NET WT" over "190,670.000 KGS"
    const L = String(text || '').toUpperCase().split('\n'), out = { gross: [], net: [] };
    const kg = (n, u) => (/^(MTS?|M\.?T\.?|TONS?|TONNES?)$/.test(u || '') ? n * 1000 : n);
    const LAB = /\b(GROSS|GR\.?|NET|NT\.?)\s*(?:WEIGHT|WT\.?|WGT)\b/g;
    L.forEach((l, i) => {
      if (/PER\s+(CONTAINER|CNTR|CTNR|UNIT|BAG|DRUM|PALLET)/.test(l)) return;
      const labs = [...l.matchAll(LAB)];
      labs.forEach((m, j) => {
        const which = /^G/.test(m[1]) ? 'gross' : 'net';
        const rest = l.slice(m.index + m[0].length, j + 1 < labs.length ? labs[j + 1].index : undefined);
        const v = rest.match(/^[^0-9\n]{0,24}?(\d[\d,]*(?:\.\d+)?) ?(KGS?|KILOS?|MTS?|M\.?T\.?|TONS?|TONNES?)?\b/);
        const labU = (rest.match(/^[^0-9]*\b(KGS?|MTS?)\b/) || [])[1] || '';
        const cell = (l.split(/\s{3,}/).find((c) => c.includes(m[0])) || l).trim();
        if (v) { const n = blNum919(v[1]); if (n !== null && (n >= 100 || /MT/.test(v[2] || labU))) out[which].push({ kg: kg(n, v[2] || labU), line: cell }); return; }
        if (labs.length > 1) return;   // a table heading (GROSS and NET side by side)
        for (let k = i + 1; k <= i + 2 && k < L.length; k++) {
          if (blCns919(L[k]).length || /(GROSS|GR\.?|NET|NT\.?)\s*(WEIGHT|WT)/.test(L[k])) continue;
          const w = L[k].match(/(\d[\d,]*(?:\.\d+)?) ?(KGS?|KILOS?|MTS?|M\.?T\.?)\b/); if (w) { out[which].push({ kg: kg(blNum919(w[1]), w[2]), line: L[k].trim() }); break; }
        }
      });
    });
    return out;
  }
  function blHs919(text) {
    const s = new Set();
    for (const m of String(text || '').toUpperCase().matchAll(/\bH\.?\s*S\.?\s*(?:CODE|NO\.?|#)?\s*[:.]?\s*(\d{4}[.\s]?\d{2}[.\s]?\d{0,4})\b/g)) { const d = m[1].replace(/\D/g, ''); if (d.length >= 6) s.add(d.slice(0, 8)); }
    return [...s];
  }
  function blPk919(text, rows) {   // the packages in all: the rows added up, else the biggest count printed
    const R = [...rows.values()];
    if (R.length && R.every((r) => r.pk !== null)) return R.reduce((n, r) => n + r.pk, 0);
    let best = null;
    for (const m of String(text || '').toUpperCase().matchAll(/(\d[\d,]*)\s*(?:X\s*)?(?:(?:JUMBO|WOODEN|PLASTIC|STEEL|HDPE|PP)\s+)?([A-Z]+)\b/g)) if (BL_PKW919.test(m[2]) && m[2] !== 'PALLETS' && m[2] !== 'PALLET' && m[2] !== 'PLTS') { const n = blNum919(m[1]); if (n && n < 100000 && (best === null || n > best)) best = n; }
    return best;
  }
  const BL_LAB919 = {
    shipper: /^(SHIPPER|EXPORTER|CONSIGNOR)\b/, consignee: /^CONSIGNEE\b/, notify: /^NOTIFY\b/, vessel: /^(OCEAN\s+)?(VESSEL|VSL)\b/,
    pol: /^(PORT OF LOADING|LOADING PORT|POL\b)/, pod: /^(PORT OF DISCHARGE|DISCHARGE PORT|POD\b)/, fdest: /^(FINAL DESTINATION|PLACE OF DELIVERY)/,
    desc: /^DESCRIPTION\b/ };
  const BL_ANYLAB919 = /^(SHIPPER|EXPORTER|CONSIGNOR|CONSIGNEE|NOTIFY|ALSO NOTIFY|OCEAN VESSEL|VESSEL|PORT OF|PLACE OF|POL\b|POD\b|FINAL DESTINATION|PRE[- ]?CARRIAGE|BOOKING|BILLS? OF LADING|B\/L|EXPORT REFERENCES|FORWARDING AGENT|POINT AND COUNTRY|DESCRIPTION|CONTAINER NO|MARKS|QUANTITY|NET WEIGHT|GROSS WEIGHT|MEASUREMENT|BASIC INSTRUCTIONS|OTHER INSTRUCTIONS|PLACE & DATE|PLACE AND DATE|TYPE OF MOVEMENT|ETD|ORIGINALS|PARTICULARS|FREIGHT PAYABLE|NO\.? OF ORIGINAL|TO OBTAIN DELIVERY|BUYER|SELLER|SOLD TO|BILL TO|SHIP TO|INVOICE|PL NO|DATE\b|PAYMENT|TERMS|COUNTRY OF|SL\.?\s?NO\b|S\.\s?NO\b|SR\.?\s?NO\b|SERIAL\s+NO\b)/;
  // v2.9.20: a container table ends a description / party block — a row with a container number, or 2+ table headings
  const BL_TBLW920 = [/\bS[LR]?\.?\s?NO\b/, /\bCONTAINER\s*(NO|NUMBER|#)/, /\bSEAL\s*(NO|NUMBER|#)/, /\bQTY\b|\bQUANTITY\b/, /\bGROSS\b/, /\bNET\b/];
  const blTbl920 = (line) => { const u = blFold920(line).toUpperCase(); return blCns919(u).length > 0 || (!/\d{3}/.test(u) && BL_TBLW920.filter((re) => re.test(u)).length >= 2); };
  function blGridLab919(grid, re, block) {   // an Excel SI: the cells under a label, in its column
    for (let r = 0; r < grid.length; r++) for (let c = 0; c < (grid[r] || []).length; c++) {
      const s = String(grid[r][c] || '').toUpperCase().trim(); if (!s || !re.test(s)) continue;
      const out = []; let gap = 0;
      const same = s.split(':').slice(1).join(':').trim(); if (same && !block) return [blFold920(grid[r][c]).split(':').slice(1).join(':').trim()];
      for (let k = r + 1; k < grid.length && k <= r + (block ? 40 : 3); k++) {
        const v = blFold920((grid[k] || [])[c] || '').trim();
        if (blTbl920((grid[k] || []).join('   '))) break;
        if (!v) { if (out.length && ++gap > 3) break; continue; }
        if (BL_ANYLAB919.test(v.toUpperCase())) break;
        gap = 0; out.push(...v.split('\n').map((x) => x.trim()).filter(Boolean)); if (!block) break;
      }
      if (out.length) return out;
    }
    return [];
  }
  function blTextLab919(text, re, block) {   // a text SI / PDF: the rest of the label's line, or the lines under it
    const L = String(text || '').split('\n').map((l) => l.trim());
    for (let i = 0; i < L.length; i++) {
      const cells = L[i].split(/\s{3,}/), c0 = cells[0].toUpperCase();
      if (!re.test(c0)) continue;
      const after = cells[0].includes(':') ? cells[0].split(':').slice(1).join(':').trim() : cells[1] && !BL_ANYLAB919.test(cells[1].toUpperCase()) ? cells[1].trim() : '';
      const out = after ? [after] : [];
      if (!block && out.length) return out;
      let gap = 0;   // v2.9.20: a description (block 2) runs on over blank lines until a label or a container table
      for (let k = i + 1; k < L.length && k <= i + (block === 2 ? 40 : block ? 14 : 2); k++) {
        const v = L[k].split(/\s{3,}/)[0].trim();
        if (blTbl920(L[k])) break;
        if (!v) { if (out.length && (block !== 2 || ++gap > 2)) break; continue; }
        gap = 0;
        if (BL_ANYLAB919.test(v.toUpperCase())) break;
        out.push(v); if (!block) break;
      }
      if (out.length) return out;
    }
    return [];
  }
  function blCellLab919(text, re) {   // the BL's own value for a label: same cell, or the cell under it (for the message only)
    const L = String(text || '').split('\n');
    for (let i = 0; i < L.length; i++) {
      const cells = L[i].trim().split(/\s{3,}/).filter(Boolean);
      for (let c = 0; c < cells.length; c++) {
        if (!re.test(cells[c].toUpperCase())) continue;
        const same = cells[c].split(':').slice(1).join(':').trim(); if (same) return same;
        if (cells[c + 1] && !BL_ANYLAB919.test(cells[c + 1].toUpperCase())) return cells[c + 1].trim();
        const nx = String(L[i + 1] || '').trim().split(/\s{3,}/).filter(Boolean);
        const v = nx.length === cells.length ? nx[c] : c === 0 && nx.length && !/^\s{3,}/.test(L[i + 1]) ? nx[0] : '';
        if (v && !BL_ANYLAB919.test(v.toUpperCase())) return v.trim();
      }
    }
    return '';
  }
  function blLev919(a, b) {   // edit distance (short strings only)
    if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[b.length];
  }
  function blDoc919(pages) {
    const T = pages.map(blTx919).join('\n'), U = T.toUpperCase(), rows = blRows919(T);
    const cells = U.split('\n').flatMap((l) => l.trim().split(/\s{3,}/)).map((c) => c.trim()).filter((c) => c.length >= 3 && c.length <= 90);
    return { pages, T, U, N: blNorm919(T), tok: new Set(U.split(/[^A-Z0-9]+/).filter(Boolean)), cells, keys: new Set(blWords920(T).map((x) => x.k)), rows, cns: [...new Set([...rows.keys(), ...blCns919(U)])], hs: blHs919(U), pk: blPk919(U, rows), w: blWts919(T) };
  }
  function blHas919(D, line) {   // is this line on the BL? word for word, or every word of it (the BL wraps lines its own way)
    const n = blNorm919(line); if (!n) return true;
    if (D.N.includes(n)) return true;
    const w = line.toUpperCase().split(/[^A-Z0-9]+/).filter((x) => x.length >= 2);
    return w.length > 0 && w.every((x) => D.tok.has(x));
  }
  function blNear919(D, line) {   // the BL's closest line (for "the BL has …")
    const n = line.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); let best = null;
    D.cells.forEach((c) => { const m = c.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); if (Math.abs(m.length - n.length) > n.length * 0.5 + 4) return; const r = 1 - blLev919(n, m) / Math.max(n.length, m.length); if (r >= 0.6 && (!best || r > best.r)) best = { r, c }; });
    return best ? best.c : '';
  }

  // ---------- v2.9.20: word by word ----------
  // Every SI line is compared word by word with the BL's closest line (one cell, or a cell and the next line's — the BL may wrap).
  // Short forms are the same word (one list, here). Only what really differs is told; lines only on the BL are never listed.
  const BL_SAME920 = { CLS: 'CLASS', NO: 'NUMBER', NUM: 'NUMBER', NBR: 'NUMBER', KGS: 'KG', KILOS: 'KG', KILO: 'KG', KILOGRAMS: 'KG', KGM: 'KG',
    PKGS: 'PACKAGES', CTNS: 'CARTONS', INTL: 'INTERNATIONAL', CO: 'COMPANY', LTD: 'LIMITED', '&': 'AND' };
  function blWords920(s) {   // the words of a line: as written (w) and the key they are compared by (k)
    return [...blFold920(s).matchAll(/\+?[A-Za-z0-9]+|&/g)].map((m) => { const k0 = m[0].replace(/^\+/, '').toUpperCase(); return { w: m[0], k: BL_SAME920[k0] || k0 }; });
  }
  function blLcs920(A, B) {   // the matched pairs of two key lists, in order
    const n = A.length, m = B.length, T = Array.from({ length: n + 1 }, () => new Int16Array(m + 1)), out = [];
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i][j] = A[i] === B[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) { if (A[i] === B[j]) { out.push([i, j]); i++; j++; } else if (T[i + 1][j] >= T[i][j + 1]) i++; else j++; }
    return out;
  }
  const blLike920 = (a, b) => (/\d/.test(a) && /\d/.test(b)) || (!/\d/.test(a + b) && 1 - blLev919(a, b) / Math.max(a.length, b.length) >= 0.5);
  function blDiff920(S, C, o) {   // S = the SI line's words, C = a BL candidate's; o: { tok (keys on the whole BL), skip (keys of the lines around), edge (one cell) }
    const P = blLcs920(S.map((x) => x.k), C.map((x) => x.k));
    const miss = [], add = [], diff = [];
    let subs = 0;
    const gap = (i0, i1, j0, j1, inner) => {
      const a = S.slice(i0, i1), b = C.slice(j0, j1);
      for (let q = 0; q < Math.min(a.length, b.length); q++) if (blLike920(a[q].k, b[q].k)) subs++;
      const a2 = a.filter((x) => !o.tok.has(x.k));   // a word that is on the BL somewhere else is not missing (its column is elsewhere)
      const b2 = b.filter((x) => inner || o.edge).filter((x) => !o.skip.has(x.k) && !S.some((y) => y.k === x.k));
      let q = 0;
      for (; q < Math.min(a2.length, b2.length) && blLike920(a2[q].k, b2[q].k); q++) diff.push([a2[q].w, b2[q].w]);
      miss.push(...a2.slice(q).map((x) => x.w)); if (inner || o.edge) add.push(...b2.slice(q).map((x) => x.w));
    };
    let pi = 0, pj = 0;
    P.forEach(([i, j], n) => { gap(pi, i, pj, j, n > 0); pi = i + 1; pj = j + 1; });
    gap(pi, S.length, pj, C.length, false);
    if (!P.length) return { m: 0, score: subs ? 0.5 * subs / Math.max(S.length, C.length) : 0, miss: [], add: [], diff: [] };
    return { m: P.length, score: (P.length + 0.5 * subs) / Math.max(S.length, C.length), miss, add, diff };
  }
  function blCands920(D) {   // the BL's cells (and each cell + the next line's cells), with their words — once per document
    if (D.cand) return D.cand;
    const L = D.T.split('\n').map((l) => l.trim().split(/\s{3,}/).map((c) => c.trim()).filter(Boolean));
    const cells = []; L.forEach((row, i) => row.forEach((c) => cells.push({ t: c, i, W: blWords920(c) })));
    D.cand = { cells, byLine: L.map((_, i) => cells.filter((c) => c.i === i)) };
    return D.cand;
  }
  function blBest920(D, line, skip) {   // the BL's closest line to an SI line, compared word by word
    const S = blWords920(line); if (!S.length) return null;
    const ks = new Set(S.map((x) => x.k)), { cells, byLine } = blCands920(D), o = { tok: D.keys, skip: skip || new Set() };
    let best = null;
    const tryC = (t, C, edge) => { const r = blDiff920(S, C, Object.assign({ edge }, o)); if (r.score > 0 && (!best || r.score > best.score + 1e-9)) best = Object.assign(r, { t, C, edge }); };
    cells.forEach((c) => {
      if (!c.W.some((x) => ks.has(x.k)) && !(c.W.some((x) => /\d{4}/.test(x.k)) && S.some((x) => /\d{4}/.test(x.k)))) return;
      tryC(c.t, c.W, true);
      (byLine[c.i + 1] || []).forEach((d) => tryC(c.t + ' ' + d.t, c.W.concat(d.W), false));
      (byLine[c.i - 1] || []).forEach((d) => { if (d.W.some((x) => ks.has(x.k))) return; tryC(d.t + ' ' + c.t, d.W.concat(c.W), false); });
    });
    return best ? Object.assign(best, { S }) : { S, score: 0 };
  }
  // compare one SI line: null when it is on the BL, else the sentence parts
  function blLine920(D, field, refW, line, skip, blLine) {
    const S = blWords920(line); if (!S.length) return null;
    const lax = S.every((x) => D.keys.has(x.k)) || D.N.includes(blNorm919(line));
    let b = blBest920(D, line, skip);
    if (blLine) { const r = blDiff920(S, blWords920(blLine), { tok: D.keys, skip: skip || new Set(), edge: true }); b = Object.assign(r, { t: blLine, S, C: blWords920(blLine), edge: true, label: true }); }
    const V = (s) => ({ v: String(s) }), shown = blFold920(line).replace(/\s+/g, ' ').trim().replace(/,\s*$/, '');
    if (lax && !(b && b.score >= 0.5 && b.m === S.length)) return { ok: true, b };
    if (lax && b && b.m === S.length && !b.add.length) return { ok: true, b };
    if (!b || !b.t || (b.score < 0.5 && !b.label)) return { ok: false, b, say: [field + ': ' + refW + ' says ', V(shown), ' — the BL draft does not have it.'] };
    const parts = [];
    if (b.m) {
      if (b.miss.length) parts.push(' · not on the BL: ', V(b.miss.join(' ')));
      if (b.add.length) parts.push(' · added on the BL: ', V(b.add.join(' ')));
      if (b.diff.length) parts.push(' · different: ', ...b.diff.flatMap(([x, y], i) => [i ? ', ' : '', V(x), ' → ', V(y)]));
      if (!parts.length) return { ok: true, b };
    }
    return { ok: false, b, say: [field + ': ' + refW + ' says ', V(shown), ' — the BL draft has ', V(b.t.replace(/\s+/g, ' ').trim()), ...parts, '.'] };
  }
  // ---------- v2.9.20: spelling — common trade words only (never names, addresses or company names) ----------
  const BL_DICT920 = ('FREE DRUM PORT DRUMS DETENTION DEMURRAGE CONTAINER CONTAINERS PREPAID COLLECT PALLET PALLETS GROSS WEIGHT CONSIGNEE SHIPPER ' +
    'SHIPPED NOTIFY DESTINATION DISCHARGE LOADING TRANSIT INTERNATIONAL TRANSPORTATION CUSTOMS INDUSTRIAL GRADE CHEMICAL FREIGHT PACKAGES ' +
    'PACKAGE BOARD TOTAL COMPANY LIMITED TRADING GENERAL CARGO GOODS DANGEROUS HAZARDOUS FLAMMABLE DESCRIPTION QUANTITY MEASUREMENT ORIGIN ' +
    'ORIGINAL PACKING INVOICE SHIPPING CARTON CARTONS BUNDLES PIECES TARIFF TERMINAL CHARGES ACCOUNT VESSEL VOYAGE DELIVERY RECEIPT CARRIAGE ' +
    'TRANSSHIPMENT PAYABLE LIQUID POWDER MARINE POLLUTANT TEMPERATURE VENTILATION NUMBER CLASS CONTAIN CONTAINS KILOS NETT').split(' ');
  const BL_DSET920 = new Set(BL_DICT920);
  const BL_REAL920 = new Set(('PAID POST PART SORT FORT PORK PORE TREE FLEE FREED DRUG DRUGS CROSS GLOSS GROSSE HEIGHT EIGHT WEIGHS FRIGHT LADING ' +
    'LEADING SHOPPER SKIPPER CHIPPER CONSIGNER RETENTION TRADE GRATE GRADING CARTOON MARINA MARINER GLASS CLASP LUMBER NUMBED FOODS WOODS ' +
    'HOODS POWER MARRIAGE MALLET BALLET ABOARD PICKING BACKING CHIPPING SPORT PORTS TOTEM CONTAINED HOARD').split(' '));
  function blSpell920(word) {   // → the list word it should be, or ''
    const w = String(word || '').toUpperCase();
    if (w.length < 4 || /[^A-Z]/.test(w) || BL_DSET920.has(w) || BL_REAL920.has(w)) return '';
    if (BL_DSET920.has(w.replace(/E?S$/, '')) || BL_DSET920.has(w + 'S') || BL_DSET920.has(w.replace(/E?D$/, ''))) return '';
    for (const d of BL_DICT920) {
      if (Math.abs(d.length - w.length) > 1 || (d.length === 4 && w.length !== 4)) continue;
      if (d.length === w.length && d.slice(0, -1) === w.slice(0, -1) && /[SDRY]/.test(d.slice(-1)) && /[SDRY]/.test(w.slice(-1))) continue;   // an inflection (PACKAGED / PACKAGES)
      if (blLev919(w, d) === 1) return d;
    }
    return '';
  }

  // ---------- the check ----------
  function blBuild919(M) {
    const done = rdDone915(), K = (p) => blKind919(p);
    const blFiles = [...new Set(done.filter((p) => K(p) === 'bill of lading').map((p) => p.f))];
    if (!blFiles.length) return { bl: null };
    const blP = done.filter((p) => p.f === blFiles[0] && !['invoice', 'packing list', 'eir', 'si'].includes(K(p)));   // its annexure pages too
    const siP = done.filter((p) => K(p) === 'si'), eirP = done.filter((p) => K(p) === 'eir');
    const ciP = done.filter((p) => K(p) === 'invoice' || K(p) === 'packing list');
    const B = blDoc919(blP), useSi = siP.length > 0, refP = useSi ? siP : ciP, R = refP.length ? blDoc919(refP) : null;
    const refW = useSi ? 'the SI' : ciP.some((p) => K(p) === 'packing list') ? 'the packing list' : 'the invoice';
    const refS = useSi ? 'SI' : ciP.some((p) => K(p) === 'packing list') ? 'PACKING LIST' : 'INVOICE';
    const blNo = (blCellLab919(B.T, /^(B\s*\/\s*L\s*(NO|NUMBER)|BILL OF LADING\s*(NO|NUMBER))/) || (B.U.match(/B\s*\/\s*L\s*(?:NO|NUMBER)\.?\s*[:.]?\s*([A-Z0-9][A-Z0-9\/-]{5,30})/) || [])[1] || '').replace(/\(?DRAFT\)?/i, '').trim().split(/\s{2,}/)[0];
    const issues = [], ok = [];
    const say = (...parts) => issues.push(parts);
    const V = (s) => ({ v: String(s) });
    // EIRs
    const eirs = eirP.map((p) => {
      const t = blTx919(p).toUpperCase(), L = t.split('\n'); let cn = '', seal = '';
      L.forEach((l, i) => {
        if (!cn && /CONTAINER/.test(l)) cn = blCns919(l)[0] || '';
        if (!seal) { const m = l.match(/SEAL\s*(?:NO|NUMBER|#)\.?\s*[:.#-]?\s*([A-Z0-9][A-Z0-9\/-]{2,15})\b/); if (m && !/^(SEAL|PREFIX|DETAILS|STATUS|CRT)$/.test(m[1])) seal = m[1]; else if (/SEAL\s*NO\.?\s*$/.test(l.trim()) && L[i + 1]) seal = (L[i + 1].trim().match(/^([A-Z0-9][A-Z0-9\/-]{2,15})\b/) || [])[1] || ''; }
      });
      return { cn: cn || blCns919(t)[0] || '', seal: blSeal919(seal), p };
    }).filter((e) => e.cn);
    const E = new Map(); eirs.forEach((e) => { if (!E.has(e.cn)) E.set(e.cn, e); });
    // containers and seals
    const blC = B.cns, refC = R ? R.cns : [];
    const all = [...new Set([...blC, ...refC, ...E.keys()])];
    const rows = all.map((cn) => {
      const b = B.rows.get(cn) || null, r = R ? R.rows.get(cn) || null : null, e = E.get(cn) || null;
      return { cn, onBl: blC.includes(cn), onRef: refC.includes(cn), bl: b, ref: r, eir: e, bad: false, cd: blCd919(cn) };
    });
    const sealOk = [], sealEir = [];
    rows.forEach((x) => {
      const bs = x.bl && x.bl.seal, rs = x.ref && x.ref.seal, es = x.eir && x.eir.seal;
      const lead = (a, b) => (a && b && a.replace(/^0+/, '') === b.replace(/^0+/, '') ? ' (only the leading 0 differs)' : '');
      if (x.onBl && es && bs && bs !== es) { x.bad = true; say('Seal for ', V(x.cn), ': the EIR says ', V(es), ' — the BL draft says ', V(bs), lead(es, bs) + '.' + (rs && rs !== es ? ' ' + refW.replace(/^t/, 'T') + ' also has ' : ''), ...(rs && rs !== es ? [V(rs), '.'] : [])); }
      else if (x.onBl && es && rs && rs !== es && bs === es) { x.bad = true; say('Seal for ', V(x.cn), ': ' + refW + ' says ', V(rs), ' — the EIR and the BL draft say ', V(es), '. The BL draft is right.'); }
      else if (x.onBl && !es && rs && bs && rs !== bs) { x.bad = true; say('Seal for ', V(x.cn), ': ' + refW + ' says ', V(rs), ' — the BL draft says ', V(bs), lead(rs, bs) + '.'); }
      else if (x.onBl && bs && (es || rs)) { sealOk.push(x.cn); if (es) sealEir.push(x.cn); }
      if (x.onBl && !bs && (es || rs)) { x.bad = true; say('No seal number could be read for ', V(x.cn), ' on the BL draft — ' + (es ? 'the EIR says ' : refW + ' says '), V(es || rs), '.'); }
    });
    const noEir = eirs.length ? rows.filter((x) => x.onBl && !x.eir).map((x) => x.cn) : [];
    const eirOff = rows.filter((x) => x.eir && !x.onBl).map((x) => x.cn);
    const andL = (a) => a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
    if (noEir.length) say('No EIR for ', V(andL(noEir)), ' — ' + (noEir.length === 1 ? 'its seal' : 'their seals') + (R ? (noEir.length === 1 ? ' was' : ' were') + ' checked against ' + refW + ' only.' : ' could not be checked.'));
    if (eirOff.length) say('The EIR' + (eirOff.length > 1 ? 's' : '') + ' for ', V(andL(eirOff)), (eirOff.length > 1 ? ' are for containers' : ' is for a container') + ' not on the BL draft.');
    if (R) {
      const miss = rows.filter((x) => x.onRef && !x.onBl).map((x) => x.cn), extra = rows.filter((x) => x.onBl && !x.onRef && refC.length).map((x) => x.cn);
      if (miss.length) { miss.forEach((cn) => { const x = rows.find((y) => y.cn === cn); x.bad = true; }); say('On ' + refW + ' but not on the BL draft: ', V(andL(miss)), '.'); }
      if (extra.length) { extra.forEach((cn) => { const x = rows.find((y) => y.cn === cn); x.bad = true; }); say('On the BL draft but not on ' + refW + ': ', V(andL(extra)), '.'); }
    }
    rows.filter((x) => !x.cd && (x.onBl || x.onRef)).forEach((x) => { x.bad = true; say(V(x.cn), ': the last digit does not fit the rest — the container number has a typo (on ' + [x.onBl ? 'the BL draft' : '', x.onRef ? refW : ''].filter(Boolean).join(' and ') + ').'); });
    // per container: packages and weights
    rows.filter((x) => x.bl && x.ref).forEach((x) => {
      const d = [];
      if (x.bl.pk !== null && x.ref.pk !== null && x.bl.pk !== x.ref.pk) d.push(['packages ', V(x.ref.pk), ' on ' + refW + ', ', V(x.bl.pk), ' on the BL draft']);
      if (x.bl.gross !== null && x.ref.gross !== null && Math.abs(x.bl.gross - x.ref.gross) > 0.5) d.push(['gross ', V(blKgS919(x.ref.gross)), ' on ' + refW + ', ', V(blKgS919(x.bl.gross)), ' on the BL draft']);
      if (x.bl.net !== null && x.ref.net !== null && Math.abs(x.bl.net - x.ref.net) > 0.5) d.push(['net ', V(blKgS919(x.ref.net)), ' on ' + refW + ', ', V(blKgS919(x.bl.net)), ' on the BL draft']);
      if (d.length) { x.bad = true; say(V(x.cn), ': ', ...d.flatMap((p, i) => (i ? ['; ', ...p] : p)), '.'); }
    });
    // totals
    const sum = (D, k) => { const r = [...D.rows.values()]; return r.length && r.every((x) => x[k] !== null) ? r.reduce((n, x) => n + x[k], 0) : null; };
    const fromF = (f) => { const m = String((f && f.v) || '').toUpperCase().match(/(\d[\d,]*(?:\.\d+)?)\s*(KGS?|MTS?|M\.?T\.?|TONS?)?/); if (!m) return null; const n = blNum919(m[1]); return n === null ? null : /^(MT|MTS|M\.?T\.?|TONS?)$/.test(m[2] || '') ? n * 1000 : n; };
    const tot = { gross: 0, net: 0 };
    ['gross', 'net'].forEach((k) => {
      const lab = k === 'gross' ? 'Gross' : 'Net';
      const ref = R ? (sum(R, k) !== null ? sum(R, k) : R.w[k].length ? R.w[k][0].kg : !useSi && M && M.F[k] ? fromF(M.F[k]) : null) : null;
      const tb = sum(B, k), seen = new Set(), bad = [];
      const figs = (tb !== null ? [{ kg: tb, line: 'the container rows add up to' }] : []).concat(B.w[k].map((x) => ({ kg: x.kg, line: x.line })));
      const want = ref !== null ? ref : tb;
      if (want === null) return;
      figs.forEach((f) => { const key = Math.round(f.kg); if (Math.abs(f.kg - want) > 1 && !seen.has(key)) { seen.add(key); bad.push(f); } });
      if (bad.length) {
        const ofRef = ref !== null ? refW + ' says ' : 'the container rows add up to ';
        say(lab + ' weight: ' + ofRef, V(blKgS919(want)), ' — the BL draft says ', ...bad.flatMap((f, i) => [i ? ' and ' : '', V(blKgS919(f.kg)), f.line === 'the container rows add up to' ? ' (its container rows added up)' : /TOTAL/.test(f.line) ? ' (“' + f.line.replace(/\s{2,}/g, ' ').slice(0, 60) + '”)' : '']), '.');
      } else tot[k] = want;
    });
    const gB = B.w.gross.map((x) => x.kg).concat(sum(B, 'gross') !== null ? [sum(B, 'gross')] : []), nB = B.w.net.map((x) => x.kg).concat(sum(B, 'net') !== null ? [sum(B, 'net')] : []);
    if (gB.length && nB.length && Math.max(...nB) > Math.min(...gB) + 1 && !issues.some((s) => /weight:/.test(String(s[0])))) say('On the BL draft the net weight (', V(blKgS919(Math.max(...nB))), ') is more than the gross weight (', V(blKgS919(Math.min(...gB))), ').');
    // packages, HS code
    if (R && R.pk !== null && B.pk !== null) { if (R.pk !== B.pk) say('Packages: ' + refW + ' says ', V(R.pk), ' — the BL draft says ', V(B.pk), '.'); else ok.push(R.pk + ' packages'); }
    const hsR = R ? (R.hs.length ? R.hs : !useSi && M ? [...new Set(M.lines.map((l) => l.hs.slice(0, 8)).filter((h) => h.length >= 6))] : []) : [];
    if (hsR.length && B.hs.length) {
      const offB = B.hs.filter((h) => !hsR.some((r) => r.startsWith(h) || h.startsWith(r))), offR = hsR.filter((h) => !B.hs.some((b) => b.startsWith(h) || h.startsWith(b)));
      if (offB.length || offR.length) say('HS code: ' + refW + ' says ', V(hsR.join(', ')), ' — the BL draft says ', V(B.hs.join(', ')), '.');
      else ok.push('HS code ' + B.hs.join(', '));
    } else if (hsR.length && !B.hs.length) say('HS code ', V(hsR.join(', ')), ' (' + refW + ') is not on the BL draft.');
    // parties, ports, vessel, description, freight
    const grids = refP.filter((p) => p.grid).map((p) => p.grid);
    const refLab = (k, block) => {
      for (const g of grids) { const v = blGridLab919(g, BL_LAB919[k], block); if (v.length) return v; }
      if (R) { const v = blTextLab919(R.T, BL_LAB919[k], k === 'desc' ? 2 : block); if (v.length) return v; }
      if (!useSi && M && { shipper: 1, consignee: 1, notify: 1 }[k] && M.F[k] && M.F[k].v) return String(M.F[k].v).split('\n');
      return [];
    };
    const blLabRe = { vessel: /^(OCEAN\s+)?VESSEL/, pol: /^PORT OF LOADING|^POL\b/, pod: /^PORT OF DISCHARGE|^POD\b/, fdest: /^PLACE OF DELIVERY|^FINAL DESTINATION/ };
    const PN = { shipper: 'Shipper', consignee: 'Consignee', notify: 'Notify party' };
    // v2.9.20: every SI line word by word against the BL's closest line — "<Field>: the SI says … — the BL draft has … · not on the BL: …"
    const keysOf = (ls) => new Set(ls.flatMap((l) => blWords920(l).map((x) => x.k)));
    const near = (ls, i) => keysOf([ls[i - 1] || '', ls[i + 1] || '']);
    const spell = { si: [], bl: [] };
    if (R) ['shipper', 'consignee', 'notify'].forEach((k) => {
      const lines = refLab(k, true).filter((l) => blNorm919(l).length >= 3 && !/^SAME AS/i.test(l));
      if (!lines.length) return;
      const res = lines.map((l, i) => blLine920(B, PN[k], refW, l, near(lines, i)));
      const bad = res.filter((r) => !r.ok);
      if (!bad.length) { ok.push(PN[k].toLowerCase()); return; }
      if (bad.length === lines.length && lines.length > 1 && res.every((r) => !r.b || !r.b.m || r.b.score < 0.5)) {
        const n0 = blNear919(B, lines[0]);
        say(PN[k] + ': ', V(blFold920(lines[0]).replace(/,\s*$/, '')), ' (' + refW + ') is not on the BL draft' + (n0 ? ' — the closest it has is ' : '.'), ...(n0 ? [V(n0), '.'] : [])); return;
      }
      bad.slice(0, 4).forEach((r) => say(...r.say));
      if (bad.length > 4) say(PN[k] + ': ' + (bad.length - 4) + ' more lines from ' + refW + ' are not on the BL draft.');
    });
    if (R) [['vessel', 'Vessel / voyage'], ['pol', 'Port of loading'], ['pod', 'Port of discharge'], ['fdest', 'Place of delivery']].forEach(([k, name]) => {
      const v = refLab(k, false)[0]; if (!v || blNorm919(v).length < 3) return;
      const has = blCellLab919(B.T, blLabRe[k]);
      const r = blLine920(B, name, refW, v, null, has && blWords920(has).length ? has : '');
      if (r.ok) { ok.push(name.toLowerCase()); return; }
      if (r.b && r.b.label && !r.b.m) say(name + ': ' + refW + ' says ', V(blFold920(v).trim()), ' — the BL draft has ', V(has), '.');
      else say(...r.say);
    });
    if (useSi) {
      const all = refLab('desc', true).filter((l) => blNorm919(l).length >= 2);
      const desc = all.filter((l) => blNorm919(l).length >= 4 && !/^H\.?\s*S\.?\s*CODE|WEIGHT|^\d[\d,.]*\s*(KGS?|MT)$/i.test(l));
      const res = desc.map((l, i) => blLine920(B, 'Description', refW, l, near(desc, i)));
      res.filter((r) => !r.ok).slice(0, 6).forEach((r) => say(...r.say));
      if (desc.length && res.every((r) => r.ok)) ok.push('description');
      // spelling: the SI's description and the BL lines it was matched to
      all.forEach((l) => blWords920(l).forEach((x) => { const t = blSpell920(x.w); if (t) spell.si.push([x.w.toUpperCase(), t]); }));
      res.forEach((r) => { if (r.b && r.b.C && r.b.score >= 0.5) r.b.C.forEach((x) => { const t = blSpell920(x.w); if (t) spell.bl.push([x.w.toUpperCase(), t]); }); });
    }
    const spellS = [];
    [...new Set(spell.si.concat(spell.bl).map((x) => x[0]))].forEach((w) => {
      const t = (spell.si.concat(spell.bl).find((x) => x[0] === w) || [])[1], a = spell.si.some((x) => x[0] === w), b = spell.bl.some((x) => x[0] === w);
      spellS.push(['Spelling: ', V(w), ' on ' + (a && b ? refW + ' and the BL draft' : a ? refW : 'the BL draft') + ' — should it be ', V(t), '?']);
    });
    if (R) {
      const fr = (D) => /FREIGHT\s+PREPAID|\bPREPAID\b/.test(D.U) ? 'PREPAID' : /FREIGHT\s+COLLECT|\bCOLLECT\b/.test(D.U) ? 'COLLECT' : '';
      const a = fr(R), b = fr(B);
      if (a && b && a !== b) say('Freight: ' + refW + ' says ', V('FREIGHT ' + a), ' — the BL draft says ', V('FREIGHT ' + b), '.'); else if (a && a === b) ok.push('freight ' + a.toLowerCase());
    }
    // what matched
    const nOn = rows.filter((x) => x.onBl).length;
    if (R && refC.length && rows.every((x) => !(x.onRef && !x.onBl) && !(x.onBl && !x.onRef)) && nOn) ok.push(rdPl915(nOn, 'container'));
    if (sealOk.length) ok.push((sealOk.length === nOn ? (sealOk.length === 1 ? 'the seal' : 'all ' + sealOk.length + ' seals') : rdPl915(sealOk.length, 'seal')) + (sealEir.length === sealOk.length ? ' (checked with the EIR' + (sealEir.length > 1 ? 's' : '') + ')' : sealEir.length ? ' (' + sealEir.length + ' checked with the EIR)' : ''));
    if (tot.gross) ok.push('gross ' + blKgS919(tot.gross)); if (tot.net) ok.push('net ' + blKgS919(tot.net));
    if (!rows.some((x) => x.onBl)) say('No container numbers could be read on the BL draft.');
    const n = issues.length;
    const head = n ? 'BL ' + (blNo || 'draft') + ' — ' + (n === 1 ? '1 thing' : n + ' things') + ' to look at' : 'BL ' + (blNo || 'draft') + ' — everything matches';
    const against = [R ? (useSi ? 'the SI' : refW) : '', eirs.length ? rdPl915(eirs.length, 'EIR') : ''].filter(Boolean);
    const okLine = ok.length ? (n ? 'Everything else matches: ' : 'Matches: ') + andL(ok) + '.' : '';
    const plain = (s) => s.map((x) => (typeof x === 'string' ? x : x.v)).join('');
    const text = [head, ...issues.map((s, i) => (i + 1) + '. ' + plain(s)), ...spellS.map(plain), okLine].filter(Boolean).join('\n');
    return { spell: spellS, bl: B, blNo, blFile: blFiles[0], more: blFiles.length - 1, si: siP, eir: eirs, ci: ciP, R, refS, refW, useSi, issues, ok, okLine, head, against, text, rows: rows.filter((x) => x.onBl || x.onRef || x.eir) };
  }
  function rdBlHtml919(M) {
    const C = blBuild919(M); RD.BL = C;
    const pasteBox = RD.paste ? '<div class="bl919-paste"><label for="bl919Si">SI TEXT</label><textarea id="bl919Si" rows="7" spellcheck="false" placeholder="Paste the SI here — from the email, or the cells copied from Excel."></textarea>' +
      '<div class="bl919-pa"><button type="button" class="btn-ghost" data-rd915="blx">Cancel</button><button type="button" class="btn-primary" data-rd915="blu">Use this SI</button></div></div>' : '';
    const pasteBtn = !RD.paste && !RD.busy ? '<button type="button" class="bl919-pbtn" data-rd915="blp">' + icon('copy', 14) + '<span>Paste the SI text</span></button>' : '';
    if (!C.bl) {
      if (RD.busy) return '<div class="bl919"><div class="bl919-card is-sk"><span class="rd915-sk"></span><span class="rd915-sk"></span><span class="rd915-sk"></span></div></div>';
      return '<div class="bl919"><div class="bl919-empty"><span class="bl919-eic">' + icon('doc915', 22) + '</span><b>Check a BL draft</b>' +
        '<p>Drop the BL draft with the EIRs and the SI — Excel, PDF or pasted text — or with the invoice and packing list. EWS tells you everything that does not match.</p>' +
        '<div class="bl919-need"><span>BL DRAFT</span><span>EIRs</span><span>SI · EXCEL, PDF OR TEXT</span><span>OR INVOICE + PACKING LIST</span></div>' + pasteBtn + '</div>' + pasteBox + '</div>';
    }
    const chip = (label, val, on) => '<span class="bl919-src' + (on ? '' : ' is-off') + '"><small>' + label + '</small><b>' + esc(val) + '</b></span>';
    const siName = C.si.length ? [...new Set(C.si.map((p) => p.f.name))].join(' · ') : '';
    const srcs = '<div class="bl919-srcs">' + chip('BL DRAFT', C.blNo || C.blFile.name, true) +
      chip('SI', siName || 'not added', !!siName) + chip('EIR', C.eir.length ? rdPl915(C.eir.length, 'container') : 'not added', C.eir.length > 0) +
      (!C.useSi && C.ci.length ? chip(C.refS, rdPl915(new Set(C.ci.map((p) => p.f)).size, 'file'), true) : '') + (C.si.length ? '' : pasteBtn) + '</div>';
    const n = C.issues.length;
    const sent = (s) => s.map((x) => (typeof x === 'string' ? esc(x) : '<b class="bl919-v">' + esc(x.v) + '</b>')).join('');
    const msg = '<section class="bl919-card' + (n ? ' is-bad' : ' is-ok') + '">' +
      '<header class="bl919-hd"><span class="bl919-st">' + (n ? '<b>' + n + '</b>' : icon('ok915', 18)) + '</span><div><h3>' + esc(C.head) + '</h3>' +
        '<small>' + (C.against.length ? 'Checked against ' + esc(C.against.join(' and ')) : 'Nothing to check against yet — add the SI, the EIRs or the invoice and packing list') + (C.more ? ' · only the first BL draft is checked' : '') + '</small></div>' + '</header>' +
      (n ? '<ol class="bl919-is">' + C.issues.map((s) => '<li>' + sent(s) + '</li>').join('') + '</ol>' : '') +
      (C.spell.length ? '<div class="bl920-sp">' + C.spell.map((s) => '<p><span class="bl920-spk">Aa</span><span>' + sent(s) + '</span></p>').join('') + '</div>' : '') +
      (C.okLine ? '<p class="bl919-ok">' + icon('ok915', 13) + '<span>' + esc(C.okLine) + '</span></p>' : '') + '</section>';
    const R = C.rows;
    const sc = (v, bad, l) => '<td data-l="' + l + '" class="m' + (bad ? ' is-bad' : '') + '">' + (v ? esc(v) : '<span class="bl919-na">—</span>') + '</td>';
    const tbl = R.length ? '<section class="dt917-s"><h3><span>CONTAINERS AND SEALS</span><em>' + R.filter((x) => x.onBl).length + ' on the BL</em></h3><div class="bl919-tw"><table class="bl919-tb"><thead><tr><th></th><th>CONTAINER</th><th>SEAL · EIR</th><th>SEAL · BL DRAFT</th><th>SEAL · ' + (C.useSi ? 'SI' : C.refS) + '</th><th>GROSS · BL</th><th>NET · BL</th></tr></thead><tbody>' +
      R.map((x) => {
        const es = x.eir ? x.eir.seal : '', bs = x.bl ? x.bl.seal : '', rs = x.ref ? x.ref.seal : '', truth = es || rs;
        return '<tr class="' + (x.bad ? 'is-bad' : '') + '"><td class="bl919-ic">' + (x.bad ? '<i class="bl919-x">!</i>' : '<i class="bl919-k">' + icon('ok915', 10) + '</i>') + '</td>' +
          '<td class="m bl919-cn' + (!x.cd || !x.onBl ? ' is-bad' : '') + '">' + esc(x.cn) + (!x.onBl ? '<em>NOT ON BL</em>' : '') + '</td>' +
          sc(es, false, 'SEAL · EIR') + sc(bs, !!(bs && truth && bs !== truth), 'SEAL · BL DRAFT') + sc(rs, !!(rs && es && rs !== es), 'SEAL · ' + (C.useSi ? 'SI' : C.refS)) +
          '<td data-l="GROSS · BL" class="m">' + (x.bl && x.bl.gross !== null ? esc(blKgS919(x.bl.gross)) : '<span class="bl919-na">—</span>') + '</td><td data-l="NET · BL" class="m">' + (x.bl && x.bl.net !== null ? esc(blKgS919(x.bl.net)) : '<span class="bl919-na">—</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div></section>' : '';
    return '<div class="bl919">' + srcs + pasteBox + msg + tbl + '</div>';
  }
  function renderReader915(first) {
    if (RD.user !== state.user && !RD.busy) rd915Clear();
    const M = rdMerge915(); RD.M = M;
    if (!RD.tabSet && RD.tab === 'si' && !RD.busy) { const ks = rdDone915().map(blKind919); if (ks.includes('bill of lading') && !ks.some((k) => k === 'invoice' || k === 'packing list')) RD.tab = 'bl'; }   // v2.9.19: a BL set opens on BL CHECK
    const anim = first ? ' reveal' : '';
    const tab = (id, label) => '<button type="button" role="tab" class="rd915-tab' + (RD.tab === id ? ' is-on' : '') + '" aria-selected="' + (RD.tab === id) + '" data-rd915="tab" data-t="' + id + '">' + label + '</button>';
    const allLabel = RD.tab === 'bl' ? 'Copy message' : RD.tab === 'boe' ? 'Copy all boxes' : RD.tab === 'text' ? 'Copy all text' : 'Copy all for the SI';
    const can = RD.tab === 'bl' ? rdDone915().some((p) => blKind919(p) === 'bill of lading') : RD.tab === 'boe' ? M.any : RD.tab === 'text' ? M.text.length > 0 : RD_SI915.some((k) => M.F[k].v);
    $('#view').innerHTML = '<div class="rd915-pg">' +
      '<header class="rd915-head' + anim + '"><div class="rd915-kick">TOOLS · SI, BOE AND BL CHECK</div><h1>Document reader</h1>' +
        '<p class="rd915-sub">Drop the invoice and packing list — even scanned — and EWS lays the details out ready to copy. Add the BL draft, EIRs and SI to check the BL.</p></header>' +
      '<div class="rd915-g' + anim + '">' + rdLeftCard915() +
        '<div class="rd915-r"><div class="rd915-tabs"><div class="rd915-tl" role="tablist" aria-label="Document reader">' + tab('si', 'FOR THE SI') + tab('boe', 'FOR DUBAI TRADE') + tab('bl', 'BL CHECK') + tab('text', 'ALL TEXT') + '</div>' +
          '<button type="button" class="rd915-all" data-rd915="all"' + (can ? '' : ' disabled') + '>' + icon('copy', 16) + '<span>' + allLabel + '</span></button></div>' +
          '<div class="rd915-body' + (RD.busy && !M.any ? ' is-wait' : '') + '" role="tabpanel">' + (RD.tab === 'bl' ? rdBlHtml919(M) : RD.tab === 'boe' ? rdDtHtml917(M) : RD.tab === 'text' ? rdTextHtml915(M) : rdSiHtml915(M)) + '</div></div>' +
      '</div></div>';
  }

  // ---------- copy ----------
  async function rdCopy915(text, btn) {
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) { ok = false; }
    if (!ok) { const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;'; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch (e) { ok = false; } ta.remove(); }
    if (ok && btn && btn.classList.contains('dt917-v')) { btn.classList.add('is-copied'); setTimeout(() => btn.classList.remove('is-copied'), 1400); }   // v2.9.17: the value stays
    else if (ok && btn) { btn.classList.add('is-copied'); const k = btn.innerHTML; btn.innerHTML = icon('ok915', btn.classList.contains('rd915-all') ? 16 : 15) + (btn.classList.contains('rd915-all') ? '<span>Copied</span>' : ''); setTimeout(() => { btn.classList.remove('is-copied'); btn.innerHTML = k; }, 1400); }
    toast(ok ? 'Copied' : 'Could not copy — select the text and copy it', ok ? {} : { error: true });
  }

  // ---------- v2.9.16: the page picker ----------
  const RD_KD916 = { 'eir': 'EIR', 'si': 'SI', 'invoice': 'INVOICE', 'packing list': 'PACKING LIST', 'bill of lading': 'BL', 'certificate of origin': 'COO', 'other': 'OTHER' };
  const rdKd916 = (k) => RD_KD916[k] || '';
  function rdStrip916(f) {   // a file's pages: small thumbnails, each with a tick; the kind under it once it is known
    if (f.st !== 'ready' || f.pages.length < 2) return '';
    return '<div class="rd916-strip" data-f="' + f.id + '" role="group" aria-label="Pages of ' + esc(f.name) + '">' + f.pages.map((p) => {
      const kd = rdKd916(p.kind), st = p.st === 'read' ? ' is-read' : p.st === 'done' ? ' is-done' : p.st === 'err' ? ' is-err' : '';
      return '<button type="button" class="rd916-pt' + (p.on ? ' is-on' : ' is-off') + st + (p.gap && p.st === 'done' ? ' is-gap' : '') + '" data-rd915="pg" data-p="' + p.id + '" aria-pressed="' + (p.on ? 'true' : 'false') + '"' + (RD.busy ? ' disabled' : '') +
        ' aria-label="Page ' + p.n + (kd ? ', ' + kd.toLowerCase() : '') + (p.on ? ', ticked' : ', not ticked') + '" title="' + (p.on ? 'Ticked — click to leave this page out' : 'Left out — click to read this page') + '">' +
        '<span class="rd916-im">' + (p.thumb ? '<img src="' + p.thumb + '" alt="">' : '') + '<i class="rd916-tk">' + icon('ok915', 10) + '</i><b class="rd916-no">' + p.n + '</b></span>' +
        '<em class="rd916-kd' + (kd ? ' is-' + (p.kind === 'invoice' ? 'inv' : p.kind === 'packing list' ? 'pl' : 'ot') : '') + '">' + (kd || '&nbsp;') + '</em></button>';
    }).join('') + '</div>';
  }
  function rdTick916(id) {
    if (RD.busy) return;
    const p = RD.files.flatMap((f) => f.pages).find((x) => x.id === id); if (!p) return;
    p.on = !p.on; RD.msg = null; RD.how = null;
    rerender();
    const b = document.querySelector('.rd916-pt[data-p="' + id + '"]'); if (b) b.focus({ preventScroll: true });
  }
  function rdEta916(pages) {   // Read: text is read at once; a scan takes Google a few seconds (two at a time)
    const s = pages.filter((p) => !p.text && typeof p.ocr !== 'string').length, sec = s * 2.5 + (s ? 2 : 0);
    return (sec < 3 ? 'at once' : sec < 15 ? 'a few seconds' : sec < 45 ? 'about half a minute' : sec < 90 ? 'about a minute' : 'about ' + Math.round(sec / 60) + ' minutes') + ' · free';
  }
  function rdFreeSay916() {
    const P = rdOn916(), S = P.filter((p) => !p.text), got = S.filter((p) => typeof p.ocr === 'string').length, now = S.filter((p) => p.st === 'read').length;
    if (!S.length || !now) return 'Reading…';
    return 'Google is reading ' + (now > 1 ? 'pages ' + (got + 1) + '–' + (got + now) : 'page ' + (got + 1)) + ' of ' + S.length + '…';
  }

  // ---------- v2.9.16: Read — free first ----------
  // 1 a PDF's own text is already here; a scan / photo goes to Code.gs, where Google reads it (Drive OCR; the file is deleted
  //   at once), two pages at a time. 2 EWS's rules lay each page out. 3 rdGaps916 checks the result; only pages with gaps go to Groq.
  async function rdFree916() {
    const pages = rdTodo915(), scans = pages.filter((p) => !p.text && typeof p.ocr !== 'string');
    let fail = null, i = 0, read = 0;
    const one = async () => {
      while (i < scans.length && !RD.stop && !fail) {
        const p = scans[i++]; p.st = 'read'; rdDraw915();
        let res = null, tries = 0;
        for (;;) {
          try { res = await api.call('ethixReadOcr', [{ img: p.img }], { timeout: 120000 }); }
          catch (e) { p.st = 'new'; fail = fail || (e && e.kind === 'auth' ? { auth: true } : { err: (e && e.message) || 'Could not reach EWS — try again.' }); return; }
          res = res || {};
          if (res.busy && res.wait && res.wait <= 30 && tries < 2 && !RD.stop && !fail) { tries++; await new Promise((ok) => setTimeout(ok, res.wait * 1000)); continue; }
          break;
        }
        p.st = 'new';
        if (!RD.files.includes(p.f)) continue;   // Start again while it was reading
        if (res.error) { fail = fail || { err: res.error }; return; }
        if (res.busy) { fail = fail || { busy: true, why: res.why === 'hour' ? 'hour' : 'google' }; return; }
        p.ocr = String(res.text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
        const flat = p.ocr.replace(/\s/g, '');
        p.ocrOk = flat.length >= 40 && (flat.match(/[A-Za-z0-9]/g) || []).length / flat.length >= 0.55;
        p.blank = flat.length < 15;
      }
    };
    await Promise.all([one(), one()]);
    if (fail && fail.auth) return { fail, read, scans: 0 };
    pages.forEach((p) => {   // what there is text for is laid out, even when a later scan failed
      if (!RD.files.includes(p.f) || p.st !== 'new') return;
      const t = p.text || p.ocr; if (typeof t !== 'string') return;
      const r = rdRules916(t, !!p.text); r.text = p.text ? '' : p.ocr;
      if (p.force) r.kind = p.force;
      p.res = r; p.kind = r.kind; p.by = p.text ? 'ews' : 'google'; p.gap = false; p.keep = null; p.st = 'done'; read++;
    });
    rdFile916();
    if (read && !RD.done) RD.done = 1;
    return { fail, read, scans: pages.filter((p) => p.by === 'google' && p.st === 'done').length };
  }
  function rdFile916() {   // packages counted line by line ("Packing: 20 bags" on each) and no total printed: added up, marked CHECK
    RD.files.forEach((f) => {
      const P = f.pages.filter((p) => p.on && p.st === 'done' && p.res && p.by !== 'groq');
      const use = P.filter((p) => p.res.kind === 'packing list').length ? P.filter((p) => p.res.kind === 'packing list') : P.filter((p) => p.res.kind === 'invoice');
      if (!use.length || use.some((p) => (p.res.fields.packages && !p.res.fields.packages.sum) || p.res.totals.some((t) => t.packages))) return;
      const L = use.flatMap((p) => p.res.lines); if (!L.length || !L.every((l) => l._pk && l._pk.n > 0)) return;
      const u = [...new Set(L.map((l) => l._pk.u))]; if (u.length !== 1) return;
      use.forEach((p) => { delete p.res.fields.packages; });
      use[use.length - 1].res.fields.packages = { v: L.reduce((n, l) => n + l._pk.n, 0) + ' ' + u[0], sure: false, sum: true };
    });
  }
  function rdGaps916() {   // EWS checks itself — the pages Groq should look at (invoice / packing-list pages only)
    const out = new Set(), all = rdDone915().filter((p) => p.by !== 'groq');
    const has = (P, k) => P.some((p) => p.res.fields[k] && p.res.fields[k].v);
    RD.files.forEach((f) => {
      const P = all.filter((p) => p.f === f), inv = P.filter((p) => p.res.kind === 'invoice'), pl = P.filter((p) => p.res.kind === 'packing list');
      if (inv.length) {
        const L = inv.flatMap((p) => p.res.lines), t = inv.flatMap((p) => p.res.totals).find((x) => x.goods !== null || x.total !== null);
        const sum = L.reduce((n, l) => n + (typeof l.value === 'number' ? l.value : 0), 0), ch = t ? (t.charges || []).reduce((n, c) => n + (c.n || 0), 0) : 0;
        const tol = Math.max(0.015, L.length * 0.005 + 0.001);
        const adds = t && (t.goods !== null ? Math.abs(sum - t.goods) < tol : Math.abs(sum + ch - t.total) < tol);
        if (!L.length || L.some((l) => l.sure === false) || !adds || !has(inv, 'shipper') || !has(inv, 'consignee') || !has(inv, 'invoice_no')) inv.forEach((p) => out.add(p));
      }
      if (pl.length) {
        const L = pl.flatMap((p) => p.res.lines), T = pl.flatMap((p) => p.res.totals);
        const w = T.some((t) => t.gross !== null) || (L.length > 0 && L.every((l) => typeof l.gross === 'number'));
        const pk = has(pl, 'packages') || has(inv, 'packages') || T.some((t) => t.packages);
        if (!w || !pk || L.some((l) => l.sure === false)) pl.forEach((p) => out.add(p));
      }
    });
    all.forEach((p) => { if (!p.text && !p.ocrOk && !p.blank && p.res.kind === 'other') out.add(p); });   // Google could not read it: the picture goes
    if (!all.some((p) => p.res.kind === 'invoice' || p.res.kind === 'packing list') && !all.some((p) => p.force || ['bill of lading', 'eir', 'si'].includes(p.res.kind))) all.filter((p) => (p.text || p.ocr || '').length > 200).slice(0, 3).forEach((p) => out.add(p));
    return [...out];
  }

  // v2.9.16: Face ID / fingerprint unlock is gone — older HISTORY rows that mention it still read well
  const pkOldWords916 = (s) => String(s || '').toLowerCase().replace(/face id \/ touch id|face id|touch id|windows hello|iphone|ipad|android|windows|mac\b/g, (w) => ({ 'face id / touch id': 'Face ID / Touch ID', 'face id': 'Face ID', 'touch id': 'Touch ID', 'windows hello': 'Windows Hello', iphone: 'iPhone', ipad: 'iPad', android: 'Android', windows: 'Windows', mac: 'Mac' })[w] || w);

  function initV2915() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = 'application/pdf,.pdf,image/*,.xls,.xlsx,.xlsm,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv'; inp.id = 'rd915In'; inp.hidden = true; inp.setAttribute('aria-hidden', 'true');
    inp.addEventListener('change', () => { rdAdd915(inp.files); inp.value = ''; });
    document.body.appendChild(inp);
    const onPage = () => state.signedIn && state.route && state.route.name === 'reader';
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-rd915]'); if (!b || !onPage()) return;
      const a = b.dataset.rd915, M = RD.M || rdMerge915();
      if (a === 'pick') inp.click();
      else if (a === 'read') rdRead915('groq');
      else if (a === 'smart') rdRead915('smart');
      else if (a === 'gaps') rdRead915('gaps');
      else if (a === 'pg') rdTick916(b.dataset.p);
      else if (a === 'tab') { RD.tab = b.dataset.t; RD.tabSet = true; rerender(); const t = $('.rd915-tab.is-on'); if (t) t.focus({ preventScroll: true }); }
      else if (a === 'rm') { RD.files = RD.files.filter((f) => String(f.id) !== b.dataset.f); RD.msg = null; rerender(); }
      else if (a === 'clear') { rd915Clear(); rerender(); }
      else if (a === 'cp') { const f = M.F[b.dataset.k] || M.cards.find((c) => c.k === b.dataset.k); if (f && f.v) rdCopy915(f.v, b); }
      else if (a === 'line') { const l = M.lines[+b.dataset.i]; if (l) rdCopy915(rdLineText915(l, M.cur), b); }
      else if (a === 'page') { const x = M.text[+b.dataset.i]; if (x) rdCopy915(x.text, b); }
      else if (a === 'dt') { const v = dtFlat917(RD.D || dtBuild917(M), b.dataset.k); if (v) rdCopy915(v, b); }   // v2.9.17: FOR DUBAI TRADE
      else if (a === 'dtv') { if (b.dataset.v) rdCopy915(b.dataset.v, b); }
      else if (a === 'dtl') { const x = (RD.D || dtBuild917(M)).lines.flatMap((g) => g.items)[+b.dataset.i]; if (x) rdCopy915(dtLineText917(x), b); }
      else if (a === 'blp') { RD.paste = true; rerender(); const t = $('#bl919Si'); if (t) t.focus(); }   // v2.9.19: BL CHECK
      else if (a === 'blx') { RD.paste = false; rerender(); }
      else if (a === 'blu') { const t = $('#bl919Si'); if (blPaste919(t && t.value)) { RD.paste = false; RD.tab = 'bl'; RD.tabSet = true; rerender(); toast('SI added — checking the BL against it.'); } else { toast('Paste the SI text first.'); if (t) t.focus(); } }
      else if (a === 'all') {
        const t = RD.tab === 'bl' ? (RD.BL || blBuild919(M)).text || '' : RD.tab === 'boe' ? dtAllText917(RD.D || dtBuild917(M)) : RD.tab === 'text' ? M.text.map((x) => '— ' + x.kind.toUpperCase() + ' · ' + x.p.f.name + ' · p' + x.p.n + ' —\n' + x.text).join('\n\n') : rdSiText915(M);
        if (t) rdCopy915(t, b);
      }
    });
    document.addEventListener('keydown', (e) => {   // the tabs: arrow keys move between them
      if (!onPage() || !e.target.classList || !e.target.classList.contains('rd915-tab') || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
      const ids = ['si', 'boe', 'bl', 'text'], i = ids.indexOf(RD.tab);
      RD.tab = ids[(i + (e.key === 'ArrowRight' ? 1 : 3)) % 4]; RD.tabSet = true; rerender(); e.preventDefault();
      const t = $('.rd915-tab.is-on'); if (t) t.focus({ preventScroll: true });
    });
    let over = 0;
    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (!onPage() || !hasFiles(e)) return; over++; document.body.classList.add('rd915-over'); });
    window.addEventListener('dragleave', () => { if (over > 0 && --over === 0) document.body.classList.remove('rd915-over'); });
    window.addEventListener('dragover', (e) => { if (onPage() && hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    window.addEventListener('drop', (e) => { over = 0; document.body.classList.remove('rd915-over'); if (!onPage() || !hasFiles(e)) return; e.preventDefault(); rdAdd915(e.dataTransfer.files); });
    document.addEventListener('paste', (e) => {
      if (!onPage() || !e.clipboardData) return;
      const fs = [...(e.clipboardData.files || [])]; if (!fs.length) return;
      e.preventDefault(); rdAdd915(fs);
    });
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
    initV298();
    initV299();
    initV2910();
    initV2911();
    initV2912();
    initV2913();
    initV2914();
    initV2915();
    if (savedSession()) resumeSession();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // exposed for automated tests only (no data, no token)
  window.__ethix = { parseDate, mapHeaders, buildJob, computeHome, today0, journeyFor, nextStep, costWorkbook, voyage: () => ({ running: voyage.running, leg: voyage.leg, phase: voyage.phase }) };
})();
