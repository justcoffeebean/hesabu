/** Payments typed in by hand, M-Pesa payment requests, and placing unmatched M-Pesa receipts. */
const express = require('express');
const db = require('../db');
const { allow } = require('../auth');
const { fail } = require('../errors');
const { toAmount, toCents } = require('../totals');
const { recordPayment, reversePayment, METHODS } = require('../services/payments');
const { getInvoice } = require('../services/documents');
const mpesa = require('../services/mpesa');

const router = express.Router();

router.get('/payments', allow('payments:read'), async (_req, res) => {
  const rows = await db.knex('payments')
    .join('invoices', 'invoices.id', 'payments.invoice_id')
    .join('clients', 'clients.id', 'invoices.client_id')
    .leftJoin('users as u', 'u.id', 'payments.created_by')
    .leftJoin('users as r', 'r.id', 'payments.reversed_by')
    .select('payments.*', 'invoices.number as invoice_number', 'invoices.currency', 'clients.name as client_name', 'u.name as by', 'r.name as reversed_by_name')
    .orderBy([{ column: 'payments.date', order: 'desc' }, { column: 'payments.created_at', order: 'desc' }]);
  res.json({
    methods: METHODS,
    payments: rows.map((p) => ({
      id: p.id, invoiceId: p.invoice_id, invoiceNumber: p.invoice_number, clientName: p.client_name, currency: p.currency,
      amount: toAmount(p.amount_cents), method: p.method, reference: p.reference || '', date: p.date, source: p.source,
      by: p.by || (p.source === 'mpesa' ? 'M-Pesa' : null),
      reversed: Boolean(p.reversed_at), reversedBy: p.reversed_by_name || null, reversalReason: p.reversal_reason || null
    })),
    unallocated: await mpesa.unallocated()
  });
});

router.post('/payments', allow('payments:write'), async (req, res) => {
  const b = req.body || {};
  const value = Number(b.amount);
  if (!(value > 0)) fail(400, 'Enter an amount greater than zero.');
  const { payment } = await db.tx((trx) => recordPayment(trx, req, {
    invoiceId: b.invoiceId, amountCents: toCents(value), method: b.method, reference: b.reference, date: b.date || undefined
  }));
  res.status(201).json({ paymentId: payment.id, invoice: await getInvoice(db.knex, payment.invoice_id) });
});

router.post('/payments/:id/reverse', allow('payments:write'), async (req, res) => {
  const { payment } = await db.tx((trx) => reversePayment(trx, req, req.params.id, req.body?.reason));
  res.json({ invoice: await getInvoice(db.knex, payment.invoice_id) });
});

/* ---------- M-Pesa ---------- */

router.post('/mpesa/stk', allow('mpesa:request'), async (req, res) => {
  const b = req.body || {};
  res.status(201).json(await mpesa.requestStk(req, { invoiceId: b.invoiceId, phone: b.phone, amount: b.amount }));
});

router.get('/mpesa/stk/:id', allow('mpesa:request'), async (req, res) => {
  const row = await db.knex('mpesa_requests').where({ id: req.params.id }).first();
  if (!row) fail(404, 'Payment request not found.');
  res.json(mpesa.requestOut(row));
});

router.post('/mpesa/stk/:id/check', allow('mpesa:request'), async (req, res) => {
  res.json(await mpesa.checkStk(req, req.params.id));
});

router.post('/mpesa/transactions/:id/allocate', allow('payments:write'), async (req, res) => {
  res.json(await mpesa.allocateManually(req, req.params.id, req.body?.invoiceId, req.body?.amount));
});

module.exports = router;
