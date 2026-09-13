/** Company details, currencies, reminder schedule, integration status and background jobs. */
const express = require('express');
const db = require('../db');
const settings = require('../settings');
const { allow } = require('../auth');
const { audit } = require('../audit');
const { fail } = require('../errors');
const { text, email } = require('../validate');
const daraja = require('../services/daraja');
const messages = require('../services/messages');
const reminders = require('../services/reminders');
const scheduler = require('../services/scheduler');

const router = express.Router();

/* ---------- company ---------- */

router.get('/settings', allow('settings:read'), async (_req, res) => {
  res.json(await settings.company());
});

router.put('/settings', allow('settings:write'), async (req, res) => {
  const b = req.body || {};
  const out = await db.tx(async (trx) => {
    const before = await settings.company(trx);
    const name = text(b.name);
    if (!name) fail(400, 'Company name is required.');
    const vatRate = Number(b.vatRate);
    if (!(vatRate >= 0 && vatRate <= 100)) fail(400, 'VAT rate must be between 0 and 100.');
    const terms = b.paymentTerms === undefined ? before.paymentTerms : Number(b.paymentTerms);
    if (!(Number.isInteger(terms) && terms >= 0 && terms <= 365)) fail(400, 'Payment terms must be a whole number of days.');

    let baseCurrency = before.baseCurrency;
    if (b.baseCurrency && b.baseCurrency.toUpperCase() !== before.baseCurrency) {
      // Changing the base after documents exist would silently re-value every balance.
      if (await trx('invoices').first('id') || await trx('quotations').first('id')) {
        fail(400, "The base currency can't change once you have quotations or invoices.");
      }
      baseCurrency = String(b.baseCurrency).toUpperCase().slice(0, 3);
    }
    const after = {
      ...before,
      name,
      email: email(b.email, 'Company email') || '',
      phone: text(b.phone, 40) || '',
      address: text(b.address, 300) || '',
      kraPin: text(b.kraPin, 20) || '',
      vatRate,
      paymentTerms: terms,
      paymentInstructions: text(b.paymentInstructions, 600) || '',
      baseCurrency
    };
    await db.putSetting(trx, 'company', after);
    await audit(trx, req, { action: 'update', entity: 'settings', summary: 'Changed company settings', before, after });
    return after;
  });
  res.json(out);
});

/* ---------- currencies ---------- */

const currencyOut = (c) => ({ code: c.code, name: c.name, rateToBase: Number(c.rate_to_base), updatedAt: c.updated_at });

router.get('/currencies', allow('settings:read'), async (_req, res) => {
  const base = (await settings.company()).baseCurrency;
  const rows = (await db.knex('currencies').orderBy('code')).map(currencyOut);
  res.json({ base, currencies: rows });
});

router.put('/currencies/:code', allow('currencies:write'), async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) fail(400, 'Currency codes are three letters, like USD.');
  const base = (await settings.company()).baseCurrency;
  if (code === base) fail(400, `${base} is your base currency; its rate is always 1.`);
  const rate = Number(req.body?.rateToBase);
  if (!(rate > 0 && rate < 1e7)) fail(400, `Enter how many ${base} one ${code} is worth.`);
  const name = text(req.body?.name, 60) || code;

  const out = await db.tx(async (trx) => {
    const before = await trx('currencies').where({ code }).first();
    const row = { code, name, rate_to_base: rate, updated_at: db.now() };
    if (before) await trx('currencies').where({ code }).update(row);
    else await trx('currencies').insert(row);
    await audit(trx, req, {
      action: before ? 'update' : 'create', entity: 'currency', entityId: code,
      summary: before ? `${code} rate ${Number(before.rate_to_base)} → ${rate} ${base}` : `Added ${code} at ${rate} ${base}`
    });
    return currencyOut(row);
  });
  res.json(out);
});

router.delete('/currencies/:code', allow('currencies:write'), async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const used = await db.knex('invoices').where({ currency: code }).first('id') ||
    await db.knex('quotations').where({ currency: code }).first('id') ||
    await db.knex('clients').where({ currency: code }).first('id');
  if (used) fail(400, `${code} is used by clients or documents, so it stays. You can still update its rate.`);
  await db.tx(async (trx) => {
    const n = await trx('currencies').where({ code }).del();
    if (!n) fail(404, 'Currency not found.');
    await audit(trx, req, { action: 'delete', entity: 'currency', entityId: code, summary: `Removed ${code}` });
  });
  res.status(204).end();
});

/* ---------- reminders ---------- */

router.get('/settings/reminders', allow('reminders:read'), async (_req, res) => {
  res.json({ ...(await settings.reminders()), channels: messages.channelStatus() });
});

router.put('/settings/reminders', allow('reminders:write'), async (req, res) => {
  const b = req.body || {};
  const offsets = [...new Set((Array.isArray(b.offsets) ? b.offsets : String(b.offsets || '').split(','))
    .map((v) => String(v).trim()).filter((v) => v !== '').map(Number))].sort((x, y) => x - y);
  if (offsets.some((n) => !Number.isInteger(n) || n < -60 || n > 365)) {
    fail(400, 'Reminder days must be whole numbers between -60 (before due) and 365 (after).');
  }
  if (b.enabled && !offsets.length) fail(400, 'Add at least one reminder day.');
  const out = await db.tx(async (trx) => {
    const before = await settings.reminders(trx);
    const after = { enabled: Boolean(b.enabled), email: Boolean(b.email), sms: Boolean(b.sms), offsets };
    await db.putSetting(trx, 'reminders', after);
    await audit(trx, req, { action: 'update', entity: 'settings', summary: `${after.enabled ? 'Changed' : 'Turned off'} payment reminders`, before, after });
    return after;
  });
  res.json({ ...out, channels: messages.channelStatus() });
});

router.get('/reminders/preview', allow('reminders:read'), async (_req, res) => {
  const { items, channels, cfg } = await reminders.plan();
  res.json({
    enabled: cfg.enabled, channels,
    items: items.map((i) => ({ invoiceId: i.inv.id, number: i.inv.number, clientName: i.client.name, channel: i.channel, to: i.to, offset: i.offset, balance: i.inv.balance, currency: i.inv.currency }))
  });
});

router.post('/reminders/run', allow('reminders:write'), async (req, res) => {
  res.json(await reminders.run(undefined, req, { force: false }));
});

/* ---------- integrations & jobs ---------- */

router.get('/settings/integrations', allow('settings:write'), async (_req, res) => {
  res.json({ mpesa: daraja.status(), channels: messages.channelStatus(), jobs: await scheduler.lastRuns(10) });
});

router.post('/settings/mpesa/register-urls', allow('settings:write'), async (req, res) => {
  const result = await daraja.registerC2bUrls();
  await audit(db.knex, req, { action: 'register', entity: 'settings', summary: 'Registered M-Pesa paybill confirmation URLs with Safaricom' });
  res.json(result);
});

module.exports = router;
