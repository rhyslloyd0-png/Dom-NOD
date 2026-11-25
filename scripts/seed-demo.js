// Fills one store with INVENTED sample people and a sample week so the screens have something to show.
// Usage: npm run seed:demo -- "<Store name>"   (wipes that store's team, rota and compliance items first)
const db = require('../db');
const storeName = process.argv[2];
if (!storeName) { console.error('Usage: npm run seed:demo -- "<Store name>"'); process.exit(1); }
db.prepare('INSERT OR IGNORE INTO stores (name) VALUES (?)').run(storeName);
const store = db.prepare('SELECT id FROM stores WHERE name = ?').get(storeName).id;

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const day = n => { const t = new Date(today + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

db.transaction(() => {
  db.prepare('DELETE FROM shifts WHERE store_id = ?').run(store);
  db.prepare('DELETE FROM forecasts WHERE store_id = ?').run(store);
  db.prepare('DELETE FROM company_items WHERE store_id = ?').run(store);
  db.prepare('DELETE FROM employees WHERE store_id = ?').run(store);

  const addEmp = db.prepare('INSERT INTO employees (store_id, first_name, last_name, job, job_title, hourly_rate, start_date, has_contract) VALUES (?,?,?,?,?,?,?,?)');
  const people = [
    ['Sam', 'Okafor', 'manager', 'Store Manager', 14.5, 1], ['Priya', 'Nair', 'manager', 'Shift Manager', 13.2, 1],
    ['Tomos', 'Bevan', 'instore', 'Instore', 12.21, 1], ['Elin', 'Marsh', 'instore', 'Instore', 12.21, 0],
    ['Dan', 'Whitlock', 'driver', 'Driver', 12.21, 1], ['Aisha', 'Rahman', 'driver', 'Driver', 12.21, 1],
    ['Lewis', 'Carter', 'driver', 'Driver', 12.21, 1], ['Megan', 'Doyle', 'driver', 'Driver', 12.21, 1]
  ].map(p => ({ id: addEmp.run(store, p[0], p[1], p[2], p[3], p[4], day(-200), p[5]).lastInsertRowid, job: p[2] }));

  const addDoc = db.prepare('INSERT INTO documents (employee_id, category, doc_type, expiry_date) VALUES (?,?,?,?)');
  addDoc.run(people[5].id, 'rtw', 'Online RTW Check', day(-7));
  addDoc.run(people[4].id, 'job', 'MOT', day(-40));
  addDoc.run(people[5].id, 'job', 'MOT', day(-2));
  addDoc.run(people[6].id, 'job', 'MOT', day(16));
  addDoc.run(people[6].id, 'job', 'Certificate of Motor Insurance', day(18));
  addDoc.run(people[7].id, 'job', 'Certificate of Motor Insurance', day(50));
  addDoc.run(people[2].id, 'additional', 'Food Hygiene Level 2', day(30));

  const addItem = db.prepare('INSERT INTO company_items (store_id, kind, name, done_date, expiry_date) VALUES (?,?,?,?,?)');
  addItem.run(store, 'register', 'Fire Alarm Test Register', day(-20), day(10));
  addItem.run(store, 'policy', 'Fire Risk Assessment', day(-340), day(25));
  addItem.run(store, 'certificate', 'Gas Safety Certificate', day(-360), day(5));

  const jobOf = Object.fromEntries(people.map(p => [p.id, p.job]));
  const insShift = db.prepare('INSERT INTO shifts (store_id, date, employee_id, job, start_min, end_min, closing) VALUES (?,?,?,?,?,?,?)');
  const addShift = { run: (st, d, emp, a, b, cl) => insShift.run(st, d, emp, jobOf[emp], a, b, cl) };
  const addFc = db.prepare('INSERT INTO forecasts (store_id, date, hour, sales, orders) VALUES (?,?,?,?,?)');
  const curve = [0, 26, 111, 100, 62, 54, 76, 285, 439, 310, 250, 119, 105, 146, 2];
  for (let d = -28; d <= 3; d++) {
    const date = day(d), k = [5, 6].includes(new Date(date + 'T12:00:00Z').getUTCDay()) ? 1.6 : 1;
    addShift.run(store, date, people[0].id, 630, 1200, 0);
    addShift.run(store, date, people[1].id, 1020, 1500, 1);
    addShift.run(store, date, people[2].id, 1080, 1380, 0);
    addShift.run(store, date, people[4].id, 660, 1140, 0);
    addShift.run(store, date, people[5].id, 960, 1260, 0);
    addShift.run(store, date, people[6].id, 1020, 1440, 0);
    addShift.run(store, date, people[7].id, 1080, 1500, 1);
    curve.forEach((v, i) => addFc.run(store, date, 10 + i, Math.round(v * k), +(v * k / 22).toFixed(2)));
  }

  // Structure, training courses and checklists, only if none exist yet.
  if (!db.prepare('SELECT area_id FROM stores WHERE id = ?').get(store).area_id) {
    db.prepare('INSERT OR IGNORE INTO regions (name) VALUES (?)').run('Sample Region');
    const region = db.prepare('SELECT id FROM regions WHERE name = ?').get('Sample Region').id;
    db.prepare('INSERT OR IGNORE INTO areas (name, region_id) VALUES (?,?)').run('Sample Area', region);
    db.prepare('UPDATE stores SET area_id = (SELECT id FROM areas WHERE name = ?) WHERE id = ?').run('Sample Area', store);
  }
  if (!db.prepare('SELECT 1 FROM courses').get()) {
    const addC = db.prepare('INSERT INTO courses (title, description, valid_months, jobs) VALUES (?,?,?,?)');
    const c1 = addC.run('Food safety level 2', 'Sample course. Core food hygiene for everyone handling food.', 36, 'all').lastInsertRowid;
    addC.run('Fire safety', 'Sample course. Alarm points, exits and assembly.', 12, 'all');
    addC.run('Safe delivery driving', 'Sample course. Vehicle checks and safe delivery.', 12, 'driver');
    addC.run('Shift running', 'Sample course. Opening, closing and cash handling.', null, 'manager');
    const done = db.prepare('INSERT INTO completions (course_id, employee_id, completed_date, expires_date, signed_by) VALUES (?,?,?,?,?)');
    people.slice(0, 5).forEach(p => done.run(c1, p.id, day(-90), day(1000), 'Sample Author'));
  }
  if (!db.prepare('SELECT 1 FROM checklists').get()) {
    const addL = db.prepare('INSERT INTO checklists (name, items) VALUES (?,?)');
    addL.run('Opening checks', JSON.stringify(['Fridge and freezer temperatures logged', 'Hand wash stations stocked', 'Ovens on and up to temperature', 'Floats counted', 'Date labels checked']));
    addL.run('Closing checks', JSON.stringify(['Food wrapped, labelled and put away', 'Surfaces and floors cleaned', 'Bins emptied', 'Cash counted and banked', 'Doors locked and alarm set']));
  }
  const addLeave = db.prepare("INSERT INTO leave (employee_id, kind, start_date, end_date, days, note, status, requested_by, decided_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  addLeave.run(people[2].id, 'holiday', day(10), day(14), 5, 'Family trip', 'pending', 'Tomos Bevan', null, new Date().toISOString());
  addLeave.run(people[6].id, 'holiday', day(20), day(22), 3, '', 'approved', 'Lewis Carter', 'Sample Author', new Date().toISOString());

  if (!db.prepare('SELECT 1 FROM notices').get()) {
    const addN = db.prepare('INSERT INTO notices (title, type, body, created_by, issued) VALUES (?,?,?,?,?)');
    addN.run('Holiday requests', 'Notice', 'Sample notice. Holiday requests need four weeks\' notice and go through your store manager.', 'Sample Author', day(-60));
    addN.run('Drivers mileage', 'Notice', 'Sample notice. Keep your mileage log up to date each shift.', 'Sample Author', day(-20));
  }
})();
console.log(`Sample data loaded for ${storeName}.`);
