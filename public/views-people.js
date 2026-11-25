// Screens for people: leave, training, records, team, all shops and setup.
(() => {
'use strict';
const { h, api, toast, act, D, money, pct, JOBS, LEVELS, R, state, views, dialog, field, input, select, check, tag, fig, figs, btn, head, panel, empty, table, storeName, can, showTemp, render, boot } = Hub;
const q = () => 'store=' + state.store;
const KIND = { holiday: 'Holiday', sickness: 'Sickness', other: 'Other absence' };
const STATUS = { pending: ['amber', 'Waiting'], approved: ['green', 'Approved'], declined: ['red', 'Declined'] };
const st = s => tag(...STATUS[s]);
const dates = l => h('span', { class: 'num' }, l.start_date === l.end_date ? D.uk(l.start_date) : `${D.uk(l.start_date)} to ${D.uk(l.end_date)}`);
const trainTag = c => c.status === 'done' ? tag('green', c.expires_date ? 'Valid to ' + D.uk(c.expires_date) : 'Done') : tag('red', c.status === 'expired' ? 'Expired ' + D.uk(c.expires_date) : 'To do');

function leaveDialog(empId, asManager) {
  dialog(asManager ? 'Log leave or absence' : 'Request holiday', [
    asManager ? field('Type', select('kind', Object.entries(KIND))) : null,
    h('div', { class: 'two' }, field('First day', h('input', { type: 'date', name: 'start_date', required: true })), field('Last day', h('input', { type: 'date', name: 'end_date', required: true }))),
    field('Working days to count (leave blank for every day in the range)', h('input', { type: 'number', name: 'days', min: 0.5, step: 0.5 })),
    field(asManager ? 'Note (do not record medical details here)' : 'Note for your manager', input('note', '', { maxlength: 300 }))
  ], { submit: asManager ? 'Save' : 'Send request', onSubmit: f => api('POST', '/api/leave', { ...f, employee_id: asManager ? empId : undefined }) });
}

// ---------- my leave ----------
views.leave = async () => {
  const d = await api('GET', '/api/employees/' + state.me.employee_id);
  const b = d.balance;
  return [
    head('My leave', `Holiday year ${b.year}`, btn('Request holiday', () => leaveDialog())),
    figs(fig('Allowance', String(b.allowance)), fig('Taken or booked', String(b.taken)), fig('Waiting for a decision', String(b.pending)), fig('Days left', String(b.left), b.left < 0 ? 'red' : '')),
    panel('Requests and absence', String(d.leave.length), d.leave.length
      ? table(['Dates', 'Type', ['Days', 'r'], 'Status', ['', 'r']], d.leave.map(l => [dates(l), KIND[l.kind], String(l.days), st(l.status),
          l.status === 'pending' ? btn('Cancel', act(() => api('DELETE', '/api/leave/' + l.id, {})), 'sm ghost') : '']))
      : empty('No leave on record yet.'))
  ];
};

// ---------- my training ----------
views.training = async () => {
  const d = await api('GET', '/api/employees/' + state.me.employee_id);
  const todo = d.training.filter(c => c.status !== 'done').length;
  return [
    head('My training', todo ? `${todo} to do` : 'All up to date'),
    panel('Courses', String(d.training.length), d.training.length ? d.training.map(c => h('div', { class: 'course' },
      h('div', {}, h('b', {}, c.title), h('p', { class: 'muted small' }, c.description),
        c.link ? h('a', { href: c.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open training material') : null),
      h('div', {}, trainTag(c), c.completed_date ? h('div', { class: 'muted small' }, `Signed off ${D.uk(c.completed_date)} by ${c.signed_by}`) : h('div', { class: 'muted small' }, 'Your manager signs this off')))) : empty('No courses set for your role yet.'))
  ];
};

// ---------- person record (also "My details") ----------
function employeeDialog(emp) {
  const e = emp || {};
  dialog(emp ? 'Edit details' : 'Add team member', [
    h('div', { class: 'two' }, field('First name', input('first_name', e.first_name, { required: true })), field('Last name', input('last_name', e.last_name, { required: true }))),
    h('div', { class: 'two' }, field('Role on rota', select('job', Object.entries(JOBS), e.job || 'instore')), field('Job title', input('job_title', e.job_title))),
    h('div', { class: 'two' }, field('Hourly rate £', h('input', { type: 'number', name: 'hourly_rate', step: '0.01', min: 0, value: e.hourly_rate ?? '', required: true })), field('Start date', h('input', { type: 'date', name: 'start_date', value: e.start_date || '' }))),
    h('div', { class: 'two' }, field('Contract hours a week', h('input', { type: 'number', name: 'contract_hours', step: '0.5', min: 0, value: e.contract_hours ?? '' })), field('Holiday days a year', h('input', { type: 'number', name: 'holiday_days', step: '0.5', min: 0, value: e.holiday_days ?? 28 }))),
    h('div', { class: 'two' }, field('Phone', input('phone', e.phone)), field('Email', input('email', e.email))),
    h('div', { class: 'two' }, field('Emergency contact', input('emergency_name', e.emergency_name)), field('Emergency phone', input('emergency_phone', e.emergency_phone))),
    check('has_contract', 'Contract on file', emp ? e.has_contract : true)
  ], { onSubmit: async f => {
    const body = { ...f, hourly_rate: Number(f.hourly_rate), has_contract: f.has_contract === 'on', store_id: state.store };
    if (emp) await api('PATCH', '/api/employees/' + emp.id, body); else await api('POST', '/api/employees', body);
  } });
}
const grantable = () => Object.keys(LEVELS).filter(l => R[l] <= R.manager && (state.me.role === 'admin' || R[l] < state.rank)).map(l => [l, LEVELS[l]]);

async function personView(id, mine) {
  const d = await api('GET', '/api/employees/' + id);
  const e = d.employee, a = d.account, m = d.canManage;
  const row = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, v || '–'));
  const contact = () => dialog('My contact details', [
    h('div', { class: 'two' }, field('Phone', input('phone', e.phone)), field('Email', input('email', e.email))),
    h('div', { class: 'two' }, field('Emergency contact', input('emergency_name', e.emergency_name)), field('Emergency phone', input('emergency_phone', e.emergency_phone)))
  ], { onSubmit: f => api('PATCH', '/api/profile', f) });
  const login = !m ? null : panel('Login', a ? tag(a.active ? 'green' : 'red', a.active ? LEVELS[a.role] : 'Disabled') : tag('amber', 'No login'),
    a ? [h('div', { class: 'kvs' }, row('Username', a.username), row('Access level', LEVELS[a.role]), row('Password', a.must_change ? 'Temporary, not yet changed' : 'Set by them')),
      h('div', { class: 'row pad' },
        btn('Reset password', act(async () => { if (confirm('Give this person a new temporary password?')) showTemp(await api('POST', `/api/users/${a.id}/reset`, {})); }), 'sm ghost'),
        btn('Change level', () => dialog('Access level', [field('Level', select('role', grantable(), a.role))], { onSubmit: f => api('PATCH', '/api/users/' + a.id, f) }), 'sm ghost'),
        btn(a.active ? 'Disable login' : 'Enable login', act(() => api('PATCH', '/api/users/' + a.id, { active: !a.active })), 'sm ghost'))]
      : [empty('This person cannot sign in yet.'), h('div', { class: 'row pad' }, btn('Create login', () => dialog('Create login', [
          field('Username', input('username', (e.first_name + '.' + e.last_name).toLowerCase().replace(/[^a-z0-9.]/g, ''), { required: true, autocapitalize: 'none' })),
          field('Access level', select('role', grantable(), 'staff'))
        ], { submit: 'Create', onSubmit: async f => { const r = await api('POST', `/api/employees/${e.id}/account`, f); render(); showTemp(r); return 'stay'; } }), 'sm'))]);
  const addDoc = () => dialog('Add document', [
    field('Category', select('category', [['job', 'Job document'], ['rtw', 'Right to work'], ['additional', 'Additional']])),
    field('Document type', input('doc_type', '', { placeholder: 'MOT, insurance, RTW check', required: true })),
    field('Expiry date', h('input', { type: 'date', name: 'expiry_date', required: true }))
  ], { onSubmit: f => api('POST', '/api/documents', { ...f, employee_id: e.id }) });
  const signOff = c => btn('Sign off', () => dialog('Sign off: ' + c.title, [field('Completed on', h('input', { type: 'date', name: 'completed_date', value: d.today, max: d.today, required: true }))],
    { onSubmit: f => api('POST', '/api/completions', { ...f, course_id: c.course_id, employee_id: e.id }) }), 'sm ghost');
  const b = d.balance;
  return [
    head(mine ? 'My details' : `${e.first_name} ${e.last_name}`, `${e.job_title || JOBS[e.job]} · ${d.store}`,
      mine ? btn('Edit contact details', contact) : null,
      m ? btn('Edit details', () => employeeDialog(e), 'ghost') : null,
      d.canMove ? btn('Move shop', () => dialog('Move to another shop', [field('New shop', select('move_to', state.stores.filter(s => s.id !== e.store_id).map(s => [s.id, s.name]))),
        h('p', { class: 'muted small' }, 'Their future shifts at the current shop become open shifts.'), h('br')],
        { submit: 'Move', onSubmit: async f => { await api('PATCH', '/api/employees/' + e.id, { move_to: Number(f.move_to) }); location.hash = '#team'; } }), 'ghost') : null,
      m ? btn('Remove', act(async () => { if (confirm(`Remove ${e.first_name} ${e.last_name}? Their login is disabled and future shifts become open.`)) { await api('PATCH', '/api/employees/' + e.id, { active: 0 }); location.hash = '#team'; } }), 'ghost') : null),
    panel('Details', null, h('div', { class: 'kvs' },
      row('Start date', D.uk(e.start_date)), row('Contract hours', e.contract_hours), row('Hourly rate', '£' + Number(e.hourly_rate).toFixed(2)), row('Contract on file', e.has_contract ? 'Yes' : 'No'),
      row('Phone', e.phone), row('Email', e.email), row('Emergency contact', e.emergency_name), row('Emergency phone', e.emergency_phone))),
    login,
    panel('Documents', m ? btn('Add document', addDoc, 'sm ghost') : String(d.documents.length), d.documents.length
      ? table(['Document', 'Expiry', ['', 'r']], d.documents.map(x => [x.doc_type, [h('span', { class: 'num' }, D.uk(x.expiry_date)), ' ', x.expiry_date < d.today ? tag('red', 'Expired') : D.between(d.today, x.expiry_date) <= 56 ? tag('amber', 'Due soon') : tag('green', 'In date')],
          m ? btn('Remove', act(() => { if (confirm('Remove this document record?')) return api('DELETE', '/api/documents/' + x.id, {}); }), 'sm ghost') : '']))
      : empty('No documents on record.')),
    panel(`Leave · ${b.left} of ${b.allowance} holiday days left`, m ? btn('Log leave or absence', () => leaveDialog(e.id, true), 'sm ghost') : null, d.leave.length
      ? table(['Dates', 'Type', ['Days', 'r'], 'Status'], d.leave.slice(0, 12).map(l => [dates(l), KIND[l.kind], String(l.days), st(l.status)])) : empty('No leave on record.')),
    panel('Training', String(d.training.filter(c => c.status === 'done').length) + ' of ' + d.training.length, d.training.length
      ? table(['Course', 'Status', ['', 'r']], d.training.map(c => [c.title, trainTag(c), m ? signOff(c) : ''])) : empty('No courses set for this role.'))
  ];
}
views.profile = () => personView(state.me.employee_id, true);
views.person = id => personView(Number(id), false);

// ---------- team ----------
views.team = async () => {
  const list = await api('GET', '/api/employees?' + q());
  return [
    head('Team', `${storeName()} · ${list.length} people`, btn('Add team member', () => employeeDialog())),
    panel('People', String(list.length), list.length ? table(['Name', 'Role', ['Rate', 'r hide-s'], ['Contract', 'hide-s'], 'Login'], list.map(e => Object.assign([
      h('b', {}, e.first_name + ' ' + e.last_name), h('span', { class: 'muted' }, e.job_title || JOBS[e.job]), h('span', { class: 'num' }, '£' + Number(e.hourly_rate).toFixed(2)),
      tag(e.has_contract ? 'green' : 'red', e.has_contract ? 'On file' : 'Missing'), e.username ? tag('green', LEVELS[e.user_role]) : tag('amber', 'None')
    ], { onclick: () => { location.hash = '#person/' + e.id; } }))) : empty('No team members yet.'))
  ];
};

// ---------- leave and absence (managers) ----------
views.absence = async () => {
  const [list, team] = await Promise.all([api('GET', '/api/leave?' + q()), api('GET', '/api/employees?' + q())]);
  const pending = list.filter(l => l.status === 'pending'), rest = list.filter(l => l.status !== 'pending');
  const decide = (l, status) => btn(status === 'approved' ? 'Approve' : 'Decline', act(() => api('POST', `/api/leave/${l.id}/decide`, { status })), 'sm ' + (status === 'approved' ? '' : 'ghost'));
  const name = l => h('a', { href: '#person/' + l.employee_id }, `${l.first_name} ${l.last_name}`);
  const log = () => dialog('Who is it for?', [field('Team member', select('emp', team.map(e => [e.id, `${e.first_name} ${e.last_name}`])))],
    { submit: 'Next', onSubmit: f => { setTimeout(() => leaveDialog(Number(f.emp), true)); return 'stay'; } });
  return [
    head('Leave and absence', storeName(), btn('Log leave or absence', log)),
    panel('Waiting for a decision', String(pending.length), pending.length
      ? table(['Who', 'Dates', ['Days', 'r'], ['Note', 'hide-s'], ['', 'r']], pending.map(l => [name(l), dates(l), String(l.days), h('span', { class: 'muted' }, l.note), h('div', { class: 'row end' }, decide(l, 'approved'), decide(l, 'declined'))]))
      : empty('No requests waiting.')),
    panel('Recent and coming up', String(rest.length), rest.length
      ? table(['Who', 'Dates', 'Type', ['Days', 'r'], 'Status', ['', 'r']], rest.map(l => [name(l), dates(l), KIND[l.kind], String(l.days), st(l.status),
          btn('Remove', act(() => { if (confirm('Remove this entry?')) return api('DELETE', '/api/leave/' + l.id, {}); }), 'sm ghost')]))
      : empty('Nothing in the last 30 days or ahead.'))
  ];
};

// ---------- training records (managers) ----------
views.records = async () => {
  const rows = await api('GET', '/api/training?' + q());
  const titles = [...new Set(rows.flatMap(r => r.courses.map(c => c.title)))].sort();
  const gaps = rows.reduce((n, r) => n + r.courses.filter(c => c.status !== 'done').length, 0);
  const cell = (r, title) => { const c = r.courses.find(x => x.title === title); return !c ? h('span', { class: 'muted' }, 'n/a') : c.status === 'done' ? tag('green', 'Done') : tag('red', c.status === 'expired' ? 'Expired' : 'To do'); };
  return [
    head('Training records', `${storeName()} · ${gaps} to do`),
    panel('Who has done what', `${rows.length} people`, rows.length && titles.length
      ? table(['Name', ...titles], rows.map(r => Object.assign([h('b', {}, r.name), ...titles.map(t => cell(r, t))], { onclick: () => { location.hash = '#person/' + r.id; } })))
      : empty(titles.length ? 'No team members yet.' : 'No courses have been set up yet.')),
    h('p', { class: 'muted small' }, 'Tap a person to sign off a course on their record.')
  ];
};

// ---------- all shops (area managers and above) ----------
let search = '';
views.overview = async () => {
  const [rows, found] = await Promise.all([api('GET', '/api/overview'), search.length > 1 ? api('GET', '/api/people?q=' + encodeURIComponent(search)) : []]);
  const sum = k => rows.reduce((a, r) => a + r[k], 0);
  const areas = [...new Set(rows.map(r => r.area || 'No area'))];
  const pick = r => () => { state.store = r.id; try { localStorage.setItem('hub-shop', r.id); } catch {} location.hash = '#compliance'; };
  const flag = n => n ? tag('red', String(n)) : h('span', { class: 'muted' }, '0');
  const box = h('input', { type: 'search', class: 'auto', placeholder: 'Find a person by name', value: search, 'aria-label': 'Find a person',
    onchange: e => { search = e.target.value.trim(); render(); } });
  return [
    head('All shops', `${rows.length} shops · ${sum('headcount').toLocaleString('en-GB')} people`, box),
    search.length > 1 ? panel(`People matching "${search}"`, String(found.length), found.length
      ? table(['Name', 'Job', 'Shop'], found.map(p => Object.assign([h('b', {}, p.first_name + ' ' + p.last_name), h('span', { class: 'muted' }, p.job_title || ''), p.store], { onclick: () => { location.hash = '#person/' + p.id; } })))
      : empty('Nobody found in your shops.')) : null,
    figs(fig('Expired documents', String(sum('expiredDocs')), sum('expiredDocs') ? 'red' : ''), fig('Due in 8 weeks', String(sum('dueDocs'))),
      fig('Missing contracts', String(sum('missingContracts')), sum('missingContracts') ? 'red' : ''), fig('Leave to decide', String(sum('pendingLeave'))),
      fig('Week sales forecast', money(sum('weekSales'))), fig('Week labour %', pct(sum('weekCost'), sum('weekSales')))),
    areas.map(a => { const list = rows.filter(r => (r.area || 'No area') === a); return panel(a + (list[0].region ? ' · ' + list[0].region : ''), `${list.length} shops`,
      table(['Shop', ['Team', 'r'], ['Expired', 'r'], ['Due', 'r hide-s'], ['No contract', 'r hide-s'], ['Leave', 'r hide-s'], ['Week sales', 'r hide-s'], ['Lab %', 'r']],
        list.map(r => Object.assign([h('b', {}, r.name), String(r.headcount), flag(r.expiredDocs), String(r.dueDocs), flag(r.missingContracts), String(r.pendingLeave), money(r.weekSales), h('span', { class: 'num' }, pct(r.weekCost, r.weekSales))], { onclick: pick(r) })))); })
  ];
};

// ---------- setup (operations and admin) ----------
let tab = 'structure', userQ = '', userRole = '';
const lines = v => v.split('\n').map(x => x.trim()).filter(Boolean);
views.admin = async () => {
  const admin = state.me.role === 'admin';
  const tabs = [['structure', 'Structure'], ['logins', 'Logins'], ['staffing', 'Staffing levels'], ['courses', 'Courses'], ['lists', 'Checklists'], admin && ['audit', 'Audit log']].filter(Boolean);
  const seg = h('div', { class: 'seg wrap', role: 'group' }, tabs.map(([k, t]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; render(); } }, t)));
  const s = await api('GET', '/api/structure');
  const areaName = id => (s.areas.find(a => a.id === id) || {}).name || 'No area', regionName = id => (s.regions.find(r => r.id === id) || {}).name || 'No region';
  const areaOpts = [['', 'No area'], ...s.areas.map(a => [a.id, a.name])], regionOpts = [['', 'No region'], ...s.regions.map(r => [r.id, r.name])];
  let body;

  if (tab === 'structure') {
    body = [
      admin ? h('div', { class: 'row gap' },
        btn('Add region', () => dialog('Add region', [field('Name', input('name', '', { required: true }))], { onSubmit: f => api('POST', '/api/regions', f) }), 'ghost'),
        btn('Add area', () => dialog('Add area', [field('Name', input('name', '', { required: true })), field('Region', select('region_id', regionOpts))], { onSubmit: f => api('POST', '/api/areas', f) }), 'ghost'),
        btn('Add shop', () => dialog('Add shop', [h('div', { class: 'two' }, field('Name', input('name', '', { required: true })), field('Postcode', input('postcode'))), field('Area', select('area_id', areaOpts))], { onSubmit: async f => { await api('POST', '/api/stores', f); await boot(); return 'stay'; } }))) : null,
      panel('Areas', `${s.areas.length} areas in ${s.regions.length} regions`, s.areas.length ? table(['Area', 'Region', ['Shops', 'r'], ['', 'r']], s.areas.map(a => [h('b', {}, a.name), regionName(a.region_id), String(s.stores.filter(x => x.area_id === a.id).length),
        admin ? btn('Move', () => dialog('Region for ' + a.name, [field('Region', select('region_id', regionOpts, a.region_id || ''))], { onSubmit: f => api('PATCH', '/api/areas/' + a.id, f) }), 'sm ghost') : ''])) : empty('No areas yet. Add regions, then areas, then put shops in them.')),
      panel('Shops', String(s.stores.length), s.stores.length ? table(['Shop', 'Area', ['Team', 'r'], ['', 'r']], s.stores.map(x => [h('b', {}, x.name), areaName(x.area_id), String(x.headcount),
        admin ? btn('Move', () => dialog('Area for ' + x.name, [field('Area', select('area_id', areaOpts, x.area_id || ''))], { onSubmit: async f => { await api('PATCH', '/api/stores/' + x.id, f); await boot(); return 'stay'; } }), 'sm ghost') : ''])) : empty('No shops yet.'))
    ];
  }

  if (tab === 'logins') {
    const users = await api('GET', `/api/users?q=${encodeURIComponent(userQ)}&role=${userRole}`);
    const levels = Object.keys(LEVELS).filter(l => admin || R[l] < state.rank).map(l => [l, LEVELS[l]]);
    const place = (u = {}) => [
      field('Access level', select('role', levels, u.role || 'area')),
      field('Shop (staff, supervisors, shop managers)', select('store_id', [['', 'Not applicable'], ...s.stores.map(x => [x.id, x.name])], u.store_id || '')),
      field('Area (area managers)', select('area_id', areaOpts, u.area_id || '')),
      field('Region (regional managers)', select('region_id', regionOpts, u.region_id || ''))];
    body = [
      h('div', { class: 'row gap' },
        h('input', { type: 'search', class: 'auto', placeholder: 'Search name or username', value: userQ, 'aria-label': 'Search logins', onchange: e => { userQ = e.target.value.trim(); render(); } }),
        h('select', { class: 'auto', 'aria-label': 'Level', onchange: e => { userRole = e.target.value; render(); } }, Hub.options([['', 'Every level'], ...Object.entries(LEVELS)], userRole)),
        btn('New login', () => dialog('New login', [
          h('p', { class: 'muted small' }, 'For area, regional, operations and admin logins. Shop staff get theirs from their record on the Team page.'), h('br'),
          h('div', { class: 'two' }, field('Full name', input('name', '', { required: true })), field('Username', input('username', '', { required: true, autocapitalize: 'none' }))), place()
        ], { submit: 'Create', onSubmit: async f => { const r = await api('POST', '/api/users', f); render(); showTemp(r); return 'stay'; } }))),
      panel('Logins', users.length === 100 ? 'First 100, search to narrow' : String(users.length), users.length ? table(['Name', ['Username', 'hide-s'], 'Level', ['Covers', 'hide-s'], ['', 'r']], users.map(u => [
        h('b', {}, u.name), h('span', { class: 'num' }, u.username), u.active ? LEVELS[u.role] : tag('red', 'Disabled'), u.place,
        u.id === state.me.id ? h('span', { class: 'muted small' }, 'You') : h('div', { class: 'row end' },
          btn('Edit', () => dialog(u.name, place(u), { onSubmit: f => api('PATCH', '/api/users/' + u.id, f),
            extra: () => btn(u.active ? 'Disable' : 'Enable', act(async () => { await api('PATCH', '/api/users/' + u.id, { active: !u.active }); document.querySelector('dialog')?.close(); }), 'danger') }), 'sm ghost'),
          btn('Reset', act(async () => { if (confirm('Give ' + u.name + ' a new temporary password?')) showTemp(await api('POST', `/api/users/${u.id}/reset`, {})); }), 'sm ghost'))])) : empty('No logins match.'))
    ];
  }

  if (tab === 'staffing') {
    const bands = await api('GET', '/api/staffing');
    const text = bands.map(b => `${b.sales_from}, ${b.insiders}, ${b.drivers}`).join('\n');
    body = [
      panel('Optimal staffing levels', btn('Edit levels', () => dialog('Staffing levels', [
        h('p', { class: 'muted small' }, 'One level per line: hourly sales from £, insiders, drivers. Insiders include the manager on shift.'), h('br'),
        field('Levels', h('textarea', { name: 'bands', rows: 10, class: 'num' }, text))
      ], { onSubmit: f => api('PUT', '/api/staffing', { bands: lines(f.bands).map(l => { const [a, b, c] = l.split(',').map(Number); return { sales_from: a, insiders: b, drivers: c }; }) }) }), 'sm'),
        table([['Hourly sales from', 'r'], ['Insiders', 'r'], ['Drivers', 'r'], ['Total', 'r']], bands.map(b => [money(b.sales_from), String(b.insiders), String(b.drivers), String(b.insiders + b.drivers)]))),
      h('p', { class: 'muted small' }, 'Build shifts on the rota looks up each hour of the sales forecast in this table and creates open shifts to match. Shifts run at least 3 hours and are split above 9. These levels apply to every shop.')
    ];
  }

  if (tab === 'courses') {
    const courses = await api('GET', '/api/courses');
    const form = (c = {}) => [
      field('Title', input('title', c.title, { required: true })),
      field('What it covers', h('textarea', { name: 'description', rows: 3 }, c.description || '')),
      field('Link to material (https://)', input('link', c.link)),
      field('Valid for how many months (blank means it never expires)', h('input', { type: 'number', name: 'valid_months', min: 1, value: c.valid_months ?? '' })),
      h('p', { class: 'small' }, h('b', {}, 'Who needs it (tick none for everyone)')),
      Object.entries(JOBS).map(([k, t]) => check('job_' + k, t, c.jobs && c.jobs.split(',').includes(k)))];
    const read = f => ({ ...f, jobs: Object.keys(JOBS).filter(k => f['job_' + k] === 'on') });
    body = [
      h('div', { class: 'row gap' }, btn('Add course', () => dialog('Add course', form(), { onSubmit: f => api('POST', '/api/courses', read(f)) }))),
      panel('Courses', String(courses.length), courses.length ? table(['Course', 'For', ['Valid', 'hide-s'], ['', 'r']], courses.map(c => [h('b', {}, c.title), c.jobs === 'all' ? 'Everyone' : c.jobs.split(',').map(j => JOBS[j]).join(', '), c.valid_months ? c.valid_months + ' months' : 'No expiry',
        btn('Edit', () => dialog('Edit course', form(c), { onSubmit: f => api('PATCH', '/api/courses/' + c.id, read(f)), extra: close => btn('Retire', async () => { await api('PATCH', '/api/courses/' + c.id, { active: 0 }); close(); render(); }, 'danger') }), 'sm ghost')])) : empty('No courses yet.'))
    ];
  }

  if (tab === 'lists') {
    const lists = await api('GET', '/api/checklists/templates');
    const form = (l = {}) => [field('Name', input('name', l.name, { required: true })), field('Items, one per line', h('textarea', { name: 'items', rows: 9 }, (l.items || []).join('\n')))];
    body = [
      h('div', { class: 'row gap' }, btn('Add checklist', () => dialog('Add checklist', form(), { onSubmit: f => api('POST', '/api/checklists', { name: f.name, items: lines(f.items) }) }))),
      panel('Checklists', String(lists.length), lists.length ? table(['Checklist', ['Items', 'r'], ['', 'r']], lists.map(l => [h('b', {}, l.name), String(l.items.length),
        btn('Edit', () => dialog('Edit checklist', form(l), { onSubmit: f => api('PATCH', '/api/checklists/' + l.id, { name: f.name, items: lines(f.items) }),
          extra: close => btn('Retire', async () => { await api('PATCH', '/api/checklists/' + l.id, { active: 0 }); close(); render(); }, 'danger') }), 'sm ghost')])) : empty('No checklists yet.')),
      h('p', { class: 'muted small' }, 'Every shop gets every checklist, once a day. Supervisors and above tick them off.')
    ];
  }

  if (tab === 'audit') {
    const log = await api('GET', '/api/audit');
    body = [panel('Last 300 changes', null, table(['When', 'Who', 'What', ['Detail', 'hide-s']], log.map(a => [h('span', { class: 'num small' }, new Date(a.at).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' })), a.user, a.action, h('span', { class: 'muted' }, a.detail)])))];
  }
  return [head('Setup', 'Structure, logins and company-wide settings', seg), body];
};

Hub.boot();
})();
