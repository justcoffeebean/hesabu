/**
 * Test harness. Require this FIRST in every test file: it points the app at a
 * throwaway database and a fake Daraja before any app module reads config.
 *
 *   npm test                                          SQLite, a fresh file per test file
 *   TEST_DATABASE_URL=postgres://… npm run test:pg    PostgreSQL (tables are dropped first!)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hesabu-test-'));
const DARAJA_PORT = 40000 + Math.floor(Math.random() * 20000);

Object.assign(process.env, {
  HESABU_SKIP_DOTENV: '1',
  NODE_ENV: 'test',
  JOBS_ENABLED: 'false',
  MAIL_TRANSPORT: 'log',
  SMS_TRANSPORT: 'log',
  SETUP_CODE: 'TESTCODE',
  PUBLIC_URL: 'https://hesabu.example.com',
  COOKIE_SECURE: 'false',
  MPESA_CALLBACK_SECRET: 'cb-secret-123',
  DARAJA_CONSUMER_KEY: 'key',
  DARAJA_CONSUMER_SECRET: 'secret',
  DARAJA_PASSKEY: 'passkey',
  DARAJA_SHORTCODE: '174379',
  DARAJA_BASE_URL: `http://127.0.0.1:${DARAJA_PORT}`,
  APP_TIMEZONE: 'Africa/Nairobi'
});
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else process.env.SQLITE_FILE = path.join(tmp, 'test.sqlite');

if (!process.env.DEBUG) {
  console.log = () => {};
  console.warn = () => {};
}

const db = require('../src/db');
const { createApp } = require('../src/app');

/* ---------- fake Daraja ---------- */

const daraja = {
  calls: [],
  stkResponse: null, // override to simulate a rejection
  queryResponse: { ResponseCode: '0', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' },
  counter: 0
};

function startDaraja() {
  const app = express();
  app.use(express.json());
  app.get('/oauth/v1/generate', (req, res) => {
    daraja.calls.push({ path: req.path, auth: req.get('authorization') });
    res.json({ access_token: 'tok', expires_in: '3599' });
  });
  app.post('/mpesa/stkpush/v1/processrequest', (req, res) => {
    daraja.calls.push({ path: req.path, body: req.body });
    daraja.counter += 1;
    res.json(daraja.stkResponse || {
      MerchantRequestID: `m-${daraja.counter}`, CheckoutRequestID: `ws_CO_${daraja.counter}`,
      ResponseCode: '0', ResponseDescription: 'Success. Request accepted for processing', CustomerMessage: 'Success. Request accepted for processing'
    });
  });
  app.post('/mpesa/stkpushquery/v1/query', (req, res) => {
    daraja.calls.push({ path: req.path, body: req.body });
    res.json(daraja.queryResponse);
  });
  app.post('/mpesa/c2b/v1/registerurl', (req, res) => {
    daraja.calls.push({ path: req.path, body: req.body });
    res.json({ ResponseCode: '0', ResponseDescription: 'Success' });
  });
  return new Promise((resolve) => { const s = app.listen(DARAJA_PORT, '127.0.0.1', () => resolve(s)); });
}

/* ---------- app + HTTP client ---------- */

async function resetDatabase() {
  if (db.isPg) {
    await db.knex.raw('drop schema public cascade');
    await db.knex.raw('create schema public');
  }
  await db.migrate();
}

async function start() {
  await resetDatabase();
  const darajaServer = await startDaraja();
  const server = await new Promise((resolve) => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async stop() {
      server.close();
      darajaServer.close();
      await db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/** A browser-ish client with its own cookie. */
function client(base) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(';');
      cookie = pair.endsWith('=') ? '' : pair;
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : type.includes('pdf') || type.includes('csv') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (url, headers) => call('GET', url, undefined, headers),
    post: (url, body = {}, headers) => call('POST', url, body, headers),
    put: (url, body = {}, headers) => call('PUT', url, body, headers),
    del: (url, headers) => call('DELETE', url, undefined, headers),
    get cookie() { return cookie; }
  };
}

/** Owner via first-run setup, plus an accounts and a staff user with passwords set. */
async function team(base) {
  const owner = client(base);
  const setup = await owner.post('/api/auth/setup', { name: 'Amina', email: 'owner@test.co.ke', password: 'owner-password-1', setupCode: 'TESTCODE', companyName: 'Test Traders Ltd' });
  if (setup.status !== 201) throw new Error(`setup failed: ${JSON.stringify(setup.data)}`);

  const make = async (name, email, role) => {
    const created = await owner.post('/api/users', { name, email, role });
    const token = created.data.link.split('/#/link/')[1];
    const c = client(base);
    const r = await c.post(`/api/auth/link/${token}`, { password: `${role}-password-1` });
    if (r.status !== 200) throw new Error(`link failed: ${JSON.stringify(r.data)}`);
    return c;
  };
  return { owner, accounts: await make('Wanjiru', 'accounts@test.co.ke', 'accounts'), staff: await make('Brian', 'staff@test.co.ke', 'staff') };
}

/** A client and an invoice to work with. */
async function basics(owner, { total = 1000, currency, items } = {}) {
  const c = await owner.post('/api/clients', { name: `Client ${Math.random().toString(36).slice(2, 7)}`, email: 'client@example.com', phone: '0722 000 111', accountCode: `C${Math.random().toString(36).slice(2, 7)}` });
  const inv = await owner.post('/api/invoices', {
    clientId: c.data.id, vatRate: 0, currency,
    items: items || [{ description: 'Work', quantity: 1, unitPrice: total }]
  });
  if (inv.status !== 201) throw new Error(`invoice failed: ${JSON.stringify(inv.data)}`);
  return { client: c.data, invoice: inv.data };
}

module.exports = { start, client, team, basics, db, daraja, tmp };
