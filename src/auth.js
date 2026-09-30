/**
 * Passwords, sessions and the middleware that guards /api.
 *
 * - Passwords: scrypt with a per-user salt (Node's crypto, no native add-ons).
 * - Sessions: a random token in an HttpOnly, SameSite=Lax cookie. Only its
 *   SHA-256 is stored, so a leaked database can't be replayed as logins.
 * - CSRF: SameSite=Lax keeps the cookie off cross-site POSTs, and any request
 *   that changes data must come from our own Origin.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('./config');
const db = require('./db');
const settings = require('./settings');
const totp = require('./totp');
const { can, permissionsFor } = require('./permissions');
const { fail } = require('./errors');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const MIN_PASSWORD = 10;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, N, r, p, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

function checkPasswordStrength(password) {
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD) fail(400, `Use at least ${MIN_PASSWORD} characters for the password.`);
  if (pw.length > 200) fail(400, 'That password is too long.');
}

/* ---------- sessions ---------- */

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i <= 0) return;
    // A malformed %-sequence (from another app on the same host, or a tampered cookie) is skipped, not a 500.
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  });
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.session.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

const setSessionCookie = (res, value, maxAgeSeconds) => setCookie(res, config.session.cookie, value, maxAgeSeconds);

async function startSession(trx, res, user, req) {
  const raw = token();
  const at = new Date();
  const expires = new Date(at.getTime() + config.session.days * 86400000);
  await trx('sessions').insert({
    id: sha256(raw),
    user_id: user.id,
    created_at: at.toISOString(),
    last_seen_at: at.toISOString(),
    expires_at: expires.toISOString(),
    ip: String(req.ip || '').slice(0, 64),
    user_agent: String(req.get('user-agent') || '').slice(0, 300)
  });
  await trx('users').where({ id: user.id }).update({ last_login_at: at.toISOString() });
  setSessionCookie(res, raw, config.session.days * 86400);
  await rememberDevice(trx, req, res, user.id);
}

/* ---------- known devices ---------- */

/**
 * A long-lived random cookie that says "this browser has signed in to these
 * accounts before". When an account is under attack from many addresses,
 * sign-in pauses for new browsers only, so the attacker can't lock the real
 * person out of the devices they already use.
 */
const DEVICE_COOKIE = 'hesabu_device';
const DEVICE_DAYS = 365;

function deviceToken(req) {
  const raw = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
}

async function rememberDevice(trx, req, res, userId) {
  const raw = deviceToken(req) || token();
  setCookie(res, DEVICE_COOKIE, raw, DEVICE_DAYS * 86400);
  const at = new Date().toISOString();
  await trx('known_devices')
    .insert({ device_hash: sha256(raw), user_id: userId, created_at: at, last_seen_at: at })
    .onConflict(['device_hash', 'user_id']).merge({ last_seen_at: at });
}

async function knownDevice(req, userId) {
  const raw = deviceToken(req);
  if (!raw || !userId) return false;
  return Boolean(await db.knex('known_devices').where({ device_hash: sha256(raw), user_id: userId }).first());
}

async function endSession(req, res) {
  const raw = parseCookies(req.headers.cookie)[config.session.cookie];
  if (raw) await db.knex('sessions').where({ id: sha256(raw) }).del();
  setSessionCookie(res, '', 0);
}

/** Attaches req.user when a valid session cookie is present. Never rejects on its own. */
async function loadUser(req, _res, next) {
  const raw = parseCookies(req.headers.cookie)[config.session.cookie];
  if (!raw) return next();
  const session = await db.knex('sessions').where({ id: sha256(raw) }).first();
  if (!session) return next();

  const nowMs = Date.now();
  // Sliding expiry keeps an active session alive, but never past maxDays from sign-in.
  const tooOld = nowMs - new Date(session.created_at).getTime() > config.session.maxDays * 86400000;
  if (tooOld || new Date(session.expires_at).getTime() < nowMs) {
    await db.knex('sessions').where({ id: session.id }).del();
    return next();
  }
  const user = await db.knex('users').where({ id: session.user_id }).first();
  if (!user || !user.active) return next();

  // Sliding expiry, but only touch the row once an hour.
  if (nowMs - new Date(session.last_seen_at).getTime() > 3600000) {
    await db.knex('sessions').where({ id: session.id }).update({
      last_seen_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + config.session.days * 86400000).toISOString()
    });
  }
  req.user = {
    id: user.id, email: user.email, name: user.name, role: user.role, active: Boolean(user.active),
    twoStep: Boolean(user.totp_secret), mustEnrol: await mustEnrol(user)
  };
  req.sessionId = session.id;
  next();
}

function requireUser(req, _res, next) {
  if (!req.user) fail(401, 'Please sign in.');
  next();
}

/** Route guard: allow(['invoices:write']) */
const allow = (permission) => (req, _res, next) => {
  if (!req.user) fail(401, 'Please sign in.');
  // Signed in, but the business requires two-step sign-in and they haven't set it up: only /auth/* works.
  if (req.user.mustEnrol) fail(403, 'Set up two-step sign-in to continue. Your business requires it.', { enrolTwoStep: true });
  if (!can(req.user, permission)) fail(403, "Your role doesn't allow that. Ask the owner if you need access.");
  next();
};

/** Rejects state-changing requests whose Origin isn't us. */
function sameOrigin(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) {
    // Browsers that omit Origin still send Sec-Fetch-Site. "same-site" is refused too: SameSite=Lax
    // lets a sibling subdomain's form carry our cookie. Non-browser clients (curl, tests) send neither.
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') fail(403, 'Cross-site request refused.');
    return next();
  }
  let host;
  try { host = new URL(origin).host; } catch { fail(403, 'Bad origin.'); }
  const allowed = new Set([req.get('host')]);
  if (config.publicUrl) allowed.add(new URL(config.publicUrl).host);
  if (!allowed.has(host)) fail(403, 'Cross-site request refused.');
  next();
}

/* ---------- brute-force brake ---------- */

const WINDOW_MS = 15 * 60 * 1000;

// One statement, so two servers (or two requests) counting at once can't lose a hit.
// Both SQLite and PostgreSQL read rate_limits.* as the row before the update.
const COUNT_SQL = `insert into rate_limits (bucket, window_start, hits) values (?, ?, 1)
  on conflict (bucket) do update set
    hits = case when rate_limits.window_start < ? then 1 else rate_limits.hits + 1 end,
    window_start = case when rate_limits.window_start < ? then excluded.window_start else rate_limits.window_start end
  returning hits`;

/**
 * Attempts per key in a fixed 15-minute window, kept in the database so a
 * restart doesn't wipe them and every server behind a load balancer shares them.
 *
 * An attempt is counted *before* the slow check (scrypt, a code), then handed
 * back if it wasn't a wrong guess. Checking first and counting after would let
 * a burst of parallel requests all get in before any of them was counted.
 */
function limiter(name, max) {
  const bucket = (key) => `${name}:${key}`.slice(0, 300);
  async function hits(key) {
    const row = await db.knex('rate_limits').where({ bucket: bucket(key) }).first();
    return row && Date.now() - Number(row.window_start) <= WINDOW_MS ? Number(row.hits) : 0;
  }
  /** Counts one attempt and returns the count including it. */
  async function hit(key) {
    const now = Date.now();
    const result = await db.knex.raw(COUNT_SQL, [bucket(key), now, now - WINDOW_MS, now - WINDOW_MS]);
    return Number((result.rows || result)[0].hits); // pg wraps rows; better-sqlite3 returns them bare
  }
  /** Takes back one attempt that turned out not to be a wrong guess (or that was turned away). */
  const giveBack = (key) => db.knex('rate_limits').where({ bucket: bucket(key) }).where('hits', '>', 0).decrement('hits', 1);
  /** Counts an attempt if there's room for it. False (and nothing counted) when the limit is reached. */
  async function take(key) {
    if ((await hit(key)) <= max) return true;
    await giveBack(key);
    return false;
  }
  return {
    max, hits, hit, take, giveBack,
    blocked: async (key) => (await hits(key)) >= max,
    clear: (key) => db.knex('rate_limits').where({ bucket: bucket(key) }).del()
  };
}

// One address guessing one account, and one address guessing across many accounts.
const perAccountIp = limiter('login', 8);
const perIp = limiter('login-ip', 30);
// Every address together guessing one account. Past this, only known devices may keep trying.
const perAccount = limiter('login-account', 20);
// First-run setup code, and password / two-step checks for someone already signed in.
const setupTries = limiter('setup', 10);
const passwordTries = limiter('password', 8);

/**
 * Counts a sign-in attempt before the password is checked. Returns
 * { blocked } or { paused } when it must be refused, otherwise { fine() }:
 * call fine() once it proves not to be a wrong guess, so it doesn't count.
 * isKnownDevice() is only asked when the account is under attack.
 */
async function loginAttempt(email, ip, isKnownDevice) {
  const pair = `${email}|${ip}`;
  if (!(await perAccountIp.take(pair))) return { blocked: true };
  if (!(await perIp.take(ip))) {
    await perAccountIp.giveBack(pair);
    return { blocked: true };
  }
  if ((await perAccount.hit(email)) > perAccount.max && !(await isKnownDevice())) {
    await Promise.all([perAccountIp.giveBack(pair), perIp.giveBack(ip), perAccount.giveBack(email)]);
    return { paused: true };
  }
  return {
    // The right password clears this address's tally for the account; the address-wide and
    // account-wide tallies only lose this one attempt, so a success doesn't hand an attacker a fresh allowance.
    fine: () => Promise.all([perAccountIp.clear(pair), perIp.giveBack(ip), perAccount.giveBack(email)])
  };
}

/** Housekeeping for the scheduler: expired counters, sessions, and devices unused for over a year. */
async function prune() {
  const at = new Date().toISOString();
  await db.knex('rate_limits').where('window_start', '<', Date.now() - WINDOW_MS).del();
  await db.knex('sessions').where('expires_at', '<', at).del();
  await db.knex('known_devices').where('last_seen_at', '<', new Date(Date.now() - DEVICE_DAYS * 86400000).toISOString()).del();
}

/* ---------- two-step sign-in ---------- */

const TWO_STEP_ROLES = ['owner', 'accounts'];

/** True when the business requires two-step sign-in for this person's role and they haven't set it up. */
async function mustEnrol(user) {
  if (user.totp_secret || !TWO_STEP_ROLES.includes(user.role)) return false;
  return Boolean((await settings.security()).requireTwoStep);
}

/**
 * Accepts a 6-digit code or an unused recovery code, and uses it up so it
 * can't be replayed. Returns 'code', 'recovery', or null. Call inside tx().
 */
async function useSecondFactor(trx, userId, input) {
  const user = await db.lock(trx('users').where({ id: userId })).first();
  if (!user || !user.totp_secret) return null;
  const step = totp.verify(user.totp_secret, input, user.totp_last_step);
  if (step !== null) {
    await trx('users').where({ id: user.id }).update({ totp_last_step: step });
    return 'code';
  }
  const left = JSON.parse(user.totp_recovery || '[]');
  const hash = totp.hashRecovery(input);
  if (totp.normalizeRecovery(input).length === 10 && left.includes(hash)) {
    await trx('users').where({ id: user.id }).update({ totp_recovery: JSON.stringify(left.filter((h) => h !== hash)) });
    return 'recovery';
  }
  return null;
}

/* ---------- first run ---------- */

let generatedSetupCode = null;

/** Code the first owner must type. Printed to the server console, so only whoever runs the server has it. */
function setupCode() {
  if (config.setupCode) return config.setupCode;
  if (!generatedSetupCode) generatedSetupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  return generatedSetupCode;
}

function setupCodeMatches(input) {
  const a = Buffer.from(String(input || '').trim().toUpperCase());
  const b = Buffer.from(setupCode().toUpperCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function publicUser(user) {
  return {
    id: user.id, email: user.email, name: user.name, role: user.role,
    active: Boolean(user.active), lastLoginAt: user.last_login_at || null,
    twoStep: Boolean(user.totp_secret),
    recoveryCodesLeft: user.totp_secret ? JSON.parse(user.totp_recovery || '[]').length : 0,
    mustEnrol: await mustEnrol(user),
    permissions: permissionsFor(user.role)
  };
}

module.exports = {
  hashPassword, verifyPassword, checkPasswordStrength, sha256, token, limiter, WINDOW_MS,
  startSession, endSession, loadUser, requireUser, allow, sameOrigin, knownDevice, DEVICE_COOKIE,
  loginAttempt, setupTries, passwordTries, prune,
  TWO_STEP_ROLES, mustEnrol, useSecondFactor,
  setupCode, setupCodeMatches, publicUser, parseCookies
};
