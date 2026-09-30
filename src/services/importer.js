/**
 * CSV import for switching over: clients, items (with opening stock) and
 * opening balances. Every import is previewed first, and commits all rows or
 * none — a half-imported file is worse than a rejected one, because running
 * it again would double everything.
 */
const db = require('../db');
const { audit } = require('../audit');
const { fail } = require('../errors');
const { today, isIsoDate } = require('../dates');
const { toCents, formatCents } = require('../totals');
const documents = require('./documents');
const { normalizeRef } = require('./mpesa');

const MAX_ROWS = 5000;

/** RFC 4180-ish: quoted fields, "" escapes, commas and newlines inside quotes, CRLF, BOM. */
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

const headerKey = (h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function toObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) fail(400, 'The file is empty.');
  if (rows.length - 1 > MAX_ROWS) fail(400, `That's more than ${MAX_ROWS} rows. Split the file and import it in parts.`);
  const headers = rows[0].map(headerKey);
  return { headers, records: rows.slice(1).map((r, i) => ({ line: i + 2, data: Object.fromEntries(headers.map((h, j) => [h, String(r[j] ?? '').trim()])) })) };
}

/** '12,500.00', 'KES 12500', '12500' → 12500. NaN when it isn't a number. */
function parseAmount(s) {
  const clean = String(s || '').replace(/[A-Za-z\s,]/g, '');
  return clean === '' ? NaN : Number(clean);
}

/** Accepts 2026-03-31, 31/03/2026, 31-03-2026 (day first, as in Kenya). */
function parseDate(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  if (isIsoDate(v)) return v;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (!m) return undefined;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : undefined;
}

const truthy = (s) => ['1', 'yes', 'y', 'true'].includes(String(s || '').trim().toLowerCase());

/* ---------- kinds ---------- */

const KINDS = {
  clients: {
    label: 'Clients',
    columns: ['name', 'email', 'phone', 'address', 'kra_pin', 'account_code', 'currency'],
    required: ['name'],
    example: ['Acme Hardware Ltd', 'orders@acme.co.ke', '0711 220 340', 'Enterprise Road, Nairobi', 'P051234567X', 'ACME', 'KES'],

    async check(conn, records, base) {
      const existingNames = new Set((await conn('clients').select('name')).map((c) => c.name.toLowerCase()));
      const existingCodes = new Set((await conn('clients').whereNotNull('account_code').select('account_code')).map((c) => c.account_code));
      const currencies = new Set([base, ...(await conn('currencies').select('code')).map((c) => c.code)]);
      const seenNames = new Set();
      const seenCodes = new Set();
      return records.map(({ line, data }) => {
        const errors = [];
        const name = data.name;
        if (!name) errors.push('Name is missing.');
        else if (existingNames.has(name.toLowerCase())) errors.push(`A client called "${name}" already exists.`);
        else if (seenNames.has(name.toLowerCase())) errors.push(`"${name}" appears twice in this file.`);
        if (name) seenNames.add(name.toLowerCase());
        if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push(`"${data.email}" isn't an email address.`);
        const code = data.account_code ? normalizeRef(data.account_code) : null;
        if (code && (existingCodes.has(code) || seenCodes.has(code))) errors.push(`Account code ${code} is already used.`);
        if (code) seenCodes.add(code);
        const currency = (data.currency || base).toUpperCase();
        if (!currencies.has(currency)) errors.push(`No exchange rate set up for ${currency}.`);
        return { line, errors, value: { name, email: data.email || null, phone: data.phone || null, address: data.address || null, kra_pin: data.kra_pin || null, account_code: code, currency } };
      });
    },

    async commit(trx, actor, rows) {
      const at = db.now();
      for (const r of rows) await trx('clients').insert({ id: db.newId(), ...r.value, reminders: true, version: 1, created_at: at });
      await audit(trx, actor, { action: 'import', entity: 'client', summary: `Imported ${rows.length} clients from CSV` });
    }
  },

  items: {
    label: 'Items',
    columns: ['name', 'sku', 'unit', 'unit_price', 'track_stock', 'stock_qty', 'reorder_level'],
    required: ['name'],
    example: ['Industrial degreaser, 20L drum', 'DG-20', 'drum', '7800', 'yes', '24', '10'],

    async check(conn, records) {
      const existingNames = new Set((await conn('items').select('name')).map((i) => i.name.toLowerCase()));
      const existingSkus = new Set((await conn('items').whereNotNull('sku').select('sku')).map((i) => i.sku.toUpperCase()));
      const seen = new Set();
      return records.map(({ line, data }) => {
        const errors = [];
        if (!data.name) errors.push('Name is missing.');
        else if (existingNames.has(data.name.toLowerCase()) || seen.has(data.name.toLowerCase())) errors.push(`"${data.name}" already exists.`);
        if (data.name) seen.add(data.name.toLowerCase());
        const sku = data.sku ? data.sku.toUpperCase() : null;
        if (sku && existingSkus.has(sku)) errors.push(`SKU ${sku} is already used.`);
        if (sku) existingSkus.add(sku);
        const price = data.unit_price === '' || data.unit_price === undefined ? 0 : parseAmount(data.unit_price);
        if (!(price >= 0)) errors.push(`Unit price "${data.unit_price}" isn't a number.`);
        const track = truthy(data.track_stock) || (data.stock_qty !== undefined && data.stock_qty !== '');
        const qty = data.stock_qty ? Number(data.stock_qty.replace(/,/g, '')) : 0;
        const reorder = data.reorder_level ? Number(data.reorder_level.replace(/,/g, '')) : 0;
        if (Number.isNaN(qty) || Number.isNaN(reorder)) errors.push('Stock and reorder level must be numbers.');
        return { line, errors, value: { name: data.name, sku, unit: data.unit || null, unit_price_cents: toCents(price), track_stock: track, stock_qty: qty, reorder_level: reorder } };
      });
    },

    async commit(trx, actor, rows) {
      const at = db.now();
      for (const r of rows) {
        const id = db.newId();
        await trx('items').insert({ id, ...r.value, active: true, version: 1, created_at: at });
        if (r.value.track_stock && r.value.stock_qty) {
          await trx('stock_movements').insert({ item_id: id, change: r.value.stock_qty, balance_after: r.value.stock_qty, reason: 'import', note: 'Opening stock', user_id: actor.user?.id || null, created_at: at });
        }
      }
      await audit(trx, actor, { action: 'import', entity: 'item', summary: `Imported ${rows.length} items from CSV` });
    }
  },

  balances: {
    label: 'Opening balances',
    columns: ['client', 'reference', 'date', 'due_date', 'amount', 'currency', 'notes'],
    required: ['client', 'amount'],
    example: ['Acme Hardware Ltd', 'OLD-1043', '15/02/2026', '01/03/2026', '48,500.00', 'KES', 'Carried over from the old system'],

    async check(conn, records, base) {
      const clients = await conn('clients').select('id', 'name', 'account_code', 'currency');
      const byName = new Map(clients.map((c) => [c.name.toLowerCase(), c]));
      const byCode = new Map(clients.filter((c) => c.account_code).map((c) => [c.account_code, c]));
      const currencies = new Set([base, ...(await conn('currencies').select('code')).map((c) => c.code)]);
      return records.map(({ line, data }) => {
        const errors = [];
        const client = byName.get(String(data.client || '').toLowerCase()) || byCode.get(normalizeRef(data.client));
        if (!data.client) errors.push('Client is missing.');
        else if (!client) errors.push(`No client called "${data.client}". Import clients first.`);
        const amount = parseAmount(data.amount);
        if (!(amount > 0)) errors.push(`Amount "${data.amount}" must be a number above zero.`);
        const date = parseDate(data.date);
        const due = parseDate(data.due_date);
        if (date === undefined) errors.push(`Date "${data.date}" isn't a date. Use 2026-03-31 or 31/03/2026.`);
        if (due === undefined) errors.push(`Due date "${data.due_date}" isn't a date. Use 2026-03-31 or 31/03/2026.`);
        const currency = (data.currency || client?.currency || base).toUpperCase();
        if (!currencies.has(currency)) errors.push(`No exchange rate set up for ${currency}.`);
        const on = date || today();
        if (due && due < on) errors.push('Due date is before the date.');
        return {
          line, errors,
          value: { clientId: client?.id, clientName: client?.name, reference: data.reference || null, date: on, dueDate: due || on, amount, currency, notes: data.notes || '' }
        };
      });
    },

    async commit(trx, actor, rows) {
      let total = 0;
      for (const r of rows) {
        const v = r.value;
        await documents.createInvoice(trx, actor, {
          kind: 'opening', clientId: v.clientId, currency: v.currency, date: v.date, dueDate: v.dueDate,
          reference: v.reference, vatRate: 0, notes: v.notes,
          items: [{ description: v.reference ? `Opening balance (${v.reference})` : 'Opening balance', quantity: 1, unitPrice: v.amount }]
        });
        total += v.amount;
      }
      await audit(trx, actor, { action: 'import', entity: 'invoice', summary: `Imported ${rows.length} opening balances totalling ${formatCents(toCents(total))} from CSV` });
    }
  }
};

function kindOf(name) {
  const kind = Object.hasOwn(KINDS, name) ? KINDS[name] : null; // not 'constructor', '__proto__', …
  if (!kind) fail(404, 'You can import clients, items or balances.');
  return kind;
}

function template(name) {
  const kind = kindOf(name);
  const quote = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${kind.columns.join(',')}\n${kind.example.map(quote).join(',')}\n`;
}

async function preview(name, csv) {
  const kind = kindOf(name);
  const { headers, records } = toObjects(csv);
  const missing = kind.required.filter((c) => !headers.includes(c));
  if (missing.length) fail(400, `The first row must name the columns. Missing: ${missing.join(', ')}. Download the template to see the layout.`);
  const base = (await require('../settings').company()).baseCurrency;
  const rows = await kind.check(db.knex, records, base);
  const unknown = headers.filter((h) => h && !kind.columns.includes(h));
  return {
    kind: name,
    total: rows.length,
    valid: rows.filter((r) => !r.errors.length).length,
    ignoredColumns: unknown,
    rows: rows.map((r) => ({ line: r.line, errors: r.errors, value: r.value }))
  };
}

async function commit(actor, name, csv) {
  const kind = kindOf(name);
  const result = await preview(name, csv);
  if (!result.total) fail(400, 'There are no rows to import.');
  const bad = result.rows.filter((r) => r.errors.length);
  if (bad.length) fail(400, `${bad.length} row${bad.length === 1 ? ' has' : 's have'} problems. Fix ${bad.length === 1 ? 'it' : 'them'} and upload again — nothing was imported.`, { rows: bad.slice(0, 50) });
  await db.tx((trx) => kind.commit(trx, actor, result.rows));
  return { imported: result.total };
}

module.exports = { parseCsv, parseAmount, parseDate, template, preview, commit, KINDS };
