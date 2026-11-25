// Usage: npm run user -- <username> "<Full Name>" <admin|manager|staff> "<Store name>" [postcode]
// Asks for the password on the terminal so it never lands in shell history.
const readline = require('readline');
const bcrypt = require('bcryptjs');
const db = require('../db');

const [username, name, role, storeName, postcode] = process.argv.slice(2);
if (!username || !name || !['admin', 'manager', 'staff'].includes(role) || !storeName) {
  console.error('Usage: npm run user -- <username> "<Full Name>" <admin|manager|staff> "<Store name>" [postcode]');
  process.exit(1);
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
  db.prepare('INSERT OR IGNORE INTO stores (name, postcode) VALUES (?, ?)').run(storeName, postcode || null);
  const store = db.prepare('SELECT id FROM stores WHERE name = ?').get(storeName);
  db.prepare(`INSERT INTO users (username, pass_hash, name, role, store_id) VALUES (?,?,?,?,?)
    ON CONFLICT (username) DO UPDATE SET pass_hash = excluded.pass_hash, name = excluded.name, role = excluded.role, store_id = excluded.store_id`)
    .run(username, bcrypt.hashSync(pw, 12), name, role, store.id);
  console.log(`Saved ${role} "${username}" at ${storeName}.`);
})();
