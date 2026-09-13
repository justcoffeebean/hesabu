const express = require('express');
const db = require('../db');
const settings = require('../settings');
const { allow } = require('../auth');
const { audit } = require('../audit');
const { fail, checkVersion } = require('../errors');
const { text, email } = require('../validate');
const { toAmount } = require('../totals');
const { listInvoices, rateFor } = require('../services/documents');
const { normalizeRef } = require('../services/mpesa');

const router = express.Router();

function clientOut(c, owed) {
  return {
    id: c.id, name: c.name, email: c.email || '', phone: c.phone || '', address: c.address || '',
    kraPin: c.kra_pin || '', accountCode: c.account_code || '', currency: c.currency,
    reminders: Boolean(c.reminders), createdAt: c.created_at, version: c.version,
    ...(owed ? owed : {})
  };
}

/** Outstanding per currency, plus a base-currency figure for sorting and totals. */
function owedBy(invoices) {
  const byCurrency = {};
  let baseCents = 0;
  invoices.filter((i) => i.balanceCents > 0).forEach((i) => {
    byCurrency[i.currency] = (byCurrency[i.currency] || 0) + i.balanceCents;
    baseCents += Math.round(i.balanceCents * i.fxRate);
  });
  return {
    outstanding: toAmount(baseCents),
    outstandingByCurrency: Object.fromEntries(Object.entries(byCurrency).map(([k, v]) => [k, toAmount(v)]))
  };
}

async function readBody(trx, body, existing) {
  const name = text(body.name ?? existing?.name);
  if (!name) fail(400, 'Client name is required.');
  const code = body.accountCode !== undefined ? normalizeRef(body.accountCode).slice(0, 20) || null : existing?.account_code || null;
  if (code) {
    const clash = await trx('clients').where({ account_code: code }).whereNot({ id: existing?.id || '' }).first();
    if (clash) fail(409, `Account code ${code} already belongs to ${clash.name}.`);
    if (/^(INV|OB)\d{8}$/.test(code)) fail(400, 'That account code looks like an invoice number. Pick something else, like ACME.');
  }
  const base = (await settings.company(trx)).baseCurrency;
  // Only the default for new documents; existing invoices keep the currency they were issued in.
  const currency = body.currency !== undefined ? (await rateFor(trx, body.currency || base)).currency : existing?.currency || base;
  return {
    name,
    email: body.email !== undefined ? email(body.email, 'Client email') : existing?.email ?? null,
    phone: body.phone !== undefined ? text(body.phone, 40) : existing?.phone ?? null,
    address: body.address !== undefined ? text(body.address, 300) : existing?.address ?? null,
    kra_pin: body.kraPin !== undefined ? text(body.kraPin, 20) : existing?.kra_pin ?? null,
    account_code: code,
    currency,
    reminders: body.reminders !== undefined ? Boolean(body.reminders) : existing ? Boolean(existing.reminders) : true
  };
}

router.get('/clients', allow('clients:read'), async (_req, res) => {
  const clients = await db.knex('clients').orderBy('name');
  const invoices = await listInvoices(db.knex);
  const byClient = new Map();
  invoices.forEach((i) => { if (!byClient.has(i.clientId)) byClient.set(i.clientId, []); byClient.get(i.clientId).push(i); });
  res.json(clients.map((c) => clientOut(c, owedBy(byClient.get(c.id) || []))));
});

router.post('/clients', allow('clients:write'), async (req, res) => {
  const out = await db.tx(async (trx) => {
    const fields = await readBody(trx, req.body || {});
    const row = { id: db.newId(), ...fields, version: 1, created_at: db.now() };
    await trx('clients').insert(row);
    await audit(trx, req, { action: 'create', entity: 'client', entityId: row.id, summary: `Added client ${row.name}`, after: fields });
    return clientOut(row, { outstanding: 0, outstandingByCurrency: {} });
  });
  res.status(201).json(out);
});

router.put('/clients/:id', allow('clients:write'), async (req, res) => {
  const out = await db.tx(async (trx) => {
    const client = await db.lock(trx('clients').where({ id: req.params.id })).first();
    if (!client) fail(404, 'Client not found.');
    checkVersion(client, req.body?.version, 'client');
    const fields = await readBody(trx, req.body || {}, client);
    await trx('clients').where({ id: client.id }).update({ ...fields, updated_at: db.now(), version: client.version + 1 });
    const after = await trx('clients').where({ id: client.id }).first();
    await audit(trx, req, { action: 'update', entity: 'client', entityId: client.id, summary: `Edited client ${after.name}`, before: client, after });
    return clientOut(after);
  });
  res.json(out);
});

router.delete('/clients/:id', allow('clients:write'), async (req, res) => {
  await db.tx(async (trx) => {
    const client = await trx('clients').where({ id: req.params.id }).first();
    if (!client) fail(404, 'Client not found.');
    const used = await trx('invoices').where({ client_id: client.id }).first('id') ||
      await trx('quotations').where({ client_id: client.id }).first('id') ||
      await trx('recurring_invoices').where({ client_id: client.id }).first('id');
    if (used) fail(400, 'This client has documents attached, so they stay on file for your records.');
    await trx('clients').where({ id: client.id }).del();
    await audit(trx, req, { action: 'delete', entity: 'client', entityId: client.id, summary: `Removed client ${client.name}`, before: client });
  });
  res.status(204).end();
});

module.exports = router;
