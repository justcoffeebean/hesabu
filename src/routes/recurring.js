const express = require('express');
const db = require('../db');
const { allow } = require('../auth');
const { fail } = require('../errors');
const { cents } = require('../validate');
const recurring = require('../services/recurring');
const documents = require('../services/documents');

const router = express.Router();

router.get('/recurring', allow('recurring:read'), async (_req, res) => {
  res.json({ frequencies: recurring.FREQUENCIES, schedules: await recurring.list() });
});

router.get('/recurring/:id', allow('recurring:read'), async (req, res) => {
  const t = await recurring.get(db.knex, req.params.id);
  const invoices = (await documents.listInvoices(db.knex)).filter((i) => i.recurringId === t.id);
  res.json({ ...t, invoices });
});

/** Create from scratch, or pass fromInvoiceId to repeat an existing invoice's lines and terms. */
router.post('/recurring', allow('recurring:write'), async (req, res) => {
  const b = { ...(req.body || {}) };
  if (b.fromInvoiceId) {
    const inv = await documents.getInvoice(db.knex, b.fromInvoiceId);
    if (inv.kind === 'opening') fail(400, "Opening balances can't repeat.");
    Object.assign(b, {
      clientId: inv.clientId, currency: inv.currency, vatRate: inv.vatRate, notes: b.notes ?? inv.notes,
      discount: b.discount ?? inv.discount,
      items: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, itemId: l.itemId }))
    });
  }
  const created = await recurring.create(req, { ...b, discountCents: cents(b.discount, 'Discount') });
  res.status(201).json(created);
});

router.put('/recurring/:id', allow('recurring:write'), async (req, res) => {
  const b = req.body || {};
  res.json(await recurring.update(req, req.params.id, { ...b, ...(b.discount !== undefined ? { discountCents: cents(b.discount, 'Discount') } : {}) }));
});

router.post('/recurring/run', allow('recurring:write'), async (req, res) => {
  const result = await recurring.runDue(undefined, req);
  res.json({ created: result.created.map(({ invoiceId, number, date, warnings }) => ({ invoiceId, number, date, warnings })), errors: result.errors });
});

module.exports = router;
