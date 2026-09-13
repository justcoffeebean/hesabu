/** Small input helpers shared by the routes. */
const { fail } = require('./errors');
const { toCents } = require('./totals');

/** Trimmed string capped at max, or null when blank. */
function text(value, max = 200) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function email(value, label = 'Email') {
  const s = text(value, 200);
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(400, `${label} doesn't look like an email address.`);
  return s ? s.toLowerCase() : null;
}

/** Non-negative money amount → cents. */
function cents(value, label = 'Amount') {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(400, `${label} must be a number of zero or more.`);
  return toCents(n);
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) fail(400, `${label} must be one of: ${allowed.join(', ')}.`);
  return value;
}

module.exports = { text, email, cents, oneOf };
