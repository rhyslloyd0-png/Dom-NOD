const path = require('path');
const fs = require('fs');

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
    'X-Robots-Tag': 'noindex, nofollow'
  });
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(cookieSession({
  name: 'hub',
  secret: SECRET,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.SECURE_COOKIES === '1',
  maxAge: 12 * 60 * 60 * 1000
}));

// Every state-changing call must be a same-origin JSON request.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
  next();
});

const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---- auth ----
const attempts = new Map();
function throttled(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(key, a);
  return a.length >= 8;
}

app.post('/api/login', (req, res) => {
  const username = text(req.body.username, 60);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const key = req.ip + '|' + username.toLowerCase();
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = bcrypt.compareSync(password, u ? u.pass_hash : '$2a$10$0000000000000000000000000000000000000000000000000000');
  if (!u || !ok) {
    attempts.get(key).push(Date.now());
    return res.status(401).json({ error: 'Username or password is wrong.' });
  }
  attempts.delete(key);
  req.session.uid = u.id;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/config', (req, res) => res.json({ org: ORG_NAME }));

app.use('/api', (req, res, next) => {
  const u = req.session.uid && db.prepare('SELECT id, username, name, role, store_id FROM users WHERE id = ?').get(req.session.uid);
  if (!u) return res.status(401).json({ error: 'Sign in first.' });
  req.user = u;
  next();
});

const canEdit = (req, res, next) =>
  req.user.role === 'staff' ? res.status(403).json({ error: 'Managers only.' }) : next();

// Staff and managers are tied to their own store; admins see every store.
function storeId(req, res) {
  const id = Number(req.query.store || req.body.store_id || req.user.store_id);
  if (!db.prepare('SELECT 1 FROM stores WHERE id = ?').get(id)) { res.status(400).json({ error: 'Unknown store.' }); return null; }
  if (req.user.role !== 'admin' && id !== req.user.store_id) { res.status(403).json({ error: 'Not your store.' }); return null; }
  return id;
}
function ownsEmployee(req, res, empId) {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
  if (!e) { res.status(404).json({ error: 'Not found.' }); return null; }
  if (req.user.role !== 'admin' && e.store_id !== req.user.store_id) { res.status(403).json({ error: 'Not your store.' }); return null; }
  return e;
}

app.get('/api/me', (req, res) => {
  const stores = req.user.role === 'admin'
    ? db.prepare('SELECT * FROM stores ORDER BY name').all()
    : db.prepare('SELECT * FROM stores WHERE id = ?').all(req.user.store_id);
  res.json({ user: req.user, stores, org: ORG_NAME, today: today() });
});

app.post('/api/password', (req, res) => {
  const cur = String(req.body.current || ''), next = String(req.body.next || '');
  if (next.length < 10) return res.status(400).json({ error: 'New password needs at least 10 characters.' });
  const u = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(cur, u.pass_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 12), req.user.id);
  res.json({ ok: true });
});

// ---- home: compliance ----
app.get('/api/home', canEdit, (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const horizon = addDays(today(), 56);
  const docs = db.prepare(`
    SELECT d.id, d.category, d.doc_type, d.expiry_date, e.first_name, e.last_name, e.job_title, s.name AS store
    FROM documents d JOIN employees e ON e.id = d.employee_id JOIN stores s ON s.id = e.store_id
    WHERE e.store_id = ? AND e.active = 1 AND d.expiry_date <= ? ORDER BY d.expiry_date`).all(store, horizon);
  const items = db.prepare(`
    SELECT c.*, s.name AS store, s.postcode FROM company_items c JOIN stores s ON s.id = c.store_id
    WHERE c.store_id = ? AND c.expiry_date <= ? ORDER BY c.expiry_date`).all(store, horizon);
  const missing = db.prepare(`
    SELECT e.id, e.first_name, e.last_name, e.job_title, e.start_date, s.name AS store
    FROM employees e JOIN stores s ON s.id = e.store_id
    WHERE e.store_id = ? AND e.active = 1 AND e.has_contract = 0 ORDER BY e.last_name`).all(store);
  res.json({
    today: today(),
    rtw: docs.filter(d => d.category === 'rtw'),
    job: docs.filter(d => d.category === 'job'),
    additional: docs.filter(d => d.category === 'additional'),
    missing,
    registers: items.filter(i => i.kind === 'register'),
    policies: items.filter(i => i.kind === 'policy'),
    certificates: items.filter(i => i.kind === 'certificate')
  });
});

app.post('/api/documents', canEdit, (req, res) => {
  const e = ownsEmployee(req, res, Number(req.body.employee_id)); if (!e) return;
  const { category, expiry_date } = req.body;
  const doc_type = text(req.body.doc_type, 80);
  if (!['rtw', 'job', 'additional'].includes(category) || !doc_type || !isDate(expiry_date)) return res.status(400).json({ error: 'Check the document details.' });
  const r = db.prepare('INSERT INTO documents (employee_id, category, doc_type, expiry_date) VALUES (?,?,?,?)').run(e.id, category, doc_type, expiry_date);
  res.json({ id: r.lastInsertRowid });
});

app.patch('/api/documents/:id', canEdit, (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found.' });
  if (!ownsEmployee(req, res, d.employee_id)) return;
  if (!isDate(req.body.expiry_date)) return res.status(400).json({ error: 'Pick a valid date.' });
  db.prepare('UPDATE documents SET expiry_date = ? WHERE id = ?').run(req.body.expiry_date, d.id);
  res.json({ ok: true });
});

// ---- notices ----
app.get('/api/notices', (req, res) => {
  res.json(db.prepare(`
    SELECT n.*, a.acked_at FROM notices n
    LEFT JOIN notice_acks a ON a.notice_id = n.id AND a.user_id = ?
    ORDER BY n.issued DESC, n.id DESC`).all(req.user.id));
});

app.post('/api/notices', canEdit, (req, res) => {
  const title = text(req.body.title, 120), body = text(req.body.body, 4000);
  if (!title) return res.status(400).json({ error: 'Give the notice a title.' });
  const r = db.prepare('INSERT INTO notices (title, type, body, created_by, issued) VALUES (?,?,?,?,?)')
    .run(title, text(req.body.type, 40) || 'Notice', body, req.user.name, today());
  res.json({ id: r.lastInsertRowid });
});

app.post('/api/notices/:id/ack', (req, res) => {
  if (!db.prepare('SELECT 1 FROM notices WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  db.prepare('INSERT OR IGNORE INTO notice_acks (notice_id, user_id, acked_at) VALUES (?,?,?)').run(req.params.id, req.user.id, new Date().toISOString());
  res.json({ ok: true });
});

// ---- team ----
app.get('/api/employees', canEdit, (req, res) => {
  const store = storeId(req, res); if (!store) return;
  res.json(db.prepare('SELECT * FROM employees WHERE store_id = ? AND active = 1 ORDER BY job, first_name').all(store));
});

function employeeFields(b) {
  const f = {
    first_name: text(b.first_name, 60), last_name: text(b.last_name, 60), job: b.job,
    job_title: text(b.job_title, 60), hourly_rate: Number(b.hourly_rate) || 0,
    start_date: isDate(b.start_date) ? b.start_date : null, has_contract: b.has_contract ? 1 : 0
  };
  if (!f.first_name || !f.last_name || !['manager', 'instore', 'driver'].includes(f.job) || f.hourly_rate < 0 || f.hourly_rate > 200) return null;
  return f;
}

app.post('/api/employees', canEdit, (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const f = employeeFields(req.body); if (!f) return res.status(400).json({ error: 'Check the team member details.' });
  const r = db.prepare(`INSERT INTO employees (store_id, first_name, last_name, job, job_title, hourly_rate, start_date, has_contract)
    VALUES (@store, @first_name, @last_name, @job, @job_title, @hourly_rate, @start_date, @has_contract)`).run({ store, ...f });
  res.json({ id: r.lastInsertRowid });
});

app.patch('/api/employees/:id', canEdit, (req, res) => {
  const e = ownsEmployee(req, res, Number(req.params.id)); if (!e) return;
  if (req.body.active === 0) { db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(e.id); return res.json({ ok: true }); }
  const f = employeeFields(req.body); if (!f) return res.status(400).json({ error: 'Check the team member details.' });
  db.prepare(`UPDATE employees SET first_name=@first_name, last_name=@last_name, job=@job, job_title=@job_title,
    hourly_rate=@hourly_rate, start_date=@start_date, has_contract=@has_contract WHERE id=@id`).run({ id: e.id, ...f });
  res.json({ ok: true });
});

// ---- rota ----
app.get('/api/rota', (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const date = isDate(req.query.date) ? req.query.date : today();
  const showPay = req.user.role !== 'staff';
  const shifts = db.prepare(`
    SELECT sh.id, sh.employee_id, sh.start_min, sh.end_min, sh.closing,
           e.first_name, e.last_name, e.job, e.job_title, e.hourly_rate
    FROM shifts sh JOIN employees e ON e.id = sh.employee_id
    WHERE sh.store_id = ? AND sh.date = ?
    ORDER BY CASE e.job WHEN 'manager' THEN 0 WHEN 'instore' THEN 1 ELSE 2 END, sh.start_min`).all(store, date);
  const forecast = db.prepare('SELECT hour, sales, orders FROM forecasts WHERE store_id = ? AND date = ?').all(store, date);
  const employees = db.prepare('SELECT id, first_name, last_name, job, job_title FROM employees WHERE store_id = ? AND active = 1 ORDER BY first_name').all(store);

  // Week totals, Monday to Sunday.
  const dow = (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const mon = addDays(date, -dow), sun = addDays(mon, 6);
  const weekSales = db.prepare('SELECT COALESCE(SUM(sales),0) v FROM forecasts WHERE store_id = ? AND date BETWEEN ? AND ?').get(store, mon, sun).v;
  const weekCost = db.prepare(`SELECT COALESCE(SUM((sh.end_min - sh.start_min) / 60.0 * e.hourly_rate),0) v
    FROM shifts sh JOIN employees e ON e.id = sh.employee_id WHERE sh.store_id = ? AND sh.date BETWEEN ? AND ?`).get(store, mon, sun).v;

  if (!showPay) shifts.forEach(s => delete s.hourly_rate);
  res.json({ date, today: today(), shifts, forecast, employees, weekSales, weekCost: showPay ? weekCost : null, canEdit: showPay });
});

function shiftFields(b) {
  const s = Number(b.start_min), e = Number(b.end_min);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 300 || e > 1740 || e <= s || s % 15 || e % 15) return null;
  return { start_min: s, end_min: e, closing: b.closing ? 1 : 0 };
}

app.post('/api/shifts', canEdit, (req, res) => {
  const emp = ownsEmployee(req, res, Number(req.body.employee_id)); if (!emp) return;
  const f = shiftFields(req.body);
  if (!f || !isDate(req.body.date)) return res.status(400).json({ error: 'Check the shift times.' });
  const r = db.prepare('INSERT INTO shifts (store_id, date, employee_id, start_min, end_min, closing) VALUES (?,?,?,?,?,?)')
    .run(emp.store_id, req.body.date, emp.id, f.start_min, f.end_min, f.closing);
  res.json({ id: r.lastInsertRowid });
});

function ownsShift(req, res) {
  const sh = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!sh) { res.status(404).json({ error: 'Not found.' }); return null; }
  if (req.user.role !== 'admin' && sh.store_id !== req.user.store_id) { res.status(403).json({ error: 'Not your store.' }); return null; }
  return sh;
}

app.patch('/api/shifts/:id', canEdit, (req, res) => {
  const sh = ownsShift(req, res); if (!sh) return;
  const f = shiftFields(req.body); if (!f) return res.status(400).json({ error: 'Check the shift times.' });
  db.prepare('UPDATE shifts SET start_min = ?, end_min = ?, closing = ? WHERE id = ?').run(f.start_min, f.end_min, f.closing, sh.id);
  res.json({ ok: true });
});

app.delete('/api/shifts/:id', canEdit, (req, res) => {
  const sh = ownsShift(req, res); if (!sh) return;
  db.prepare('DELETE FROM shifts WHERE id = ?').run(sh.id);
  res.json({ ok: true });
});

app.put('/api/forecast', canEdit, (req, res) => {
  const store = storeId(req, res); if (!store) return;
  const hour = Number(req.body.hour), sales = Number(req.body.sales), orders = Number(req.body.orders) || 0;
  if (!isDate(req.body.date) || !Number.isInteger(hour) || hour < 5 || hour > 28 || !(sales >= 0) || sales > 100000) return res.status(400).json({ error: 'Check the forecast value.' });
  db.prepare(`INSERT INTO forecasts (store_id, date, hour, sales, orders) VALUES (?,?,?,?,?)
    ON CONFLICT (store_id, date, hour) DO UPDATE SET sales = excluded.sales, orders = excluded.orders`).run(store, req.body.date, hour, sales, orders);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong.' }); });

app.listen(PORT, '127.0.0.1', () => console.log(`${ORG_NAME} hub listening on 127.0.0.1:${PORT}`));
