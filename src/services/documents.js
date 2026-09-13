/**
 * Quotations and invoices: creating them, reading them back with their money
 * worked out, and the stock they move. Routes, recurring billing and imports
 * all come through here so the rules live in one place.
 */
const db = require('../db');
const settings = require('../settings');
const { audit } = require('../audit');
const { fail } = require('../errors');
const { today, addDays, isIsoDate } = require('../dates');
const { toAmount, formatCents, cleanItems, documentTotals, invoiceStatus, ageBucket } = require('../totals');

/* ---------- currency ---------- */

async function rateFor(conn, currency) {
  const base = (await settings.company(conn)).baseCurrency;
  const code = String(currency || base).toUpperCase();
  if (code === base) return { currency: code, fxRate: 1 };
  const row = await conn('currencies').where({ code }).first();
  if (!row) fail(400, `There's no exchange rate for ${code} yet. Add one under Settings → Currencies.`);
  return { currency: code, fxRate: Number(row.rate_to_base) };
}

/* ---------- lines ---------- */

async function validateLines(conn, items) {
  const lines = cleanItems(items);
  if (!lines.length) fail(400, 'Add at least one line with a description.');
  if (lines.length > 200) fail(400, 'That is more than 200 lines. Split it into two documents.');
  for (const l of lines) {
    if (l.quantity < 0 || l.unitPriceCents < 0) fail(400, `"${l.description}" has a negative quantity or price.`);
  }
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter(Boolean))];
  if (itemIds.length) {
    const found = new Set((await conn('items').whereIn('id', itemIds).select('id')).map((r) => r.id));
    lines.forEach((l) => { if (l.itemId && !found.has(l.itemId)) l.itemId = null; });
  }
  return lines;
}

async function writeLines(trx, table, parentKey, parentId, lines) {
  await trx(table).where({ [parentKey]: parentId }).del();
  if (!lines.length) return;
  await trx(table).insert(lines.map((l, position) => ({
    [parentKey]: parentId,
    position,
    item_id: l.itemId || null,
    description: l.description,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents
  })));
}

async function readLines(conn, table, parentKey, ids) {
  if (!ids.length) return new Map();
  const rows = await conn(table).whereIn(parentKey, ids).orderBy([parentKey, 'position']);
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r[parentKey])) map.set(r[parentKey], []);
    map.get(r[parentKey]).push({
      description: r.description,
      quantity: Number(r.quantity),
      unitPriceCents: Number(r.unit_price_cents),
      itemId: r.item_id || null
    });
  });
  return map;
}

const linesOut = (lines) => lines.map((l) => ({
  description: l.description,
  quantity: l.quantity,
  unitPrice: toAmount(l.unitPriceCents),
  itemId: l.itemId,
  lineTotal: toAmount(Math.round(l.quantity * l.unitPriceCents))
}));

/* ---------- stock ---------- */

/** Moves stock for tracked items. direction -1 when goods leave, +1 when they come back. */
async function moveStock(trx, actor, lines, direction, reason, refType, refId) {
  const warnings = [];
  const byItem = new Map();
  lines.filter((l) => l.itemId).forEach((l) => byItem.set(l.itemId, (byItem.get(l.itemId) || 0) + l.quantity));

  for (const [itemId, qty] of byItem) {
    const item = await db.lock(trx('items').where({ id: itemId })).first();
    if (!item || !item.track_stock || !qty) continue;
    const balance = Number(item.stock_qty) + direction * qty;
    await trx('items').where({ id: itemId }).update({ stock_qty: balance, updated_at: db.now() });
    await trx('stock_movements').insert({
      item_id: itemId, change: direction * qty, balance_after: balance, reason,
      ref_type: refType, ref_id: refId, user_id: actor?.user?.id || null, created_at: db.now()
    });
    if (direction < 0 && balance < 0) {
      warnings.push(`${item.name}: stock is now ${balance} ${item.unit || ''}. Record the goods received to correct it.`.replace(/ +\./, '.'));
    }
  }
  return warnings;
}

/* ---------- invoices ---------- */

async function paidByInvoice(conn, ids) {
  const query = conn('payments').whereNull('reversed_at').select('invoice_id').sum({ paid: 'amount_cents' }).groupBy('invoice_id');
  if (ids) query.whereIn('invoice_id', ids);
  const map = new Map();
  (await query).forEach((r) => map.set(r.invoice_id, Number(r.paid) || 0));
  return map;
}

function invoiceOut(row, paidCents, lines, on = today()) {
  const status = invoiceStatus(row, paidCents, on);
  const balanceCents = row.status === 'cancelled' ? 0 : row.total_cents - paidCents;
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    clientId: row.client_id,
    clientName: row.client_name ?? undefined,
    quotationId: row.quotation_id,
    recurringId: row.recurring_id,
    reference: row.reference,
    date: row.date,
    dueDate: row.due_date,
    currency: row.currency,
    fxRate: Number(row.fx_rate),
    subtotal: toAmount(row.subtotal_cents),
    discount: toAmount(row.discount_cents),
    vatRate: Number(row.vat_rate),
    vat: toAmount(row.vat_cents),
    total: toAmount(row.total_cents),
    paid: toAmount(paidCents),
    balance: toAmount(balanceCents),
    balanceCents,
    status,
    age: status === 'paid' || status === 'cancelled' ? 'current' : ageBucket(row.due_date, on),
    notes: row.notes || '',
    emailedAt: row.emailed_at || null,
    createdAt: row.created_at,
    version: row.version,
    ...(lines ? { lines: linesOut(lines) } : {})
  };
}

/** Invoices with computed status and balance. Filters: ids, clientId, open (balance > 0, not cancelled). */
async function listInvoices(conn, { ids, clientId, withLines = false, on } = {}) {
  const q = conn('invoices').join('clients', 'clients.id', 'invoices.client_id')
    .select('invoices.*', 'clients.name as client_name')
    .orderBy([{ column: 'invoices.date', order: 'desc' }, { column: 'invoices.number', order: 'desc' }]);
  if (ids) q.whereIn('invoices.id', ids);
  if (clientId) q.where('invoices.client_id', clientId);
  const rows = await q;
  const paid = await paidByInvoice(conn, ids);
  const lines = withLines ? await readLines(conn, 'invoice_lines', 'invoice_id', rows.map((r) => r.id)) : null;
  return rows.map((r) => invoiceOut(r, paid.get(r.id) || 0, lines ? lines.get(r.id) || [] : null, on));
}

async function getInvoice(conn, id) {
  const [inv] = await listInvoices(conn, { ids: [id], withLines: true });
  if (!inv) fail(404, 'Invoice not found.');
  return inv;
}

/**
 * Creates an invoice and moves stock. Returns { invoice, warnings }.
 * Used by: new invoice, quotation conversion, recurring billing, opening-balance import.
 */
async function createInvoice(trx, actor, input) {
  const client = await trx('clients').where({ id: input.clientId }).first();
  if (!client) fail(400, 'Pick a client first.');

  const company = await settings.company(trx);
  const kind = input.kind === 'opening' ? 'opening' : 'standard';
  const lines = await validateLines(trx, input.items);
  const date = input.date || today();
  const dueDate = input.dueDate || addDays(date, Number(company.paymentTerms) || 14);
  if (!isIsoDate(date) || !isIsoDate(dueDate)) fail(400, 'Dates must look like 2026-03-31.');
  if (dueDate < date) fail(400, 'The due date is before the invoice date.');

  const { currency, fxRate } = await rateFor(trx, input.currency || client.currency);
  const vatRate = input.vatRate === undefined || input.vatRate === '' ? Number(company.vatRate) : Number(input.vatRate);
  if (!(vatRate >= 0 && vatRate <= 100)) fail(400, 'VAT rate must be between 0 and 100.');
  const totals = documentTotals(lines, input.discountCents || 0, vatRate);

  const row = {
    id: db.newId(),
    number: await db.nextNumber(trx, kind === 'opening' ? 'opening' : 'invoice'),
    kind,
    client_id: client.id,
    quotation_id: input.quotationId || null,
    recurring_id: input.recurringId || null,
    reference: input.reference || null,
    date,
    due_date: dueDate,
    currency,
    fx_rate: input.fxRate ? Number(input.fxRate) : fxRate,
    discount_cents: totals.discount,
    vat_rate: vatRate,
    subtotal_cents: totals.subtotal,
    vat_cents: totals.vat,
    total_cents: totals.total,
    notes: input.notes || '',
    status: 'open',
    created_by: actor?.user?.id || null,
    created_at: db.now(),
    version: 1
  };
  await trx('invoices').insert(row);
  await writeLines(trx, 'invoice_lines', 'invoice_id', row.id, lines);
  const warnings = kind === 'opening' ? [] : await moveStock(trx, actor, lines, -1, 'invoice', 'invoice', row.id);

  const from = input.quotationId ? ' from a quotation' : input.recurringId ? ' from a recurring schedule' : '';
  await audit(trx, actor, {
    action: 'create', entity: 'invoice', entityId: row.id,
    summary: `${row.number} for ${client.name}: ${currency} ${formatCents(row.total_cents)}${from}`,
    after: { number: row.number, client: client.name, currency, total: toAmount(row.total_cents), dueDate, lines: linesOut(lines) }
  });
  return { invoice: row, lines, warnings };
}

async function cancelInvoice(trx, actor, id) {
  const inv = await db.lock(trx('invoices').where({ id })).first();
  if (!inv) fail(404, 'Invoice not found.');
  if (inv.status === 'cancelled') fail(400, 'That invoice is already cancelled.');
  const live = await trx('payments').where({ invoice_id: id }).whereNull('reversed_at').first();
  if (live) fail(400, 'This invoice has payments against it. Reverse them before cancelling.');

  await trx('invoices').where({ id }).update({ status: 'cancelled', cancelled_at: db.now(), updated_at: db.now(), version: inv.version + 1 });
  const lines = (await readLines(trx, 'invoice_lines', 'invoice_id', [id])).get(id) || [];
  if (inv.kind !== 'opening') await moveStock(trx, actor, lines, +1, 'cancel', 'invoice', id);
  await audit(trx, actor, { action: 'cancel', entity: 'invoice', entityId: id, summary: `Cancelled ${inv.number}`, changes: { status: ['open', 'cancelled'] } });
}

/* ---------- quotations ---------- */

function quotationOut(row, lines) {
  return {
    id: row.id,
    number: row.number,
    clientId: row.client_id,
    clientName: row.client_name ?? undefined,
    date: row.date,
    validUntil: row.valid_until,
    currency: row.currency,
    fxRate: Number(row.fx_rate),
    subtotal: toAmount(row.subtotal_cents),
    discount: toAmount(row.discount_cents),
    vatRate: Number(row.vat_rate),
    vat: toAmount(row.vat_cents),
    total: toAmount(row.total_cents),
    notes: row.notes || '',
    status: row.status,
    invoiceId: row.invoice_id,
    createdAt: row.created_at,
    version: row.version,
    ...(lines ? { lines: linesOut(lines) } : {})
  };
}

async function listQuotations(conn, { ids, withLines = false } = {}) {
  const q = conn('quotations').join('clients', 'clients.id', 'quotations.client_id')
    .select('quotations.*', 'clients.name as client_name')
    .orderBy([{ column: 'quotations.date', order: 'desc' }, { column: 'quotations.number', order: 'desc' }]);
  if (ids) q.whereIn('quotations.id', ids);
  const rows = await q;
  const lines = withLines ? await readLines(conn, 'quotation_lines', 'quotation_id', rows.map((r) => r.id)) : null;
  return rows.map((r) => quotationOut(r, lines ? lines.get(r.id) || [] : null));
}

async function getQuotation(conn, id) {
  const [q] = await listQuotations(conn, { ids: [id], withLines: true });
  if (!q) fail(404, 'Quotation not found.');
  return q;
}

/* ---------- display helpers shared by PDF and email ---------- */

async function documentContext(conn, kind, id) {
  const doc = kind === 'invoice' ? await getInvoice(conn, id) : await getQuotation(conn, id);
  const client = await conn('clients').where({ id: doc.clientId }).first();
  const company = await settings.company(conn);
  const payments = kind === 'invoice'
    ? await conn('payments').where({ invoice_id: id }).whereNull('reversed_at').orderBy('date')
    : [];
  return { kind, doc, client, company, payments };
}

module.exports = {
  rateFor, validateLines, writeLines, readLines, linesOut, moveStock,
  paidByInvoice, invoiceOut, listInvoices, getInvoice, createInvoice, cancelInvoice,
  quotationOut, listQuotations, getQuotation, documentContext
};
