'use strict';
// Sets a new password for an existing user, keeping all data. Works with SQLite or SQL Server
// (same environment variables as the server).
//   node scripts/reset-password.js            -> lists the users
//   node scripts/reset-password.js EMAIL NEWPASSWORD
const crypto = require('crypto');
const path = require('path');
const { openFromEnv } = require('../lib/db');

(async () => {
  const [email, pw] = process.argv.slice(2);
  const db = await openFromEnv(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  if (!email) {
    const rows = await db.q('SELECT email, name, role FROM users ORDER BY id', []);
    console.log(rows.length ? rows.map((r) => `${r.email}  (${r.name}, ${r.role})`).join('\n') : 'No users yet: open the site and create the first account.');
  } else {
    if (!pw || pw.length < 8 || pw.length > 200) throw new Error('The new password must be 8 characters or more.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
    const r = await db.run('UPDATE users SET pass_hash=?, salt=? WHERE email=?', [hash, salt, email.trim().toLowerCase()]);
    if (!r.changes) throw new Error('No user with that email. Run the script without arguments to list the users.');
    await db.run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=?)', [email.trim().toLowerCase()]);
    console.log('Password updated. You can log in now.');
  }
  await db.close();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
