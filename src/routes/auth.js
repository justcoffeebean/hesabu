/** Sign in and out, first-run setup, and setting a password from an invite or reset link. */
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const { audit } = require('../audit');
const { fail } = require('../errors');
const { text, email } = require('../validate');

const router = express.Router();

router.get('/auth/status', async (req, res) => {
  const anyUser = await db.knex('users').first('id');
  res.json({ needsSetup: !anyUser, signedIn: Boolean(req.user) });
});

/** Creates the first owner. Only works while there are no users, and needs the code printed in the server console. */
router.post('/auth/setup', async (req, res) => {
  const { name, password, setupCode, companyName } = req.body || {};
  const address = email(req.body?.email);
  if (!auth.setupCodeMatches(setupCode)) fail(403, 'That setup code is wrong. It is printed in the terminal where the server is running.');
  if (!text(name)) fail(400, 'Enter your name.');
  if (!address) fail(400, 'Enter your email address.');
  auth.checkPasswordStrength(password);
  const hash = await auth.hashPassword(password);

  const user = await db.tx(async (trx) => {
    if (await trx('users').first('id')) fail(409, 'This Hesabu already has an owner. Sign in instead.');
    const row = { id: db.newId(), email: address, name: text(name, 120), role: 'owner', password_hash: hash, active: true, created_at: db.now() };
    await trx('users').insert(row);
    if (text(companyName)) {
      const company = await settings.company(trx);
      await db.putSetting(trx, 'company', { ...company, name: text(companyName) });
    }
    await audit(trx, { user: row, ip: req.ip }, { action: 'setup', entity: 'user', entityId: row.id, summary: `${row.name} set up Hesabu as owner` });
    await auth.startSession(trx, res, row, req);
    return row;
  });
  res.status(201).json(auth.publicUser(user));
});

router.post('/auth/login', async (req, res) => {
  const address = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const key = `${address}|${req.ip}`;
  if (auth.loginBlocked(key)) fail(429, 'Too many attempts. Wait 15 minutes, or ask the owner to send you a reset link.');

  const user = address ? await db.knex('users').where({ email: address }).first() : null;
  // Always run a hash comparison so response time doesn't reveal which emails exist.
  const ok = user && user.password_hash
    ? await auth.verifyPassword(password, user.password_hash)
    : (await auth.verifyPassword(password, await dummyHash()), false);

  if (!ok || !user.active) {
    auth.noteLoginFailure(key);
    // Recorded against the account but not as done by its owner — whoever typed it is unknown.
    if (user) await audit(db.knex, { user: { id: null, name: 'Unknown' }, ip: req.ip }, { action: 'login-failed', entity: 'user', entityId: user.id, summary: `Failed sign-in attempt for ${user.email}` });
    fail(401, !ok ? 'Email or password is wrong.' : 'This account has been switched off. Ask the owner.');
  }
  auth.clearLoginFailures(key);
  await db.tx(async (trx) => {
    await auth.startSession(trx, res, user, req);
    await audit(trx, { user, ip: req.ip }, { action: 'login', entity: 'user', entityId: user.id, summary: `${user.name} signed in` });
  });
  res.json(auth.publicUser(user));
});

let cachedDummy = null;
async function dummyHash() {
  if (!cachedDummy) cachedDummy = await auth.hashPassword('not-a-real-password-just-timing');
  return cachedDummy;
}

router.post('/auth/logout', async (req, res) => {
  await auth.endSession(req, res);
  res.status(204).end();
});

router.get('/auth/me', auth.requireUser, async (req, res) => {
  const user = await db.knex('users').where({ id: req.user.id }).first();
  res.json(auth.publicUser(user));
});

router.post('/auth/password', auth.requireUser, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = await db.knex('users').where({ id: req.user.id }).first();
  if (!(await auth.verifyPassword(currentPassword, user.password_hash))) fail(400, 'Your current password is wrong.');
  auth.checkPasswordStrength(newPassword);
  const hash = await auth.hashPassword(newPassword);
  await db.tx(async (trx) => {
    await trx('users').where({ id: user.id }).update({ password_hash: hash, updated_at: db.now() });
    // Sign out everywhere else; keep this browser signed in.
    await trx('sessions').where({ user_id: user.id }).whereNot({ id: req.sessionId }).del();
    await audit(trx, req, { action: 'password', entity: 'user', entityId: user.id, summary: `${user.name} changed their password` });
  });
  res.status(204).end();
});

/* ---------- invite / reset links ---------- */

async function findToken(conn, raw) {
  const row = await conn('password_tokens').where({ id: auth.sha256(String(raw || '')) }).first();
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
    fail(410, 'This link has expired or was already used. Ask the owner for a new one.');
  }
  const user = await conn('users').where({ id: row.user_id }).first();
  if (!user || !user.active) fail(410, 'This account has been switched off.');
  return { row, user };
}

router.get('/auth/link/:token', async (req, res) => {
  const { row, user } = await findToken(db.knex, req.params.token);
  res.json({ purpose: row.purpose, email: user.email, name: user.name });
});

router.post('/auth/link/:token', async (req, res) => {
  auth.checkPasswordStrength(req.body?.password);
  const hash = await auth.hashPassword(req.body.password);
  const user = await db.tx(async (trx) => {
    const { row, user: u } = await findToken(trx, req.params.token);
    await trx('password_tokens').where({ id: row.id }).update({ used_at: db.now() });
    await trx('users').where({ id: u.id }).update({ password_hash: hash, updated_at: db.now() });
    await trx('sessions').where({ user_id: u.id }).del();
    await audit(trx, { user: u, ip: req.ip }, { action: 'password', entity: 'user', entityId: u.id, summary: `${u.name} set a password from ${row.purpose === 'invite' ? 'an invite' : 'a reset'} link` });
    await auth.startSession(trx, res, u, req);
    return u;
  });
  res.json(auth.publicUser(user));
});

module.exports = router;
