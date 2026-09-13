const express = require('express');
const db = require('../db');
const settings = require('../settings');
const { allow } = require('../auth');
const { audit } = require('../audit');
const { fail, checkVersion } = require('../errors');
const { cents, oneOf } = require('../validate');
const { today, addDays, isIsoDate } = require('../dates');
const { toAmount, formatCents, documentTotals } = require('../totals');
const documents = require('../services/documents');
const { documentPdf, sendPdf } = require('../services/pdf');
const { emailQuotation } = require('../services/sending');

const router = express.Router();
const STATUSES = ['draft', 'sent', 'accepted', 'declined'];

router.get('/quotations', allow('quotations:read'), async (_req, res) => {
  res.json(await documents.listQuotations(db.knex));
});

router.get('/quotations/:id', allow('quotations:read'), async (req, res) => {
  res.json(await documents.getQuotation(db.knex, req.params.id));
});

router.post('/quotations', allow('quotations:write'), async (req, res) => {
  const b = req.body || {};
  const out = await db.tx(async (trx) => {
    const client = await trx('clients').where({ id: b.clientId }).first();
    if (!client) fail(400, 'Pick a client first.');
    const company = await settings.company(trx);
    const lines = await documents.validateLines(trx, b.items);
    const { currency, fxRate } = await documents.rateFor(trx, b.currency || client.currency);
    const vatRate = b.vatRate === undefined || b.vatRate === '' ? Number(company.vatRate) : Number(b.vatRate);
    if (!(vatRate >= 0 && vatRate <= 100)) fail(400, 'VAT rate must be between 0 and 100.');
    const validUntil = b.validUntil || addDays(today(), 30);
    if (!isIsoDate(validUntil)) fail(400, 'Valid-until must be a date.');
    const totals = documentTotals(lines, cents(b.discount, 'Discount'), vatRate);

    const row = {
      id: db.newId(), number: await db.nextNumber(trx, 'quotation'), client_id: client.id, date: today(), valid_until: validUntil,
      currency, fx_rate: fxRate, discount_cents: totals.discount, vat_rate: vatRate,
      subtotal_cents: totals.subtotal, vat_cents: totals.vat, total_cents: totals.total,
      notes: String(b.notes || '').slice(0, 4000), status: 'draft', invoice_id: null, created_by: req.user.id, created_at: db.now(), version: 1
    };
    await trx('quotations').insert(row);
    await documents.writeLines(trx, 'quotation_lines', 'quotation_id', row.id, lines);
    await audit(trx, req, {
      action: 'create', entity: 'quotation', entityId: row.id,
      summary: `${row.number} for ${client.name}: ${currency} ${formatCents(row.total_cents)}`,
      after: { number: row.number, client: client.name, currency, total: toAmount(row.total_cents), lines: documents.linesOut(lines) }
    });
    return row.id;
  });
  res.status(201).json(await documents.getQuotation(db.knex, out));
});

router.put('/quotations/:id', allow('quotations:write'), async (req, res) => {
  const b = req.body || {};
  const id = await db.tx(async (trx) => {
    const q = await db.lock(trx('quotations').where({ id: req.params.id })).first();
    if (!q) fail(404, 'Quotation not found.');
    if (q.invoice_id) fail(400, 'This quotation was already invoiced and can no longer change.');
    checkVersion(q, b.version, 'quotation');
    const before = await documents.getQuotation(trx, q.id);

    const patch = {};
    let lines = (await documents.readLines(trx, 'quotation_lines', 'quotation_id', [q.id])).get(q.id) || [];
    if (b.items !== undefined) {
      lines = await documents.validateLines(trx, b.items);
      await documents.writeLines(trx, 'quotation_lines', 'quotation_id', q.id, lines);
    }
    if (b.status !== undefined) patch.status = oneOf(b.status, STATUSES, 'Status');
    if (b.clientId !== undefined) {
      if (!(await trx('clients').where({ id: b.clientId }).first())) fail(400, 'Pick a client first.');
      patch.client_id = b.clientId;
    }
    if (b.currency !== undefined) Object.assign(patch, await documents.rateFor(trx, b.currency).then((r) => ({ currency: r.currency, fx_rate: r.fxRate })));
    if (b.vatRate !== undefined) {
      const v = Number(b.vatRate);
      if (!(v >= 0 && v <= 100)) fail(400, 'VAT rate must be between 0 and 100.');
      patch.vat_rate = v;
    }
    if (b.notes !== undefined) patch.notes = String(b.notes || '').slice(0, 4000);
    if (b.validUntil !== undefined) {
      if (!isIsoDate(b.validUntil)) fail(400, 'Valid-until must be a date.');
      patch.valid_until = b.validUntil;
    }
    const discount = b.discount !== undefined ? cents(b.discount, 'Discount') : Number(q.discount_cents);
    const totals = documentTotals(lines, discount, patch.vat_rate ?? Number(q.vat_rate));
    Object.assign(patch, { discount_cents: totals.discount, subtotal_cents: totals.subtotal, vat_cents: totals.vat, total_cents: totals.total });

    await trx('quotations').where({ id: q.id }).update({ ...patch, updated_at: db.now(), version: q.version + 1 });
    const after = await documents.getQuotation(trx, q.id);
    const statusOnly = b.status !== undefined && Object.keys(b).every((k) => k === 'status' || k === 'version');
    await audit(trx, req, {
      action: statusOnly ? 'status' : 'update', entity: 'quotation', entityId: q.id,
      summary: statusOnly ? `Marked ${q.number} as ${b.status}` : `Edited ${q.number}`,
      before: strip(before), after: strip(after)
    });
    return q.id;
  });
  res.json(await documents.getQuotation(db.knex, id));
});

const strip = ({ version, createdAt, clientName, ...rest }) => rest;

/** Accepted work becomes billable: copy the quotation into a fresh invoice. */
router.post('/quotations/:id/convert', allow('invoices:write'), async (req, res) => {
  const result = await db.tx(async (trx) => {
    const q = await db.lock(trx('quotations').where({ id: req.params.id })).first();
    if (!q) fail(404, 'Quotation not found.');
    if (q.invoice_id) fail(400, 'This quotation already has an invoice.');
    if (q.status === 'declined') fail(400, 'This quotation was declined. Mark it as accepted first if the client changed their mind.');
    const lines = (await documents.readLines(trx, 'quotation_lines', 'quotation_id', [q.id])).get(q.id) || [];
    // Rate at the invoice date is the one that counts for tax, not the quotation date.
    const created = await documents.createInvoice(trx, req, {
      clientId: q.client_id, quotationId: q.id, items: lines, discountCents: Number(q.discount_cents), vatRate: Number(q.vat_rate),
      notes: q.notes, currency: q.currency, dueDate: req.body?.dueDate || undefined
    });
    await trx('quotations').where({ id: q.id }).update({ invoice_id: created.invoice.id, status: 'accepted', updated_at: db.now(), version: q.version + 1 });
    return created;
  });
  res.status(201).json({ ...(await documents.getInvoice(db.knex, result.invoice.id)), warnings: result.warnings });
});

router.delete('/quotations/:id', allow('quotations:write'), async (req, res) => {
  await db.tx(async (trx) => {
    const q = await trx('quotations').where({ id: req.params.id }).first();
    if (!q) fail(404, 'Quotation not found.');
    if (q.invoice_id) fail(400, 'Invoiced quotations are kept for your records.');
    const before = await documents.getQuotation(trx, q.id);
    await trx('quotations').where({ id: q.id }).del();
    await audit(trx, req, { action: 'delete', entity: 'quotation', entityId: q.id, summary: `Deleted ${q.number}`, before: strip(before) });
  });
  res.status(204).end();
});

router.get('/quotations/:id/pdf', allow('quotations:read'), async (req, res) => {
  const { buffer, filename } = await documentPdf('quotation', req.params.id);
  sendPdf(req, res, buffer, filename);
});

router.post('/quotations/:id/email', allow('quotations:write'), async (req, res) => {
  res.json(await emailQuotation(req, req.params.id, { to: req.body?.to, note: req.body?.note }));
});

module.exports = router;
