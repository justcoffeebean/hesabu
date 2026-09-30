/**
 * Thin client for Safaricom's Daraja API: OAuth, STK push (Lipa na M-Pesa
 * Online), STK status query, C2B URL registration, and the two "initiator"
 * commands — Transaction Status (look up a receipt) and Reversal (refund).
 * Docs: https://developer.safaricom.co.ke
 */
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const { darajaTimestamp } = require('../dates');
const { fail } = require('../errors');

const HOSTS = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' };
const base = () => config.daraja.baseUrl || HOSTS[config.daraja.env];

let cached = { token: null, expires: 0 };

function requireReady() {
  const d = config.daraja;
  const missing = [];
  if (!d.consumerKey) missing.push('DARAJA_CONSUMER_KEY');
  if (!d.consumerSecret) missing.push('DARAJA_CONSUMER_SECRET');
  if (!d.passkey) missing.push('DARAJA_PASSKEY');
  if (!d.shortcode) missing.push('DARAJA_SHORTCODE');
  if (!d.callbackSecret) missing.push('MPESA_CALLBACK_SECRET');
  if (!config.publicUrl) missing.push('PUBLIC_URL');
  if (missing.length) fail(400, `M-Pesa isn't set up on this server yet. Missing in .env: ${missing.join(', ')}.`);
}

async function call(path, { method = 'POST', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(base() + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
  } catch (err) {
    fail(502, `Couldn't reach M-Pesa (${err.name === 'TimeoutError' ? 'timed out' : err.message}). Try again in a minute.`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { errorMessage: text.slice(0, 200) }; }
  if (!res.ok) {
    const reason = data.errorMessage || data.ResponseDescription || data.resultDesc || `HTTP ${res.status}`;
    const err = new Error(`M-Pesa said: ${reason}`);
    err.status = 502;
    err.daraja = data;
    throw err;
  }
  return data;
}

async function accessToken() {
  if (cached.token && Date.now() < cached.expires) return cached.token;
  const basic = Buffer.from(`${config.daraja.consumerKey}:${config.daraja.consumerSecret}`).toString('base64');
  const data = await call('/oauth/v1/generate?grant_type=client_credentials', {
    method: 'GET', headers: { Authorization: `Basic ${basic}` }
  });
  // Refresh a minute early so a token never expires mid-request.
  cached = { token: data.access_token, expires: Date.now() + (Number(data.expires_in || 3599) - 60) * 1000 };
  return cached.token;
}

function signature() {
  const timestamp = darajaTimestamp();
  const password = Buffer.from(config.daraja.shortcode + config.daraja.passkey + timestamp).toString('base64');
  return { timestamp, password };
}

const callbackUrl = (kind) => `${config.publicUrl}/hooks/${kind}/${config.daraja.callbackSecret}`;

/* ---------- initiator commands: Transaction Status and Reversal ---------- */

/** Where Safaricom posts the answer to a command. Avoids words Daraja rejects in URLs (cmd, query, exe…). */
const resultUrls = () => ({ ResultURL: `${callbackUrl('async')}/result`, QueueTimeOutURL: `${callbackUrl('async')}/timeout` });

function requireInitiator() {
  requireReady();
  const d = config.daraja;
  const missing = [];
  if (!d.initiatorName) missing.push('DARAJA_INITIATOR_NAME');
  if (!d.securityCredential && !(d.initiatorPassword && d.certFile)) {
    missing.push('DARAJA_SECURITY_CREDENTIAL (or DARAJA_INITIATOR_PASSWORD and DARAJA_CERT_FILE)');
  }
  if (missing.length) fail(400, `Looking up and refunding M-Pesa payments isn't set up yet. Missing in .env: ${missing.join(', ')}.`);
}

let credentialCache = null;

/**
 * The initiator's password encrypted with Safaricom's public certificate (RSA,
 * PKCS#1 v1.5), base64. Sandbox and production use different certificates;
 * both download from the Daraja portal.
 */
function securityCredential() {
  const d = config.daraja;
  if (d.securityCredential) return d.securityCredential;
  if (credentialCache) return credentialCache;
  let cert;
  try {
    cert = new crypto.X509Certificate(fs.readFileSync(d.certFile));
  } catch (err) {
    fail(400, `Couldn't read Safaricom's certificate from DARAJA_CERT_FILE (${err.code === 'ENOENT' ? 'no such file' : err.message}).`);
  }
  credentialCache = crypto.publicEncrypt(
    { key: cert.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(d.initiatorPassword)
  ).toString('base64');
  return credentialCache;
}

async function command(path, body) {
  requireInitiator();
  const token = await accessToken();
  return call(path, {
    headers: { Authorization: `Bearer ${token}` },
    body: { Initiator: config.daraja.initiatorName, SecurityCredential: securityCredential(), ...resultUrls(), ...body }
  });
}

/** Asks Safaricom about a receipt. The answer arrives later at /hooks/async/<secret>/result. */
function transactionStatus(receipt) {
  return command('/mpesa/transactionstatus/v1/query', {
    CommandID: 'TransactionStatusQuery',
    TransactionID: receipt,
    PartyA: config.daraja.shortcode,
    IdentifierType: '4', // organisation shortcode
    Remarks: 'Payment lookup',
    Occasion: ''
  });
}

/** Sends a whole M-Pesa payment back to the customer. The answer arrives later, like a status query. */
function reversal(receipt, amountShillings, remarks) {
  return command('/mpesa/reversal/v1/request', {
    CommandID: 'TransactionReversal',
    TransactionID: receipt,
    Amount: String(amountShillings),
    ReceiverParty: config.daraja.shortcode,
    RecieverIdentifierType: '11', // Safaricom's spelling
    Remarks: String(remarks || 'Refund').slice(0, 100),
    Occasion: ''
  });
}

async function stkPush({ phone, amount, accountReference, description }) {
  requireReady();
  const { timestamp, password } = signature();
  const token = await accessToken();
  return call('/mpesa/stkpush/v1/processrequest', {
    headers: { Authorization: `Bearer ${token}` },
    body: {
      BusinessShortCode: config.daraja.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: config.daraja.type === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: config.daraja.partyB,
      PhoneNumber: phone,
      CallBackURL: callbackUrl('stk'),
      AccountReference: String(accountReference).replace(/[^A-Za-z0-9]/g, '').slice(0, 12),
      TransactionDesc: String(description || 'Invoice').slice(0, 13)
    }
  });
}

async function stkQuery(checkoutRequestId) {
  requireReady();
  const { timestamp, password } = signature();
  const token = await accessToken();
  return call('/mpesa/stkpushquery/v1/query', {
    headers: { Authorization: `Bearer ${token}` },
    body: { BusinessShortCode: config.daraja.shortcode, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId }
  });
}

/** Tells Safaricom where to send paybill/till payments that customers make on their own. */
async function registerC2bUrls() {
  requireReady();
  const token = await accessToken();
  return call('/mpesa/c2b/v1/registerurl', {
    headers: { Authorization: `Bearer ${token}` },
    body: {
      ShortCode: config.daraja.type === 'till' ? config.daraja.partyB : config.daraja.shortcode,
      ResponseType: 'Completed',
      ConfirmationURL: callbackUrl('c2b') + '/confirm',
      ValidationURL: callbackUrl('c2b') + '/validate'
    }
  });
}

/* ---------- connection test ---------- */

// Daraja refuses callback URLs containing these (in the host too).
const BANNED = ['mpesa', 'm-pesa', 'safaricom', 'query', 'exe', 'sql', 'cmd'];
const SANDBOX_SHORTCODES = /^(174379|600\d{3})$/;

/**
 * Everything that can be checked from here without moving money: settings,
 * the callback address, whether the keys get a token, and the initiator.
 * Returns [{ name, status: ok|warn|error|info, detail }].
 */
async function testConnection() {
  const d = config.daraja;
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const missing = [
    ['DARAJA_CONSUMER_KEY', d.consumerKey], ['DARAJA_CONSUMER_SECRET', d.consumerSecret], ['DARAJA_PASSKEY', d.passkey],
    ['DARAJA_SHORTCODE', d.shortcode], ['MPESA_CALLBACK_SECRET', d.callbackSecret], ['PUBLIC_URL', config.publicUrl]
  ].filter(([, v]) => !v).map(([k]) => k);
  add('Settings in .env', missing.length ? 'error' : 'ok', missing.length ? `Missing: ${missing.join(', ')}.` : `${d.env}, ${d.type} ${d.shortcode}.`);

  if (d.env === 'production' && SANDBOX_SHORTCODES.test(d.shortcode)) {
    add('Shortcode', 'error', `${d.shortcode} is a sandbox test shortcode, but DARAJA_ENV is production.`);
  } else if (d.env === 'sandbox' && d.shortcode && !SANDBOX_SHORTCODES.test(d.shortcode)) {
    add('Shortcode', 'warn', `The sandbox only knows its test shortcodes (174379 for STK push, 600xxx for paybill). ${d.shortcode} looks like a real one: set DARAJA_ENV=production once Safaricom approves your app.`);
  }
  if (d.callbackSecret && d.callbackSecret.length < 24) {
    add('Callback secret', 'warn', 'MPESA_CALLBACK_SECRET is short. Anyone who guesses it can post fake payments; use 24+ random characters.');
  }

  if (config.publicUrl) {
    const url = new URL(config.publicUrl);
    const lower = config.publicUrl.toLowerCase();
    if (url.protocol !== 'https:') add('Callback address', 'error', `Safaricom only calls https addresses; PUBLIC_URL is ${config.publicUrl}.`);
    else if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) add('Callback address', 'error', `${url.hostname} can't be reached from the internet. Use your real domain or a tunnel.`);
    else if (BANNED.some((w) => lower.includes(w))) add('Callback address', 'error', `Daraja rejects callback URLs containing "${BANNED.find((w) => lower.includes(w))}". Use a different domain or subdomain.`);
    else add('Callback address', 'ok', `Safaricom will call ${config.publicUrl}/hooks/…`);
  }

  if (d.consumerKey && d.consumerSecret) {
    cached = { token: null, expires: 0 };
    try {
      await accessToken();
      add('Consumer key and secret', 'ok', `Safaricom's ${d.env} accepted them.`);
    } catch (err) {
      const hint = d.env === 'sandbox' ? ' If these are production keys, set DARAJA_ENV=production.' : ' If these are sandbox keys, set DARAJA_ENV=sandbox.';
      add('Consumer key and secret', 'error', `${err.message.replace(/^M-Pesa said: /, 'Safaricom said: ')}${err.status === 502 && /couldn't reach/i.test(err.message) ? '' : hint}`);
    }
  }

  if (!d.initiatorName && !d.securityCredential && !d.initiatorPassword) {
    add('Lookups and refunds', 'info', 'Optional. Add DARAJA_INITIATOR_NAME and a security credential to look up missed payments and refund customers.');
  } else {
    try {
      requireInitiator();
      securityCredential();
      add('Lookups and refunds', 'ok', `Initiator ${d.initiatorName} is set up.`);
    } catch (err) {
      add('Lookups and refunds', 'error', err.message);
    }
  }
  return { ok: !checks.some((c) => c.status === 'error'), checks };
}

function status() {
  const d = config.daraja;
  return {
    ready: d.ready,
    commandsReady: d.commandsReady,
    env: d.env,
    type: d.type,
    shortcode: d.shortcode || null,
    callbackBase: config.publicUrl ? `${config.publicUrl}/hooks/…` : null
  };
}

const resetTokenCache = () => { cached = { token: null, expires: 0 }; credentialCache = null; };

module.exports = {
  stkPush, stkQuery, registerC2bUrls, transactionStatus, reversal, testConnection, securityCredential,
  status, requireReady, resetTokenCache
};
