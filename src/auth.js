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

function setSessionCookie(res, value, maxAgeSeconds) {
  const parts = [
    `${config.session.cookie}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`
  ];
  if (config.session.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

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
  req.user = { id: user.id, email: user.email, name: user.name, role: user.role, active: Boolean(user.active) };
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
const MAX_KEYS = 10000;

/**
 * Counts failures per key within a fixed window. Memory is bounded by evicting
 * the oldest keys one at a time — never by clearing everything, or an attacker
 * could spray junk keys to wipe the counter on the account they're guessing.
 */
function limiter(max) {
  const hits = new Map();
  const live = (key) => {
    const entry = hits.get(key);
    if (entry && Date.now() - entry.first > WINDOW_MS) { hits.delete(key); return null; }
    return entry || null;
  };
  return {
    blocked: (key) => (live(key)?.count || 0) >= max,
    fail(key) {
      const entry = live(key);
      if (entry) { entry.count += 1; return; }
      hits.set(key, { first: Date.now(), count: 1 });
      while (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value); // Map keeps insertion order
    },
    clear: (key) => hits.delete(key)
  };
}

// One address guessing one account, and one address guessing across many accounts.
const perAccount = limiter(8);
const perIp = limiter(30);
// First-run setup code and "current password" checks.
const setupTries = limiter(10);
const passwordTries = limiter(8);

const loginBlocked = (email, ip) => perAccount.blocked(`${email}|${ip}`) || perIp.blocked(ip);
function noteLoginFailure(email, ip) {
  perAccount.fail(`${email}|${ip}`);
  perIp.fail(ip);
}
// Only the account's own counter resets; the address keeps its tally for the window.
const clearLoginFailures = (email, ip) => perAccount.clear(`${email}|${ip}`);

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

function publicUser(user) {
  return {
    id: user.id, email: user.email, name: user.name, role: user.role,
    active: Boolean(user.active), lastLoginAt: user.last_login_at || null,
    permissions: permissionsFor(user.role)
  };
}

module.exports = {
  hashPassword, verifyPassword, checkPasswordStrength, sha256, token, limiter,
  startSession, endSession, loadUser, requireUser, allow, sameOrigin,
  loginBlocked, noteLoginFailure, clearLoginFailures, setupTries, passwordTries, setupCode, setupCodeMatches, publicUser, parseCookies
};
