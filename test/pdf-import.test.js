const h = require('./helpers');
const fs = require('fs');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let app;
let owner;
let accounts;
let staff;
before(async () => {
  app = await h.start();
  ({ owner, accounts, staff } = await h.team(app.base));
});
after(() => app.stop());

const pageCount = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

/* ---------- money maths ---------- */

test('totals are exact in cents: discount before VAT, VAT rounded once', () => {
  const { documentTotals } = require('../src/totals');
  const t = documentTotals([{ quantity: 3, unitPriceCents: 3333 }, { quantity: 0.5, unitPriceCents: 199 }], 1000, 16);
  assert.equal(t.subtotal, 9999 + 100); // 99.99 + 0.995 → 1.00
  assert.equal(t.discount, 1000);
  assert.equal(t.vat, Math.round(9099 * 0.16));
  assert.equal(t.total, 9099 + 1456);
  assert.equal(documentTotals([{ quantity: 1, unitPriceCents: 500 }], 9999, 16).total, 0, 'discount capped at subtotal');
});

/* ---------- PDF ---------- */

test('invoice PDF downloads as a real, multi-page PDF with the right name', async () => {
  const c = (await owner.post('/api/clients', { name: 'Ünïcode & Sons — Ltd ✓', address: 'Nyeri Road, 2nd Floor' })).data;
  const items = Array.from({ length: 70 }, (_, i) => ({ description: `Line ${i + 1}: floor cleaner concentrate, 5L jerrycan − delivered to site ${i % 7} with a longer description that wraps`, quantity: i + 1, unitPrice: 1450.5 }));
  const inv = (await owner.post('/api/invoices', { clientId: c.id, discount: 100, items, notes: 'Thank you 🙏' })).data;
  await owner.put('/api/settings', { name: 'Test Traders Ltd', vatRate: 16, paymentInstructions: 'Paybill 400200, account = invoice number' });
  await accounts.post('/api/payments', { invoiceId: inv.id, amount: 1000, reference: 'SJX1' });

  const res = await staff.get(`/api/invoices/${inv.id}/pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="${inv.number}.pdf"`);
  assert.equal(res.data.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pageCount(res.data) >= 3, `expected several pages, got ${pageCount(res.data)}`);

  const inline = await staff.get(`/api/invoices/${inv.id}/pdf?inline=1`);
  assert.match(inline.headers.get('content-disposition'), /^inline;/);
});

test('foreign-currency invoice PDF and quotation PDF render', async () => {
  await owner.put('/api/currencies/USD', { rateToBase: 129.5 });
  const { invoice } = await h.basics(owner, { currency: 'USD', total: 100 });
  const pdf = await owner.get(`/api/invoices/${invoice.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.ok(pdf.data.length > 1000);

  const c = (await owner.post('/api/clients', { name: 'Quote PDF' })).data;
  const q = (await staff.post('/api/quotations', { clientId: c.id, items: [{ description: 'x', quantity: 2, unitPrice: 10 }] })).data;
  const qpdf = await staff.get(`/api/quotations/${q.id}/pdf`);
  assert.equal(qpdf.status, 200);
  assert.equal(qpdf.data.subarray(0, 5).toString(), '%PDF-');
});

test('PDF of a missing invoice is a 404, and needs a session', async () => {
  assert.equal((await owner.get('/api/invoices/nope/pdf')).status, 404);
  assert.equal((await h.client(app.base).get('/api/invoices/nope/pdf')).status, 401);
});

/* ---------- CSV ---------- */

test('CSV parser handles quotes, commas, newlines, CRLF and a BOM', () => {
  const { parseCsv, parseDate, parseAmount } = require('../src/services/importer');
  const rows = parseCsv('﻿name,address\r\n"Acme, Ltd","Line 1\nLine 2"\r\n"Say ""hi""",x\r\n\r\n');
  assert.deepEqual(rows, [['name', 'address'], ['Acme, Ltd', 'Line 1\nLine 2'], ['Say "hi"', 'x']]);
  assert.equal(parseDate('31/03/2026'), '2026-03-31');
  assert.equal(parseDate('2026-03-31'), '2026-03-31');
  assert.equal(parseDate('31/02/2026'), undefined);
  assert.equal(parseAmount('KES 12,500.50'), 12500.5);
  assert.ok(Number.isNaN(parseAmount('twelve')));
});

test('templates download as CSV', async () => {
  const res = await accounts.get('/api/import/balances/template');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.data.toString(), /^client,reference,date,due_date,amount,currency,notes\n/);
  assert.equal((await staff.get('/api/import/clients/template')).status, 403);
});

test('client import previews problems and imports nothing until the file is clean', async () => {
  await owner.post('/api/clients', { name: 'Already Here' });
  const bad = 'Name,Email,Account Code\nNew One,new@x.co.ke,NEW1\nAlready Here,,\n,missing@x.co.ke,\nDup,bad-email,NEW1\n';
  const preview = await accounts.post('/api/import/clients/preview', { csv: bad });
  assert.equal(preview.data.total, 4);
  assert.equal(preview.data.valid, 1);
  assert.deepEqual(preview.data.rows.map((r) => r.line), [2, 3, 4, 5]);
  assert.match(preview.data.rows[1].errors[0], /already exists/);
  assert.equal(preview.data.rows[3].errors.length, 2);

  const before = (await owner.get('/api/clients')).data.length;
  const commit = await accounts.post('/api/import/clients/commit', { csv: bad });
  assert.equal(commit.status, 400);
  assert.match(commit.data.error, /nothing was imported/);
  assert.equal((await owner.get('/api/clients')).data.length, before);

  const good = 'name,email,phone,account_code\nNew One,new@x.co.ke,0722 111 222,new1\n"Second, Ltd",,,\n';
  assert.equal((await accounts.post('/api/import/clients/commit', { csv: good })).data.imported, 2);
  const names = (await owner.get('/api/clients')).data.map((c) => c.name);
  assert.ok(names.includes('Second, Ltd'));
  assert.equal((await owner.get('/api/clients')).data.find((c) => c.name === 'New One').accountCode, 'NEW1');

  assert.equal((await accounts.post('/api/import/clients/preview', { csv: 'email\nx@y.z\n' })).status, 400, 'name column required');
});

test('opening balances become OB- invoices with no VAT and no stock movement', async () => {
  await owner.post('/api/clients', { name: 'Old Debtor', accountCode: 'OLDD' });
  const csv = 'client,reference,date,due_date,amount,currency\nOld Debtor,OLD-1043,15/02/2026,01/03/2026,"48,500.00",\noldd,OLD-1050,2026-03-01,,1200,\n';
  const preview = await accounts.post('/api/import/balances/preview', { csv });
  assert.equal(preview.data.valid, 2, JSON.stringify(preview.data.rows));
  const commit = await accounts.post('/api/import/balances/commit', { csv });
  assert.equal(commit.data.imported, 2);

  const all = (await owner.get('/api/invoices')).data.filter((i) => i.kind === 'opening');
  assert.equal(all.length, 2);
  const first = all.find((i) => i.reference === 'OLD-1043');
  assert.match(first.number, /^OB-\d{4}-0001$/);
  assert.equal(first.total, 48500);
  assert.equal(first.vat, 0);
  assert.equal(first.dueDate, '2026-03-01');
  assert.equal(first.status, 'overdue');
  const second = all.find((i) => i.reference === 'OLD-1050');
  assert.equal(second.dueDate, '2026-03-01', 'blank due date means due on the date');

  const pdf = await owner.get(`/api/invoices/${first.id}/pdf`);
  assert.equal(pdf.status, 200);
});

test('item import sets opening stock with a movement', async () => {
  const csv = 'name,sku,unit,unit_price,track_stock,stock_qty,reorder_level\nDegreaser 20L,dg-20,drum,"7,800",yes,24,10\nDelivery,,trip,3500,no,,\n';
  assert.equal((await accounts.post('/api/import/items/commit', { csv })).data.imported, 2);
  const items = (await owner.get('/api/items')).data;
  const dg = items.find((i) => i.sku === 'DG-20');
  assert.equal(dg.unitPrice, 7800);
  assert.equal(dg.stockQty, 24);
  assert.equal(dg.trackStock, true);
  assert.equal(items.find((i) => i.name === 'Delivery').trackStock, false);
  assert.equal((await owner.get(`/api/items/${dg.id}/movements`)).data[0].reason, 'import');
});

/* ---------- legacy JSON ---------- */

test('old data/hesabu.json moves into the database once, with balances intact', async () => {
  const { importLegacyJson } = require('../src/db/import-json');
  const file = path.join(h.tmp, 'legacy.json');
  const legacy = {
    company: { name: 'Legacy Co', vatRate: 16, currency: 'KES', kraPin: 'P1' },
    clients: [{ id: 'cl1', name: 'Acme', createdAt: '2026-06-15' }],
    quotations: [{ id: 'qt1', number: 'QT-2026-0001', clientId: 'cl1', date: '2026-07-01', validUntil: '2026-07-31', discount: 0, vatRate: 16, status: 'accepted', invoiceId: 'in1', items: [{ description: 'Drum', quantity: 12, unitPrice: 7800 }] }],
    invoices: [{ id: 'in1', number: 'INV-2026-0001', clientId: 'cl1', quotationId: 'qt1', date: '2026-07-02', dueDate: '2026-07-16', discount: 0, vatRate: 16, status: 'open', items: [{ description: 'Drum', quantity: 12, unitPrice: 7800 }] }],
    payments: [{ id: 'pm1', invoiceId: 'in1', amount: 60000, method: 'M-Pesa', reference: 'SJ1', date: '2026-07-10' }],
    tasks: [{ id: 'tk1', title: 'Deliver', dueDate: '2026-07-03', priority: 'high', status: 'done' }],
    counters: { quotation: 1, invoice: 1 }
  };
  fs.writeFileSync(file, JSON.stringify(legacy));

  // This database already has data from the tests above, so the import stands aside.
  assert.equal(await importLegacyJson(file), null);

  // On an empty database it moves everything over.
  await h.db.knex('settings').where({ key: 'legacy_import' }).del();
  for (const t of ['audit_log', 'outbox', 'mpesa_requests', 'payments', 'mpesa_transactions', 'invoice_lines', 'recurring_lines', 'quotation_lines', 'stock_movements', 'tasks']) await h.db.knex(t).del();
  await h.db.knex('quotations').update({ invoice_id: null });
  await h.db.knex('invoices').del();
  for (const t of ['recurring_invoices', 'quotations', 'items', 'clients', 'counters']) await h.db.knex(t).del();

  const counts = await importLegacyJson(file);
  assert.deepEqual(counts, { clients: 1, quotations: 1, invoices: 1, payments: 1, tasks: 1 });
  const inv = (await owner.get('/api/invoices/in1')).data;
  assert.equal(inv.total, 108576);
  assert.equal(inv.balance, 48576);
  assert.equal(inv.quotationId, 'qt1');
  assert.equal((await owner.get('/api/settings')).data.baseCurrency, 'KES');
  assert.equal(await importLegacyJson(file), null, 'never twice');

  const next = (await owner.post('/api/invoices', { clientId: 'cl1', items: [{ description: 'x', quantity: 1, unitPrice: 1 }] })).data;
  assert.match(next.number, /-0002$/, 'numbering continues from the old counter');
});
