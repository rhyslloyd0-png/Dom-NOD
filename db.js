const path = require('path');
const Database = require('better-sqlite3');

const file = process.env.DB_FILE || path.join(__dirname, 'data', 'hub.db');
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  postcode TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','manager','staff')),
  store_id INTEGER REFERENCES stores(id)
);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  job TEXT NOT NULL CHECK (job IN ('manager','instore','driver')),
  job_title TEXT,
  hourly_rate REAL NOT NULL DEFAULT 0,
  start_date TEXT,
  has_contract INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('rtw','job','additional')),
  doc_type TEXT NOT NULL,
  expiry_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_items (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  kind TEXT NOT NULL CHECK (kind IN ('register','policy','certificate')),
  name TEXT NOT NULL,
  done_date TEXT,
  expiry_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Notice',
  body TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  issued TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notice_acks (
  notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acked_at TEXT NOT NULL,
  PRIMARY KEY (notice_id, user_id)
);
-- Times are minutes from midnight of the trading day; a close at 01:00 is 1500.
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  date TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  closing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shifts_day ON shifts (store_id, date);
CREATE TABLE IF NOT EXISTS forecasts (
  store_id INTEGER NOT NULL REFERENCES stores(id),
  date TEXT NOT NULL,
  hour INTEGER NOT NULL,
  sales REAL NOT NULL DEFAULT 0,
  orders REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, date, hour)
);
`);


// ---- upgrades for databases created by an earlier version ----
function hasCol(table, col) { return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col); }
function addCol(table, col, def) { if (!hasCol(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }

const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql;
db.exec(`
CREATE TABLE IF NOT EXISTS regions (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS areas (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, region_id INTEGER REFERENCES regions(id));
`);
addCol('stores', 'area_id', 'INTEGER REFERENCES areas(id)');

if (!usersSql.includes("'operations'")) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('staff','supervisor','manager','area','regional','operations','admin')),
        store_id INTEGER REFERENCES stores(id),
        area_id INTEGER REFERENCES areas(id),
        region_id INTEGER REFERENCES regions(id),
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        must_change INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO users_new (id, username, pass_hash, name, role, store_id) SELECT id, username, pass_hash, name, role, store_id FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;`);
  })();
  db.pragma('foreign_keys = ON');
}

addCol('employees', 'phone', 'TEXT');
addCol('employees', 'email', 'TEXT');
addCol('employees', 'emergency_name', 'TEXT');
addCol('employees', 'emergency_phone', 'TEXT');
addCol('employees', 'contract_hours', 'REAL');
addCol('employees', 'holiday_days', 'REAL NOT NULL DEFAULT 28');
addCol('notices', 'scope_type', "TEXT NOT NULL DEFAULT 'all'");
addCol('notices', 'scope_id', 'INTEGER');

db.exec(`
CREATE TABLE IF NOT EXISTS leave (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('holiday','sickness','other')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  valid_months INTEGER,
  jobs TEXT NOT NULL DEFAULT 'all',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS completions (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  completed_date TEXT NOT NULL,
  expires_date TEXT,
  signed_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  items TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS checklist_runs (
  checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  date TEXT NOT NULL,
  ticks TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  done_by TEXT NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (checklist_id, store_id, date)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`);


db.exec(`
CREATE INDEX IF NOT EXISTS emp_store ON employees (store_id, active);
CREATE INDEX IF NOT EXISTS doc_emp ON documents (employee_id, expiry_date);
CREATE INDEX IF NOT EXISTS leave_emp ON leave (employee_id, status);
CREATE INDEX IF NOT EXISTS comp_emp ON completions (employee_id, course_id);
CREATE INDEX IF NOT EXISTS shift_emp ON shifts (employee_id, date);
CREATE INDEX IF NOT EXISTS user_emp ON users (employee_id);
`);

// Open shifts: a shift can exist before anyone is assigned to it, so it carries its own role.
if (!hasCol('shifts', 'job')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE shifts_new (
        id INTEGER PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id),
        date TEXT NOT NULL,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        job TEXT NOT NULL CHECK (job IN ('manager','instore','driver')),
        start_min INTEGER NOT NULL,
        end_min INTEGER NOT NULL,
        closing INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO shifts_new (id, store_id, date, employee_id, job, start_min, end_min, closing)
        SELECT sh.id, sh.store_id, sh.date, sh.employee_id, e.job, sh.start_min, sh.end_min, sh.closing FROM shifts sh JOIN employees e ON e.id = sh.employee_id;
      DROP TABLE shifts;
      ALTER TABLE shifts_new RENAME TO shifts;
      CREATE INDEX shifts_day ON shifts (store_id, date);
      CREATE INDEX shift_emp ON shifts (employee_id, date);`);
  })();
  db.pragma('foreign_keys = ON');
}

// Optimal staffing: for an hour forecast at or above sales_from, this many insiders and drivers.
db.exec(`CREATE TABLE IF NOT EXISTS staffing_bands (
  sales_from REAL PRIMARY KEY, insiders INTEGER NOT NULL, drivers INTEGER NOT NULL)`);
if (!db.prepare('SELECT 1 FROM staffing_bands').get()) {
  const ins = db.prepare('INSERT INTO staffing_bands VALUES (?,?,?)');
  [[0, 1, 1], [80, 2, 1], [150, 2, 2], [250, 2, 3], [350, 3, 4], [500, 4, 5], [700, 5, 6]].forEach(b => ins.run(...b));
}

module.exports = db;
