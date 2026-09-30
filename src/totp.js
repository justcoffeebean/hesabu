/**
 * Two-step sign-in codes (TOTP, RFC 6238): the 6-digit codes from Google
 * Authenticator, Microsoft Authenticator, Authy, 1Password and friends.
 * SHA-1, 30-second steps, 6 digits — the settings every app supports.
 */
const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not base32.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 random bits, the size RFC 4226 recommends. */
const newSecret = () => base32Encode(crypto.randomBytes(20));

const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

function codeAt(secret, step, digits = DIGITS) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, '0');
}

/**
 * Checks a typed code against the current step and one either side (phone
 * clocks drift). Returns the matching step, or null. Steps at or before
 * lastStep are refused, so a code seen over someone's shoulder can't be reused.
 */
function verify(secret, input, lastStep = -1, ms = Date.now()) {
  const typed = String(input || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const now = stepAt(ms);
  let match = null;
  // Check every candidate so timing doesn't reveal which step matched.
  for (const step of [now - 1, now, now + 1]) {
    const ok = crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(typed));
    if (ok && step > Number(lastStep ?? -1) && match === null) match = step;
  }
  return match;
}

/** otpauth:// link. On a phone, tapping it opens the authenticator app with everything filled in. */
function uri(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

/* ---------- recovery codes ---------- */

const normalizeRecovery = (code) => String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
const hashRecovery = (code) => crypto.createHash('sha256').update(normalizeRecovery(code)).digest('hex');

/** Ten one-time codes like "K7XQM-4TPRA" (50 bits each), for when the phone is lost. */
function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

module.exports = { newSecret, codeAt, stepAt, verify, uri, newRecoveryCodes, hashRecovery, normalizeRecovery, base32Encode, base32Decode };
