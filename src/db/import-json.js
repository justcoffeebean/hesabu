/**
 * One-time move from the old data/hesabu.json store into the database.
 * Runs at startup only if the JSON file exists and has never been imported.
 * The JSON file is left untouched as a backup.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('./index');
const settings = require('../settings');
const { SYSTEM, audit } = require('../audit');
const { toCents, documentTotals } = require('../totals');

const LEGACY_FILE = path.join(config.root, 'data', 'hesabu.json');

const lines = (items) => (items || [])
  .filter((i) => i && String(i.description || '').trim())
  .map((i) => ({ description: String(i.description).trim(), quantity: Number(i.quantity) || 0, unitPriceCents: toCents(i.unitPrice), itemId: null }));

async function importLegacyJson(file = LEGACY_FILE) {
  if (!fs.existsSync(file)) return null;
  if (await db.knex('settings').where({ key: 'legacy_import' }).first()) return null;

  const hasData = await db.knex('clients').first('id') || await db.knex('invoices').first('id');
  if (hasData) {
    // The database was set up some other way (seed, CSV import); don't merge two histories.
    await db.putSetting(db.knex, 'legacy_import', { skipped: true, at: db.now() });
    return null;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`data/hesabu.json could not be read, so it wasn't imported. Fix or move it, then restart. (${err.message})`);
  }

  const at = db.now();
  const counts = await db.tx(async (trx) => {
    const company = { ...settings.COMPANY, ...(data.company || {}) };
    company.baseCurrency = company.baseCurrency || company.currency || 'KES';
    delete company.currency;
    await db.putSetting(trx, 'company', company);
    const base = company.baseCurrency;

    for (const c of data.clients || []) {
      await trx('clients').insert({
        id: c.id, name: c.name, email: c.email || null, phone: c.phone || null, address: c.address || null,
        currency: base, reminders: true, version: 1, created_at: c.createdAt ? `${c.createdAt}T00:00:00.000Z` : at
      });
    }

    const writeDoc = async (table, lineTable, key, doc, extra) => {
      const l = lines(doc.items);
      const t = documentTotals(l, toCents(doc.discount), Number(doc.vatRate ?? company.vatRate));
      await trx(table).insert({
        id: doc.id, number: doc.number, client_id: doc.clientId, date: doc.date, currency: base, fx_rate: 1,
        discount_cents: t.discount, vat_rate: Number(doc.vatRate ?? company.vatRate),
        subtotal_cents: t.subtotal, vat_cents: t.vat, total_cents: t.total, notes: doc.notes || '',
        version: 1, created_at: at, ...extra
      });
      if (!l.length) return;
      await trx(lineTable).insert(l.map((x, position) => ({
        [key]: doc.id, position, description: x.description, quantity: x.quantity, unit_price_cents: x.unitPriceCents
      })));
    };

    // Invoices first: quotations point at them, and invoices point back.
    for (const inv of data.invoices || []) {
      await writeDoc('invoices', 'invoice_lines', 'invoice_id', inv, {
        kind: 'standard', quotation_id: null, due_date: inv.dueDate || inv.date,
        status: inv.status === 'cancelled' ? 'cancelled' : 'open'
      });
    }
    for (const q of data.quotations || []) {
      await writeDoc('quotations', 'quotation_lines', 'quotation_id', q, {
        valid_until: q.validUntil || null, status: q.status || 'draft', invoice_id: q.invoiceId || null
      });
    }
    for (const inv of data.invoices || []) {
      if (inv.quotationId) await trx('invoices').where({ id: inv.id }).update({ quotation_id: inv.quotationId });
    }

    for (const p of data.payments || []) {
      await trx('payments').insert({
        id: p.id, invoice_id: p.invoiceId, amount_cents: toCents(p.amount), method: p.method || 'M-Pesa',
        reference: p.reference || '', date: p.date, source: 'manual', created_at: at
      });
    }

    for (const t of data.tasks || []) {
      await trx('tasks').insert({
        id: t.id, title: t.title, assignee: t.assignee || null, client_id: t.clientId || null, due_date: t.dueDate || null,
        priority: t.priority || 'normal', status: t.status || 'todo', version: 1, created_at: at
      });
    }

    for (const [kind, value] of Object.entries(data.counters || {})) {
      await trx('counters').insert({ kind, value: Number(value) || 0 });
    }

    const summary = {
      clients: (data.clients || []).length, quotations: (data.quotations || []).length,
      invoices: (data.invoices || []).length, payments: (data.payments || []).length, tasks: (data.tasks || []).length
    };
    await db.putSetting(trx, 'legacy_import', { at, ...summary });
    await audit(trx, SYSTEM, { action: 'import', entity: 'settings', summary: `Moved data from data/hesabu.json: ${Object.entries(summary).map(([k, v]) => `${v} ${k}`).join(', ')}` });
    return summary;
  });

  console.log(`  Imported data/hesabu.json into the database (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}). The JSON file was left as a backup.`);
  return counts;
}

module.exports = { importLegacyJson, LEGACY_FILE };
