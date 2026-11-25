// Bulk load team members from a CSV file.
//   npm run import -- staff.csv
// Header row (any order): shop, first_name, last_name, job, job_title, hourly_rate, start_date, contract_hours, holiday_days, area, region
// job is manager, instore or driver. start_date is YYYY-MM-DD. Shops, areas and regions are created if missing.
// Rows that match an existing active person (same shop, first and last name) are skipped, so the file can be re-run.
const fs = require('fs');
const db = require('../db');
const file = process.argv[2];
if (!file) { console.error('Usage: npm run import -- <file.csv>'); process.exit(1); }

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const head = rows.shift().map(x => x.trim().toLowerCase());
for (const need of ['shop', 'first_name', 'last_name', 'job']) if (!head.includes(need)) { console.error('Missing column: ' + need); process.exit(1); }
const id = (table, name, extra = {}) => {
  if (!name) return null;
  const cols = ['name', ...Object.keys(extra)];
  db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(name, ...Object.values(extra));
  return db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name).id;
};
let added = 0, skipped = 0; const problems = [];
db.transaction(() => rows.forEach((r, n) => {
  const v = Object.fromEntries(head.map((k, i) => [k, (r[i] || '').trim()]));
  const job = v.job.toLowerCase();
  if (!v.shop || !v.first_name || !v.last_name || !['manager', 'instore', 'driver'].includes(job)) { problems.push(`row ${n + 2}: needs shop, names and a job of manager, instore or driver`); return; }
  const region = id('regions', v.region), area = v.area ? id('areas', v.area, region ? { region_id: region } : {}) : null;
  const store = id('stores', v.shop);
  if (area) db.prepare('UPDATE stores SET area_id = ? WHERE id = ? AND area_id IS NULL').run(area, store);
  if (db.prepare('SELECT 1 FROM employees WHERE store_id = ? AND first_name = ? AND last_name = ? AND active = 1').get(store, v.first_name, v.last_name)) { skipped++; return; }
  db.prepare(`INSERT INTO employees (store_id, first_name, last_name, job, job_title, hourly_rate, start_date, contract_hours, holiday_days) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(store, v.first_name, v.last_name, job, v.job_title || '', Number(v.hourly_rate) || 0, /^\d{4}-\d{2}-\d{2}$/.test(v.start_date) ? v.start_date : null, v.contract_hours ? Number(v.contract_hours) : null, v.holiday_days ? Number(v.holiday_days) : 28);
  added++;
}))();
console.log(`Added ${added}, skipped ${skipped} already on file.`);
problems.slice(0, 20).forEach(p => console.log('  ' + p));
if (problems.length > 20) console.log(`  and ${problems.length - 20} more rows with problems`);
