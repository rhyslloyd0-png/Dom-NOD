(() => {
'use strict';

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
function svg(tag, attrs, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}
async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') { state.me = null; render(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const ukDate = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';
const longDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const hhmm = m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const money = v => '£' + Math.round(v).toLocaleString('en-GB');
const pct = (cost, sales) => sales > 0 ? (cost / sales * 100).toFixed(1) : '–';
const hourLabel = hr => { const x = hr % 24; return (x % 12 || 12) + (x < 12 ? 'am' : 'pm'); };

const DAY_START = 600, DAY_END = 1500;           // 10:00 to 01:00 on the board
const HOURS = Array.from({ length: 15 }, (_, i) => 10 + i);
const JOBS = { manager: 'Manager', instore: 'Instore', driver: 'Driver' };

const state = { me: null, org: 'Staff Hub', stores: [], store: null, today: null, rotaDate: null, unread: 0, timer: null };
const app = document.getElementById('app');

// ---------- dialogs ----------
function dialog(title, fields, { submit = 'Save', onSubmit, extra } = {}) {
  const err = h('p', { class: 'err', role: 'alert' });
  const dlg = h('dialog', {},
    h('form', { method: 'dialog', onsubmit: async e => {
      e.preventDefault();
      try { await onSubmit(Object.fromEntries(new FormData(e.target))); dlg.close(); } catch (x) { err.textContent = x.message; }
    } },
      h('h2', {}, title), fields, err,
      h('div', { class: 'row' },
        h('div', { class: 'row' }, extra ? extra(() => dlg.close()) : null),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'),
          h('button', { class: 'btn' }, submit)))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}
const field = (label, input) => h('label', {}, label, input);
const options = (list, selected) => list.map(([v, t]) => h('option', { value: v, selected: String(v) === String(selected) }, t));

// ---------- login ----------
function loginView() {
  const err = h('p', { class: 'err', role: 'alert' });
  document.title = state.org + ' · Staff Hub';
  return h('div', { class: 'login' },
    h('div', { class: 'left' },
      h('div', {}, h('span', {}, 'Staff Hub'), h('b', {}, state.org)),
      h('small', {}, 'Built by RSVX · ', h('a', { href: 'mailto:rhys@rsvx.co.uk' }, 'rhys@rsvx.co.uk'))),
    h('form', { onsubmit: async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') }); await boot(); }
      catch (x) { err.textContent = x.message; }
    } },
      h('h1', {}, 'Sign in'),
      field('Username', h('input', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true })),
      field('Password', h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true })),
      err,
      h('button', { class: 'btn' }, 'Sign in')));
}

// ---------- shell ----------
const isManager = () => state.me.role !== 'staff';
function routes() {
  return [
    isManager() && ['home', 'Compliance'],
    ['board', 'Heads Up'],
    ['rota', 'Rota'],
    ['notices', 'Notices'],
    isManager() && ['team', 'Team']
  ].filter(Boolean);
}
function currentRoute() {
  const r = location.hash.slice(1);
  return routes().some(x => x[0] === r) ? r : routes()[0][0];
}

function shell(content) {
  const route = currentRoute();
  const side = h('aside', { class: 'side' },
    h('div', { class: 'brand' }, h('span', {}, 'Staff Hub'), h('b', {}, state.org)),
    state.stores.length > 1
      ? h('select', { 'aria-label': 'Store', onchange: e => { state.store = Number(e.target.value); render(); } }, options(state.stores.map(s => [s.id, s.name]), state.store))
      : null,
    h('nav', { class: 'nav' }, routes().map(([id, label]) =>
      h('a', { href: '#' + id, class: id === route ? 'on' : '', onclick: () => side.classList.remove('open') },
        label, id === 'notices' && state.unread ? h('span', { class: 'count' }, String(state.unread)) : null))),
    h('div', { class: 'who' },
      h('div', {}, state.me.name),
      h('div', { class: 'muted' }, storeName()),
      h('div', { class: 'row' },
        h('button', { onclick: passwordDialog }, 'Change password'),
        h('button', { onclick: async () => { await api('POST', '/api/logout', {}); state.me = null; render(); } }, 'Sign out')),
      h('small', {}, 'Built by RSVX · ', h('a', { href: 'mailto:rhys@rsvx.co.uk' }, 'rhys@rsvx.co.uk'))));
  return h('div', { class: 'shell' },
    h('div', { class: 'topbar' }, h('b', {}, state.org), h('button', { onclick: () => side.classList.toggle('open') }, 'Menu')),
    side, h('main', {}, content));
}
const storeName = () => (state.stores.find(s => s.id === state.store) || {}).name || '';

function passwordDialog() {
  dialog('Change password', [
    field('Current password', h('input', { type: 'password', name: 'current', autocomplete: 'current-password', required: true })),
    field('New password (10+ characters)', h('input', { type: 'password', name: 'next', autocomplete: 'new-password', minlength: 10, required: true }))
  ], { onSubmit: async f => { await api('POST', '/api/password', f); toast('Password changed.'); } });
}

function head(title, sub, ...actions) {
  return h('div', { class: 'head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null), h('div', { class: 'row' }, actions));
}

// ---------- compliance (home) ----------
let homeFilter = 'all';
async function homeView() {
  const d = await api('GET', '/api/home?store=' + state.store);
  const status = date => date < d.today ? 'red' : 'amber';
  const keep = date => homeFilter === 'all' || status(date) === (homeFilter === 'expired' ? 'red' : 'amber');
  const dueTag = date => {
    const n = daysBetween(d.today, date);
    return h('span', { class: 'tag ' + status(date) }, n < 0 ? `${-n}d overdue` : n === 0 ? 'today' : `in ${n}d`);
  };
  const all = [...d.rtw, ...d.job, ...d.additional, ...d.registers, ...d.policies, ...d.certificates];
  const expired = all.filter(x => x.expiry_date < d.today).length;

  const editBtn = doc => h('button', { class: 'btn sm ghost', onclick: () => dialog('Update expiry date', [
    h('p', { class: 'muted' }, `${doc.first_name} ${doc.last_name} · ${doc.doc_type}`), h('br'),
    field('New expiry date', h('input', { type: 'date', name: 'expiry_date', value: doc.expiry_date, required: true }))
  ], { onSubmit: async f => { await api('PATCH', '/api/documents/' + doc.id, f); render(); } }) }, 'Edit');

  const docPanel = (title, rows) => {
    rows = rows.filter(r => keep(r.expiry_date));
    return h('section', { class: 'panel' },
      h('header', {}, h('h2', {}, title), h('span', { class: 'num' }, String(rows.length))),
      rows.length ? h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'hide-s' }, 'Job'), h('th', {}, 'Document'), h('th', {}, 'Expiry'), h('th', {}))),
        h('tbody', {}, rows.map(r => h('tr', { class: status(r.expiry_date) },
          h('td', {}, h('b', {}, r.last_name), ', ', r.first_name),
          h('td', { class: 'hide-s muted' }, r.job_title || ''),
          h('td', {}, r.doc_type),
          h('td', {}, h('span', { class: 'num' }, ukDate(r.expiry_date)), ' ', dueTag(r.expiry_date)),
          h('td', { class: 'r' }, editBtn(r))))))) : h('p', { class: 'empty' }, 'Nothing due.'));
  };
  const itemPanel = (title, rows, doneLabel, dueLabel) => {
    rows = rows.filter(r => keep(r.expiry_date));
    return h('section', { class: 'panel' },
      h('header', {}, h('h2', {}, title), h('span', { class: 'num' }, String(rows.length))),
      rows.length ? h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'hide-s' }, doneLabel), h('th', {}, dueLabel))),
        h('tbody', {}, rows.map(r => h('tr', { class: status(r.expiry_date) },
          h('td', {}, r.name), h('td', { class: 'hide-s num' }, ukDate(r.done_date)),
          h('td', {}, h('span', { class: 'num' }, ukDate(r.expiry_date)), ' ', dueTag(r.expiry_date))))))) : h('p', { class: 'empty' }, 'Nothing due.'));
  };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter' },
    [['all', 'All'], ['expired', 'Expired'], ['soon', 'Within 8 weeks']].map(([k, t]) =>
      h('button', { class: homeFilter === k ? 'on' : '', onclick: () => { homeFilter = k; render(); } }, t)));

  return [
    head('Compliance', `${storeName()} · ${longDate(d.today)}`, seg),
    h('div', { class: 'figs' },
      h('div', { class: 'fig' + (expired ? ' red' : '') }, h('div', { class: 'v' }, String(expired)), h('div', { class: 'k' }, 'Expired')),
      h('div', { class: 'fig' }, h('div', { class: 'v' }, String(all.length - expired)), h('div', { class: 'k' }, 'Due within 8 weeks')),
      h('div', { class: 'fig' + (d.missing.length ? ' red' : '') }, h('div', { class: 'v' }, String(d.missing.length)), h('div', { class: 'k' }, 'Missing contracts'))),
    docPanel('Right to work documents', d.rtw),
    docPanel('Job documents', d.job),
    docPanel('Additional documents', d.additional),
    h('section', { class: 'panel' },
      h('header', {}, h('h2', {}, 'Missing contracts'), h('span', { class: 'num' }, String(d.missing.length))),
      d.missing.length ? h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Job'), h('th', {}, 'Start date'))),
        h('tbody', {}, d.missing.map(r => h('tr', { class: 'red' },
          h('td', {}, h('b', {}, r.last_name), ', ', r.first_name), h('td', { class: 'muted' }, r.job_title || ''), h('td', { class: 'num' }, ukDate(r.start_date))))))) : h('p', { class: 'empty' }, 'Everyone has a contract on file.')),
    itemPanel('Compliance registers', d.registers, 'Completed', 'Review'),
    itemPanel('Policies and assessments', d.policies, 'Uploaded', 'Expiry'),
    itemPanel('Certificates', d.certificates, 'Uploaded', 'Expiry')
  ];
}

// ---------- notices ----------
let openNotice = null;
async function noticesView() {
  const list = await api('GET', '/api/notices');
  state.unread = list.filter(n => !n.acked_at).length;
  const add = isManager() ? h('button', { class: 'btn', onclick: () => dialog('New notice', [
    field('Title', h('input', { type: 'text', name: 'title', maxlength: 120, required: true })),
    field('Message', h('textarea', { name: 'body', rows: 6, maxlength: 4000 }))
  ], { submit: 'Publish', onSubmit: async f => { await api('POST', '/api/notices', f); render(); } }) }, 'New notice') : null;

  return [
    head('Notices', state.unread ? `${state.unread} to read` : 'All read', add),
    h('section', { class: 'panel' }, list.length ? list.map(n => {
      const open = openNotice === n.id;
      return h('div', { class: 'notice' + (n.acked_at ? ' read' : ''), onclick: () => { openNotice = open ? null : n.id; render(); } },
        h('span', { class: 'dot', title: n.acked_at ? 'Read' : 'Unread' }),
        h('div', {}, h('b', {}, n.title), h('div', { class: 'muted small' }, `${n.type} · ${n.created_by}`)),
        h('span', { class: 'num muted small' }, ukDate(n.issued)),
        open ? h('div', { class: 'body' },
          h('p', {}, n.body || 'No message.'), h('br'),
          n.acked_at ? h('span', { class: 'tag green' }, 'Read ' + ukDate(n.acked_at.slice(0, 10)))
            : h('button', { class: 'btn sm', onclick: async e => { e.stopPropagation(); await api('POST', `/api/notices/${n.id}/ack`, {}); render(); } }, 'Mark as read')) : null);
    }) : h('p', { class: 'empty' }, 'No notices yet.'))
  ];
}

// ---------- rota maths ----------
function rotaMaths(d) {
  const perHour = { inside: HOURS.map(() => 0), driver: HOURS.map(() => 0) };
  const cost = { manager: 0, instore: 0, driver: 0 };
  const hrs = { manager: 0, instore: 0, driver: 0 };
  for (const s of d.shifts) {
    const len = (s.end_min - s.start_min) / 60;
    hrs[s.job] += len;
    cost[s.job] += len * (s.hourly_rate || 0);
    HOURS.forEach((hr, i) => {
      const o = Math.max(0, Math.min(s.end_min, hr * 60 + 60) - Math.max(s.start_min, hr * 60)) / 60;
      perHour[s.job === 'driver' ? 'driver' : 'inside'][i] += o;
    });
  }
  const sales = HOURS.map(hr => (d.forecast.find(f => f.hour === hr) || {}).sales || 0);
  const orders = d.forecast.reduce((a, f) => a + (f.orders || 0), 0);
  const total = sales.reduce((a, b) => a + b, 0);
  return { perHour, cost, hrs, sales, orders, total, allCost: cost.manager + cost.instore + cost.driver, allHrs: hrs.manager + hrs.instore + hrs.driver };
}

// ---------- rota ----------
function shiftDialog(d, shift) {
  const times = [];
  for (let m = 300; m <= 1740; m += 15) times.push([m, hhmm(m) + (m >= 1440 ? ' (next day)' : '')]);
  dialog(shift ? `${shift.first_name} ${shift.last_name}` : 'Add shift', [
    shift ? null : field('Team member', h('select', { name: 'employee_id', required: true },
      d.employees.map(e => h('option', { value: e.id }, `${e.first_name} ${e.last_name} · ${JOBS[e.job]}`)))),
    h('div', { class: 'two' },
      field('Start', h('select', { name: 'start_min' }, options(times, shift ? shift.start_min : 1020))),
      field('Finish', h('select', { name: 'end_min' }, options(times, shift ? shift.end_min : 1380)))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'closing', checked: shift && !!shift.closing }), 'Closing shift')
  ], {
    onSubmit: async f => {
      const body = { start_min: Number(f.start_min), end_min: Number(f.end_min), closing: f.closing === 'on' };
      if (body.end_min <= body.start_min) throw new Error('Finish must be after start.');
      if (shift) await api('PATCH', '/api/shifts/' + shift.id, body);
      else await api('POST', '/api/shifts', { ...body, employee_id: Number(f.employee_id), date: d.date });
      render();
    },
    extra: shift ? close => h('button', { type: 'button', class: 'btn danger', onclick: async () => { await api('DELETE', '/api/shifts/' + shift.id, {}); close(); render(); } }, 'Delete') : null
  });
}

async function rotaView() {
  state.rotaDate = state.rotaDate || state.today;
  const d = await api('GET', `/api/rota?store=${state.store}&date=${state.rotaDate}`);
  const m = rotaMaths(d);
  const go = date => { state.rotaDate = date; render(); };
  const dow = (new Date(d.date + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const monday = addDays(d.date, -dow);

  const nav = h('div', { class: 'row' },
    h('button', { class: 'btn ghost', onclick: () => go(addDays(d.date, -1)), 'aria-label': 'Previous day' }, 'Prev'),
    h('input', { type: 'date', value: d.date, 'aria-label': 'Date', style: { width: 'auto' }, onchange: e => e.target.value && go(e.target.value) }),
    h('button', { class: 'btn ghost', onclick: () => go(addDays(d.date, 1)), 'aria-label': 'Next day' }, 'Next'),
    h('div', { class: 'days' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((l, i) =>
      h('button', { class: i === dow ? 'on' : '', onclick: () => go(addDays(monday, i)), 'aria-label': longDate(addDays(monday, i)) }, l))));

  const figs = d.canEdit ? h('div', { class: 'figs' },
    [['Manager lab %', pct(m.cost.manager, m.total)], ['Instore lab %', pct(m.cost.instore, m.total)], ['Driver lab %', pct(m.cost.driver, m.total)],
     ['Total lab %', pct(m.allCost, m.total)], ['Forecast sales', money(m.total)], ['Week sales', money(d.weekSales)], ['Week lab %', pct(d.weekCost, d.weekSales)]]
      .map(([k, v]) => h('div', { class: 'fig' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k)))) : null;

  const line = (cls, lab, cells, tot) => h('div', { class: 'line ' + cls }, h('div', { class: 'lab' }, lab), cells, h('div', { class: 'tot' }, tot));
  const cellRow = vals => h('div', { class: 'cells' }, vals.map(v => h('span', {}, v)));
  const span = DAY_END - DAY_START;

  const shiftLine = s => {
    const a = Math.max(s.start_min, DAY_START), b = Math.min(s.end_min, DAY_END);
    const bar = h('button', {
      class: 'bar ' + s.job, disabled: !d.canEdit, title: `${hhmm(s.start_min)} to ${hhmm(s.end_min)}`,
      style: { left: (a - DAY_START) / span * 100 + '%', width: Math.max(0, b - a) / span * 100 + '%' },
      onclick: () => shiftDialog(d, s)
    }, h('span', {}, hhmm(s.start_min)), h('span', {}, hhmm(s.end_min) + (s.closing ? ' CL' : '')));
    return line('', [s.first_name + ' ' + s.last_name, h('small', {}, s.job_title || JOBS[s.job])], h('div', { class: 'track' }, bar), ((s.end_min - s.start_min) / 60).toFixed(2));
  };

  const fcRow = d.canEdit
    ? h('div', { class: 'cells' }, HOURS.map((hr, i) => h('input', {
        class: 'fc', type: 'number', min: 0, step: 1, inputmode: 'numeric', value: m.sales[i] || '', 'aria-label': 'Forecast sales ' + hourLabel(hr),
        onchange: async e => {
          try { await api('PUT', '/api/forecast', { store_id: state.store, date: d.date, hour: hr, sales: Number(e.target.value) || 0 }); render(); }
          catch (x) { toast(x.message); }
        } })))
    : cellRow(m.sales.map(v => v ? money(v) : '–'));

  const board = h('section', { class: 'panel' },
    h('header', {}, h('h2', {}, 'Day plan'), d.canEdit ? h('button', { class: 'btn sm', onclick: () => d.employees.length ? shiftDialog(d) : toast('Add team members first.') }, 'Add shift') : null),
    h('div', { class: 'scroll' }, h('div', { class: 'rota' },
      line('hours', 'Team', cellRow(HOURS.map(hourLabel)), 'Hrs'),
      d.shifts.length ? d.shifts.map(shiftLine) : h('p', { class: 'empty' }, 'No shifts on this day yet.'),
      line('sum', 'Instore hrs', cellRow(m.perHour.inside.map(v => v.toFixed(2))), (m.hrs.manager + m.hrs.instore).toFixed(2)),
      line('sum', 'Driver hrs', cellRow(m.perHour.driver.map(v => v.toFixed(2))), m.hrs.driver.toFixed(2)),
      line('sum', 'Forecast £', fcRow, money(m.total)),
      line('hours', 'Total', cellRow(HOURS.map((_, i) => (m.perHour.inside[i] + m.perHour.driver[i]).toFixed(1))), m.allHrs.toFixed(2)))),
    h('div', { class: 'key' },
      h('span', {}, h('i', { style: { background: 'var(--mgr)' } }), 'Manager'),
      h('span', {}, h('i', { style: { background: 'var(--ins)' } }), 'Instore'),
      h('span', {}, h('i', { style: { background: 'var(--drv)' } }), 'Driver'),
      h('span', {}, 'CL = closing shift'),
      d.canEdit ? h('span', {}, 'Tap a shift to change it. Forecast boxes save as you type.') : null));

  return [head('Rota', `${storeName()} · ${longDate(d.date)}`, nav), figs, board];
}

// ---------- heads up ----------
function staffChart(shifts, drivers, nowMin) {
  const bins = [];
  for (let t = DAY_START; t < DAY_END; t += 15)
    bins.push(shifts.filter(s => (s.job === 'driver') === drivers && s.start_min <= t && s.end_min > t).length);
  const max = Math.max(2, ...bins), W = 640, H = 150, L = 22, B = 18, pw = (W - L) / bins.length, ph = H - B - 6;
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': (drivers ? 'Drivers' : 'Insiders') + ' on shift through the day' });
  for (let v = 0; v <= max; v++) {
    const y = 6 + ph - v / max * ph;
    g.append(svg('line', { class: 'grid', x1: L, x2: W, y1: y, y2: y }), svg('text', { class: 'axis', x: L - 6, y: y + 3, 'text-anchor': 'end' }, v));
  }
  bins.forEach((v, i) => { if (v) g.append(svg('rect', { class: 'b', x: L + i * pw + 1.5, y: 6 + ph - v / max * ph, width: pw - 3, height: v / max * ph })); });
  for (let hr = 10; hr <= 24; hr += 2) g.append(svg('text', { class: 'axis', x: L + (hr * 60 - DAY_START) / 15 * pw, y: H - 4 }, hhmm(hr * 60)));
  if (nowMin != null && nowMin >= DAY_START && nowMin < DAY_END) {
    const x = L + (nowMin - DAY_START) / 15 * pw;
    g.append(svg('line', { class: 'now', x1: x, x2: x, y1: 2, y2: 6 + ph }));
  }
  return h('div', { class: 'chart' }, g);
}

async function boardView() {
  const d = await api('GET', `/api/rota?store=${state.store}&date=${state.today}`);
  const m = rotaMaths(d);
  const london = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const now = london();
  let nowMin = now.getHours() * 60 + now.getMinutes();
  if (nowMin < 300) nowMin += 1440;                       // after midnight still belongs to last night's board
  const on = job => d.shifts.filter(s => s.start_min <= nowMin && s.end_min > nowMin && (job === 'driver') === (s.job === 'driver')).length;
  const hourSales = m.sales[HOURS.indexOf(Math.floor(nowMin / 60))] || 0;
  const clock = h('div', { class: 'clock', 'aria-live': 'off' }, '');
  const tick = () => { clock.textContent = london().toLocaleTimeString('en-GB'); };
  tick(); state.timer = setInterval(tick, 1000);
  const fig = (k, v, cls) => h('div', { class: 'fig ' + (cls || '') }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));

  return [
    head('Heads Up', `${storeName()} · ${longDate(d.today)}`, clock),
    h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Labour'), h('a', { href: '#rota', class: 'btn sm ghost' }, 'View rota')),
      h('div', { class: 'figs', style: { margin: '0', border: '0' } },
        fig('Instores on now', String(on('inside'))), fig('Drivers on now', String(on('driver'))),
        fig('Rota hours today', m.allHrs.toFixed(1)),
        d.canEdit ? fig('Rota labour %', pct(m.allCost, m.total)) : null)),
    h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Sales forecast')),
      h('div', { class: 'figs', style: { margin: '0', border: '0' } },
        fig('Forecast today', money(m.total)), fig('Forecast this hour', money(hourSales)),
        fig('Forecast orders', Math.round(m.orders).toString()),
        fig('Forecast sales per labour hour', m.allHrs ? money(m.total / m.allHrs) : '–'))),
    h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Insiders on shift'), h('span', { class: 'muted small' }, 'Red line is now')), staffChart(d.shifts, false, nowMin)),
    h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Drivers on shift')), staffChart(d.shifts, true, nowMin)),
    h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Live service'), h('span', { class: 'tag amber' }, 'No feed connected')),
      h('div', { class: 'figs', style: { margin: '0', border: '0' } },
        ['Actual sales', 'Orders', 'Load time', 'Rack time', 'GPS ADT', 'DOT %', 'Single run %', 'OPMH'].map(k => fig(k, '–', 'off'))),
      h('p', { class: 'empty small' }, 'These need a data feed from the store till system. Nothing is shown until one is connected.'))
  ];
}

// ---------- team ----------
function employeeDialog(emp) {
  const e = emp || {};
  dialog(emp ? 'Edit team member' : 'Add team member', [
    h('div', { class: 'two' },
      field('First name', h('input', { type: 'text', name: 'first_name', value: e.first_name || '', required: true })),
      field('Last name', h('input', { type: 'text', name: 'last_name', value: e.last_name || '', required: true }))),
    h('div', { class: 'two' },
      field('Role on rota', h('select', { name: 'job' }, options(Object.entries(JOBS), e.job || 'instore'))),
      field('Job title', h('input', { type: 'text', name: 'job_title', value: e.job_title || '' }))),
    h('div', { class: 'two' },
      field('Hourly rate £', h('input', { type: 'number', name: 'hourly_rate', step: '0.01', min: 0, value: e.hourly_rate ?? '', required: true })),
      field('Start date', h('input', { type: 'date', name: 'start_date', value: e.start_date || '' }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'has_contract', checked: emp ? !!e.has_contract : true }), 'Contract on file')
  ], {
    onSubmit: async f => {
      const body = { ...f, hourly_rate: Number(f.hourly_rate), has_contract: f.has_contract === 'on', store_id: state.store };
      if (emp) await api('PATCH', '/api/employees/' + emp.id, body); else await api('POST', '/api/employees', body);
      render();
    },
    extra: emp ? close => h('button', { type: 'button', class: 'btn danger', onclick: async () => {
      if (!confirm(`Remove ${e.first_name} ${e.last_name} from the team list?`)) return;
      await api('PATCH', '/api/employees/' + emp.id, { active: 0 }); close(); render();
    } }, 'Remove') : null
  });
}
function documentDialog(emp) {
  dialog(`Add document · ${emp.first_name} ${emp.last_name}`, [
    field('Category', h('select', { name: 'category' }, options([['job', 'Job document'], ['rtw', 'Right to work'], ['additional', 'Additional']], 'job'))),
    field('Document type', h('input', { type: 'text', name: 'doc_type', placeholder: 'MOT, insurance, RTW check', required: true })),
    field('Expiry date', h('input', { type: 'date', name: 'expiry_date', required: true }))
  ], { onSubmit: async f => { await api('POST', '/api/documents', { ...f, employee_id: emp.id }); toast('Document added.'); } });
}
async function teamView() {
  const list = await api('GET', '/api/employees?store=' + state.store);
  return [
    head('Team', `${storeName()} · ${list.length} people`, h('button', { class: 'btn', onclick: () => employeeDialog() }, 'Add team member')),
    h('section', { class: 'panel' }, list.length ? h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', { class: 'r hide-s' }, 'Rate'), h('th', { class: 'hide-s' }, 'Contract'), h('th', {}))),
      h('tbody', {}, list.map(e => h('tr', {},
        h('td', {}, h('b', {}, e.first_name + ' ' + e.last_name)),
        h('td', { class: 'muted' }, e.job_title || JOBS[e.job]),
        h('td', { class: 'r num hide-s' }, '£' + Number(e.hourly_rate).toFixed(2)),
        h('td', { class: 'hide-s' }, h('span', { class: 'tag ' + (e.has_contract ? 'green' : 'red') }, e.has_contract ? 'On file' : 'Missing')),
        h('td', { class: 'r' }, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          h('button', { class: 'btn sm ghost', onclick: () => documentDialog(e) }, 'Add doc'),
          h('button', { class: 'btn sm ghost', onclick: () => employeeDialog(e) }, 'Edit')))))))) : h('p', { class: 'empty' }, 'No team members yet.'))
  ];
}

// ---------- boot ----------
const views = { home: homeView, board: boardView, rota: rotaView, notices: noticesView, team: teamView };
let renderSeq = 0;
async function render() {
  clearInterval(state.timer);
  const seq = ++renderSeq;
  if (!state.me) { app.replaceChildren(loginView()); return; }
  document.title = state.org + ' · Staff Hub';
  try {
    const content = await views[currentRoute()]();
    if (seq === renderSeq) { const y = scrollY; app.replaceChildren(shell(content)); scrollTo(0, y); }
  } catch (x) {
    if (state.me && seq === renderSeq) app.replaceChildren(shell([head('Something went wrong'), h('p', {}, x.message)]));
  }
}
async function boot() {
  try { state.org = (await (await fetch('/api/config')).json()).org; } catch { /* keep default */ }
  try {
    const me = await api('GET', '/api/me');
    Object.assign(state, { me: me.user, stores: me.stores, today: me.today, store: me.user.store_id || (me.stores[0] || {}).id });
    state.unread = (await api('GET', '/api/notices')).filter(n => !n.acked_at).length;
  } catch { state.me = null; }
  render();
}
addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
boot();
})();
