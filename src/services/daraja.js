/**
 * Thin client for Safaricom's Daraja API: OAuth, STK push (Lipa na M-Pesa
 * Online), STK status query and C2B URL registration.
 * Docs: https://developer.safaricom.co.ke
 */
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

function status() {
  const d = config.daraja;
  return {
    ready: d.ready,
    env: d.env,
    type: d.type,
    shortcode: d.shortcode || null,
    callbackBase: config.publicUrl ? `${config.publicUrl}/hooks/…` : null
  };
}

const resetTokenCache = () => { cached = { token: null, expires: 0 }; };

module.exports = { stkPush, stkQuery, registerC2bUrls, status, requireReady, resetTokenCache };
