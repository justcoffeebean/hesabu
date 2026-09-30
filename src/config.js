/**
 * Everything configurable lives here, read once from the environment.
 * Secrets (SMTP, Daraja, SMS keys) only ever come from env — never from the
 * database, so an owner looking at Settings can't leak them.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && !process.env.HESABU_SKIP_DOTENV) process.loadEnvFile(envFile);

const env = process.env;
const flag = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

const config = {
  root: ROOT,
  port: Number(env.PORT) || 3000,
  production: env.NODE_ENV === 'production',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  timezone: env.APP_TIMEZONE || 'Africa/Nairobi',
  trustProxy: env.TRUST_PROXY || false,

  db: env.DATABASE_URL
    ? { client: 'pg', connection: env.DATABASE_URL }
    : { client: 'better-sqlite3', filename: env.SQLITE_FILE || path.join(ROOT, 'data', 'hesabu.sqlite') },

  session: {
    cookie: 'hesabu_session',
    days: Number(env.SESSION_DAYS) || 7,
    // Hard limit from sign-in, however active the session is. Then sign in again.
    maxDays: Number(env.SESSION_MAX_DAYS) || 30,
    // Default to Secure cookies whenever the app is served over https.
    secure: env.COOKIE_SECURE ? flag(env.COOKIE_SECURE) : (env.PUBLIC_URL || '').startsWith('https://')
  },
  setupCode: env.SETUP_CODE || '',

  jobs: {
    enabled: env.JOBS_ENABLED === undefined ? true : flag(env.JOBS_ENABLED),
    hour: env.JOBS_HOUR === undefined ? 8 : Number(env.JOBS_HOUR)
  },

  mail: {
    transport: env.MAIL_TRANSPORT || (env.SMTP_HOST ? 'smtp' : 'off'),
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 587,
    secure: flag(env.SMTP_SECURE),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || ''
  },

  sms: {
    transport: env.SMS_TRANSPORT || (env.AT_API_KEY ? 'africastalking' : 'off'),
    username: env.AT_USERNAME || '',
    apiKey: env.AT_API_KEY || '',
    senderId: env.AT_SENDER_ID || ''
  },

  daraja: {
    env: env.DARAJA_ENV === 'production' ? 'production' : 'sandbox',
    consumerKey: env.DARAJA_CONSUMER_KEY || '',
    consumerSecret: env.DARAJA_CONSUMER_SECRET || '',
    passkey: env.DARAJA_PASSKEY || '',
    shortcode: env.DARAJA_SHORTCODE || '',
    // Buy Goods: shortcode is the store number and PARTY_B is the till.
    partyB: env.DARAJA_PARTY_B || env.DARAJA_SHORTCODE || '',
    type: env.DARAJA_TYPE === 'till' ? 'till' : 'paybill',
    callbackSecret: env.MPESA_CALLBACK_SECRET || '',
    allowedIps: (env.DARAJA_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Looking up a receipt and refunding one are done as an "initiator" (an API operator
    // user created on the M-Pesa org portal). Give either the security credential the
    // Daraja portal generates, or the initiator's password plus Safaricom's certificate.
    initiatorName: env.DARAJA_INITIATOR_NAME || '',
    securityCredential: env.DARAJA_SECURITY_CREDENTIAL || '',
    initiatorPassword: env.DARAJA_INITIATOR_PASSWORD || '',
    certFile: env.DARAJA_CERT_FILE || '',
    baseUrl: env.DARAJA_BASE_URL || ''
  }
};

/** Settings that would make the app unsafe to run. server.js refuses to start while any are listed. */
config.problems = () => {
  const out = [];
  if (config.publicUrl) {
    let url = null;
    try { url = new URL(config.publicUrl); } catch { /* reported below */ }
    if (!url || !/^https?:$/.test(url.protocol)) out.push(`PUBLIC_URL must be a full http(s) address, like https://hesabu.example.com (got "${config.publicUrl}").`);
    else if (url.pathname !== '/' || url.search || url.hash) out.push('PUBLIC_URL must be just the address, with no path, like https://hesabu.example.com.');
  } else if (config.production) {
    out.push('Set PUBLIC_URL in .env (the https address people reach the app on). Sign-in links and M-Pesa callbacks need it.');
  }
  return out;
};

config.daraja.ready = Boolean(
  config.daraja.consumerKey && config.daraja.consumerSecret && config.daraja.passkey &&
  config.daraja.shortcode && config.daraja.callbackSecret && config.publicUrl
);

// Lookups and refunds need the basics plus an initiator.
config.daraja.commandsReady = Boolean(
  config.daraja.ready && config.daraja.initiatorName &&
  (config.daraja.securityCredential || (config.daraja.initiatorPassword && config.daraja.certFile))
);

module.exports = config;
