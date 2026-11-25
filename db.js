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

module.exports = db;
