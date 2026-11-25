const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Tiny .env loader so there is no extra dependency.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const db = require('./db');

const PORT = Number(process.env.PORT || 3400);
const ORG_NAME = process.env.ORG_NAME || 'Full House Restaurants';
const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 24) {
  console.error('SESSION_SECRET is missing or too short. Set it in .env (openssl rand -hex 32).');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': req.path.startsWith('/api') ? 'no-store' : 'no-cache'
  });
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(cookieSession({
  name: 'hub', secret: SECRET, httpOnly: true, sameSite: 'lax',
  secure: process.env.SECURE_COOKIES === '1', maxAge: 12 * 60 * 60 * 1000
}));

// Every state-changing call must be a same-origin JSON request.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
  next();
});

const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const addMonths = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCMonth(t.getUTCMonth() + n); return t.toISOString().slice(0, 10); };
const monday = d => addDays(d, -((new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7));
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg, code = 400) => { res.status(code).json({ error: msg }); return null; };
const marks = list => list.map(() => '?').join(',') || 'NULL';

// ---- access levels ----
// staff: own record.            supervisor: runs the shift.     manager: one shop.
// area: a cluster of shops.     regional: a group of areas.     operations: the whole business.
// admin: operations plus logins, structure and the audit log.
const RANK = { staff: 0, supervisor: 1, manager: 2, area: 3, regional: 4, operations: 5, admin: 6 };
const ROLES = Object.keys(RANK);
const rank = u => RANK[u.role];
const need = role => (req, res, next) => rank(req.user) >= RANK[role] ? next() : bad(res, 'You do not have access to that.', 403);
function audit(req, action, detail = '') {
  db.prepare('INSERT INTO audit (at, user, action, detail) VALUES (?,?,?,?)').run(new Date().toISOString(), req.user ? req.user.username : '-', action, String(detail).slice(0, 300));
}

// ---- auth ----
const attempts = new Map();
function throttled(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(key, a);
  return a.length >= 8;
}
const DUMMY = '$2a$12$0000000000000000000000000000000000000000000000000000';

app.post('/api/login', async (req, res, next) => {
  try {
    const username = text(req.body.username, 60);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const key = req.ip + '|' + username.toLowerCase();
    if (throttled(key)) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    const ok = await bcrypt.compare(password, u ? u.pass_hash : DUMMY);
    if (!u || !ok) { attempts.get(key).push(Date.now()); return bad(res, 'Username or password is wrong.', 401); }
    attempts.delete(key);
    req.session.uid = u.id;
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
app.get('/api/config', (req, res) => res.json({ org: ORG_NAME }));

// Which shops a login can reach is worked out from the structure on every request.
function scopeFor(u) {
  if (rank(u) >= RANK.operations) return db.prepare('SELECT id FROM stores').all().map(s => s.id);
  if (u.role === 'regional') return db.prepare('SELECT s.id FROM stores s JOIN areas a ON a.id = s.area_id WHERE a.region_id = ?').all(u.region_id).map(s => s.id);
  if (u.role === 'area') return db.prepare('SELECT id FROM stores WHERE area_id = ?').all(u.area_id).map(s => s.id);
  return u.store_id ? [u.store_id] : [];
}
app.use('/api', (req, res, next) => {
  const u = req.session.uid && db.prepare('SELECT id, username, name, role, store_id, area_id, region_id, employee_id, must_change FROM users WHERE id = ? AND active = 1').get(req.session.uid);
  if (!u) return bad(res, 'Sign in first.', 401);
  req.user = u;
  req.stores = scopeFor(u);
  const rows = db.prepare(`SELECT DISTINCT s.area_id, a.region_id FROM stores s LEFT JOIN areas a ON a.id = s.area_id WHERE s.id IN (${marks(req.stores)})`).all(...req.stores);
  req.areas = [...new Set(rows.map(r => r.area_id).filter(Boolean))];
  req.regions = [...new Set(rows.map(r => r.region_id).filter(Boolean))];
  // A temporary password only lets you set a new one.
  if (u.must_change && !['/me', '/password'].includes(req.path)) return bad(res, 'Set a new password first.', 403);
  next();
});

function storeId(req, res) {
  const id = Number(req.query.store || req.body.store_id || req.user.store_id || req.stores[0]);
  if (!req.stores.includes(id)) return bad(res, 'That shop is not in your access.', 403);
  return id;
}
function ownsEmployee(req, res, empId) {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
  if (!e) return bad(res, 'Not found.', 404);
  if (!req.stores.includes(e.store_id)) return bad(res, 'That person is not in your access.', 403);
  return e;
}

app.get('/api/me', (req, res) => {
  const stores = db.prepare(`SELECT s.id, s.name, s.postcode, s.area_id, a.name AS area, r.name AS region FROM stores s
    LEFT JOIN areas a ON a.id = s.area_id LEFT JOIN regions r ON r.id = a.region_id
    WHERE s.id IN (${marks(req.stores)}) ORDER BY r.name, a.name, s.name`).all(...req.stores);
  res.json({ user: req.user, stores, org: ORG_NAME, today: today(), roles: ROLES, rank: rank(req.user) });
});

app.post('/api/password', (req, res) => {
  const cur = String(req.body.current || ''), next = String(req.body.next || '');
  if (next.length < 10) return bad(res, 'New password needs at least 10 characters.');
  const u = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(cur, u.pass_hash)) return bad(res, 'Current password is wrong.');
  if (cur === next) return bad(res, 'Choose a different password.');
  db.prepare('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?').run(bcrypt.hashSync(next, 12), req.user.id);
  audit(req, 'password changed');
  res.json({ ok: true });
});

// ---- notices: who can see what ----
function noticeWhere(req) {
  return {
    sql: `(n.scope_type = 'all' OR (n.scope_type = 'store' AND n.scope_id IN (${marks(req.stores)}))
      OR (n.scope_type = 'area' AND n.scope_id IN (${marks(req.areas)})) OR (n.scope_type = 'region' AND n.scope_id IN (${marks(req.regions)})))`,
    args: [...req.stores, ...req.areas, ...req.regions]
  };
}

// ---- home summary ----
function storeFigures(ids) {
  const t = today(), horizon = addDays(t, 56), m = marks(ids), out = new Map(ids.map(id => [id, { headcount: 0, pendingLeave: 0, expiredDocs: 0, dueDocs: 0, missingContracts: 0 }]));
  const fill = (key, sql, ...args) => db.prepare(sql).all(...args, ...ids).forEach(r => { out.get(r.store_id)[key] = r.c; });
  fill('headcount', `SELECT store_id, COUNT(*) c FROM employees WHERE active = 1 AND store_id IN (${m}) GROUP BY store_id`);
  fill('missingContracts', `SELECT store_id, COUNT(*) c FROM employees WHERE active = 1 AND has_contract = 0 AND store_id IN (${m}) GROUP BY store_id`);
  fill('pendingLeave', `SELECT e.store_id, COUNT(*) c FROM leave l JOIN employees e ON e.id = l.employee_id WHERE l.status = 'pending' AND e.store_id IN (${m}) GROUP BY e.store_id`);
  fill('expiredDocs', `SELECT e.store_id, COUNT(*) c FROM documents d JOIN employees e ON e.id = d.employee_id WHERE e.active = 1 AND d.expiry_date < ? AND e.store_id IN (${m}) GROUP BY e.store_id`, t);
  fill('dueDocs', `SELECT e.store_id, COUNT(*) c FROM documents d JOIN employees e ON e.id = d.employee_id WHERE e.active = 1 AND d.expiry_date BETWEEN ? AND ? AND e.store_id IN (${m}) GROUP BY e.store_id`, t, horizon);
  return out;
}

app.get('/api/summary', (req, res) => {
  const t = today(), emp = req.user.employee_id, out = { today: t }, w = noticeWhere(req);
  out.unread = db.prepare(`SELECT COUNT(*) c FROM notices n WHERE ${w.sql} AND NOT EXISTS (SELECT 1 FROM notice_acks a WHERE a.notice_id = n.id AND a.user_id = ?)`).get(...w.args, req.user.id).c;
  if (emp) {
    out.shifts = db.prepare('SELECT date, start_min, end_min, closing FROM shifts WHERE employee_id = ? AND date >= ? ORDER BY date, start_min LIMIT 5').all(emp, t);
    out.balance = holidayBalance(emp);
    out.trainingDue = trainingFor(db.prepare('SELECT * FROM employees WHERE id = ?').get(emp)).filter(c => c.status !== 'done').length;
    out.myPending = db.prepare("SELECT COUNT(*) c FROM leave WHERE employee_id = ? AND status = 'pending'").get(emp).c;
  }
  if (rank(req.user) >= RANK.manager && req.stores.length) {
    const store = storeId(req, res); if (!store) return;
    out.manage = storeFigures([store]).get(store);
    out.manage.offToday = db.prepare("SELECT e.first_name, e.last_name, l.kind FROM leave l JOIN employees e ON e.id = l.employee_id WHERE e.store_id = ? AND l.status = 'approved' AND ? BETWEEN l.start_date AND l.end_date").all(store, t);
  }
  res.json(out);
});

// One line per shop for area managers and above.
app.get('/api/overview', need('area'), (req, res) => {
  const figs = storeFigures(req.stores), mon = monday(today()), sun = addDays(mon, 6), m = marks(req.stores);
  const sales = new Map(db.prepare(`SELECT store_id, SUM(sales) v FROM forecasts WHERE date BETWEEN ? AND ? AND store_id IN (${m}) GROUP BY store_id`).all(mon, sun, ...req.stores).map(r => [r.store_id, r.v]));
  const cost = new Map(db.prepare(`SELECT sh.store_id, SUM((sh.end_min - sh.start_min) / 60.0 * e.hourly_rate) v FROM shifts sh JOIN employees e ON e.id = sh.employee_id
    WHERE sh.date BETWEEN ? AND ? AND sh.store_id IN (${m}) GROUP BY sh.store_id`).all(mon, sun, ...req.stores).map(r => [r.store_id, r.v]));
  res.json(db.prepare(`SELECT s.id, s.name, a.name AS area, r.name AS region FROM stores s LEFT JOIN areas a ON a.id = s.area_id LEFT JOIN regions r ON r.id = a.region_id
    WHERE s.id IN (${m}) ORDER BY r.name, a.name, s.name`).all(...req.stores).map(s => ({ ...s, ...figs.get(s.id), weekSales: sales.get(s.id) || 0, weekCost: cost.get(s.id) || 0 })));
});

// ---- compliance ----
app.get('/api/home', need('manager'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const horizon = addDays(today(), 56);
  const docs = db.prepare(`
    SELECT d.id, d.category, d.doc_type, d.expiry_date, e.id AS employee_id, e.first_name, e.last_name, e.job_title
    FROM documents d JOIN employees e ON e.id = d.employee_id
    WHERE e.store_id = ? AND e.active = 1 AND d.expiry_date <= ? ORDER BY d.expiry_date`).all(store, horizon);
  const items = db.prepare('SELECT * FROM company_items WHERE store_id = ? ORDER BY expiry_date').all(store);
  const missing = db.prepare('SELECT id, first_name, last_name, job_title, start_date FROM employees WHERE store_id = ? AND active = 1 AND has_contract = 0 ORDER BY last_name').all(store);
  const due = k => items.filter(i => i.kind === k && i.expiry_date <= horizon);
  res.json({
    today: today(), rtw: docs.filter(d => d.category === 'rtw'), job: docs.filter(d => d.category === 'job'),
    additional: docs.filter(d => d.category === 'additional'), missing,
    registers: due('register'), policies: due('policy'), certificates: due('certificate'), allItems: items
  });
});

app.post('/api/documents', need('manager'), (req, res) => {
  const e = ownsEmployee(req, res, Number(req.body.employee_id)); if (!e) return;
  const { category, expiry_date } = req.body, doc_type = text(req.body.doc_type, 80);
  if (!['rtw', 'job', 'additional'].includes(category) || !doc_type || !isDate(expiry_date)) return bad(res, 'Check the document details.');
  const r = db.prepare('INSERT INTO documents (employee_id, category, doc_type, expiry_date) VALUES (?,?,?,?)').run(e.id, category, doc_type, expiry_date);
  audit(req, 'document added', `${e.first_name} ${e.last_name}: ${doc_type}`);
  res.json({ id: r.lastInsertRowid });
});
function ownsDoc(req, res) {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return bad(res, 'Not found.', 404);
  return ownsEmployee(req, res, d.employee_id) ? d : null;
}
app.patch('/api/documents/:id', need('manager'), (req, res) => {
  const d = ownsDoc(req, res); if (!d) return;
  if (!isDate(req.body.expiry_date)) return bad(res, 'Pick a valid date.');
  db.prepare('UPDATE documents SET expiry_date = ? WHERE id = ?').run(req.body.expiry_date, d.id);
  audit(req, 'document expiry updated', `${d.doc_type} to ${req.body.expiry_date}`);
  res.json({ ok: true });
});
app.delete('/api/documents/:id', need('manager'), (req, res) => {
  const d = ownsDoc(req, res); if (!d) return;
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  audit(req, 'document removed', d.doc_type);
  res.json({ ok: true });
});

app.post('/api/company-items', need('manager'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const name = text(req.body.name, 100), { kind, expiry_date } = req.body;
  if (!['register', 'policy', 'certificate'].includes(kind) || !name || !isDate(expiry_date)) return bad(res, 'Check the details.');
  const r = db.prepare('INSERT INTO company_items (store_id, kind, name, done_date, expiry_date) VALUES (?,?,?,?,?)').run(store, kind, name, isDate(req.body.done_date) ? req.body.done_date : today(), expiry_date);
  audit(req, 'compliance item added', name);
  res.json({ id: r.lastInsertRowid });
});
app.patch('/api/company-items/:id', need('manager'), (req, res) => {
  const i = db.prepare('SELECT * FROM company_items WHERE id = ?').get(req.params.id);
  if (!i) return bad(res, 'Not found.', 404);
  if (!req.stores.includes(i.store_id)) return bad(res, 'That shop is not in your access.', 403);
  if (req.body.remove) db.prepare('DELETE FROM company_items WHERE id = ?').run(i.id);
  else {
    if (!isDate(req.body.expiry_date)) return bad(res, 'Pick a valid date.');
    db.prepare('UPDATE company_items SET done_date = ?, expiry_date = ? WHERE id = ?').run(isDate(req.body.done_date) ? req.body.done_date : today(), req.body.expiry_date, i.id);
  }
  audit(req, req.body.remove ? 'compliance item removed' : 'compliance item renewed', i.name);
  res.json({ ok: true });
});

// ---- notices and policies ----
app.get('/api/notices', (req, res) => {
  const w = noticeWhere(req);
  res.json(db.prepare(`
    SELECT n.*, a.acked_at,
      CASE n.scope_type WHEN 'store' THEN (SELECT name FROM stores WHERE id = n.scope_id) WHEN 'area' THEN (SELECT name FROM areas WHERE id = n.scope_id)
        WHEN 'region' THEN (SELECT name FROM regions WHERE id = n.scope_id) ELSE 'Whole business' END AS audience
    FROM notices n LEFT JOIN notice_acks a ON a.notice_id = n.id AND a.user_id = ?
    WHERE ${w.sql} ORDER BY n.issued DESC, n.id DESC LIMIT 200`).all(req.user.id, ...w.args));
});
app.post('/api/notices', need('manager'), (req, res) => {
  const title = text(req.body.title, 120), body = text(req.body.body, 6000);
  const type = req.body.type === 'Policy' ? 'Policy' : 'Notice', scope = ['store', 'area', 'region', 'all'].includes(req.body.scope) ? req.body.scope : 'store';
  if (!title) return bad(res, 'Give it a title.');
  const needRole = { store: 'manager', area: 'area', region: 'regional', all: 'operations' }[scope];
  if (rank(req.user) < RANK[needRole]) return bad(res, 'You cannot publish that widely.', 403);
  let scopeId = null;
  if (scope !== 'all') {
    const store = storeId(req, res); if (!store) return;
    const s = db.prepare('SELECT s.id, s.area_id, a.region_id FROM stores s LEFT JOIN areas a ON a.id = s.area_id WHERE s.id = ?').get(store);
    scopeId = scope === 'store' ? s.id : scope === 'area' ? s.area_id : s.region_id;
    if (!scopeId) return bad(res, `That shop is not in ${scope === 'area' ? 'an area' : 'a region'} yet.`);
  }
  const r = db.prepare('INSERT INTO notices (title, type, body, created_by, issued, scope_type, scope_id) VALUES (?,?,?,?,?,?,?)').run(title, type, body, req.user.name, today(), scope, scopeId);
  audit(req, type.toLowerCase() + ' published', `${title} (${scope})`);
  res.json({ id: r.lastInsertRowid });
});
function noticeInScope(req, res) {
  const w = noticeWhere(req);
  return db.prepare(`SELECT n.* FROM notices n WHERE n.id = ? AND ${w.sql}`).get(req.params.id, ...w.args) || bad(res, 'Not found.', 404);
}
const noticeRank = n => RANK[{ store: 'manager', area: 'area', region: 'regional', all: 'operations' }[n.scope_type]];
app.post('/api/notices/:id/ack', (req, res) => {
  const n = noticeInScope(req, res); if (!n) return;
  db.prepare('INSERT OR IGNORE INTO notice_acks (notice_id, user_id, acked_at) VALUES (?,?,?)').run(n.id, req.user.id, new Date().toISOString());
  res.json({ ok: true });
});
// Who has read it, limited to one shop at a time so the list stays usable.
app.get('/api/notices/:id/acks', need('manager'), (req, res) => {
  const n = noticeInScope(req, res); if (!n) return;
  const store = storeId(req, res); if (!store) return;
  res.json(db.prepare(`SELECT u.name, u.role, a.acked_at FROM users u LEFT JOIN notice_acks a ON a.user_id = u.id AND a.notice_id = ?
    WHERE u.active = 1 AND u.store_id = ? ORDER BY a.acked_at IS NOT NULL, u.name`).all(n.id, store));
});
app.delete('/api/notices/:id', need('manager'), (req, res) => {
  const n = noticeInScope(req, res); if (!n) return;
  if (rank(req.user) < noticeRank(n)) return bad(res, 'That notice was published above your level.', 403);
  db.prepare('DELETE FROM notices WHERE id = ?').run(n.id);
  audit(req, 'notice removed', n.title);
  res.json({ ok: true });
});

// ---- team and employee records ----
app.get('/api/employees', need('manager'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  res.json(db.prepare(`SELECT e.*, u.username, u.role AS user_role FROM employees e
    LEFT JOIN users u ON u.employee_id = e.id AND u.active = 1
    WHERE e.store_id = ? AND e.active = 1 ORDER BY e.job, e.first_name`).all(store));
});
// Name search across every shop you can reach.
app.get('/api/people', need('area'), (req, res) => {
  const q = text(req.query.q, 40).replace(/[%_]/g, '');
  if (q.length < 2) return res.json([]);
  res.json(db.prepare(`SELECT e.id, e.first_name, e.last_name, e.job_title, s.name AS store FROM employees e JOIN stores s ON s.id = e.store_id
    WHERE e.active = 1 AND e.store_id IN (${marks(req.stores)}) AND (e.first_name || ' ' || e.last_name) LIKE ? ORDER BY e.last_name LIMIT 30`).all(...req.stores, `%${q}%`));
});

const contactFields = b => ({ phone: text(b.phone, 30), email: text(b.email, 120), emergency_name: text(b.emergency_name, 80), emergency_phone: text(b.emergency_phone, 30) });
function employeeFields(b) {
  const f = {
    first_name: text(b.first_name, 60), last_name: text(b.last_name, 60), job: b.job,
    job_title: text(b.job_title, 60), hourly_rate: Number(b.hourly_rate) || 0,
    start_date: isDate(b.start_date) ? b.start_date : null, has_contract: b.has_contract ? 1 : 0,
    contract_hours: b.contract_hours === '' || b.contract_hours == null ? null : Number(b.contract_hours),
    holiday_days: b.holiday_days === '' || b.holiday_days == null ? 28 : Number(b.holiday_days),
    ...contactFields(b)
  };
  if (!f.first_name || !f.last_name || !['manager', 'instore', 'driver'].includes(f.job) || !(f.hourly_rate >= 0) || f.hourly_rate > 200 || !(f.holiday_days >= 0)) return null;
  return f;
}

app.post('/api/employees', need('manager'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const f = employeeFields(req.body); if (!f) return bad(res, 'Check the team member details.');
  const r = db.prepare(`INSERT INTO employees (store_id, first_name, last_name, job, job_title, hourly_rate, start_date, has_contract, contract_hours, holiday_days, phone, email, emergency_name, emergency_phone)
    VALUES (@store, @first_name, @last_name, @job, @job_title, @hourly_rate, @start_date, @has_contract, @contract_hours, @holiday_days, @phone, @email, @emergency_name, @emergency_phone)`).run({ store, ...f });
  audit(req, 'team member added', `${f.first_name} ${f.last_name}`);
  res.json({ id: r.lastInsertRowid });
});

app.patch('/api/employees/:id', need('manager'), (req, res) => {
  const e = ownsEmployee(req, res, Number(req.params.id)); if (!e) return;
  if (e.id === req.user.employee_id) return bad(res, 'Someone above you has to change your own record.', 403);
  if (req.body.active === 0) {
    db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(e.id);
    db.prepare('UPDATE users SET active = 0 WHERE employee_id = ?').run(e.id);
    db.prepare('UPDATE shifts SET employee_id = NULL WHERE employee_id = ? AND date >= ?').run(e.id, today());
    audit(req, 'team member removed', `${e.first_name} ${e.last_name}`);
    return res.json({ ok: true });
  }
  if (req.body.move_to) {                                   // transfer to another shop, area managers and above
    const to = Number(req.body.move_to);
    if (rank(req.user) < RANK.area || !req.stores.includes(to)) return bad(res, 'You cannot move people to that shop.', 403);
    db.prepare('UPDATE employees SET store_id = ? WHERE id = ?').run(to, e.id);
    db.prepare('UPDATE users SET store_id = ? WHERE employee_id = ?').run(to, e.id);
    db.prepare('UPDATE shifts SET employee_id = NULL WHERE employee_id = ? AND date >= ?').run(e.id, today());
    audit(req, 'team member transferred', `${e.first_name} ${e.last_name} to shop ${to}`);
    return res.json({ ok: true });
  }
  const f = employeeFields(req.body); if (!f) return bad(res, 'Check the team member details.');
  db.prepare(`UPDATE employees SET first_name=@first_name, last_name=@last_name, job=@job, job_title=@job_title, hourly_rate=@hourly_rate,
    start_date=@start_date, has_contract=@has_contract, contract_hours=@contract_hours, holiday_days=@holiday_days,
    phone=@phone, email=@email, emergency_name=@emergency_name, emergency_phone=@emergency_phone WHERE id=@id`).run({ id: e.id, ...f });
  db.prepare('UPDATE users SET name = ? WHERE employee_id = ?').run(`${f.first_name} ${f.last_name}`, e.id);
  audit(req, 'team member updated', `${f.first_name} ${f.last_name}`);
  res.json({ ok: true });
});

function holidayBalance(empId) {
  const e = db.prepare('SELECT holiday_days FROM employees WHERE id = ?').get(empId);
  const y = today().slice(0, 4);
  const sum = s => db.prepare("SELECT COALESCE(SUM(days),0) v FROM leave WHERE employee_id = ? AND kind = 'holiday' AND status = ? AND start_date BETWEEN ? AND ?").get(empId, s, y + '-01-01', y + '-12-31').v;
  const taken = sum('approved'), pending = sum('pending');
  return { year: y, allowance: e.holiday_days, taken, pending, left: e.holiday_days - taken };
}
function trainingFor(e) {
  const t = today();
  const done = new Map();
  db.prepare('SELECT * FROM completions WHERE employee_id = ? ORDER BY completed_date').all(e.id).forEach(c => done.set(c.course_id, c));
  return db.prepare('SELECT * FROM courses WHERE active = 1 ORDER BY title').all()
    .filter(c => c.jobs === 'all' || c.jobs.split(',').includes(e.job))
    .map(c => {
      const d = done.get(c.id);
      const status = !d ? 'missing' : d.expires_date && d.expires_date < t ? 'expired' : 'done';
      return { course_id: c.id, title: c.title, description: c.description, link: c.link, valid_months: c.valid_months, status, completed_date: d && d.completed_date, expires_date: d && d.expires_date, signed_by: d && d.signed_by };
    });
}

// Full record: managers for their people, anyone for themselves.
app.get('/api/employees/:id', (req, res) => {
  const id = Number(req.params.id), self = req.user.employee_id === id, mgr = rank(req.user) >= RANK.manager;
  if (!self && !mgr) return bad(res, 'You do not have access to that.', 403);
  const e = self ? db.prepare('SELECT * FROM employees WHERE id = ?').get(id) : ownsEmployee(req, res, id);
  if (!e) return res.headersSent ? null : bad(res, 'Not found.', 404);
  const canManage = mgr && !self && req.stores.includes(e.store_id);
  res.json({
    employee: e, self, canManage, canMove: canManage && rank(req.user) >= RANK.area,
    store: db.prepare('SELECT name FROM stores WHERE id = ?').get(e.store_id).name,
    documents: db.prepare('SELECT * FROM documents WHERE employee_id = ? ORDER BY expiry_date').all(id),
    leave: db.prepare('SELECT * FROM leave WHERE employee_id = ? ORDER BY start_date DESC LIMIT 40').all(id),
    balance: holidayBalance(id), training: trainingFor(e),
    account: canManage ? db.prepare('SELECT id, username, role, active, must_change FROM users WHERE employee_id = ?').get(id) || null : undefined,
    today: today()
  });
});

// People keep their own contact details up to date.
app.patch('/api/profile', (req, res) => {
  if (!req.user.employee_id) return bad(res, 'Your login is not linked to a team record.');
  db.prepare('UPDATE employees SET phone=@phone, email=@email, emergency_name=@emergency_name, emergency_phone=@emergency_phone WHERE id=@id').run({ id: req.user.employee_id, ...contactFields(req.body) });
  res.json({ ok: true });
});

// ---- logins ----
const tempPassword = () => crypto.randomBytes(9).toString('base64url');
// You can hand out any level below your own; admins can also create admins.
const canGrant = (req, role) => ROLES.includes(role) && (req.user.role === 'admin' || RANK[role] < rank(req.user));
const validUsername = u => /^[a-z0-9._-]{3,40}$/.test(u);

app.post('/api/employees/:id/account', need('manager'), (req, res) => {
  const e = ownsEmployee(req, res, Number(req.params.id)); if (!e) return;
  const username = text(req.body.username, 40).toLowerCase(), role = req.body.role || 'staff';
  if (!validUsername(username)) return bad(res, 'Username: 3 to 40 letters, numbers, dots or dashes.');
  if (!canGrant(req, role) || RANK[role] > RANK.manager) return bad(res, 'You cannot give out that access level here.', 403);
  if (db.prepare('SELECT 1 FROM users WHERE employee_id = ?').get(e.id)) return bad(res, 'This person already has a login.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return bad(res, 'That username is taken.');
  const pw = tempPassword();
  db.prepare('INSERT INTO users (username, pass_hash, name, role, store_id, employee_id, must_change) VALUES (?,?,?,?,?,?,1)').run(username, bcrypt.hashSync(pw, 12), `${e.first_name} ${e.last_name}`, role, e.store_id, e.id);
  audit(req, 'login created', `${username} as ${role}`);
  res.json({ username, temp_password: pw });
});

function targetUser(req, res) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return bad(res, 'Not found.', 404);
  if (u.id === req.user.id) return bad(res, 'You cannot change your own access.');
  const inScope = req.user.role === 'admin' || (u.store_id ? req.stores.includes(u.store_id) : u.area_id ? req.areas.includes(u.area_id) : u.region_id ? req.regions.includes(u.region_id) : false);
  if (!inScope || (req.user.role !== 'admin' && RANK[u.role] >= rank(req.user))) return bad(res, 'That login is outside your access.', 403);
  return u;
}
app.post('/api/users/:id/reset', need('manager'), (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const pw = tempPassword();
  db.prepare('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?').run(bcrypt.hashSync(pw, 12), u.id);
  audit(req, 'password reset', u.username);
  res.json({ username: u.username, temp_password: pw });
});
// Where a login sits in the structure has to match its level.
function placement(role, b) {
  const p = { store_id: null, area_id: null, region_id: null };
  if (RANK[role] <= RANK.manager) { p.store_id = Number(b.store_id); if (!db.prepare('SELECT 1 FROM stores WHERE id = ?').get(p.store_id)) return null; }
  else if (role === 'area') { p.area_id = Number(b.area_id); if (!db.prepare('SELECT 1 FROM areas WHERE id = ?').get(p.area_id)) return null; }
  else if (role === 'regional') { p.region_id = Number(b.region_id); if (!db.prepare('SELECT 1 FROM regions WHERE id = ?').get(p.region_id)) return null; }
  return p;
}
app.patch('/api/users/:id', need('manager'), (req, res) => {
  const u = targetUser(req, res); if (!u) return;
  const role = req.body.role || u.role, active = req.body.active === undefined ? u.active : (req.body.active ? 1 : 0);
  if (role !== u.role && !canGrant(req, role)) return bad(res, 'You cannot give out that access level.', 403);
  let p = { store_id: u.store_id, area_id: u.area_id, region_id: u.region_id };
  if (rank(req.user) >= RANK.operations) {
    p = placement(role, { store_id: req.body.store_id || u.store_id, area_id: req.body.area_id || u.area_id, region_id: req.body.region_id || u.region_id });
    if (!p) return bad(res, 'Pick where this login sits: a shop, an area or a region to match the level.');
  } else if (RANK[role] > RANK.manager) return bad(res, 'Operations or an admin sets up area and regional logins.', 403);
  db.prepare('UPDATE users SET role = ?, active = ?, store_id = ?, area_id = ?, region_id = ? WHERE id = ?').run(role, active, p.store_id, p.area_id, p.region_id, u.id);
  audit(req, 'login updated', `${u.username}: ${role}, ${active ? 'active' : 'disabled'}`);
  res.json({ ok: true });
});
app.get('/api/users', need('operations'), (req, res) => {
  const q = text(req.query.q, 40).replace(/[%_]/g, '');
  res.json(db.prepare(`SELECT u.id, u.username, u.name, u.role, u.store_id, u.area_id, u.region_id, u.employee_id, u.active, u.must_change,
      COALESCE(s.name, a.name, r.name, 'Whole business') AS place
    FROM users u LEFT JOIN stores s ON s.id = u.store_id LEFT JOIN areas a ON a.id = u.area_id LEFT JOIN regions r ON r.id = u.region_id
    WHERE (? = '' OR u.name LIKE ? OR u.username LIKE ?) AND (? = 'any' OR u.role = ?)
    ORDER BY u.active DESC, CASE u.role WHEN 'admin' THEN 0 WHEN 'operations' THEN 1 WHEN 'regional' THEN 2 WHEN 'area' THEN 3 ELSE 4 END, u.name LIMIT 100`)
    .all(q, `%${q}%`, `%${q}%`, ROLES.includes(req.query.role) ? req.query.role : 'any', req.query.role || ''));
});
app.post('/api/users', need('operations'), (req, res) => {
  const username = text(req.body.username, 40).toLowerCase(), name = text(req.body.name, 80), role = req.body.role;
  if (!validUsername(username) || !name) return bad(res, 'Check the name and username.');
  if (!canGrant(req, role)) return bad(res, 'You cannot give out that access level.', 403);
  const p = placement(role, req.body);
  if (!p) return bad(res, 'Pick where this login sits: a shop, an area or a region to match the level.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return bad(res, 'That username is taken.');
  const pw = tempPassword();
  db.prepare('INSERT INTO users (username, pass_hash, name, role, store_id, area_id, region_id, must_change) VALUES (?,?,?,?,?,?,?,1)').run(username, bcrypt.hashSync(pw, 12), name, role, p.store_id, p.area_id, p.region_id);
  audit(req, 'login created', `${username} as ${role}`);
  res.json({ username, temp_password: pw });
});

// ---- leave and absence ----
const dayCount = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
app.get('/api/leave', need('manager'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  res.json(db.prepare(`SELECT l.*, e.first_name, e.last_name, e.job_title FROM leave l JOIN employees e ON e.id = l.employee_id
    WHERE e.store_id = ? AND (l.status = 'pending' OR l.end_date >= ?) ORDER BY l.status = 'pending' DESC, l.start_date`).all(store, addDays(today(), -30)));
});
app.post('/api/leave', (req, res) => {
  const mgr = rank(req.user) >= RANK.manager;
  const empId = mgr && req.body.employee_id ? Number(req.body.employee_id) : req.user.employee_id;
  if (!empId) return bad(res, 'Your login is not linked to a team record.');
  if (empId !== req.user.employee_id && !ownsEmployee(req, res, empId)) return;
  const direct = mgr && empId !== req.user.employee_id;        // logged for someone else, so already agreed
  const kind = direct && ['holiday', 'sickness', 'other'].includes(req.body.kind) ? req.body.kind : 'holiday';
  const { start_date, end_date } = req.body;
  if (!isDate(start_date) || !isDate(end_date) || end_date < start_date || dayCount(start_date, end_date) > 60) return bad(res, 'Check the dates.');
  const days = Number(req.body.days) > 0 && Number(req.body.days) <= 60 ? Number(req.body.days) : dayCount(start_date, end_date);
  if (db.prepare("SELECT 1 FROM leave WHERE employee_id = ? AND status != 'declined' AND start_date <= ? AND end_date >= ?").get(empId, end_date, start_date)) return bad(res, 'Those dates overlap an existing entry.');
  const r = db.prepare('INSERT INTO leave (employee_id, kind, start_date, end_date, days, note, status, requested_by, decided_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(empId, kind, start_date, end_date, days, text(req.body.note, 300), direct ? 'approved' : 'pending', req.user.name, direct ? req.user.name : null, new Date().toISOString());
  audit(req, kind + (direct ? ' logged' : ' requested'), `${start_date} to ${end_date}`);
  res.json({ id: r.lastInsertRowid });
});
app.post('/api/leave/:id/decide', need('manager'), (req, res) => {
  const l = db.prepare('SELECT * FROM leave WHERE id = ?').get(req.params.id);
  if (!l) return bad(res, 'Not found.', 404);
  if (!ownsEmployee(req, res, l.employee_id)) return;
  if (l.employee_id === req.user.employee_id) return bad(res, 'Someone else has to decide your own request.', 403);
  if (!['approved', 'declined'].includes(req.body.status)) return bad(res, 'Choose approve or decline.');
  db.prepare('UPDATE leave SET status = ?, decided_by = ? WHERE id = ?').run(req.body.status, req.user.name, l.id);
  audit(req, 'leave ' + req.body.status, `${l.start_date} to ${l.end_date}`);
  res.json({ ok: true });
});
app.delete('/api/leave/:id', (req, res) => {
  const l = db.prepare('SELECT * FROM leave WHERE id = ?').get(req.params.id);
  if (!l) return bad(res, 'Not found.', 404);
  const own = l.employee_id === req.user.employee_id;
  if (own) { if (l.status !== 'pending') return bad(res, 'Only pending requests can be cancelled.', 403); }
  else { if (rank(req.user) < RANK.manager) return bad(res, 'You do not have access to that.', 403); if (!ownsEmployee(req, res, l.employee_id)) return; }
  db.prepare('DELETE FROM leave WHERE id = ?').run(l.id);
  audit(req, 'leave entry removed', `${l.start_date} to ${l.end_date}`);
  res.json({ ok: true });
});

// ---- training ----
app.get('/api/courses', (req, res) => res.json(db.prepare('SELECT * FROM courses WHERE active = 1 ORDER BY title').all()));
function courseFields(b) {
  const f = { title: text(b.title, 100), description: text(b.description, 1000), link: text(b.link, 300), valid_months: Number(b.valid_months) > 0 ? Math.round(Number(b.valid_months)) : null,
    jobs: ['manager', 'instore', 'driver'].filter(j => (Array.isArray(b.jobs) ? b.jobs : []).includes(j)).join(',') || 'all' };
  if (!f.title || (f.link && !/^https:\/\//.test(f.link))) return null;
  return f;
}
app.post('/api/courses', need('operations'), (req, res) => {
  const f = courseFields(req.body); if (!f) return bad(res, 'Give the course a title. Links must start with https://');
  const r = db.prepare('INSERT INTO courses (title, description, link, valid_months, jobs) VALUES (@title, @description, @link, @valid_months, @jobs)').run(f);
  audit(req, 'course added', f.title);
  res.json({ id: r.lastInsertRowid });
});
app.patch('/api/courses/:id', need('operations'), (req, res) => {
  if (req.body.active === 0) { db.prepare('UPDATE courses SET active = 0 WHERE id = ?').run(req.params.id); audit(req, 'course retired', req.params.id); return res.json({ ok: true }); }
  const f = courseFields(req.body); if (!f) return bad(res, 'Give the course a title. Links must start with https://');
  db.prepare('UPDATE courses SET title=@title, description=@description, link=@link, valid_months=@valid_months, jobs=@jobs WHERE id=@id').run({ id: req.params.id, ...f });
  res.json({ ok: true });
});
app.get('/api/training', need('manager'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  res.json(db.prepare('SELECT * FROM employees WHERE store_id = ? AND active = 1 ORDER BY first_name').all(store)
    .map(e => ({ id: e.id, name: `${e.first_name} ${e.last_name}`, job_title: e.job_title, courses: trainingFor(e) })));
});
app.post('/api/completions', need('manager'), (req, res) => {
  const e = ownsEmployee(req, res, Number(req.body.employee_id)); if (!e) return;
  if (e.id === req.user.employee_id) return bad(res, 'Someone else has to sign off your own training.', 403);
  const c = db.prepare('SELECT * FROM courses WHERE id = ? AND active = 1').get(req.body.course_id);
  const date = isDate(req.body.completed_date) ? req.body.completed_date : today();
  if (!c || date > today()) return bad(res, 'Check the course and date.');
  db.prepare('INSERT INTO completions (course_id, employee_id, completed_date, expires_date, signed_by) VALUES (?,?,?,?,?)').run(c.id, e.id, date, c.valid_months ? addMonths(date, c.valid_months) : null, req.user.name);
  audit(req, 'training signed off', `${e.first_name} ${e.last_name}: ${c.title}`);
  res.json({ ok: true });
});

// ---- checklists ----
app.get('/api/checklists', need('supervisor'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const date = isDate(req.query.date) ? req.query.date : today();
  const lists = db.prepare(`SELECT c.* FROM checklists c WHERE c.active = 1
    OR EXISTS (SELECT 1 FROM checklist_runs r WHERE r.checklist_id = c.id AND r.store_id = ? AND r.date = ?) ORDER BY c.id`).all(store, date);
  res.json({ date, today: today(), lists: lists.map(c => {
    const run = db.prepare('SELECT * FROM checklist_runs WHERE checklist_id = ? AND store_id = ? AND date = ?').get(c.id, store, date);
    const items = JSON.parse(c.items);
    return { id: c.id, name: c.name, items, ticks: run ? JSON.parse(run.ticks) : items.map(() => false), completed: !!(run && run.completed), done_by: run && run.done_by, done_at: run && run.done_at };
  }) });
});
app.put('/api/checklists/:id/run', need('supervisor'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const c = db.prepare('SELECT * FROM checklists WHERE id = ? AND active = 1').get(req.params.id);
  if (!c) return bad(res, 'Not found.', 404);
  const n = JSON.parse(c.items).length, ticks = Array.isArray(req.body.ticks) ? req.body.ticks.slice(0, n).map(Boolean) : [];
  if (ticks.length !== n || req.body.date !== today()) return bad(res, 'Checklists can only be filled in for today.');
  const done = ticks.every(Boolean) ? 1 : 0;
  db.prepare(`INSERT INTO checklist_runs (checklist_id, store_id, date, ticks, completed, done_by, done_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (checklist_id, store_id, date) DO UPDATE SET ticks = excluded.ticks, completed = excluded.completed, done_by = excluded.done_by, done_at = excluded.done_at`)
    .run(c.id, store, today(), JSON.stringify(ticks), done, req.user.name, new Date().toISOString());
  if (done) audit(req, 'checklist completed', c.name);
  res.json({ ok: true, completed: !!done });
});
app.get('/api/checklists/templates', need('operations'), (req, res) =>
  res.json(db.prepare('SELECT * FROM checklists WHERE active = 1 ORDER BY id').all().map(c => ({ id: c.id, name: c.name, items: JSON.parse(c.items) }))));
const listItems = b => (Array.isArray(b.items) ? b.items : []).map(i => text(i, 160)).filter(Boolean).slice(0, 60);
app.post('/api/checklists', need('operations'), (req, res) => {
  const name = text(req.body.name, 80), items = listItems(req.body);
  if (!name || !items.length) return bad(res, 'Give the checklist a name and at least one item.');
  const r = db.prepare('INSERT INTO checklists (name, items) VALUES (?,?)').run(name, JSON.stringify(items));
  audit(req, 'checklist added', name);
  res.json({ id: r.lastInsertRowid });
});
app.patch('/api/checklists/:id', need('operations'), (req, res) => {
  // Editing retires the old list and starts a new one so past records still match their items.
  const name = text(req.body.name, 80), items = listItems(req.body);
  if (req.body.active !== 0 && (!name || !items.length)) return bad(res, 'Give the checklist a name and at least one item.');
  db.prepare('UPDATE checklists SET active = 0 WHERE id = ?').run(req.params.id);
  if (req.body.active !== 0) db.prepare('INSERT INTO checklists (name, items) VALUES (?,?)').run(name, JSON.stringify(items));
  audit(req, 'checklist changed', name || req.params.id);
  res.json({ ok: true });
});

// ---- rota ----
const shiftSql = `SELECT sh.id, sh.date, sh.employee_id, sh.start_min, sh.end_min, sh.closing, sh.job, e.first_name, e.last_name, e.job_title, e.hourly_rate
  FROM shifts sh LEFT JOIN employees e ON e.id = sh.employee_id`;
const shiftOrder = "CASE sh.job WHEN 'manager' THEN 0 WHEN 'instore' THEN 1 ELSE 2 END";
const jobOrder = "CASE e.job WHEN 'manager' THEN 0 WHEN 'instore' THEN 1 ELSE 2 END";

app.get('/api/rota', (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const date = isDate(req.query.date) ? req.query.date : today();
  const showPay = rank(req.user) >= RANK.manager;
  const shifts = db.prepare(`${shiftSql} WHERE sh.store_id = ? AND sh.date = ? ORDER BY ${shiftOrder}, sh.employee_id IS NULL, sh.start_min`).all(store, date);
  const forecast = db.prepare('SELECT hour, sales, orders FROM forecasts WHERE store_id = ? AND date = ?').all(store, date);
  const employees = db.prepare('SELECT id, first_name, last_name, job, job_title FROM employees WHERE store_id = ? AND active = 1 ORDER BY first_name').all(store);
  const off = db.prepare("SELECT l.employee_id FROM leave l JOIN employees e ON e.id = l.employee_id WHERE e.store_id = ? AND l.status = 'approved' AND ? BETWEEN l.start_date AND l.end_date").all(store, date).map(o => o.employee_id);
  const mon = monday(date), sun = addDays(mon, 6);
  const weekSales = db.prepare('SELECT COALESCE(SUM(sales),0) v FROM forecasts WHERE store_id = ? AND date BETWEEN ? AND ?').get(store, mon, sun).v;
  const weekCost = db.prepare(`SELECT COALESCE(SUM((sh.end_min - sh.start_min) / 60.0 * e.hourly_rate),0) v
    FROM shifts sh JOIN employees e ON e.id = sh.employee_id WHERE sh.store_id = ? AND sh.date BETWEEN ? AND ?`).get(store, mon, sun).v;
  if (!showPay) shifts.forEach(s => delete s.hourly_rate);
  res.json({ date, today: today(), shifts, forecast, employees, off, need: staffingNeed(store, date), weekSales, weekCost: showPay ? weekCost : null, canEdit: showPay });
});

app.get('/api/rota/week', (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const mon = monday(isDate(req.query.date) ? req.query.date : today()), sun = addDays(mon, 6);
  const shifts = db.prepare(`${shiftSql} WHERE sh.store_id = ? AND sh.date BETWEEN ? AND ? ORDER BY sh.start_min`).all(store, mon, sun);
  shifts.forEach(s => delete s.hourly_rate);
  const employees = db.prepare(`SELECT e.id, e.first_name, e.last_name, e.job, e.job_title, e.contract_hours FROM employees e WHERE e.store_id = ? AND e.active = 1 ORDER BY ${jobOrder}, e.first_name`).all(store);
  const off = db.prepare("SELECT l.employee_id, l.start_date, l.end_date FROM leave l JOIN employees e ON e.id = l.employee_id WHERE e.store_id = ? AND l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ?").all(store, sun, mon);
  res.json({ monday: mon, today: today(), shifts, employees, off, canEdit: rank(req.user) >= RANK.manager });
});

app.post('/api/rota/copy-week', need('manager'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  if (!isDate(req.body.date)) return bad(res, 'Pick a week.');
  const mon = monday(req.body.date), sun = addDays(mon, 6);
  if (db.prepare('SELECT 1 FROM shifts WHERE store_id = ? AND date BETWEEN ? AND ?').get(store, mon, sun)) return bad(res, 'This week already has shifts, so nothing was copied.');
  const src = db.prepare(`SELECT sh.* FROM shifts sh LEFT JOIN employees e ON e.id = sh.employee_id
    WHERE sh.store_id = ? AND (sh.employee_id IS NULL OR (e.active = 1 AND e.store_id = sh.store_id)) AND sh.date BETWEEN ? AND ?`).all(store, addDays(mon, -7), addDays(mon, -1));
  if (!src.length) return bad(res, 'Last week has no shifts to copy.');
  const ins = db.prepare('INSERT INTO shifts (store_id, date, employee_id, job, start_min, end_min, closing) VALUES (?,?,?,?,?,?,?)');
  const away = (emp, date) => emp && db.prepare("SELECT 1 FROM leave WHERE employee_id = ? AND status = 'approved' AND ? BETWEEN start_date AND end_date").get(emp, date);
  db.transaction(() => src.forEach(s => { const d = addDays(s.date, 7); ins.run(store, d, away(s.employee_id, d) ? null : s.employee_id, s.job, s.start_min, s.end_min, s.closing); }))();
  audit(req, 'rota copied from last week', mon);
  res.json({ copied: src.length });
});

app.get('/api/shifts/mine', (req, res) => {
  if (!req.user.employee_id) return res.json({ linked: false, shifts: [] });
  res.json({ linked: true, today: today(), shifts: db.prepare(`SELECT sh.id, sh.date, sh.start_min, sh.end_min, sh.closing, s.name AS store
    FROM shifts sh JOIN stores s ON s.id = sh.store_id WHERE sh.employee_id = ? AND sh.date >= ? ORDER BY sh.date, sh.start_min LIMIT 60`).all(req.user.employee_id, today()) });
});

function shiftFields(b) {
  const s = Number(b.start_min), e = Number(b.end_min);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 300 || e > 1740 || e <= s || s % 15 || e % 15) return null;
  return { start_min: s, end_min: e, closing: b.closing ? 1 : 0 };
}
// Why this person cannot take this shift, or null if they can.
function clash(emp, job, date, f, ignoreId) {
  if ((emp.job === 'driver') !== (job === 'driver')) return job === 'driver' ? 'Pick a driver for a driver shift.' : 'Pick an insider or manager for an instore shift.';
  if (db.prepare("SELECT 1 FROM leave WHERE employee_id = ? AND status = 'approved' AND ? BETWEEN start_date AND end_date").get(emp.id, date)) return `${emp.first_name} is off that day.`;
  if (db.prepare('SELECT 1 FROM shifts WHERE employee_id = ? AND date = ? AND id != ? AND start_min < ? AND end_min > ?').get(emp.id, date, ignoreId || 0, f.end_min, f.start_min)) return `${emp.first_name} already has a shift that overlaps.`;
  return null;
}
app.post('/api/shifts', need('manager'), (req, res) => {
  const f = shiftFields(req.body);
  if (!f || !isDate(req.body.date)) return bad(res, 'Check the shift times.');
  let store, emp = null, job = req.body.job;
  if (req.body.employee_id) {
    emp = ownsEmployee(req, res, Number(req.body.employee_id)); if (!emp) return;
    store = emp.store_id; job = emp.job;
    const why = clash(emp, job, req.body.date, f); if (why) return bad(res, why);
  } else {
    store = storeId(req, res); if (!store) return;
    if (!['manager', 'instore', 'driver'].includes(job)) return bad(res, 'Pick a role for the open shift.');
  }
  const r = db.prepare('INSERT INTO shifts (store_id, date, employee_id, job, start_min, end_min, closing) VALUES (?,?,?,?,?,?,?)').run(store, req.body.date, emp && emp.id, job, f.start_min, f.end_min, f.closing);
  res.json({ id: r.lastInsertRowid });
});
function ownsShift(req, res) {
  const sh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!sh) return bad(res, 'Not found.', 404);
  if (!req.stores.includes(sh.store_id)) return bad(res, 'That shop is not in your access.', 403);
  return sh;
}
app.patch('/api/shifts/:id', need('manager'), (req, res) => {
  const sh = ownsShift(req, res); if (!sh) return;
  const f = shiftFields(req.body); if (!f) return bad(res, 'Check the shift times.');
  let empId = sh.employee_id;
  if ('employee_id' in req.body) empId = req.body.employee_id ? Number(req.body.employee_id) : null;
  if (empId) {
    const emp = ownsEmployee(req, res, empId); if (!emp) return;
    if (emp.store_id !== sh.store_id || !emp.active) return bad(res, 'That person is not at this shop.');
    const why = clash(emp, sh.job, sh.date, f, sh.id); if (why) return bad(res, why);
  }
  db.prepare('UPDATE shifts SET employee_id = ?, start_min = ?, end_min = ?, closing = ? WHERE id = ?').run(empId, f.start_min, f.end_min, f.closing, sh.id);
  res.json({ ok: true });
});
app.delete('/api/shifts/:id', need('manager'), (req, res) => {
  const sh = ownsShift(req, res); if (!sh) return;
  db.prepare('DELETE FROM shifts WHERE id = ?').run(sh.id);
  res.json({ ok: true });
});

// ---- optimal staffing and automatic shifts ----
const MIN_SHIFT = 180, MAX_SHIFT = 540;
const bands = () => db.prepare('SELECT * FROM staffing_bands ORDER BY sales_from').all();
// Per trading hour: how many insiders and drivers the forecast calls for.
function staffingNeed(store, date) {
  const bs = bands();
  return db.prepare('SELECT hour, sales FROM forecasts WHERE store_id = ? AND date = ? AND sales > 0 ORDER BY hour').all(store, date).map(f => {
    const b = bs.filter(x => x.sales_from <= f.sales).pop() || { insiders: 0, drivers: 0 };
    return { hour: f.hour, insiders: b.insiders, drivers: b.drivers };
  });
}
// Turn hourly head counts into shifts: level 1 covers every hour that needs anyone,
// level 2 every hour that needs two, and so on. Short runs are stretched, long ones split.
function buildShifts(need, key, close) {
  const out = [], max = Math.max(0, ...need.map(n => n[key]));
  for (let k = 1; k <= max; k++) {
    let run = null;
    const flush = () => {
      if (!run) return;
      let s = run.s * 60, e = (run.e + 1) * 60;
      if (e - s < MIN_SHIFT) { e = Math.min(close, s + MIN_SHIFT); s = Math.min(s, e - MIN_SHIFT); }
      const parts = Math.ceil((e - s) / MAX_SHIFT), len = Math.ceil((e - s) / parts / 60) * 60;
      for (let i = 0; i < parts; i++) out.push({ level: k, start_min: s + i * len, end_min: Math.min(e, s + (i + 1) * len) });
      run = null;
    };
    for (const n of need) {
      if (n[key] >= k && run && n.hour === run.e + 1) run.e = n.hour;
      else if (n[key] >= k) { flush(); run = { s: n.hour, e: n.hour }; }
      else flush();
    }
    flush();
  }
  return out;
}
function generateDay(store, date) {
  const full = staffingNeed(store, date);
  if (!full.length) return 0;
  const close = (full[full.length - 1].hour + 1) * 60;
  db.prepare('DELETE FROM shifts WHERE store_id = ? AND date = ? AND employee_id IS NULL').run(store, date);
  const filled = db.prepare('SELECT job, start_min, end_min FROM shifts WHERE store_id = ? AND date = ?').all(store, date);
  const covers = (s, h) => Math.min(s.end_min, h * 60 + 60) - Math.max(s.start_min, h * 60) >= 30;
  // Only build what the people already on the rota do not cover.
  const gap = full.map(n => ({
    hour: n.hour,
    insiders: Math.max(0, n.insiders - filled.filter(s => s.job !== 'driver' && covers(s, n.hour)).length),
    drivers: Math.max(0, n.drivers - filled.filter(s => s.job === 'driver' && covers(s, n.hour)).length)
  }));
  const ins = db.prepare('INSERT INTO shifts (store_id, date, employee_id, job, start_min, end_min, closing) VALUES (?,?,NULL,?,?,?,?)');
  let made = 0;
  const hasManager = s => filled.some(m => m.job === 'manager' && m.start_min < s.end_min && m.end_min > s.start_min);
  for (const s of buildShifts(gap, 'insiders', close)) { ins.run(store, date, s.level === 1 && !hasManager(s) ? 'manager' : 'instore', s.start_min, s.end_min, s.end_min === close ? 1 : 0); made++; }
  for (const s of buildShifts(gap, 'drivers', close)) { ins.run(store, date, 'driver', s.start_min, s.end_min, s.end_min === close ? 1 : 0); made++; }
  return made;
}
app.post('/api/rota/generate', need('manager'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  if (!isDate(req.body.date)) return bad(res, 'Pick a date.');
  const days = req.body.week ? Array.from({ length: 7 }, (_, i) => addDays(monday(req.body.date), i)).filter(d => d >= today()) : [req.body.date];
  let made = 0;
  const hasForecast = d => db.prepare('SELECT 1 FROM forecasts WHERE store_id = ? AND date = ? AND sales > 0').get(store, d);
  // A day with no forecast yet gets the predicted one first.
  db.transaction(() => days.forEach(d => { if (!hasForecast(d)) predictDay(store, d); made += generateDay(store, d); }))();
  if (!made) return bad(res, req.body.week ? 'Nothing to build. There is no sales forecast or history for that week yet.' : 'Nothing to build. Enter a sales forecast for this day first, or the day is already covered.');
  audit(req, 'shifts built from forecast', `${req.body.week ? 'week of ' : ''}${req.body.date}: ${made}`);
  res.json({ made });
});
// Predicted sales: the average of the same weekday over the last four weeks.
function predictDay(store, d) {
  const rows = db.prepare('SELECT hour, AVG(sales) s, AVG(orders) o FROM forecasts WHERE store_id = ? AND date IN (?,?,?,?) GROUP BY hour').all(store, ...[7, 14, 21, 28].map(n => addDays(d, -n)));
  const put = db.prepare(`INSERT INTO forecasts (store_id, date, hour, sales, orders) VALUES (?,?,?,?,?)
    ON CONFLICT (store_id, date, hour) DO UPDATE SET sales = excluded.sales, orders = excluded.orders`);
  rows.forEach(r => put.run(store, d, r.hour, Math.round(r.s), +r.o.toFixed(2)));
  return rows.length > 0;
}
app.post('/api/forecast/predict', need('manager'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  if (!isDate(req.body.date)) return bad(res, 'Pick a date.');
  const days = req.body.week ? Array.from({ length: 7 }, (_, i) => addDays(monday(req.body.date), i)) : [req.body.date];
  let filled = 0;
  db.transaction(() => days.forEach(d => { if (predictDay(store, d)) filled++; }))();
  if (!filled) return bad(res, 'No sales history for the last four weeks to predict from. Enter the forecast by hand.');
  res.json({ filled });
});
app.get('/api/staffing', need('manager'), (req, res) => res.json(bands()));
app.put('/api/staffing', need('operations'), (req, res) => {
  const rows = (Array.isArray(req.body.bands) ? req.body.bands : []).map(b => [Number(b.sales_from), Math.round(Number(b.insiders)), Math.round(Number(b.drivers))]);
  if (!rows.length || rows.length > 30 || rows.some(r => !(r[0] >= 0) || !(r[1] >= 0 && r[1] <= 40) || !(r[2] >= 0 && r[2] <= 60)) || new Set(rows.map(r => r[0])).size !== rows.length)
    return bad(res, 'Each level needs its own sales figure and sensible head counts.');
  db.transaction(() => { db.prepare('DELETE FROM staffing_bands').run(); rows.forEach(r => db.prepare('INSERT INTO staffing_bands VALUES (?,?,?)').run(...r)); })();
  audit(req, 'staffing levels changed', `${rows.length} levels`);
  res.json({ ok: true });
});
app.put('/api/forecast', need('manager'), (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const hour = Number(req.body.hour), sales = Number(req.body.sales), orders = Number(req.body.orders) || 0;
  if (!isDate(req.body.date) || !Number.isInteger(hour) || hour < 5 || hour > 28 || !(sales >= 0) || sales > 100000) return bad(res, 'Check the forecast value.');
  db.prepare(`INSERT INTO forecasts (store_id, date, hour, sales, orders) VALUES (?,?,?,?,?)
    ON CONFLICT (store_id, date, hour) DO UPDATE SET sales = excluded.sales, orders = excluded.orders`).run(store, req.body.date, hour, sales, orders);
  res.json({ ok: true });
});

// ---- business structure ----
app.get('/api/structure', need('operations'), (req, res) => res.json({
  regions: db.prepare('SELECT * FROM regions ORDER BY name').all(),
  areas: db.prepare('SELECT * FROM areas ORDER BY name').all(),
  stores: db.prepare('SELECT s.*, (SELECT COUNT(*) FROM employees e WHERE e.store_id = s.id AND e.active = 1) AS headcount FROM stores s ORDER BY s.name').all()
}));
app.post('/api/regions', need('admin'), (req, res) => {
  const name = text(req.body.name, 60);
  if (!name || db.prepare('SELECT 1 FROM regions WHERE name = ?').get(name)) return bad(res, 'Give the region a new name.');
  db.prepare('INSERT INTO regions (name) VALUES (?)').run(name); audit(req, 'region added', name); res.json({ ok: true });
});
app.post('/api/areas', need('admin'), (req, res) => {
  const name = text(req.body.name, 60), region = Number(req.body.region_id) || null;
  if (!name || db.prepare('SELECT 1 FROM areas WHERE name = ?').get(name)) return bad(res, 'Give the area a new name.');
  if (region && !db.prepare('SELECT 1 FROM regions WHERE id = ?').get(region)) return bad(res, 'Unknown region.');
  db.prepare('INSERT INTO areas (name, region_id) VALUES (?,?)').run(name, region); audit(req, 'area added', name); res.json({ ok: true });
});
app.patch('/api/areas/:id', need('admin'), (req, res) => {
  const region = Number(req.body.region_id) || null;
  if (region && !db.prepare('SELECT 1 FROM regions WHERE id = ?').get(region)) return bad(res, 'Unknown region.');
  db.prepare('UPDATE areas SET region_id = ? WHERE id = ?').run(region, req.params.id); audit(req, 'area moved', req.params.id); res.json({ ok: true });
});
app.post('/api/stores', need('admin'), (req, res) => {
  const name = text(req.body.name, 60), area = Number(req.body.area_id) || null;
  if (!name || db.prepare('SELECT 1 FROM stores WHERE name = ?').get(name)) return bad(res, 'Give the shop a new name.');
  if (area && !db.prepare('SELECT 1 FROM areas WHERE id = ?').get(area)) return bad(res, 'Unknown area.');
  db.prepare('INSERT INTO stores (name, postcode, area_id) VALUES (?,?,?)').run(name, text(req.body.postcode, 12) || null, area); audit(req, 'shop added', name); res.json({ ok: true });
});
app.patch('/api/stores/:id', need('admin'), (req, res) => {
  const area = Number(req.body.area_id) || null;
  if (area && !db.prepare('SELECT 1 FROM areas WHERE id = ?').get(area)) return bad(res, 'Unknown area.');
  db.prepare('UPDATE stores SET area_id = ? WHERE id = ?').run(area, req.params.id); audit(req, 'shop moved', req.params.id); res.json({ ok: true });
});
app.get('/api/audit', need('admin'), (req, res) => res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all()));

app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong.' }); });

app.listen(PORT, '127.0.0.1', () => console.log(`${ORG_NAME} hub listening on 127.0.0.1:${PORT}`));
