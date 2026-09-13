const express = require('express');
const db = require('../db');
const settings = require('../settings');
const { allow } = require('../auth');
const { can } = require('../permissions');
const { today, addMonths } = require('../dates');
const { toAmount } = require('../totals');
const { listInvoices } = require('../services/documents');
const mpesa = require('../services/mpesa');

const router = express.Router();

/**
 * Everything here is in the base currency. Foreign invoices are converted at
 * the rate stored on each invoice, so yesterday's figures don't move when
 * today's exchange rate does.
 */
router.get('/dashboard', allow('dashboard:read'), async (req, res) => {
  const on = today();
  const month = on.slice(0, 7);
  const company = await settings.company();
  const invoices = await listInvoices(db.knex, { on });
  const live = invoices.filter((i) => i.status !== 'cancelled');
  const open = live.filter((i) => i.balanceCents > 0);
  const base = (i, c) => Math.round(c * i.fxRate);

  const aging = { current: 0, '1-30': 0, '31-60': 0, '60+': 0 };
  const byCurrency = {};
  open.forEach((i) => {
    aging[i.age] += base(i, i.balanceCents);
    byCurrency[i.currency] = (byCurrency[i.currency] || 0) + i.balanceCents;
  });

  const payments = await db.knex('payments').join('invoices', 'invoices.id', 'payments.invoice_id')
    .whereNull('payments.reversed_at')
    .where('payments.date', '>=', `${month}-01`).where('payments.date', '<', addMonths(`${month}-01`, 1))
    .select('payments.amount_cents', 'invoices.fx_rate');
  const collected = payments.reduce((s, p) => s + Math.round(Number(p.amount_cents) * Number(p.fx_rate)), 0);

  const [quotations, tasks, lowStock] = await Promise.all([
    db.knex('quotations').select('status', 'invoice_id'),
    db.knex('tasks').whereNot({ status: 'done' }).select('due_date'),
    db.knex('items').where({ track_stock: true, active: true }).whereRaw('stock_qty <= reorder_level').orderBy('name').select('id', 'name', 'unit', 'stock_qty', 'reorder_level')
  ]);

  const money = can(req.user, 'payments:read');
  const unallocated = money ? await mpesa.unallocated() : [];

  res.json({
    currency: company.baseCurrency,
    outstanding: toAmount(Object.values(aging).reduce((a, b) => a + b, 0)),
    overdue: toAmount(open.filter((i) => i.status === 'overdue').reduce((s, i) => s + base(i, i.balanceCents), 0)),
    collectedThisMonth: toAmount(collected),
    invoicedThisMonth: toAmount(live.filter((i) => i.date.startsWith(month)).reduce((s, i) => s + base(i, Math.round(i.total * 100)), 0)),
    aging: Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, toAmount(v)])),
    outstandingByCurrency: Object.fromEntries(Object.entries(byCurrency).map(([k, v]) => [k, toAmount(v)])),
    unpaidInvoices: open.length,
    openQuotations: quotations.filter((q) => !q.invoice_id && q.status !== 'declined').length,
    awaitingInvoice: quotations.filter((q) => q.status === 'accepted' && !q.invoice_id).length,
    jobsDueToday: tasks.filter((t) => t.due_date && t.due_date <= on).length,
    lowStock: lowStock.map((i) => ({ id: i.id, name: i.name, unit: i.unit || '', stockQty: Number(i.stock_qty), reorderLevel: Number(i.reorder_level) })),
    unallocatedMpesa: { count: unallocated.length, amount: unallocated.reduce((s, t) => s + t.left, 0) },
    topDebtors: [...open]
      .sort((a, b) => base(b, b.balanceCents) - base(a, a.balanceCents))
      .slice(0, 5)
      .map((i) => ({ id: i.id, number: i.number, clientName: i.clientName, balance: i.balance, currency: i.currency, status: i.status, dueDate: i.dueDate }))
  });
});

module.exports = router;
