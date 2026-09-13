/**
 * Money received against invoices. Every path that records a payment — typed
 * in by hand, confirmed by M-Pesa, or allocated from an unmatched receipt —
 * goes through recordPayment(), which locks the invoice so two payments
 * arriving together can never push it past zero.
 */
const db = require('../db');
const { audit } = require('../audit');
const { fail } = require('../errors');
const { today, isIsoDate } = require('../dates');
const { toAmount, formatCents } = require('../totals');
const { paidByInvoice } = require('./documents');

const METHODS = ['M-Pesa', 'Bank transfer', 'Cheque', 'Cash', 'Card', 'Other'];

async function lockedBalance(trx, invoiceId) {
  const inv = await db.lock(trx('invoices').where({ id: invoiceId })).first();
  if (!inv) return { inv: null, balance: 0 };
  const paid = (await paidByInvoice(trx, [invoiceId])).get(invoiceId) || 0;
  return { inv, balance: inv.total_cents - paid };
}

async function recordPayment(trx, actor, input) {
  const { inv, balance } = await lockedBalance(trx, input.invoiceId);
  if (!inv) fail(400, 'Pick the invoice this payment settles.');
  if (inv.status === 'cancelled') fail(400, `${inv.number} was cancelled.`);

  const amount = Math.round(Number(input.amountCents));
  if (!(amount > 0)) fail(400, 'Enter an amount greater than zero.');
  if (amount > balance) {
    fail(400, `That is more than the ${inv.currency} ${formatCents(balance)} still owed on ${inv.number}.`);
  }
  const date = input.date || today();
  if (!isIsoDate(date)) fail(400, 'Payment date must look like 2026-03-31.');
  // M-Pesa stamps receipts in East Africa Time, which can be "tomorrow" for a server set to another zone.
  if (date > today() && input.source !== 'mpesa') fail(400, "The payment date can't be in the future.");

  const method = input.method || 'M-Pesa';
  if (!METHODS.includes(method)) fail(400, `Method must be one of: ${METHODS.join(', ')}.`);

  const row = {
    id: db.newId(),
    invoice_id: inv.id,
    amount_cents: amount,
    method,
    reference: String(input.reference || '').trim().slice(0, 60),
    date,
    source: input.source || 'manual',
    mpesa_transaction_id: input.mpesaTransactionId || null,
    created_by: actor?.user?.id || null,
    created_at: db.now()
  };
  await trx('payments').insert(row);
  await audit(trx, actor, {
    action: 'create', entity: 'payment', entityId: row.id,
    summary: `${inv.currency} ${formatCents(amount)} ${method}${row.reference ? ` (${row.reference})` : ''} against ${inv.number}`,
    after: { invoice: inv.number, amount: toAmount(amount), method, reference: row.reference, date, source: row.source }
  });
  return { payment: row, invoice: inv, balanceAfter: balance - amount };
}

/**
 * Payments are never deleted; they are reversed with a reason. If the money
 * came in through M-Pesa it really did arrive, so it goes back to the
 * unallocated pile instead of disappearing.
 */
async function reversePayment(trx, actor, id, reason) {
  const p = await db.lock(trx('payments').where({ id })).first();
  if (!p) fail(404, 'Payment not found.');
  if (p.reversed_at) fail(400, 'That payment was already reversed.');
  const why = String(reason || '').trim();
  if (!why) fail(400, 'Say why this payment is being reversed. It goes in the audit log.');

  await trx('payments').where({ id }).update({
    reversed_at: db.now(), reversed_by: actor?.user?.id || null, reversal_reason: why.slice(0, 200)
  });
  if (p.mpesa_transaction_id) {
    await trx('mpesa_transactions').where({ id: p.mpesa_transaction_id }).decrement('allocated_cents', Number(p.amount_cents));
  }
  const inv = await trx('invoices').where({ id: p.invoice_id }).first();
  await audit(trx, actor, {
    action: 'reverse', entity: 'payment', entityId: id,
    summary: `Reversed ${inv.currency} ${formatCents(p.amount_cents)} on ${inv.number}: ${why}`,
    changes: {
      reversed: [false, true],
      reason: [null, why],
      payment: [{ amount: toAmount(p.amount_cents), method: p.method, reference: p.reference, date: p.date }, null]
    }
  });
  return { payment: p, invoice: inv };
}

module.exports = { METHODS, recordPayment, reversePayment, lockedBalance };
