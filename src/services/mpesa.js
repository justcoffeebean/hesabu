/**
 * M-Pesa money coming in, from two directions:
 *
 *   STK push  We ask a customer's phone to pay an invoice; Safaricom calls
 *             /hooks/stk/<secret> with the result.
 *   C2B       The customer pays the paybill/till themselves; Safaricom calls
 *             /hooks/c2b/<secret>/confirm. We match the account number they
 *             typed to an invoice number or a client's account code.
 *
 * Every receipt becomes an mpesa_transactions row first (unique on the
 * receipt number, so Safaricom retrying a callback can't double-count), and
 * is then allocated to invoices. Whatever can't be matched waits in the
 * unallocated list for a person to place.
 */
const db = require('../db');
const daraja = require('./daraja');
const { audit } = require('../audit');
const { fail } = require('../errors');
const { today } = require('../dates');
const { toAmount, toCents, formatCents } = require('../totals');
const { paidByInvoice } = require('./documents');
const { recordPayment, lockedBalance } = require('./payments');

const MPESA = { id: null, name: 'M-Pesa' };

/** '0722 884 019', '+254722884019', '722884019' → '254722884019'. Null if it isn't a Kenyan mobile. */
function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '254' + digits.slice(1);
  else if (/^[71]\d{8}$/.test(digits)) digits = '254' + digits;
  return /^254[71]\d{8}$/.test(digits) ? digits : null;
}

const normalizeRef = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** '20260913143015' → '2026-09-13' */
function mpesaDate(value) {
  const s = String(value || '');
  return /^\d{14}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : today();
}

/* ---------- STK push ---------- */

async function requestStk(actor, { invoiceId, phone, amount }) {
  const inv = await db.knex('invoices').where({ id: invoiceId }).first();
  if (!inv) fail(404, 'Invoice not found.');
  if (inv.status === 'cancelled') fail(400, `${inv.number} was cancelled.`);
  if (inv.currency !== 'KES') fail(400, `M-Pesa only takes shillings, and ${inv.number} is in ${inv.currency}.`);

  const msisdn = normalizePhone(phone);
  if (!msisdn) fail(400, 'Enter a Safaricom number like 0722 123 456.');

  const paid = (await paidByInvoice(db.knex, [inv.id])).get(inv.id) || 0;
  const balance = inv.total_cents - paid;
  if (balance <= 0) fail(400, `${inv.number} is already paid.`);

  // M-Pesa only moves whole shillings.
  const shillings = Math.round(Number(amount));
  if (!(shillings >= 1)) fail(400, 'Enter at least KES 1.');
  if (shillings * 100 > Math.ceil(balance / 100) * 100) {
    fail(400, `That is more than the KES ${formatCents(balance)} still owed on ${inv.number}.`);
  }

  const response = await daraja.stkPush({
    phone: msisdn, amount: shillings, accountReference: inv.number, description: `Inv ${inv.number.slice(-4)}`
  });
  if (String(response.ResponseCode) !== '0') {
    fail(502, `M-Pesa didn't accept the request: ${response.ResponseDescription || response.errorMessage || 'unknown reason'}.`);
  }

  const row = {
    id: db.newId(),
    invoice_id: inv.id,
    phone: msisdn,
    amount_cents: shillings * 100,
    merchant_request_id: response.MerchantRequestID || null,
    checkout_request_id: response.CheckoutRequestID,
    status: 'pending',
    created_by: actor?.user?.id || null,
    created_at: db.now()
  };
  await db.tx(async (trx) => {
    await trx('mpesa_requests').insert(row);
    await audit(trx, actor, {
      action: 'stk-request', entity: 'invoice', entityId: inv.id,
      summary: `Asked ${msisdn.replace(/^(\d{6})\d{3}/, '$1***')} to pay KES ${formatCents(shillings * 100)} on ${inv.number} by M-Pesa`
    });
  });
  return { request: requestOut(row), customerMessage: response.CustomerMessage };
}

function requestOut(r) {
  return {
    id: r.id, invoiceId: r.invoice_id, phone: r.phone, amount: toAmount(r.amount_cents),
    status: r.status, resultCode: r.result_code || null, resultDesc: r.result_desc || null,
    createdAt: r.created_at
  };
}

const RESULT_TEXT = {
  1: 'The customer doesn\'t have enough money in M-Pesa.',
  1032: 'The customer cancelled the request on their phone.',
  1037: 'The customer\'s phone didn\'t respond in time. Check it is on and try again.',
  2001: 'The customer entered the wrong M-Pesa PIN.'
};

/** Handles Safaricom's STK result callback. Safe to receive more than once. */
async function handleStkCallback(body) {
  const cb = body && body.Body && body.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return { ignored: 'not an STK callback' };

  return db.tx(async (trx) => {
    const req = await db.lock(trx('mpesa_requests').where({ checkout_request_id: cb.CheckoutRequestID })).first();
    if (!req) return { ignored: 'unknown CheckoutRequestID' };

    const code = String(cb.ResultCode);
    if (code !== '0') {
      if (req.status === 'pending') {
        await trx('mpesa_requests').where({ id: req.id }).update({
          status: 'failed', result_code: code, result_desc: RESULT_TEXT[code] || cb.ResultDesc || 'Payment failed.', updated_at: db.now()
        });
      }
      return { status: 'failed' };
    }

    const meta = {};
    ((cb.CallbackMetadata && cb.CallbackMetadata.Item) || []).forEach((i) => { meta[i.Name] = i.Value; });
    const amountCents = toCents(meta.Amount ?? toAmount(req.amount_cents));
    const receipt = meta.MpesaReceiptNumber ? String(meta.MpesaReceiptNumber) : null;

    // Already settled by a status check that ran before this callback arrived: just fill in the receipt.
    if (req.mpesa_transaction_id) {
      if (receipt) {
        await trx('mpesa_transactions').where({ id: req.mpesa_transaction_id }).whereNull('receipt')
          .update({ receipt, phone: String(meta.PhoneNumber || req.phone), raw: JSON.stringify(body) });
        await trx('payments').where({ mpesa_transaction_id: req.mpesa_transaction_id }).update({ reference: receipt });
      }
      return { status: 'paid', duplicate: true };
    }

    const txn = await upsertTransaction(trx, {
      receipt, source: 'stk', amountCents, phone: String(meta.PhoneNumber || req.phone),
      billRef: null, date: mpesaDate(meta.TransactionDate), raw: body
    });
    await trx('mpesa_requests').where({ id: req.id }).update({
      status: 'paid', result_code: '0', result_desc: 'Paid', mpesa_transaction_id: txn.id, updated_at: db.now()
    });
    if (!txn.duplicate) await allocateToInvoice(trx, MPESA, txn, req.invoice_id);
    return { status: 'paid' };
  });
}

/** For when a callback never arrives (e.g. running locally without a public URL). */
async function checkStk(actor, requestId) {
  const req = await db.knex('mpesa_requests').where({ id: requestId }).first();
  if (!req) fail(404, 'Payment request not found.');
  if (req.status !== 'pending') return requestOut(req);

  const result = await daraja.stkQuery(req.checkout_request_id);
  const code = result.ResultCode === undefined ? null : String(result.ResultCode);
  if (code === null) return requestOut(req); // still being processed on Safaricom's side

  if (code === '0') {
    await handleStkCallback({
      Body: { stkCallback: { CheckoutRequestID: req.checkout_request_id, ResultCode: 0, CallbackMetadata: { Item: [{ Name: 'Amount', Value: toAmount(req.amount_cents) }, { Name: 'PhoneNumber', Value: req.phone }] } } }
    });
  } else {
    await handleStkCallback({ Body: { stkCallback: { CheckoutRequestID: req.checkout_request_id, ResultCode: code, ResultDesc: result.ResultDesc } } });
  }
  return requestOut(await db.knex('mpesa_requests').where({ id: requestId }).first());
}

/* ---------- C2B ---------- */

async function handleC2bConfirmation(body) {
  if (!body || !body.TransID || body.TransAmount === undefined) return { ignored: 'not a C2B confirmation' };
  return db.tx(async (trx) => {
    const name = [body.FirstName, body.MiddleName, body.LastName].filter(Boolean).join(' ');
    const txn = await upsertTransaction(trx, {
      receipt: String(body.TransID), source: 'c2b', amountCents: toCents(body.TransAmount),
      phone: body.MSISDN ? String(body.MSISDN) : null, payerName: name || null,
      billRef: body.BillRefNumber ? String(body.BillRefNumber) : null, date: mpesaDate(body.TransTime), raw: body
    });
    if (txn.duplicate) return { duplicate: true };
    const allocated = await autoAllocate(trx, txn);
    return { allocated };
  });
}

async function upsertTransaction(trx, t) {
  if (t.receipt) {
    const existing = await trx('mpesa_transactions').where({ receipt: t.receipt }).first();
    if (existing) return { ...existing, duplicate: true };
  }
  const row = {
    id: db.newId(), receipt: t.receipt, source: t.source, amount_cents: t.amountCents, allocated_cents: 0,
    phone: t.phone, payer_name: t.payerName || null, bill_ref: t.billRef, date: t.date,
    raw: JSON.stringify(t.raw), created_at: db.now()
  };
  await trx('mpesa_transactions').insert(row);
  return row;
}

/** Oldest-due open shilling invoices first. */
async function openKesInvoices(trx, where) {
  const rows = await trx('invoices').where(where).where({ currency: 'KES' }).whereNot({ status: 'cancelled' })
    .orderBy([{ column: 'due_date' }, { column: 'number' }]);
  const paid = await paidByInvoice(trx, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, balance: r.total_cents - (paid.get(r.id) || 0) })).filter((r) => r.balance > 0);
}

async function allocateToInvoice(trx, actor, txn, invoiceId, maxCents) {
  const remaining = Number(txn.amount_cents) - Number(txn.allocated_cents || 0);
  if (remaining <= 0) return 0;
  // Lock first, then read the balance, so a payment landing at the same moment can't overdraw it.
  const { inv, balance } = await lockedBalance(trx, invoiceId);
  if (!inv || inv.status === 'cancelled' || inv.currency !== 'KES' || balance <= 0) return 0;
  const amount = Math.min(remaining, balance, maxCents ?? Infinity);
  if (amount <= 0) return 0;
  await recordPayment(trx, actor, {
    invoiceId, amountCents: amount, method: 'M-Pesa', reference: txn.receipt || '', date: txn.date,
    source: 'mpesa', mpesaTransactionId: txn.id
  });
  await trx('mpesa_transactions').where({ id: txn.id }).increment('allocated_cents', amount);
  txn.allocated_cents = Number(txn.allocated_cents || 0) + amount;
  return amount;
}

/** Account number → invoice number (INV-2026-0007, inv20260007) or a client's account code (oldest invoices first). */
async function autoAllocate(trx, txn) {
  const ref = normalizeRef(txn.bill_ref);
  if (!ref) return 0;

  const byNumber = /^(INV|OB)(\d{4})(\d{4})$/.exec(ref);
  if (byNumber) {
    const inv = await trx('invoices').where({ number: `${byNumber[1]}-${byNumber[2]}-${byNumber[3]}` }).first();
    if (inv) return allocateToInvoice(trx, MPESA, txn, inv.id);
  }

  const client = await trx('clients').where({ account_code: ref }).first();
  if (!client) return 0;
  let total = 0;
  for (const inv of await openKesInvoices(trx, { client_id: client.id })) {
    if (Number(txn.amount_cents) - Number(txn.allocated_cents) <= 0) break;
    total += await allocateToInvoice(trx, MPESA, txn, inv.id);
  }
  return total;
}

/** A person places an unmatched (or partly matched) receipt against an invoice. */
async function allocateManually(actor, transactionId, invoiceId, amount) {
  return db.tx(async (trx) => {
    const txn = await db.lock(trx('mpesa_transactions').where({ id: transactionId })).first();
    if (!txn) fail(404, 'M-Pesa receipt not found.');
    const remaining = Number(txn.amount_cents) - Number(txn.allocated_cents);
    if (remaining <= 0) fail(400, 'All of this receipt has already been placed.');
    const inv = await trx('invoices').where({ id: invoiceId }).first();
    if (!inv) fail(400, 'Pick the invoice this money is for.');
    if (inv.currency !== 'KES') fail(400, `${inv.number} is in ${inv.currency}; M-Pesa receipts are in shillings.`);

    const wanted = amount === undefined || amount === '' ? remaining : toCents(amount);
    if (!(wanted > 0)) fail(400, 'Enter an amount greater than zero.');
    if (wanted > remaining) fail(400, `Only KES ${formatCents(remaining)} of this receipt is left to place.`);

    const placed = await allocateToInvoice(trx, actor, txn, invoiceId, wanted);
    if (!placed) fail(400, `${inv.number} has nothing left to pay.`);
    return { placed: toAmount(placed), left: toAmount(remaining - placed) };
  });
}

async function unallocated(conn = db.knex) {
  const rows = await conn('mpesa_transactions').whereRaw('amount_cents > allocated_cents').orderBy('date', 'desc');
  return rows.map((t) => ({
    id: t.id, receipt: t.receipt, source: t.source, date: t.date, phone: t.phone, payerName: t.payer_name,
    billRef: t.bill_ref, amount: toAmount(t.amount_cents), left: toAmount(t.amount_cents - t.allocated_cents)
  }));
}

module.exports = {
  normalizePhone, normalizeRef, requestStk, requestOut, checkStk, handleStkCallback,
  handleC2bConfirmation, allocateManually, unallocated
};
