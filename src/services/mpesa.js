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
 *
 * Two things go the other way, as "commands" Safaricom answers later at
 * /hooks/async/<secret>/result:
 *
 *   Lookup    Ask about a receipt code whose callback never came (the
 *             customer shows you the SMS); if it paid us, record it.
 *   Refund    Reverse a whole receipt back to the customer; once Safaricom
 *             confirms, every payment made from it is reversed in the books.
 */
const config = require('../config');
const db = require('../db');
const daraja = require('./daraja');
const { audit } = require('../audit');
const { fail } = require('../errors');
const { today } = require('../dates');
const { toAmount, toCents, formatCents } = require('../totals');
const { paidByInvoice } = require('./documents');
const { recordPayment, reversePayment, lockedBalance } = require('./payments');

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
    if (txn.refunded_at) fail(400, 'This money was refunded to the customer.');
    if (await trx('mpesa_commands').where({ kind: 'refund', mpesa_transaction_id: txn.id }).whereIn('status', ['pending', 'unknown']).first()) {
      fail(400, 'A refund of this receipt is waiting for Safaricom. Wait for it to finish first.');
    }
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
  const rows = await conn('mpesa_transactions').whereRaw('amount_cents > allocated_cents').whereNull('refunded_at').orderBy('date', 'desc');
  const refunds = await refundStates(conn, rows.map((t) => t.id));
  return rows.map((t) => ({
    id: t.id, receipt: t.receipt, source: t.source, date: t.date, phone: t.phone, payerName: t.payer_name,
    billRef: t.bill_ref, amount: toAmount(t.amount_cents), left: toAmount(t.amount_cents - t.allocated_cents),
    refund: refunds.get(t.id) || null
  }));
}

/* ---------- commands: lookups and refunds ---------- */

const RECEIPT = /^[A-Z0-9]{10}$/; // M-Pesa receipt codes are always 10 characters, like SJ84K2LQ01
const OPEN = ['pending', 'unknown']; // unknown: Safaricom never answered, so it may or may not have happened

function commandOut(c) {
  return {
    id: c.id, kind: c.kind, receipt: c.receipt, invoiceId: c.invoice_id || null, transactionId: c.mpesa_transaction_id || null,
    amount: c.amount_cents === null || c.amount_cents === undefined ? null : toAmount(c.amount_cents),
    reason: c.reason || null, status: c.status, resultDesc: c.result_desc || null, createdAt: c.created_at, updatedAt: c.updated_at || null
  };
}

/** Latest refund state per transaction: { status, resultDesc } for the payments screen. */
async function refundStates(conn, transactionIds) {
  const out = new Map();
  if (!transactionIds.length) return out;
  const rows = await conn('mpesa_commands').where({ kind: 'refund' }).whereIn('mpesa_transaction_id', transactionIds).orderBy('created_at');
  rows.forEach((c) => out.set(c.mpesa_transaction_id, { id: c.id, status: c.status, resultDesc: c.result_desc || null }));
  return out;
}

async function getCommand(id) {
  const row = await db.knex('mpesa_commands').where({ id }).first();
  if (!row) fail(404, 'Not found.');
  return commandOut(row);
}

async function recentCommands(limit = 10) {
  return (await db.knex('mpesa_commands').orderBy('created_at', 'desc').limit(limit)).map(commandOut);
}

/** Sends the command to Safaricom for a row already saved as pending; marks it failed if Safaricom won't take it. */
async function dispatch(row, send) {
  let response;
  try {
    response = await send();
    if (String(response.ResponseCode) !== '0') {
      const e = new Error(`M-Pesa didn't accept it: ${response.ResponseDescription || response.errorMessage || 'unknown reason'}.`);
      e.status = 502;
      throw e;
    }
  } catch (err) {
    await db.knex('mpesa_commands').where({ id: row.id }).update({ status: 'failed', result_desc: String(err.message).slice(0, 300), updated_at: db.now() });
    throw err;
  }
  const ids = {
    originator_conversation_id: response.OriginatorConversationID ? String(response.OriginatorConversationID) : null,
    conversation_id: response.ConversationID ? String(response.ConversationID) : null
  };
  await db.knex('mpesa_commands').where({ id: row.id }).update({ ...ids, updated_at: db.now() });
  return { ...row, ...ids };
}

/** "Look up an M-Pesa code": for a payment whose callback never arrived. */
async function lookupReceipt(actor, { receipt, invoiceId }) {
  const code = normalizeRef(receipt);
  if (!RECEIPT.test(code)) fail(400, 'Enter the M-Pesa code from the SMS, like SJ84K2LQ01.');
  const known = await db.knex('mpesa_transactions').where({ receipt: code }).first();
  if (known) {
    fail(409, `${code} is already in Hesabu${Number(known.amount_cents) > Number(known.allocated_cents) && !known.refunded_at ? ', waiting to be placed' : ''}.`);
  }
  if (invoiceId) {
    const inv = await db.knex('invoices').where({ id: invoiceId }).first();
    if (!inv) fail(400, 'Pick the invoice this payment is for.');
    if (inv.currency !== 'KES') fail(400, `${inv.number} is in ${inv.currency}; M-Pesa payments are in shillings.`);
    if (inv.status === 'cancelled') fail(400, `${inv.number} was cancelled.`);
  }

  const row = await db.tx(async (trx) => {
    const waiting = await trx('mpesa_commands').where({ kind: 'lookup', receipt: code }).whereIn('status', OPEN).first();
    if (waiting) return { ...waiting, existing: true };
    const r = {
      id: db.newId(), kind: 'lookup', receipt: code, invoice_id: invoiceId || null, status: 'pending',
      requested_by: actor?.user?.id || null, created_at: db.now()
    };
    await trx('mpesa_commands').insert(r);
    await audit(trx, actor, { action: 'mpesa-lookup', entity: 'mpesa', entityId: r.id, summary: `Asked M-Pesa about receipt ${code}` });
    return r;
  });
  if (row.existing) return commandOut(row);
  return commandOut(await dispatch(row, () => daraja.transactionStatus(code)));
}

/** "Refund by M-Pesa": sends a whole receipt back to the customer. Owner only; the route confirms their password first. */
async function refundTransaction(actor, transactionId, reason) {
  const why = String(reason || '').trim();
  if (!why) fail(400, 'Say why this money is going back. It goes in the audit log and on the M-Pesa request.');

  const row = await db.tx(async (trx) => {
    // Locked so two clicks (or two owners) can't send the same refund twice.
    const txn = await db.lock(trx('mpesa_transactions').where({ id: transactionId })).first();
    if (!txn) fail(404, 'M-Pesa receipt not found.');
    if (!txn.receipt) fail(400, "This payment doesn't have an M-Pesa receipt yet, so it can't be refunded.");
    if (txn.refunded_at) fail(400, `${txn.receipt} was already refunded.`);
    const open = await trx('mpesa_commands').where({ kind: 'refund', mpesa_transaction_id: txn.id }).whereIn('status', OPEN).first();
    if (open?.status === 'pending') fail(409, `A refund of ${txn.receipt} is already waiting for Safaricom.`);
    // "unknown" means Safaricom never answered. Retrying is safe: M-Pesa refuses to reverse the same receipt twice.
    const r = {
      id: db.newId(), kind: 'refund', receipt: txn.receipt, mpesa_transaction_id: txn.id, amount_cents: Number(txn.amount_cents),
      reason: why.slice(0, 200), status: 'pending', requested_by: actor?.user?.id || null, created_at: db.now()
    };
    if (open) await trx('mpesa_commands').where({ id: open.id }).update({ status: 'failed', result_desc: 'Superseded by a new refund request.', updated_at: db.now() });
    await trx('mpesa_commands').insert(r);
    await audit(trx, actor, {
      action: 'mpesa-refund', entity: 'mpesa', entityId: txn.id,
      summary: `Asked M-Pesa to refund KES ${formatCents(txn.amount_cents)} (${txn.receipt}) to ${txn.payer_name || txn.phone || 'the customer'}: ${why}`
    });
    return r;
  });
  // M-Pesa moves whole shillings, and a reversal is always for the whole receipt.
  return commandOut(await dispatch(row, () => daraja.reversal(row.receipt, Math.round(row.amount_cents / 100), why)));
}

function resultParams(result) {
  const list = result?.ResultParameters?.ResultParameter;
  const items = Array.isArray(list) ? list : list ? [list] : [];
  return Object.fromEntries(items.map((p) => [p.Key, p.Value]));
}

/** Safaricom's answer to a lookup or refund, at /hooks/async/<secret>/result (or /timeout). Safe to receive more than once. */
async function handleCommandResult(body, { timedOut = false } = {}) {
  const r = body && body.Result;
  if (!r) return { ignored: 'not a command result' };
  const params = resultParams(r);

  return db.tx(async (trx) => {
    let cmd = null;
    for (const [column, value] of [['originator_conversation_id', r.OriginatorConversationID], ['conversation_id', r.ConversationID]]) {
      if (!cmd && value) cmd = await db.lock(trx('mpesa_commands').where({ [column]: String(value) })).first();
    }
    // An answer can beat us to saving the conversation IDs; fall back to the receipt it's about.
    const about = normalizeRef(params.ReceiptNo || params.OriginalTransactionID || '');
    if (!cmd && about) {
      cmd = await db.lock(trx('mpesa_commands').where({ receipt: about }).whereIn('status', OPEN).orderBy('created_at', 'desc')).first();
    }
    if (!cmd) return { ignored: 'unknown command' };
    if (!OPEN.includes(cmd.status)) return { duplicate: true };

    const settle = (status, desc, extra = {}) => trx('mpesa_commands').where({ id: cmd.id }).update({
      status, result_code: r.ResultCode === undefined ? null : String(r.ResultCode), result_desc: String(desc).slice(0, 300),
      result_raw: JSON.stringify(body), updated_at: db.now(), ...extra
    });

    if (timedOut) {
      // For a refund we can't be sure nothing happened, so it stays open as "unknown" rather than "failed".
      if (cmd.kind === 'refund') await settle('unknown', "Safaricom's queue timed out. Check your M-Pesa statement, then try the refund again if the money is still there.");
      else await settle('failed', 'Safaricom took too long to answer. Try the lookup again.');
      return { status: 'timeout' };
    }
    if (String(r.ResultCode) !== '0') {
      await settle('failed', r.ResultDesc || 'M-Pesa refused.');
      await audit(trx, MPESA, { action: `mpesa-${cmd.kind}`, entity: 'mpesa', entityId: cmd.mpesa_transaction_id || cmd.id, summary: `M-Pesa ${cmd.kind} of ${cmd.receipt} failed: ${r.ResultDesc || r.ResultCode}` });
      return { status: 'failed' };
    }
    return cmd.kind === 'lookup' ? finishLookup(trx, cmd, params, body, settle) : finishRefund(trx, cmd, r, settle);
  });
}

async function finishLookup(trx, cmd, params, body, settle) {
  const state = String(params.TransactionStatus || '');
  if (state && state.toLowerCase() !== 'completed') {
    await settle('failed', `M-Pesa says this payment is "${state}", not completed.`);
    return { status: 'failed' };
  }
  // Only money that came to us. "600984 - Business Name"
  const credit = String(params.CreditPartyName || '').trim();
  const ours = [config.daraja.shortcode, config.daraja.partyB].filter(Boolean);
  if (credit && !ours.some((code) => credit.startsWith(code))) {
    await settle('failed', `That payment went to ${credit.split(' - ')[0]}, not to your ${config.daraja.type}.`);
    return { status: 'failed' };
  }
  const amountCents = toCents(params.Amount);
  if (!(amountCents > 0)) {
    await settle('failed', "M-Pesa's answer didn't include an amount.");
    return { status: 'failed' };
  }
  // "254722000111 - Jane Doe" (production may mask digits: "2547*****111 - Jane Doe")
  const [who, ...name] = String(params.DebitPartyName || '').split(' - ');
  const phone = /^[\d*]{9,15}$/.test(who.trim()) ? who.trim() : null;
  const receipt = normalizeRef(params.ReceiptNo || cmd.receipt);

  const txn = await upsertTransaction(trx, {
    receipt, source: 'c2b', amountCents, phone, payerName: name.join(' - ').trim() || null, billRef: null,
    date: mpesaDate(params.FinalisedTime || params.InitiatedTime), raw: body
  });
  if (txn.duplicate) {
    await settle('done', 'It was already recorded.', { mpesa_transaction_id: txn.id });
    return { status: 'done', duplicate: true };
  }
  const placed = cmd.invoice_id ? await allocateToInvoice(trx, MPESA, txn, cmd.invoice_id) : 0;
  const inv = placed ? await trx('invoices').where({ id: cmd.invoice_id }).first() : null;
  const left = amountCents - placed;
  const desc = `Found KES ${formatCents(amountCents)}${txn.payer_name ? ` from ${txn.payer_name}` : ''}.` +
    (placed ? ` Put KES ${formatCents(placed)} on ${inv.number}.` : '') +
    (left > 0 ? ` KES ${formatCents(left)} is waiting to be placed.` : '');
  await settle('done', desc, { mpesa_transaction_id: txn.id, amount_cents: amountCents });
  await audit(trx, MPESA, { action: 'mpesa-found', entity: 'mpesa', entityId: txn.id, summary: `Looked up ${receipt}: ${desc}` });
  return { status: 'done' };
}

async function finishRefund(trx, cmd, r, settle) {
  const txn = await db.lock(trx('mpesa_transactions').where({ id: cmd.mpesa_transaction_id })).first();
  if (txn.refunded_at) {
    await settle('done', 'It was already refunded.');
    return { status: 'done', duplicate: true };
  }
  const reversalReceipt = r.TransactionID ? String(r.TransactionID).slice(0, 40) : null;
  const live = await trx('payments').where({ mpesa_transaction_id: txn.id }).whereNull('reversed_at');
  for (const p of live) {
    await reversePayment(trx, MPESA, p.id, `Refunded to the customer by M-Pesa${reversalReceipt ? ` (${reversalReceipt})` : ''}: ${cmd.reason}`);
  }
  await trx('mpesa_transactions').where({ id: txn.id }).update({ refunded_at: db.now(), refund_receipt: reversalReceipt });
  const desc = `Refunded KES ${formatCents(txn.amount_cents)} to ${txn.payer_name || txn.phone || 'the customer'}${live.length ? `; reversed ${live.length} payment${live.length === 1 ? '' : 's'} in the books` : ''}.`;
  await settle('done', desc);
  await audit(trx, MPESA, { action: 'mpesa-refunded', entity: 'mpesa', entityId: txn.id, summary: `${txn.receipt}: ${desc}` });
  return { status: 'done' };
}

/** Scheduler: requests Safaricom never answered. Lookups just fail; refunds become "unknown" (check the statement). */
async function expireCommands(olderThanMs = 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  await db.knex('mpesa_commands').where({ kind: 'lookup', status: 'pending' }).where('created_at', '<', cutoff)
    .update({ status: 'failed', result_desc: 'No answer from Safaricom. Try the lookup again.', updated_at: db.now() });
  await db.knex('mpesa_commands').where({ kind: 'refund', status: 'pending' }).where('created_at', '<', cutoff)
    .update({ status: 'unknown', result_desc: 'No answer from Safaricom yet. Check your M-Pesa statement before trying again.', updated_at: db.now() });
}

module.exports = {
  normalizePhone, normalizeRef, requestStk, requestOut, checkStk, handleStkCallback,
  handleC2bConfirmation, allocateManually, unallocated,
  lookupReceipt, refundTransaction, handleCommandResult, getCommand, recentCommands, refundStates, expireCommands, commandOut
};
