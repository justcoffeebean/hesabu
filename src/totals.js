/**
 * All money is held in whole cents (integers) to keep addition exact.
 * The API accepts and returns plain amounts (12500.5); conversion happens at
 * the edges with toCents()/toAmount().
 */
const { today, daysBetween } = require('./dates');

const toCents = (n) => Math.round(Number(n || 0) * 100);
const toAmount = (cents) => Math.round(Number(cents || 0)) / 100;
/** 9918000 → '99,180.00', for messages people read. */
const formatCents = (cents) => toAmount(cents).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Normalises line input from the browser or a CSV. Drops lines with no description. */
function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && String(i.description || '').trim())
    .map((i) => ({
      description: String(i.description).trim().slice(0, 500),
      quantity: Number(i.quantity) || 0,
      unitPriceCents: i.unitPriceCents !== undefined ? Math.round(Number(i.unitPriceCents) || 0) : toCents(i.unitPrice),
      itemId: i.itemId || null
    }));
}

/** Subtotal, discount, VAT and grand total, all in cents. */
function documentTotals(lines, discountCents = 0, vatRate = 0) {
  const lineCents = lines.map((l) => Math.round(Number(l.quantity) * Number(l.unitPriceCents)));
  const subtotal = lineCents.reduce((s, c) => s + c, 0);
  const discount = Math.max(0, Math.min(Math.round(discountCents), subtotal));
  const taxable = subtotal - discount;
  const vat = Math.round(taxable * (Number(vatRate) / 100));
  return { lineCents, subtotal, discount, vat, total: taxable + vat };
}

/** Where an invoice stands. `open` and `cancelled` are stored; the rest is derived. */
function invoiceStatus(invoice, paidCents, on = today()) {
  const balance = invoice.total_cents - paidCents;
  if (invoice.status === 'cancelled') return 'cancelled';
  if (balance <= 0) return 'paid';
  if (paidCents > 0) return invoice.due_date < on ? 'overdue' : 'part-paid';
  return invoice.due_date < on ? 'overdue' : 'unpaid';
}

/** Days a balance has been outstanding, bucketed the way collections teams read it. */
function ageBucket(dueDate, on = today()) {
  if (!dueDate) return 'current';
  const days = daysBetween(dueDate, on);
  if (days <= 0) return 'current';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  return '60+';
}

module.exports = { toCents, toAmount, formatCents, cleanItems, documentTotals, invoiceStatus, ageBucket };
