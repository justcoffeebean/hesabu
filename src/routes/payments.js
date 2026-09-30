/** Payments typed in by hand, M-Pesa payment requests, and placing unmatched M-Pesa receipts. */
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { allow } = auth;
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
    .leftJoin('mpesa_transactions as t', 't.id', 'payments.mpesa_transaction_id')
    .select('payments.*', 'invoices.number as invoice_number', 'invoices.currency', 'clients.name as client_name', 'u.name as by', 'r.name as reversed_by_name',
      't.amount_cents as receipt_amount_cents', 't.refunded_at as receipt_refunded_at')
    .orderBy([{ column: 'payments.date', order: 'desc' }, { column: 'payments.created_at', order: 'desc' }]);
  const refunds = await mpesa.refundStates(db.knex, [...new Set(rows.map((p) => p.mpesa_transaction_id).filter(Boolean))]);
  res.json({
    methods: METHODS,
    payments: rows.map((p) => ({
      id: p.id, invoiceId: p.invoice_id, invoiceNumber: p.invoice_number, clientName: p.client_name, currency: p.currency,
      amount: toAmount(p.amount_cents), method: p.method, reference: p.reference || '', date: p.date, source: p.source,
      by: p.by || (p.source === 'mpesa' ? 'M-Pesa' : null),
      reversed: Boolean(p.reversed_at), reversedBy: p.reversed_by_name || null, reversalReason: p.reversal_reason || null,
      // The M-Pesa receipt it came from: a refund sends the whole receipt back, which may cover other invoices too.
      mpesa: p.mpesa_transaction_id ? {
        transactionId: p.mpesa_transaction_id, receiptAmount: toAmount(p.receipt_amount_cents),
        refunded: Boolean(p.receipt_refunded_at), refund: refunds.get(p.mpesa_transaction_id) || null
      } : null
    })),
    unallocated: await mpesa.unallocated(),
    commands: await mpesa.recentCommands(),
    commandsReady: require('../config').daraja.commandsReady
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

/** A customer says they paid and shows the SMS, but nothing arrived: ask Safaricom about the code. */
router.post('/mpesa/lookup', allow('payments:write'), async (req, res) => {
  res.status(202).json(await mpesa.lookupReceipt(req, { receipt: req.body?.receipt, invoiceId: req.body?.invoiceId || null }));
});

router.get('/mpesa/commands/:id', allow('payments:read'), async (req, res) => {
  res.json(await mpesa.getCommand(req.params.id));
});

/** Sends a whole receipt back to the customer. Owner only, and they confirm who they are first. */
router.post('/mpesa/transactions/:id/refund', allow('mpesa:refund'), async (req, res) => {
  await auth.confirmIdentity(req, { password: req.body?.password, code: req.body?.code });
  res.status(202).json(await mpesa.refundTransaction(req, req.params.id, req.body?.reason));
});

module.exports = router;
