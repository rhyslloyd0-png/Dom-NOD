// Screens for the shop floor: home, shifts, rota, Heads Up, checklists, notices, compliance.
(() => {
'use strict';
const { h, svg, api, toast, act, D, money, pct, JOBS, state, views, dialog, field, input, select, check, tag, fig, figs, btn, head, panel, empty, table, storeName, can, render } = Hub;

const DAY_START = 600, DAY_END = 1500;           // 10:00 to 01:00 on the board
const HOURS = Array.from({ length: 15 }, (_, i) => 10 + i);
const hourLabel = hr => { const x = hr % 24; return (x % 12 || 12) + (x < 12 ? 'am' : 'pm'); };
const span = s => D.hhmm(s.start_min) + ' to ' + D.hhmm(s.end_min) + (s.closing ? ' (close)' : '');
const q = () => 'store=' + state.store;

// ---------- home ----------
views.home = async () => {
  const d = await api('GET', '/api/summary' + (state.store ? '?' + q() : ''));
  state.unread = d.unread;
  const next = d.shifts && d.shifts[0];
  const me = [
    d.shifts ? fig('Next shift', next ? D.short(next.date) : 'None', next ? '' : 'off') : null,
    d.balance ? fig('Holiday days left', String(d.balance.left)) : null,
    d.trainingDue != null ? fig('Training to do', String(d.trainingDue), d.trainingDue ? 'red' : '') : null,
    fig('Notices to read', String(d.unread), d.unread ? 'red' : '')
  ];
  const m = d.manage;
  return [
    head('Hello, ' + state.me.name.split(' ')[0], D.long(d.today)),
    figs(me),
    state.stores.length ? null : panel('Getting started', null, h('div', { class: 'steps' }, can('admin') ? [
      h('p', {}, h('b', {}, '1. '), 'Open Setup and add your regions, areas and shops. The rota, team and compliance pages appear once there is a shop.'),
      h('p', {}, h('b', {}, '2. '), 'Add people on the Team page, or load them all at once with the import command in the README.'),
      h('p', {}, h('b', {}, '3. '), 'Create logins for area, regional and operations managers under Setup, Logins. Shop managers create logins for their own staff.'),
      h('p', {}, h('a', { href: '#admin', class: 'btn' }, 'Open Setup'))
    ] : h('p', {}, 'No shops are linked to your login yet. Ask an admin to add them under Setup.'))),
    d.shifts ? panel('Your next shifts', h('a', { href: '#shifts', class: 'btn sm ghost' }, 'All shifts'),
      d.shifts.length ? table(['Day', 'Time'], d.shifts.map(s => [D.short(s.date), h('span', { class: 'num' }, span(s))])) : empty('Nothing on the rota for you yet.')) : null,
    m ? panel(storeName() + ' today', h('a', { href: '#compliance', class: 'btn sm ghost' }, 'Compliance'),
      h('div', { class: 'figs flush' },
        fig('Team', String(m.headcount)),
        fig('Leave to decide', String(m.pendingLeave), m.pendingLeave ? 'red' : ''),
        fig('Expired documents', String(m.expiredDocs), m.expiredDocs ? 'red' : ''),
        fig('Due in 8 weeks', String(m.dueDocs)),
        fig('Missing contracts', String(m.missingContracts), m.missingContracts ? 'red' : '')),
      m.offToday.length ? h('p', { class: 'empty' }, 'Off today: ' + m.offToday.map(o => `${o.first_name} ${o.last_name} (${o.kind})`).join(', ')) : null) : null
  ];
};

views.shifts = async () => {
  const d = await api('GET', '/api/shifts/mine');
  return [
    head('My shifts', 'From today onwards'),
    panel('Coming up', String(d.shifts.length), d.shifts.length
      ? table(['Day', 'Time', ['Hours', 'r'], ['Shop', 'hide-s']], d.shifts.map(s => [D.short(s.date), h('span', { class: 'num' }, span(s)), ((s.end_min - s.start_min) / 60).toFixed(2), s.store]))
      : empty('Nothing on the rota for you yet.'))
  ];
};

// ---------- rota maths ----------
function rotaMaths(d) {
  const perHour = { inside: HOURS.map(() => 0), driver: HOURS.map(() => 0) };
  const cost = { manager: 0, instore: 0, driver: 0 }, hrs = { manager: 0, instore: 0, driver: 0 };
  for (const s of d.shifts) {
    if (!s.employee_id) continue;                         // open shifts are not labour yet
    const len = (s.end_min - s.start_min) / 60;
    hrs[s.job] += len; cost[s.job] += len * (s.hourly_rate || 0);
    HOURS.forEach((hr, i) => { perHour[s.job === 'driver' ? 'driver' : 'inside'][i] += Math.max(0, Math.min(s.end_min, hr * 60 + 60) - Math.max(s.start_min, hr * 60)) / 60; });
  }
  const sales = HOURS.map(hr => (d.forecast.find(f => f.hour === hr) || {}).sales || 0);
  const need = k => HOURS.map(hr => ((d.need || []).find(n => n.hour === hr) || {})[k] || 0);
  return { perHour, cost, hrs, sales, need: { inside: need('insiders'), driver: need('drivers') },
    orders: d.forecast.reduce((a, f) => a + (f.orders || 0), 0), total: sales.reduce((a, b) => a + b, 0),
    allCost: cost.manager + cost.instore + cost.driver, allHrs: hrs.manager + hrs.instore + hrs.driver, open: d.shifts.filter(s => !s.employee_id).length };
}

// ---------- day rota ----------
function shiftDialog(d, shift, preset) {
  const times = [];
  for (let m = 300; m <= 1740; m += 15) times.push([m, D.hhmm(m) + (m >= 1440 ? ' (next day)' : '')]);
  const s = shift || preset || {};
  const busy = new Set(d.shifts.filter(x => x.employee_id && x.id !== s.id).map(x => x.employee_id));
  const fits = e => !shift || (e.job === 'driver') === (shift.job === 'driver');
  const people = d.employees.filter(fits).map(e => [e.id, `${e.first_name} ${e.last_name} · ${JOBS[e.job]}${d.off.includes(e.id) ? ' · off' : busy.has(e.id) ? ' · on today' : ''}`]);
  dialog(shift ? (shift.employee_id ? `${shift.first_name} ${shift.last_name}` : `Open ${JOBS[shift.job].toLowerCase()} shift`) : 'Add shift', [
    field('Who', select('employee_id', [['', shift ? 'Nobody yet (open shift)' : 'Nobody yet (open shift)'], ...people], s.employee_id || '')),
    shift ? null : field('Role, if left open', select('job', Object.entries(JOBS), 'instore')),
    h('div', { class: 'two' },
      field('Start', select('start_min', times, s.start_min || 1020)),
      field('Finish', select('end_min', times, s.end_min || 1380))),
    check('closing', 'Closing shift', s.closing)
  ], {
    onSubmit: async f => {
      const body = { start_min: Number(f.start_min), end_min: Number(f.end_min), closing: f.closing === 'on', employee_id: f.employee_id ? Number(f.employee_id) : null };
      if (body.end_min <= body.start_min) throw new Error('Finish must be after start.');
      if (shift) await api('PATCH', '/api/shifts/' + shift.id, body);
      else await api('POST', '/api/shifts', { ...body, job: f.job, date: d.date, store_id: state.store });
    },
    extra: shift ? close => btn('Delete', async () => { await api('DELETE', '/api/shifts/' + shift.id, {}); close(); render(); }, 'danger') : null
  });
}

views.rota = async () => {
  state.rotaDate = state.rotaDate || state.today;
  const d = await api('GET', `/api/rota?${q()}&date=${state.rotaDate}`);
  const m = rotaMaths(d);
  const go = date => { state.rotaDate = date; render(); };
  const dow = D.dow(d.date), monday = D.add(d.date, -dow);

  const nav = h('div', { class: 'row' },
    btn('Prev', () => go(D.add(d.date, -1)), 'ghost'),
    h('input', { type: 'date', value: d.date, 'aria-label': 'Date', class: 'auto', onchange: e => e.target.value && go(e.target.value) }),
    btn('Next', () => go(D.add(d.date, 1)), 'ghost'),
    h('div', { class: 'days' }, ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((l, i) =>
      h('button', { class: i === dow ? 'on' : '', onclick: () => go(D.add(monday, i)), 'aria-label': D.long(D.add(monday, i)) }, l))));

  const top = d.canEdit ? figs(
    fig('Manager lab %', pct(m.cost.manager, m.total)), fig('Instore lab %', pct(m.cost.instore, m.total)), fig('Driver lab %', pct(m.cost.driver, m.total)),
    fig('Total lab %', pct(m.allCost, m.total)), fig('Forecast sales', money(m.total)), fig('Open shifts', String(m.open), m.open ? 'red' : ''),
    fig('Week sales', money(d.weekSales)), fig('Week lab %', pct(d.weekCost, d.weekSales))) : null;

  const line = (cls, lab, cells, tot) => h('div', { class: 'line ' + cls }, h('div', { class: 'lab' }, lab), cells, h('div', { class: 'tot' }, tot));
  const cellRow = (vals, flags) => h('div', { class: 'cells' }, vals.map((v, i) => h('span', { class: flags && flags[i] ? 'short' : '' }, v)));
  const width = DAY_END - DAY_START;

  const shiftLine = s => {
    const a = Math.max(s.start_min, DAY_START), b = Math.min(s.end_min, DAY_END), open = !s.employee_id;
    const bar = h('button', {
      class: 'bar ' + s.job + (open ? ' open' : ''), disabled: !d.canEdit, title: span(s),
      style: { left: (a - DAY_START) / width * 100 + '%', width: Math.max(0, b - a) / width * 100 + '%' },
      onclick: () => shiftDialog(d, s)
    }, h('span', {}, D.hhmm(s.start_min)), open && d.canEdit ? h('span', {}, 'Assign') : null, h('span', {}, D.hhmm(s.end_min) + (s.closing ? ' CL' : '')));
    return line(open ? 'openline' : '', [open ? 'Open shift' : s.first_name + ' ' + s.last_name, h('small', {}, open ? JOBS[s.job] : s.job_title || JOBS[s.job])],
      h('div', { class: 'track' }, bar), ((s.end_min - s.start_min) / 60).toFixed(2));
  };

  const fcRow = d.canEdit
    ? h('div', { class: 'cells' }, HOURS.map((hr, i) => h('input', {
        class: 'fc', type: 'number', min: 0, step: 1, inputmode: 'numeric', value: m.sales[i] || '', 'aria-label': 'Forecast sales ' + hourLabel(hr),
        onchange: act(e => api('PUT', '/api/forecast', { store_id: state.store, date: d.date, hour: hr, sales: Number(e.target.value) || 0 })) })))
    : cellRow(m.sales.map(v => v ? money(v) : '–'));
  const have = k => m.perHour[k].map(v => v.toFixed(2));
  const shortOf = k => m.perHour[k].map((v, i) => v + 0.01 < m.need[k][i]);

  const tools = d.canEdit ? h('div', { class: 'row' },
    btn('Predict sales', act(async () => { await api('POST', '/api/forecast/predict', { store_id: state.store, date: d.date }); return 'Forecast filled from the last four ' + D.long(d.date).split(' ')[0] + 's.'; }), 'sm ghost'),
    btn('Build shifts', act(async () => { const r = await api('POST', '/api/rota/generate', { store_id: state.store, date: d.date }); return `${r.made} open shifts built. Tap each one to assign.`; }), 'sm'),
    btn('Add shift', () => shiftDialog(d), 'sm ghost')) : null;

  const board = panel('Day plan', tools,
    h('div', { class: 'scroll' }, h('div', { class: 'rota' },
      line('hours', 'Team', cellRow(HOURS.map(hourLabel)), 'Hrs'),
      d.shifts.length ? d.shifts.map(shiftLine) : empty(d.canEdit ? 'No shifts yet. Enter or predict the forecast, then press Build shifts.' : 'No shifts on this day yet.'),
      line('sum', 'Forecast £', fcRow, money(m.total)),
      line('sum need', 'Insiders needed', cellRow(m.need.inside), ''),
      line('sum', 'Insiders on rota', cellRow(have('inside'), shortOf('inside')), (m.hrs.manager + m.hrs.instore).toFixed(2)),
      line('sum need', 'Drivers needed', cellRow(m.need.driver), ''),
      line('sum', 'Drivers on rota', cellRow(have('driver'), shortOf('driver')), m.hrs.driver.toFixed(2)),
      line('hours', 'Total', cellRow(HOURS.map((_, i) => (m.perHour.inside[i] + m.perHour.driver[i]).toFixed(1))), m.allHrs.toFixed(2)))),
    h('div', { class: 'key' },
      h('span', {}, h('i', { class: 'k-mgr' }), 'Manager'), h('span', {}, h('i', { class: 'k-ins' }), 'Instore'), h('span', {}, h('i', { class: 'k-drv' }), 'Driver'),
      h('span', {}, h('i', { class: 'k-open' }), 'Open, nobody assigned'), h('span', {}, h('i', { class: 'k-short' }), 'Below the level needed'),
      h('span', {}, 'CL = closing shift')));

  return [head('Day rota', `${storeName()} · ${D.long(d.date)}`, nav), top, board];
};

// ---------- week rota ----------
views.week = async () => {
  state.rotaDate = state.rotaDate || state.today;
  const d = await api('GET', `/api/rota/week?${q()}&date=${state.rotaDate}`);
  const days = Array.from({ length: 7 }, (_, i) => D.add(d.monday, i));
  const go = n => { state.rotaDate = D.add(d.monday, n); render(); };
  const cell = list => list.length ? list.map(s => h('div', { class: 'num wk ' + s.job }, D.hhmm(s.start_min) + '–' + D.hhmm(s.end_min))) : '';
  const isOff = (id, day) => d.off.some(o => o.employee_id === id && o.start_date <= day && o.end_date >= day);
  const open = d.shifts.filter(s => !s.employee_id);
  const rows = d.employees.map(e => {
    const mine = d.shifts.filter(s => s.employee_id === e.id), hrs = mine.reduce((a, s) => a + (s.end_min - s.start_min) / 60, 0);
    return [[h('b', {}, e.first_name + ' ' + e.last_name), h('div', { class: 'muted small' }, e.job_title || JOBS[e.job])],
      ...days.map(day => isOff(e.id, day) ? tag('amber', 'Off') : cell(mine.filter(s => s.date === day))),
      h('span', { class: 'num' }, hrs.toFixed(1) + (e.contract_hours ? ' / ' + e.contract_hours : ''))];
  });
  if (open.length) rows.unshift([[h('b', {}, 'Open shifts'), h('div', { class: 'muted small' }, 'Nobody assigned')],
    ...days.map(day => { const n = open.filter(s => s.date === day); return n.length ? tag('red', n.length + ' open') : ''; }), h('span', { class: 'num' }, String(open.length))]);
  const dayHead = day => [h('button', { class: 'daylink', onclick: () => { state.rotaDate = day; location.hash = '#rota'; } }, D.short(day)), day === d.today ? 'today' : ''];
  const tools = d.canEdit ? [
    btn('Copy last week', act(async () => { const r = await api('POST', '/api/rota/copy-week', { store_id: state.store, date: d.monday }); return `${r.copied} shifts copied.`; }), 'ghost'),
    btn('Predict sales', act(async () => { await api('POST', '/api/forecast/predict', { store_id: state.store, date: d.monday, week: true }); return 'Forecast filled for the week.'; }), 'ghost'),
    btn('Build week', act(async () => { const r = await api('POST', '/api/rota/generate', { store_id: state.store, date: d.monday, week: true }); return `${r.made} open shifts built for the week.`; }))
  ] : [];
  return [
    head('Week rota', `${storeName()} · week of ${D.long(d.monday)}`, btn('Prev', () => go(-7), 'ghost'), btn('This week', () => { state.rotaDate = state.today; render(); }, 'ghost'), btn('Next', () => go(7), 'ghost')),
    d.canEdit ? h('div', { class: 'row gap' }, tools) : null,
    panel('Schedule', `${d.shifts.length - open.length} shifts`, table(['Team', ...days.map(dayHead), ['Hours', 'r']], rows)),
    d.canEdit ? h('p', { class: 'muted small' }, 'Build week reads the sales forecast and the optimal staffing levels, then creates open shifts for every day from today. Shifts already given to people are kept and counted. Tap a day to assign.') : null
  ];
};

// ---------- heads up ----------
function staffChart(shifts, drivers, nowMin) {
  const bins = [];
  for (let t = DAY_START; t < DAY_END; t += 15) bins.push(shifts.filter(s => s.employee_id && (s.job === 'driver') === drivers && s.start_min <= t && s.end_min > t).length);
  const max = Math.max(2, ...bins), W = 640, H = 150, L = 22, B = 18, pw = (W - L) / bins.length, ph = H - B - 6;
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': (drivers ? 'Drivers' : 'Insiders') + ' on shift through the day' });
  for (let v = 0; v <= max; v++) {
    const y = 6 + ph - v / max * ph;
    g.append(svg('line', { class: 'grid', x1: L, x2: W, y1: y, y2: y }), svg('text', { class: 'axis', x: L - 6, y: y + 3, 'text-anchor': 'end' }, v));
  }
  bins.forEach((v, i) => { if (v) g.append(svg('rect', { class: 'b', x: L + i * pw + 1.5, y: 6 + ph - v / max * ph, width: pw - 3, height: v / max * ph })); });
  for (let hr = 10; hr <= 24; hr += 2) g.append(svg('text', { class: 'axis', x: L + (hr * 60 - DAY_START) / 15 * pw, y: H - 4 }, D.hhmm(hr * 60)));
  if (nowMin >= DAY_START && nowMin < DAY_END) { const x = L + (nowMin - DAY_START) / 15 * pw; g.append(svg('line', { class: 'now', x1: x, x2: x, y1: 2, y2: 6 + ph })); }
  return h('div', { class: 'chart' }, g);
}
views.board = async () => {
  const d = await api('GET', `/api/rota?${q()}&date=${state.today}`);
  const m = rotaMaths(d);
  const london = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const now = london();
  let nowMin = now.getHours() * 60 + now.getMinutes();
  if (nowMin < 300) nowMin += 1440;                       // after midnight still belongs to last night's board
  const on = drivers => d.shifts.filter(s => s.employee_id && s.start_min <= nowMin && s.end_min > nowMin && drivers === (s.job === 'driver'));
  const i = HOURS.indexOf(Math.floor(nowMin / 60));
  const clock = h('div', { class: 'clock' }, '');
  const tick = () => { clock.textContent = london().toLocaleTimeString('en-GB'); };
  tick(); state.timer = setInterval(tick, 1000);
  const inN = on(false).length, drN = on(true).length, needIn = i < 0 ? 0 : m.need.inside[i], needDr = i < 0 ? 0 : m.need.driver[i];
  return [
    head('Heads Up', `${storeName()} · ${D.long(d.today)}`, clock),
    panel('On now', h('a', { href: '#rota', class: 'btn sm ghost' }, 'Day rota'),
      h('div', { class: 'figs flush' },
        fig(`Insiders, ${needIn} needed`, String(inN), inN < needIn ? 'red' : ''), fig(`Drivers, ${needDr} needed`, String(drN), drN < needDr ? 'red' : ''),
        fig('Open shifts today', String(m.open), m.open ? 'red' : ''), fig('Rota hours today', m.allHrs.toFixed(1)),
        d.canEdit ? fig('Rota labour %', pct(m.allCost, m.total)) : null),
      h('p', { class: 'empty' }, [...on(false), ...on(true)].map(s => `${s.first_name} ${s.last_name}`).join(', ') || 'Nobody is on the rota right now.')),
    panel('Sales forecast', null, h('div', { class: 'figs flush' },
      fig('Forecast today', money(m.total)), fig('Forecast this hour', money(i < 0 ? 0 : m.sales[i])),
      fig('Forecast orders', Math.round(m.orders).toString()), fig('Sales per labour hour', m.allHrs ? money(m.total / m.allHrs) : '–'))),
    panel('Insiders on shift', h('span', { class: 'muted small' }, 'Red line is now'), staffChart(d.shifts, false, nowMin)),
    panel('Drivers on shift', null, staffChart(d.shifts, true, nowMin)),
    panel('Live service', tag('amber', 'No feed connected'),
      h('div', { class: 'figs flush' }, ['Actual sales', 'Orders', 'Load time', 'Rack time', 'GPS ADT', 'DOT %', 'Single run %', 'OPMH'].map(k => fig(k, '–', 'off'))),
      h('p', { class: 'empty small' }, 'These need a data feed from the shop till system. Nothing is shown until one is connected.'))
  ];
};

// ---------- checklists ----------
let checkDate = null;
views.checks = async () => {
  checkDate = checkDate || state.today;
  const d = await api('GET', `/api/checklists?${q()}&date=${checkDate}`);
  const live = d.date === d.today;
  return [
    head('Checklists', `${storeName()} · ${D.long(d.date)}`,
      h('input', { type: 'date', class: 'auto', value: d.date, max: d.today, 'aria-label': 'Date', onchange: e => { checkDate = e.target.value || d.today; render(); } })),
    d.lists.length ? d.lists.map(l => panel(l.name, l.completed ? tag('green', 'Done · ' + l.done_by) : tag(live ? 'amber' : 'red', `${l.ticks.filter(Boolean).length} of ${l.items.length}`),
      h('div', { class: 'ticks' }, l.items.map((item, i) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: l.ticks[i], disabled: !live, onchange: act(e => {
          const ticks = l.ticks.slice(); ticks[i] = e.target.checked;
          return api('PUT', `/api/checklists/${l.id}/run`, { store_id: state.store, date: d.date, ticks });
        }) }), item))))) : panel('No checklists', null, empty('Operations sets up checklists under Setup.'))
  ];
};

// ---------- notices ----------
let openNotice = null;
views.notices = async () => {
  const list = await api('GET', '/api/notices');
  state.unread = list.filter(n => !n.acked_at).length;
  const scopes = [['store', storeName() + ' only'], can('area') && ['area', 'The area ' + storeName() + ' is in'], can('regional') && ['region', 'The whole region'], can('operations') && ['all', 'Whole business']].filter(Boolean);
  const add = can('manager') ? btn('New notice', () => dialog('New notice', [
    field('Title', input('title', '', { maxlength: 120, required: true })),
    h('div', { class: 'two' }, field('Type', select('type', [['Notice', 'Notice'], ['Policy', 'Policy']])), field('Who sees it', select('scope', scopes))),
    field('Message', h('textarea', { name: 'body', rows: 6, maxlength: 6000 }))
  ], { submit: 'Publish', onSubmit: f => api('POST', '/api/notices', { ...f, store_id: state.store }) })) : null;
  const whoRead = n => act(async () => {
    const acks = await api('GET', `/api/notices/${n.id}/acks?${q()}`);
    dialog(`Read at ${storeName()}: ${acks.filter(a => a.acked_at).length} of ${acks.length}`, [
      h('div', { class: 'list' }, acks.map(a => h('p', {}, tag(a.acked_at ? 'green' : 'red', a.acked_at ? 'Read' : 'Not yet'), ' ', a.name))), h('br')], {});
  });
  return [
    head('Notices', state.unread ? `${state.unread} to read` : 'All read', add),
    panel('Notices and policies', String(list.length), list.length ? list.map(n => {
      const open = openNotice === n.id;
      return h('div', { class: 'notice' + (n.acked_at ? ' read' : ''), onclick: () => { openNotice = open ? null : n.id; render(); } },
        h('span', { class: 'dot', title: n.acked_at ? 'Read' : 'Unread' }),
        h('div', {}, h('b', {}, n.title), h('div', { class: 'muted small' }, `${n.type} · ${n.created_by} · ${n.audience}`)),
        h('span', { class: 'num muted small' }, D.uk(n.issued)),
        open ? h('div', { class: 'body' },
          h('p', {}, n.body || 'No message.'), h('br'),
          h('div', { class: 'row' },
            n.acked_at ? tag('green', 'Read ' + D.uk(n.acked_at.slice(0, 10))) : btn(n.type === 'Policy' ? 'I have read and understood this' : 'Mark as read', act(() => api('POST', `/api/notices/${n.id}/ack`, {})), 'sm'),
            can('manager') ? btn('Who has read it', whoRead(n), 'sm ghost') : null,
            can('manager') ? btn('Remove', act(() => { if (confirm('Remove this notice for everyone?')) return api('DELETE', '/api/notices/' + n.id, {}); }), 'sm ghost') : null)) : null);
    }) : empty('No notices yet.'))
  ];
};

// ---------- compliance ----------
let filter = 'all';
views.compliance = async () => {
  const d = await api('GET', '/api/home?' + q());
  const status = date => date < d.today ? 'red' : 'amber';
  const keep = date => filter === 'all' || status(date) === (filter === 'expired' ? 'red' : 'amber');
  const due = date => { const n = D.between(d.today, date); return [h('span', { class: 'num' }, D.uk(date)), ' ', tag(status(date), n < 0 ? `${-n}d overdue` : n === 0 ? 'today' : `in ${n}d`)]; };
  const all = [...d.rtw, ...d.job, ...d.additional, ...d.registers, ...d.policies, ...d.certificates];
  const expired = all.filter(x => x.expiry_date < d.today).length;
  const editDoc = doc => btn('Edit', () => dialog('Update expiry date', [
    h('p', { class: 'muted' }, `${doc.first_name} ${doc.last_name} · ${doc.doc_type}`), h('br'),
    field('New expiry date', h('input', { type: 'date', name: 'expiry_date', value: doc.expiry_date, required: true }))
  ], { onSubmit: f => api('PATCH', '/api/documents/' + doc.id, f) }), 'sm ghost');
  const docs = (title, rows) => { rows = rows.filter(r => keep(r.expiry_date)); return panel(title, String(rows.length), rows.length
    ? table(['Name', ['Job', 'hide-s'], 'Document', 'Expiry', ['', 'r']], rows.map(r => [h('a', { href: '#person/' + r.employee_id }, h('b', {}, r.last_name), ', ', r.first_name), h('span', { class: 'muted' }, r.job_title || ''), r.doc_type, due(r.expiry_date), editDoc(r)]))
    : empty('Nothing due.')); };
  const renew = it => btn('Renew', () => dialog('Renew: ' + it.name, [
    h('div', { class: 'two' }, field('Done on', h('input', { type: 'date', name: 'done_date', value: d.today, required: true })), field('Next due', h('input', { type: 'date', name: 'expiry_date', required: true })))
  ], { onSubmit: f => api('PATCH', '/api/company-items/' + it.id, f), extra: close => btn('Remove', async () => { await api('PATCH', '/api/company-items/' + it.id, { remove: true }); close(); render(); }, 'danger') }), 'sm ghost');
  const items = (title, rows) => { rows = rows.filter(r => keep(r.expiry_date)); return panel(title, String(rows.length), rows.length
    ? table(['Name', ['Last done', 'hide-s'], 'Due', ['', 'r']], rows.map(r => [r.name, h('span', { class: 'num' }, D.uk(r.done_date)), due(r.expiry_date), renew(r)])) : empty('Nothing due.')); };
  const addItem = btn('Add shop item', () => dialog('Add register, policy or certificate', [
    field('Kind', select('kind', [['register', 'Compliance register'], ['policy', 'Policy or assessment'], ['certificate', 'Certificate']])),
    field('Name', input('name', '', { required: true, placeholder: 'Fire risk assessment' })),
    h('div', { class: 'two' }, field('Done on', h('input', { type: 'date', name: 'done_date', value: d.today })), field('Next due', h('input', { type: 'date', name: 'expiry_date', required: true })))
  ], { onSubmit: f => api('POST', '/api/company-items', { ...f, store_id: state.store }) }), 'ghost');
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter' }, [['all', 'All'], ['expired', 'Expired'], ['soon', 'Within 8 weeks']].map(([k, t]) =>
    h('button', { class: filter === k ? 'on' : '', onclick: () => { filter = k; render(); } }, t)));
  return [
    head('Compliance', `${storeName()} · ${D.long(d.today)}`, seg, addItem),
    figs(fig('Expired', String(expired), expired ? 'red' : ''), fig('Due within 8 weeks', String(all.length - expired)), fig('Missing contracts', String(d.missing.length), d.missing.length ? 'red' : ''), fig('Shop items tracked', String(d.allItems.length))),
    docs('Right to work documents', d.rtw), docs('Job documents', d.job), docs('Additional documents', d.additional),
    panel('Missing contracts', String(d.missing.length), d.missing.length
      ? table(['Name', 'Job', 'Start date'], d.missing.map(r => [h('a', { href: '#person/' + r.id }, h('b', {}, r.last_name), ', ', r.first_name), h('span', { class: 'muted' }, r.job_title || ''), h('span', { class: 'num' }, D.uk(r.start_date))]))
      : empty('Everyone has a contract on file.')),
    items('Compliance registers', d.registers), items('Policies and assessments', d.policies), items('Certificates', d.certificates)
  ];
};
})();
