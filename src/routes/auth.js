/** Sign in and out, first-run setup, setting a password from an invite or reset link, and two-step sign-in. */
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const { audit } = require('../audit');
const { fail } = require('../errors');
const { text, email } = require('../validate');
const totp = require('../totp');

const router = express.Router();

router.get('/auth/status', async (req, res) => {
  const anyUser = await db.knex('users').first('id');
  res.json({ needsSetup: !anyUser, signedIn: Boolean(req.user) });
});

/** Creates the first owner. Only works while there are no users, and needs the code printed in the server console. */
router.post('/auth/setup', async (req, res) => {
  const { name, password, setupCode, companyName } = req.body || {};
  const address = email(req.body?.email);
  // The code is short enough to type, so guessing it must be slow.
  if (!(await auth.setupTries.take(req.ip))) fail(429, 'Too many wrong setup codes. Wait 15 minutes and try again.');
  if (!auth.setupCodeMatches(setupCode)) fail(403, 'That setup code is wrong. It is printed in the terminal where the server is running.');
  await auth.setupTries.giveBack(req.ip);
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
  res.status(201).json(await auth.publicUser(user));
});

const PAUSED = "So many wrong passwords have been tried on this account that sign-in from new devices is paused for 15 minutes. " +
  "Use a device you've signed in on before, or ask the owner for a reset link.";

router.post('/auth/login', async (req, res) => {
  const address = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const code = String(req.body?.code || '').trim();
  const user = address ? await db.knex('users').where({ email: address }).first() : null;

  // Counted before anything slow. Paused accounts are refused before the password is looked at,
  // so a guesser learns nothing, and unknown emails pause the same way as real ones.
  const attempt = await auth.loginAttempt(address, req.ip, () => auth.knownDevice(req, user?.id));
  if (attempt.blocked) fail(429, 'Too many attempts. Wait 15 minutes, or ask the owner to send you a reset link.');
  if (attempt.paused) fail(429, PAUSED);
  // Real passwords are capped at 200 characters; don't spend scrypt time on megabytes of junk.
  if (password.length > 200) fail(401, 'Email or password is wrong.');

  // Always run a hash comparison so response time doesn't reveal which emails exist.
  const ok = user && user.password_hash
    ? await auth.verifyPassword(password, user.password_hash)
    : (await auth.verifyPassword(password, await dummyHash()), false);

  if (!ok || !user.active) {
    // Recorded against the account but not as done by its owner — whoever typed it is unknown.
    if (user) await audit(db.knex, { user: { id: null, name: 'Unknown' }, ip: req.ip }, { action: 'login-failed', entity: 'user', entityId: user.id, summary: `Failed sign-in attempt for ${user.email}` });
    fail(401, !ok ? 'Email or password is wrong.' : 'This account has been switched off. Ask the owner.');
  }

  let second = null;
  if (user.totp_secret) {
    if (!code) {
      await attempt.fine(); // right password; they just haven't been asked for the code yet
      fail(401, 'Enter the 6-digit code from your authenticator app.', { needsCode: true });
    }
    second = await db.tx((trx) => auth.useSecondFactor(trx, user.id, code));
    if (!second) {
      await audit(db.knex, { user: { id: null, name: 'Unknown' }, ip: req.ip }, { action: 'login-failed', entity: 'user', entityId: user.id, summary: `Right password but wrong two-step code for ${user.email}` });
      fail(401, 'That code is wrong or was already used. Wait for the next one and try again.', { needsCode: true });
    }
  }

  await attempt.fine();
  await db.tx(async (trx) => {
    await auth.startSession(trx, res, user, req);
    const how = second === 'recovery' ? ' with a recovery code' : '';
    await audit(trx, { user, ip: req.ip }, { action: 'login', entity: 'user', entityId: user.id, summary: `${user.name} signed in${how}` });
  });
  res.json(await auth.publicUser(await db.knex('users').where({ id: user.id }).first()));
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
  res.json(await auth.publicUser(user));
});

/**
 * For someone already signed in: counts the attempt, then re-checks their
 * password. Wrong answers (password or two-step code) share one budget per user.
 * Call done() only once the whole request has succeeded — a right password
 * with a wrong code still counts, or a stolen session that knows the password
 * could guess two-step codes forever.
 */
async function takeTry(req) {
  if (!(await auth.passwordTries.take(req.user.id))) fail(429, 'Too many wrong tries. Wait 15 minutes and try again.');
  return () => auth.passwordTries.giveBack(req.user.id);
}

async function confirmPassword(req, password, message = 'Your password is wrong.') {
  const done = await takeTry(req);
  const user = await db.knex('users').where({ id: req.user.id }).first();
  if (!(await auth.verifyPassword(password, user.password_hash))) fail(400, message);
  return { user, done };
}

router.post('/auth/password', auth.requireUser, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  // Stops a borrowed or stolen session from guessing its way to the real password.
  const { user, done } = await confirmPassword(req, currentPassword, 'Your current password is wrong.');
  await done();
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
  res.json({ purpose: row.purpose, email: user.email, name: user.name, twoStep: Boolean(user.totp_secret) });
});

router.post('/auth/link/:token', async (req, res) => {
  auth.checkPasswordStrength(req.body?.password);
  const hash = await auth.hashPassword(req.body.password);
  // Limits live outside the transaction: on SQLite, db.knex inside tx() would wait on itself.
  const { user: linked } = await findToken(db.knex, req.params.token);
  const counted = Boolean(linked.totp_secret);
  if (counted && !(await auth.passwordTries.take(linked.id))) fail(429, 'Too many wrong codes. Wait 15 minutes and try again.');
  const user = await db.tx(async (trx) => {
    const { row, user: u } = await findToken(trx, req.params.token);
    // A reset link replaces the password, not the phone. Lost both? The owner can reset two-step under Team.
    if (u.totp_secret) {
      if (!req.body?.code) fail(400, 'Enter the 6-digit code from your authenticator app.', { needsCode: true });
      if (!(await auth.useSecondFactor(trx, u.id, req.body.code))) fail(400, 'That code is wrong or was already used.', { needsCode: true, badCode: true });
    }
    await trx('password_tokens').where({ id: row.id }).update({ used_at: db.now() });
    await trx('users').where({ id: u.id }).update({ password_hash: hash, updated_at: db.now() });
    await trx('sessions').where({ user_id: u.id }).del();
    await audit(trx, { user: u, ip: req.ip }, { action: 'password', entity: 'user', entityId: u.id, summary: `${u.name} set a password from ${row.purpose === 'invite' ? 'an invite' : 'a reset'} link` });
    await auth.startSession(trx, res, u, req);
    return u;
  }).catch(async (err) => {
    // Only a wrong code counts against them; anything else (no code yet, weak password) is handed back.
    if (err.extra?.badCode) delete err.extra.badCode;
    else if (counted) await auth.passwordTries.giveBack(linked.id);
    throw err;
  });
  if (counted) await auth.passwordTries.giveBack(linked.id);
  res.json(await auth.publicUser(await db.knex('users').where({ id: user.id }).first()));
});

/* ---------- two-step sign-in ---------- */

const issuer = async () => `Hesabu ${(await settings.company()).name}`.replace(/:/g, '').slice(0, 60);

/** Step 1: confirm the password, get a secret to put in the authenticator app. Nothing changes until step 2. */
router.post('/auth/two-step/start', auth.requireUser, async (req, res) => {
  const { user, done } = await confirmPassword(req, req.body?.password);
  await done();
  if (user.totp_secret) fail(400, 'Two-step sign-in is already on.');
  const secret = totp.newSecret();
  await db.knex('users').where({ id: user.id }).update({ totp_pending: secret });
  res.json({ secret, uri: totp.uri(secret, user.email, await issuer()) });
});

/** Step 2: a code from the app proves it's set up. Turns two-step on and hands back recovery codes, once. */
router.post('/auth/two-step/enable', auth.requireUser, async (req, res) => {
  const done = await takeTry(req);
  const codes = await db.tx(async (trx) => {
    const user = await db.lock(trx('users').where({ id: req.user.id })).first();
    if (user.totp_secret) fail(400, 'Two-step sign-in is already on.');
    if (!user.totp_pending) fail(400, 'Start again: enter your password to get a new setup key.');
    const step = totp.verify(user.totp_pending, req.body?.code);
    if (step === null) return null;
    const recovery = totp.newRecoveryCodes();
    await trx('users').where({ id: user.id }).update({
      totp_secret: user.totp_pending, totp_pending: null, totp_last_step: step,
      totp_recovery: JSON.stringify(recovery.map(totp.hashRecovery)), totp_enabled_at: db.now(), updated_at: db.now()
    });
    // Other browsers signed in without a code; make them sign in again with one.
    await trx('sessions').where({ user_id: user.id }).whereNot({ id: req.sessionId }).del();
    await audit(trx, req, { action: 'two-step', entity: 'user', entityId: user.id, summary: `${user.name} turned on two-step sign-in` });
    return recovery;
  });
  if (!codes) fail(400, "That code doesn't match. Check the phone's clock is set automatically, then type the newest code.");
  await done();
  res.json({ recoveryCodes: codes, me: await auth.publicUser(await db.knex('users').where({ id: req.user.id }).first()) });
});

/** Password plus a current code (or a recovery code) for anything that weakens or replaces two-step. */
async function confirmBoth(req) {
  const { user, done } = await confirmPassword(req, req.body?.password);
  if (!user.totp_secret) { await done(); fail(400, 'Two-step sign-in is not on.'); }
  return { user, done };
}

const badCode = () => fail(400, 'That code is wrong or was already used.');

router.post('/auth/two-step/disable', auth.requireUser, async (req, res) => {
  const { user, done } = await confirmBoth(req);
  if (await auth.mustEnrol({ ...user, totp_secret: null })) {
    await done();
    fail(400, 'Your business requires two-step sign-in for your role. An owner can change that under Team.');
  }
  const ok = await db.tx(async (trx) => {
    if (!(await auth.useSecondFactor(trx, user.id, req.body?.code))) return false;
    await trx('users').where({ id: user.id }).update({
      totp_secret: null, totp_pending: null, totp_last_step: null, totp_recovery: null, totp_enabled_at: null, updated_at: db.now()
    });
    await audit(trx, req, { action: 'two-step', entity: 'user', entityId: user.id, summary: `${user.name} turned off two-step sign-in` });
    return true;
  });
  if (!ok) badCode();
  await done();
  res.json(await auth.publicUser(await db.knex('users').where({ id: user.id }).first()));
});

router.post('/auth/two-step/recovery-codes', auth.requireUser, async (req, res) => {
  const { user, done } = await confirmBoth(req);
  const codes = await db.tx(async (trx) => {
    if (!(await auth.useSecondFactor(trx, user.id, req.body?.code))) return null;
    const recovery = totp.newRecoveryCodes();
    await trx('users').where({ id: user.id }).update({ totp_recovery: JSON.stringify(recovery.map(totp.hashRecovery)), updated_at: db.now() });
    await audit(trx, req, { action: 'two-step', entity: 'user', entityId: user.id, summary: `${user.name} made new two-step recovery codes` });
    return recovery;
  });
  if (!codes) badCode();
  await done();
  res.json({ recoveryCodes: codes });
});

module.exports = router;
