// Creates or resets a login from the server's command line.
//   npm run user -- <username> "<Full Name>" <level> ["<Shop | Area | Region name>"]
// Levels: staff, supervisor, manager (need a shop), area (needs an area), regional (needs a region), operations, admin.
// Asks for the password on the terminal so it never lands in shell history.
const readline = require('readline');
const bcrypt = require('bcryptjs');
const db = require('../db');

const [username, name, role, place] = process.argv.slice(2);
const LEVELS = ['staff', 'supervisor', 'manager', 'area', 'regional', 'operations', 'admin'];
const usage = () => { console.error('Usage: npm run user -- <username> "<Full Name>" <' + LEVELS.join('|') + '> ["<Shop | Area | Region name>"]'); process.exit(1); };
if (!username || !name || !LEVELS.includes(role)) usage();

const where = { store_id: null, area_id: null, region_id: null };
if (['staff', 'supervisor', 'manager'].includes(role)) {
  if (!place) usage();
  db.prepare('INSERT OR IGNORE INTO stores (name) VALUES (?)').run(place);
  where.store_id = db.prepare('SELECT id FROM stores WHERE name = ?').get(place).id;
} else if (role === 'area') {
  if (!place) usage();
  db.prepare('INSERT OR IGNORE INTO areas (name) VALUES (?)').run(place);
  where.area_id = db.prepare('SELECT id FROM areas WHERE name = ?').get(place).id;
} else if (role === 'regional') {
  if (!place) usage();
  db.prepare('INSERT OR IGNORE INTO regions (name) VALUES (?)').run(place);
  where.region_id = db.prepare('SELECT id FROM regions WHERE name = ?').get(place).id;
}

function ask(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const tty = process.stdin.isTTY;
    rl.question(q, a => { rl.close(); if (tty) process.stdout.write('\n'); resolve(a); });
    if (tty) rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(q); };
  });
}

(async () => {
  const pw = await ask('Password (10+ characters): ');
  if (pw.length < 10) { console.error('Too short.'); process.exit(1); }
  db.prepare(`INSERT INTO users (username, pass_hash, name, role, store_id, area_id, region_id) VALUES (@username, @hash, @name, @role, @store_id, @area_id, @region_id)
    ON CONFLICT (username) DO UPDATE SET pass_hash = excluded.pass_hash, name = excluded.name, role = excluded.role,
      store_id = excluded.store_id, area_id = excluded.area_id, region_id = excluded.region_id, active = 1, must_change = 0`)
    .run({ username: username.toLowerCase(), hash: bcrypt.hashSync(pw, 12), name, role, ...where });
  console.log(`Saved ${role} "${username}"${place ? ' at ' + place : ''}.`);
})();
