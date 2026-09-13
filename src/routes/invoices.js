const express = require('express');
const db = require('../db');
const settings = require('../settings');
const { allow } = require('../auth');
const { can } = require('../permissions');
const { cents } = require('../validate');
const { toAmount } = require('../totals');
const documents = require('../services/documents');
const { documentPdf, sendPdf } = require('../services/pdf');
const { emailInvoice } = require('../services/sending');
const reminders = require('../services/reminders');
const { requestOut } = require('../services/mpesa');

const router = express.Router();

router.get('/invoices', allow('invoices:read'), async (req, res) => {
  let out = await documents.listInvoices(db.knex, { clientId: req.query.clientId || undefined });
  if (req.query.status) out = out.filter((i) => i.status === req.query.status);
  if (req.query.open) out = out.filter((i) => i.balanceCents > 0 && i.status !== 'cancelled');
  res.json(out);
});

router.get('/invoices/:id', allow('invoices:read'), async (req, res) => {
  const inv = await documents.getInvoice(db.knex, req.params.id);
  const money = can(req.user, 'payments:read');
  const [client, company, payments, requests, sent] = await Promise.all([
    db.knex('clients').where({ id: inv.clientId }).first(),
    settings.company(),
    money
      ? db.knex('payments').leftJoin('users', 'users.id', 'payments.created_by').where({ invoice_id: inv.id })
        .orderBy('payments.date').select('payments.*', 'users.name as by')
      : [],
    db.knex('mpesa_requests').where({ invoice_id: inv.id }).orderBy('created_at', 'desc').limit(5),
    money ? db.knex('outbox').where({ invoice_id: inv.id }).orderBy('created_at', 'desc').limit(20) : []
  ]);
  // History covers the invoice and every payment made against it.
  let history = null;
  if (can(req.user, 'audit:read')) {
    const paymentIds = payments.map((p) => p.id);
    history = (await db.knex('audit_log')
      .where((q) => {
        q.where({ entity: 'invoice', entity_id: inv.id });
        if (paymentIds.length) q.orWhere((w) => w.where({ entity: 'payment' }).whereIn('entity_id', paymentIds));
      })
      .orderBy('id', 'desc').limit(100))
      .map((e) => ({ at: e.at, userName: e.user_name, action: e.action, summary: e.summary }));
  }

  res.json({
    ...inv,
    history,
    company,
    client: client && {
      id: client.id, name: client.name, email: client.email || '', phone: client.phone || '',
      address: client.address || '', kraPin: client.kra_pin || '', accountCode: client.account_code || ''
    },
    payments: payments.map((p) => ({
      id: p.id, amount: toAmount(p.amount_cents), method: p.method, reference: p.reference || '', date: p.date,
      source: p.source, by: p.by || (p.source === 'mpesa' ? 'M-Pesa' : null),
      reversed: Boolean(p.reversed_at), reversalReason: p.reversal_reason || null
    })),
    mpesaRequests: requests.map(requestOut),
    messages: sent.map((m) => ({ id: m.id, channel: m.channel, to: m.recipient, purpose: m.purpose, status: m.status, at: m.sent_at || m.created_at, error: m.error }))
  });
});

router.post('/invoices', allow('invoices:write'), async (req, res) => {
  const b = req.body || {};
  const result = await db.tx((trx) => documents.createInvoice(trx, req, {
    clientId: b.clientId, items: b.items, notes: String(b.notes || '').slice(0, 4000), discountCents: cents(b.discount, 'Discount'),
    vatRate: b.vatRate, dueDate: b.dueDate || undefined, currency: b.currency || undefined
  }));
  res.status(201).json({ ...(await documents.getInvoice(db.knex, result.invoice.id)), warnings: result.warnings });
});

router.post('/invoices/:id/cancel', allow('invoices:write'), async (req, res) => {
  await db.tx((trx) => documents.cancelInvoice(trx, req, req.params.id));
  res.json(await documents.getInvoice(db.knex, req.params.id));
});

router.get('/invoices/:id/pdf', allow('invoices:read'), async (req, res) => {
  const { buffer, filename } = await documentPdf('invoice', req.params.id);
  sendPdf(req, res, buffer, filename);
});

router.post('/invoices/:id/email', allow('invoices:send'), async (req, res) => {
  res.json(await emailInvoice(req, req.params.id, { to: req.body?.to, note: req.body?.note }));
});

router.post('/invoices/:id/remind', allow('invoices:send'), async (req, res) => {
  const channel = req.body?.channel === 'sms' ? 'sms' : 'email';
  res.json(await reminders.sendNow(req, req.params.id, { channel }));
});

module.exports = router;
