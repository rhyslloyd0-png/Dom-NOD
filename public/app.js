// Core: helpers, sign in, navigation. Screens live in views-*.js and register on Hub.views.
(() => {
'use strict';

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
  for (const kid of kids.flat(3)) if (kid != null && kid !== false) el.append(kid);
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
  setTimeout(() => t.remove(), 3600);
}
// Run an action, then redraw; show the reason if it fails.
const act = fn => async e => { e?.stopPropagation?.(); try { const m = await fn(e); if (typeof m === 'string') toast(m); render(); } catch (x) { toast(x.message); } };

const D = {
  add: (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); },
  uk: d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '',
  long: d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
  short: d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
  between: (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000),
  dow: d => (new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7,
  hhmm: m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
};
const money = v => '£' + Math.round(v).toLocaleString('en-GB');
const pct = (cost, sales) => sales > 0 ? (cost / sales * 100).toFixed(1) : '–';
const JOBS = { manager: 'Manager', instore: 'Instore', driver: 'Driver' };
const LEVELS = { staff: 'Staff', supervisor: 'Supervisor', manager: 'Shop manager', area: 'Area manager', regional: 'Regional manager', operations: 'Operations', admin: 'Admin' };
const R = { staff: 0, supervisor: 1, manager: 2, area: 3, regional: 4, operations: 5, admin: 6 };

const state = { me: null, rank: 0, org: 'Staff Hub', stores: [], store: null, today: null, rotaDate: null, unread: 0, timer: null };
const app = document.getElementById('app');
const views = {};

// ---------- building blocks ----------
function dialog(title, fields, { submit = 'Save', onSubmit, extra } = {}) {
  const err = h('p', { class: 'err', role: 'alert' });
  const dlg = h('dialog', {},
    h('form', { method: 'dialog', onsubmit: async e => {
      e.preventDefault();
      try { const out = await onSubmit(Object.fromEntries(new FormData(e.target)), e.target); dlg.close(); if (out !== 'stay') render(); } catch (x) { err.textContent = x.message; }
    } },
      h('h2', {}, title), fields, err,
      h('div', { class: 'row' },
        h('div', { class: 'row' }, extra ? extra(() => dlg.close()) : null),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, onSubmit ? 'Cancel' : 'Close'),
          onSubmit ? h('button', { class: 'btn' }, submit) : null))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
const field = (label, input) => h('label', {}, label, input);
const input = (name, value, attrs) => h('input', { type: 'text', name, value: value ?? '', ...attrs });
const options = (list, selected) => list.map(([v, t]) => h('option', { value: v, selected: String(v) === String(selected) }, t));
const select = (name, list, selected, attrs) => h('select', { name, ...attrs }, options(list, selected));
const check = (name, label, on) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked: !!on }), label);
const tag = (cls, text) => h('span', { class: 'tag ' + cls }, text);
const fig = (k, v, cls) => h('div', { class: 'fig ' + (cls || '') }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
const figs = (...items) => h('div', { class: 'figs' }, items);
const btn = (label, onclick, cls) => h('button', { type: 'button', class: 'btn ' + (cls || ''), onclick }, label);
function head(title, sub, ...actions) {
  return h('div', { class: 'head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null), h('div', { class: 'row' }, actions));
}
function panel(title, right, ...body) {
  return h('section', { class: 'panel' }, h('header', {}, h('h2', {}, title), typeof right === 'string' ? h('span', { class: 'num' }, right) : right), body);
}
const empty = msg => h('p', { class: 'empty' }, msg);
// heads: 'Text' or ['Text', 'class']. rows: arrays of cells; a row may carry .onclick.
function table(heads, rows) {
  const cls = heads.map(x => Array.isArray(x) ? x[1] : '');
  return h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, heads.map((x, i) => h('th', { class: cls[i] }, Array.isArray(x) ? x[0] : x)))),
    h('tbody', {}, rows.map(r => h('tr', { class: r.onclick ? 'link' : '', onclick: r.onclick }, r.map((c, i) => h('td', { class: cls[i] }, c)))))));
}
const storeName = () => (state.stores.find(s => s.id === state.store) || {}).name || '';
const can = level => state.rank >= R[level];
function showTemp(r) {
  dialog('Temporary password', [
    h('p', {}, 'Pass these on in person. The password is shown once and must be changed at first sign in.'), h('br'),
    h('p', {}, 'Username: ', h('b', { class: 'num' }, r.username)),
    h('p', {}, 'Password: ', h('b', { class: 'num' }, r.temp_password)), h('br')
  ], {});
}

// ---------- sign in ----------
function loginView() {
  const err = h('p', { class: 'err', role: 'alert' });
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
      field('Username', input('username', '', { autocomplete: 'username', autocapitalize: 'none', required: true })),
      field('Password', h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true })),
      err, h('button', { class: 'btn' }, 'Sign in')));
}
function passwordForm(forced) {
  const err = h('p', { class: 'err', role: 'alert' });
  return h('form', { onsubmit: async e => {
    e.preventDefault();
    try { await api('POST', '/api/password', Object.fromEntries(new FormData(e.target))); toast('Password changed.'); location.hash = '#home'; await boot(); }
    catch (x) { err.textContent = x.message; }
  } },
    h('h1', {}, forced ? 'Choose your password' : 'Change password'),
    forced ? h('p', { class: 'muted' }, 'You signed in with a temporary password. Set your own to carry on.') : null, h('br'),
    field(forced ? 'Temporary password' : 'Current password', h('input', { type: 'password', name: 'current', autocomplete: 'current-password', required: true })),
    field('New password (10 or more characters)', h('input', { type: 'password', name: 'next', autocomplete: 'new-password', minlength: 10, required: true })),
    err, h('button', { class: 'btn' }, 'Save password'));
}

// ---------- navigation ----------
function routes() {
  const emp = !!state.me.employee_id;
  return [
    ['home', 'Home', 'Me'],
    emp && ['shifts', 'My shifts', 'Me'],
    emp && ['leave', 'My leave', 'Me'],
    emp && ['training', 'My training', 'Me'],
    ['notices', 'Notices', 'Me'],
    emp && ['profile', 'My details', 'Me'],
    state.stores.length && ['rota', 'Day rota', 'Shop'],
    state.stores.length && ['week', 'Week rota', 'Shop'],
    can('supervisor') && ['board', 'Heads Up', 'Shop'],
    can('supervisor') && ['checks', 'Checklists', 'Shop'],
    can('manager') && ['compliance', 'Compliance', 'Manage'],
    can('manager') && ['team', 'Team', 'Manage'],
    can('manager') && ['absence', 'Leave and absence', 'Manage'],
    can('manager') && ['records', 'Training records', 'Manage'],
    can('area') && ['overview', 'All shops', 'Business'],
    can('operations') && ['admin', 'Setup', 'Business'],
    ['password', 'Change password', null],
    can('manager') && ['person', 'Person', null]
  ].filter(Boolean);
}
function currentRoute() {
  const [name, arg] = location.hash.slice(1).split('/');
  return routes().some(x => x[0] === name) && views[name] ? { name, arg } : { name: 'home' };
}
function shell(content) {
  const route = currentRoute().name;
  let group = null;
  const links = [];
  for (const [id, label, g] of routes()) {
    if (!g) continue;
    if (g !== group) { links.push(h('div', { class: 'grp' }, g === 'Shop' && state.stores.length === 1 ? storeName() : g)); group = g; }
    links.push(h('a', { href: '#' + id, class: id === route ? 'on' : '', onclick: () => side.classList.remove('open') },
      label, id === 'notices' && state.unread ? h('span', { class: 'count' }, String(state.unread)) : null));
  }
  const groups = {};
  state.stores.forEach(s => { (groups[s.area || 'No area'] = groups[s.area || 'No area'] || []).push(s); });
  const picker = state.stores.length > 1 ? h('select', { 'aria-label': 'Shop', onchange: e => { state.store = Number(e.target.value); try { localStorage.setItem('hub-shop', state.store); } catch {} render(); } },
    Object.entries(groups).map(([area, list]) => h('optgroup', { label: area }, options(list.map(s => [s.id, s.name]), state.store)))) : null;
  const side = h('aside', { class: 'side' },
    h('div', { class: 'brand' }, h('span', {}, 'Staff Hub'), h('b', {}, state.org)),
    picker,
    h('nav', { class: 'nav' }, links),
    h('div', { class: 'who' },
      h('div', {}, state.me.name),
      h('div', { class: 'muted' }, LEVELS[state.me.role]),
      h('div', { class: 'row' },
        h('a', { href: '#password', onclick: () => side.classList.remove('open') }, 'Change password'),
        h('button', { onclick: async () => { await api('POST', '/api/logout', {}); state.me = null; render(); } }, 'Sign out')),
      h('small', {}, 'Built by RSVX · ', h('a', { href: 'mailto:rhys@rsvx.co.uk' }, 'rhys@rsvx.co.uk'))));
  return h('div', { class: 'shell' },
    h('div', { class: 'topbar' }, h('b', {}, state.org), h('button', { onclick: () => side.classList.toggle('open') }, 'Menu')),
    side, h('main', {}, content));
}
views.password = () => [h('div', { class: 'narrow' }, passwordForm(false))];

let renderSeq = 0;
async function render() {
  clearInterval(state.timer);
  const seq = ++renderSeq;
  document.title = state.org + ' · Staff Hub';
  if (!state.me) { app.replaceChildren(loginView()); return; }
  if (state.me.must_change) { app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'left' }, h('div', {}, h('span', {}, 'Staff Hub'), h('b', {}, state.org))), passwordForm(true))); return; }
  try {
    const r = currentRoute();
    const content = await views[r.name](r.arg);
    if (seq === renderSeq) { const y = scrollY; app.replaceChildren(shell(content)); scrollTo(0, y); }
  } catch (x) {
    if (state.me && seq === renderSeq) app.replaceChildren(shell([head('Something went wrong'), h('p', {}, x.message)]));
  }
}
async function boot() {
  try { state.org = (await (await fetch('/api/config')).json()).org; } catch { /* keep default */ }
  try {
    const me = await api('GET', '/api/me');
    let saved = null; try { saved = Number(localStorage.getItem('hub-shop')); } catch {}
    Object.assign(state, { me: me.user, rank: me.rank, stores: me.stores, today: me.today,
      store: me.stores.some(s => s.id === saved) ? saved : me.user.store_id || (me.stores[0] || {}).id || null });
    if (!me.user.must_change) state.unread = (await api('GET', '/api/summary' + (state.store ? '?store=' + state.store : ''))).unread;
  } catch { state.me = null; }
  render();
}
addEventListener('hashchange', () => { scrollTo(0, 0); render(); });

window.Hub = { h, svg, api, toast, act, D, money, pct, JOBS, LEVELS, R, state, views, dialog, field, input, options, select, check, tag, fig, figs, btn, head, panel, empty, table, storeName, can, showTemp, render, boot };
})();
