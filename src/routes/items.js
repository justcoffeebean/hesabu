/** Products and services you sell, with optional stock tracking. */
const express = require('express');
const db = require('../db');
const { allow } = require('../auth');
const { audit } = require('../audit');
const { fail, checkVersion } = require('../errors');
const { text, cents } = require('../validate');
const { toAmount } = require('../totals');

const router = express.Router();

const itemOut = (i) => ({
  id: i.id, name: i.name, sku: i.sku || '', unit: i.unit || '', unitPrice: toAmount(i.unit_price_cents),
  trackStock: Boolean(i.track_stock), stockQty: Number(i.stock_qty), reorderLevel: Number(i.reorder_level),
  low: Boolean(i.track_stock) && Number(i.stock_qty) <= Number(i.reorder_level),
  active: Boolean(i.active), version: i.version
});

async function readBody(trx, b, existing) {
  const name = text(b.name ?? existing?.name);
  if (!name) fail(400, 'Give the item a name.');
  const sku = b.sku !== undefined ? (text(b.sku, 60) || '').toUpperCase() || null : existing?.sku ?? null;
  if (sku) {
    const clash = await trx('items').where({ sku }).whereNot({ id: existing?.id || '' }).first();
    if (clash) fail(409, `SKU ${sku} is already used by ${clash.name}.`);
  }
  const reorder = b.reorderLevel !== undefined ? Number(b.reorderLevel) : Number(existing?.reorder_level || 0);
  if (!(reorder >= 0)) fail(400, 'Reorder level must be zero or more.');
  return {
    name,
    sku,
    unit: b.unit !== undefined ? text(b.unit, 30) : existing?.unit ?? null,
    unit_price_cents: b.unitPrice !== undefined ? cents(b.unitPrice, 'Unit price') : Number(existing?.unit_price_cents || 0),
    track_stock: b.trackStock !== undefined ? Boolean(b.trackStock) : Boolean(existing?.track_stock),
    reorder_level: reorder,
    active: b.active !== undefined ? Boolean(b.active) : existing ? Boolean(existing.active) : true
  };
}

router.get('/items', allow('items:read'), async (_req, res) => {
  res.json((await db.knex('items').orderBy('name')).map(itemOut));
});

router.post('/items', allow('items:write'), async (req, res) => {
  const out = await db.tx(async (trx) => {
    const fields = await readBody(trx, req.body || {});
    const opening = Number(req.body?.stockQty) || 0;
    if (opening < 0) fail(400, 'Opening stock must be zero or more.');
    const row = { id: db.newId(), ...fields, stock_qty: fields.track_stock ? opening : 0, version: 1, created_at: db.now() };
    await trx('items').insert(row);
    if (fields.track_stock && opening) {
      await trx('stock_movements').insert({
        item_id: row.id, change: opening, balance_after: opening, reason: 'received', note: 'Opening stock', user_id: req.user.id, created_at: db.now()
      });
    }
    await audit(trx, req, { action: 'create', entity: 'item', entityId: row.id, summary: `Added item ${row.name}`, after: itemOut(row) });
    return itemOut(row);
  });
  res.status(201).json(out);
});

router.put('/items/:id', allow('items:write'), async (req, res) => {
  const out = await db.tx(async (trx) => {
    const item = await db.lock(trx('items').where({ id: req.params.id })).first();
    if (!item) fail(404, 'Item not found.');
    checkVersion(item, req.body?.version, 'item');
    const fields = await readBody(trx, req.body || {}, item);
    await trx('items').where({ id: item.id }).update({ ...fields, updated_at: db.now(), version: item.version + 1 });
    const after = await trx('items').where({ id: item.id }).first();
    await audit(trx, req, { action: 'update', entity: 'item', entityId: item.id, summary: `Edited item ${after.name}`, before: itemOut(item), after: itemOut(after) });
    return itemOut(after);
  });
  res.json(out);
});

/**
 * Stock in, or a count correction.
 *   { mode: 'received', quantity: 20 }  → adds 20
 *   { mode: 'count', quantity: 14 }     → sets the balance to 14 (what's physically on the shelf)
 */
router.post('/items/:id/stock', allow('stock:adjust'), async (req, res) => {
  const mode = req.body?.mode === 'count' ? 'count' : 'received';
  const qty = Number(req.body?.quantity);
  if (!Number.isFinite(qty) || (mode === 'received' ? qty <= 0 : qty < 0)) {
    fail(400, mode === 'received' ? 'Enter how many came in.' : 'Enter how many are on the shelf.');
  }
  const note = text(req.body?.note, 300);
  const out = await db.tx(async (trx) => {
    const item = await db.lock(trx('items').where({ id: req.params.id })).first();
    if (!item) fail(404, 'Item not found.');
    if (!item.track_stock) fail(400, `Stock isn't tracked for ${item.name}. Turn it on by editing the item.`);
    const current = Number(item.stock_qty);
    const balance = mode === 'count' ? qty : current + qty;
    const change = balance - current;
    if (change === 0) return itemOut(item);
    await trx('items').where({ id: item.id }).update({ stock_qty: balance, updated_at: db.now(), version: item.version + 1 });
    await trx('stock_movements').insert({
      item_id: item.id, change, balance_after: balance, reason: mode === 'count' ? 'adjusted' : 'received', note, user_id: req.user.id, created_at: db.now()
    });
    await audit(trx, req, {
      action: 'stock', entity: 'item', entityId: item.id,
      summary: mode === 'count'
        ? `Counted ${item.name}: ${current} → ${balance}${note ? ` (${note})` : ''}`
        : `Received ${[qty, item.unit].filter(Boolean).join(' ')} of ${item.name}`,
      changes: { stock: [current, balance] }
    });
    return itemOut(await trx('items').where({ id: item.id }).first());
  });
  res.json(out);
});

router.get('/items/:id/movements', allow('items:read'), async (req, res) => {
  const rows = await db.knex('stock_movements').leftJoin('users', 'users.id', 'stock_movements.user_id')
    .where({ item_id: req.params.id }).orderBy('stock_movements.id', 'desc').limit(100)
    .select('stock_movements.*', 'users.name as user_name');
  const invoiceIds = rows.filter((r) => r.ref_type === 'invoice').map((r) => r.ref_id);
  const numbers = new Map((invoiceIds.length ? await db.knex('invoices').whereIn('id', invoiceIds).select('id', 'number') : []).map((i) => [i.id, i.number]));
  res.json(rows.map((r) => ({
    at: r.created_at, change: Number(r.change), balance: Number(r.balance_after), reason: r.reason,
    reference: r.ref_type === 'invoice' ? numbers.get(r.ref_id) || null : null, note: r.note || '', by: r.user_name || 'System'
  })));
});

router.delete('/items/:id', allow('items:write'), async (req, res) => {
  await db.tx(async (trx) => {
    const item = await trx('items').where({ id: req.params.id }).first();
    if (!item) fail(404, 'Item not found.');
    const used = await trx('invoice_lines').where({ item_id: item.id }).first('id') || await trx('quotation_lines').where({ item_id: item.id }).first('id');
    if (used) {
      // Keep the history intact; just hide it from new documents.
      await trx('items').where({ id: item.id }).update({ active: false, updated_at: db.now() });
      await audit(trx, req, { action: 'archive', entity: 'item', entityId: item.id, summary: `Archived item ${item.name}` });
    } else {
      await trx('items').where({ id: item.id }).del();
      await audit(trx, req, { action: 'delete', entity: 'item', entityId: item.id, summary: `Deleted item ${item.name}`, before: itemOut(item) });
    }
  });
  res.status(204).end();
});

module.exports = router;
