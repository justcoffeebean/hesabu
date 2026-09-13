/**
 * Calendar dates are plain 'YYYY-MM-DD' strings everywhere. They compare
 * correctly as strings and never shift when a server runs in UTC while the
 * business runs in Nairobi.
 */
const config = require('./config');

function partsIn(timeZone, date = new Date()) {
  const out = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).forEach((p) => { out[p.type] = p.value; });
  return out;
}

/** Today's date where the business is, not where the server is. */
function today() {
  if (process.env.HESABU_TODAY) return process.env.HESABU_TODAY;
  const p = partsIn(config.timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

function localHour() {
  return Number(partsIn(config.timezone).hour);
}

const toUtc = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

function addDays(iso, days) {
  return fromUtc(toUtc(iso) + days * 86400000);
}

function daysBetween(fromIso, toIso) {
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / 86400000);
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * Adds months while remembering the intended day, so a schedule anchored on
 * the 31st runs 31 Jan → 28 Feb → 31 Mar instead of drifting to the 28th.
 */
function addMonths(iso, months, anchorDay) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = Math.min(anchorDay || d, daysInMonth(year, month));
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUtc(toUtc(s)) === s;

/** YYYYMMDDHHmmss in East Africa Time — the format Daraja signs requests with. */
function darajaTimestamp(date = new Date()) {
  const p = partsIn('Africa/Nairobi', date);
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}

module.exports = { today, localHour, addDays, addMonths, daysBetween, isIsoDate, darajaTimestamp };
