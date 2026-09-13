const h = require('./helpers');
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

test('quotation → invoice carries lines, discount and VAT exactly, then locks', async () => {
  const c = (await owner.post('/api/clients', { name: 'Acme Hardware Ltd', email: 'orders@acme.co.ke' })).data;
  const q = await staff.post('/api/quotations', {
    clientId: c.id, discount: 5000, vatRate: 16,
    items: [{ description: 'Degreaser 20L', quantity: 12, unitPrice: 7800 }, { description: 'Delivery', quantity: 1, unitPrice: 3500 }, { description: '   ' }]
  });
  assert.equal(q.status, 201);
  assert.equal(q.data.lines.length, 2);
  assert.equal(q.data.subtotal, 97100);
  assert.equal(q.data.vat, 14736); // (97100 - 5000) × 16%
  assert.equal(q.data.total, 106836);
  assert.match(q.data.number, /^QT-\d{4}-0001$/);

  assert.equal((await staff.post(`/api/quotations/${q.data.id}/convert`)).status, 403, 'staff cannot invoice');
  const inv = await accounts.post(`/api/quotations/${q.data.id}/convert`, { dueDate: '2099-01-31' });
  assert.equal(inv.status, 201);
  assert.equal(inv.data.total, 106836);
  assert.equal(inv.data.quotationId, q.data.id);
  assert.equal(inv.data.dueDate, '2099-01-31');

  const locked = await owner.put(`/api/quotations/${q.data.id}`, { notes: 'change' });
  assert.equal(locked.status, 400);
  assert.equal((await owner.post(`/api/quotations/${q.data.id}/convert`)).status, 400);
});

test('payments can never exceed the balance, even when they arrive together', async () => {
  const { invoice } = await h.basics(owner, { total: 1000 });
  // Ten simultaneous 300.00 payments against 1,000.00: exactly three can fit.
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    accounts.post('/api/payments', { invoiceId: invoice.id, amount: 300, method: 'Cash' })));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 400 && /more than/.test(r.data.error)));
  const after = (await owner.get(`/api/invoices/${invoice.id}`)).data;
  assert.equal(after.paid, 900);
  assert.equal(after.balance, 100);
  assert.equal(after.status, 'part-paid');
});

test('document numbers stay unique under concurrent creation', async () => {
  const c = (await owner.post('/api/clients', { name: 'Busy Client' })).data;
  const made = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    owner.post('/api/invoices', { clientId: c.id, items: [{ description: `Job ${i}`, quantity: 1, unitPrice: 10 }] })));
  assert.ok(made.every((r) => r.status === 201), JSON.stringify(made.map((r) => r.data.error).filter(Boolean)));
  assert.equal(new Set(made.map((r) => r.data.number)).size, 8);
});

test('reversing a payment needs a reason, keeps the record, and is audited', async () => {
  const { invoice } = await h.basics(owner, { total: 500 });
  const pay = await accounts.post('/api/payments', { invoiceId: invoice.id, amount: 500, reference: 'QWE123' });
  assert.equal(pay.data.invoice.status, 'paid');

  assert.equal((await accounts.post(`/api/payments/${pay.data.paymentId}/reverse`, {})).status, 400);
  const rev = await accounts.post(`/api/payments/${pay.data.paymentId}/reverse`, { reason: 'Cheque bounced' });
  assert.equal(rev.status, 200);
  assert.equal(rev.data.invoice.balance, 500);
  assert.equal((await accounts.post(`/api/payments/${pay.data.paymentId}/reverse`, { reason: 'again' })).status, 400);

  const list = (await accounts.get('/api/payments')).data.payments.find((p) => p.id === pay.data.paymentId);
  assert.equal(list.reversed, true);
  assert.equal(list.reversalReason, 'Cheque bounced');
  assert.equal(list.reversedBy, 'Wanjiru');

  const log = (await owner.get(`/api/audit?entity=payment&entityId=${pay.data.paymentId}`)).data.entries;
  assert.deepEqual(log.map((e) => e.action).sort(), ['create', 'reverse']);
  assert.match(log.find((e) => e.action === 'reverse').summary, /Cheque bounced/);
  assert.equal(log.find((e) => e.action === 'reverse').userName, 'Wanjiru');
});

test('cancelling is blocked while payments stand, allowed after reversal', async () => {
  const { invoice } = await h.basics(owner, { total: 200 });
  const pay = await accounts.post('/api/payments', { invoiceId: invoice.id, amount: 50 });
  assert.equal((await accounts.post(`/api/invoices/${invoice.id}/cancel`)).status, 400);
  await accounts.post(`/api/payments/${pay.data.paymentId}/reverse`, { reason: 'Wrong invoice' });
  const cancelled = await accounts.post(`/api/invoices/${invoice.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.balance, 0);
  assert.equal((await accounts.post('/api/payments', { invoiceId: invoice.id, amount: 1 })).status, 400);
});

test('editing a record someone else just changed gives a clear 409', async () => {
  const c = (await owner.post('/api/clients', { name: 'Riverside' })).data;
  const first = await owner.put(`/api/clients/${c.id}`, { phone: '0700 000 001', version: c.version });
  assert.equal(first.status, 200);
  const stale = await accounts.put(`/api/clients/${c.id}`, { phone: '0700 000 002', version: c.version });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /Someone else changed/);
});

test('audit log shows field-level changes with who made them', async () => {
  const c = (await owner.post('/api/clients', { name: 'Audit Me', email: 'a@x.co.ke' })).data;
  await accounts.put(`/api/clients/${c.id}`, { email: 'b@x.co.ke', version: c.version });
  const { entries } = (await owner.get(`/api/audit?entity=client&entityId=${c.id}`)).data;
  const edit = entries.find((e) => e.action === 'update');
  assert.deepEqual(edit.changes.email, ['a@x.co.ke', 'b@x.co.ke']);
  assert.equal(edit.userName, 'Wanjiru');
  assert.equal(Object.keys(edit.changes).length, 1, 'only the field that changed');
});

test('clients with documents cannot be deleted; unused ones can', async () => {
  const { client } = await h.basics(owner);
  assert.equal((await owner.del(`/api/clients/${client.id}`)).status, 400);
  const spare = (await owner.post('/api/clients', { name: 'Spare' })).data;
  assert.equal((await owner.del(`/api/clients/${spare.id}`)).status, 204);
});

test('account codes are unique and normalised', async () => {
  const a = await owner.post('/api/clients', { name: 'Code A', accountCode: ' river-side ' });
  assert.equal(a.data.accountCode, 'RIVERSIDE');
  const b = await owner.post('/api/clients', { name: 'Code B', accountCode: 'riverside' });
  assert.equal(b.status, 409);
  const looksLikeInvoice = await owner.post('/api/clients', { name: 'Code C', accountCode: 'INV-2026-0001' });
  assert.equal(looksLikeInvoice.status, 400);
});

/* ---------- stock ---------- */

test('invoicing tracked items takes stock out; cancelling puts it back; shortfalls warn', async () => {
  const item = (await owner.post('/api/items', { name: 'Bleach 20L', unit: 'drum', unitPrice: 2100, trackStock: true, stockQty: 5, reorderLevel: 3 })).data;
  assert.equal(item.stockQty, 5);
  const c = (await owner.post('/api/clients', { name: 'Stock Client' })).data;

  const inv = await owner.post('/api/invoices', { clientId: c.id, items: [{ description: 'Bleach 20L', quantity: 7, unitPrice: 2100, itemId: item.id }] });
  assert.equal(inv.status, 201);
  assert.equal(inv.data.warnings.length, 1);
  assert.match(inv.data.warnings[0], /Bleach 20L: stock is now -2 drum/);

  let items = (await owner.get('/api/items')).data;
  assert.equal(items.find((i) => i.id === item.id).stockQty, -2);
  assert.equal(items.find((i) => i.id === item.id).low, true);
  assert.ok((await owner.get('/api/dashboard')).data.lowStock.some((i) => i.id === item.id));

  // Quotations don't touch stock.
  await owner.post('/api/quotations', { clientId: c.id, items: [{ description: 'Bleach 20L', quantity: 50, unitPrice: 2100, itemId: item.id }] });
  assert.equal((await owner.get('/api/items')).data.find((i) => i.id === item.id).stockQty, -2);

  await owner.post(`/api/invoices/${inv.data.id}/cancel`);
  items = (await owner.get('/api/items')).data;
  assert.equal(items.find((i) => i.id === item.id).stockQty, 5);

  // Staff can receive and count stock.
  assert.equal((await staff.post(`/api/items/${item.id}/stock`, { mode: 'received', quantity: 10 })).data.stockQty, 15);
  assert.equal((await staff.post(`/api/items/${item.id}/stock`, { mode: 'count', quantity: 12, note: 'Two leaking' })).data.stockQty, 12);
  const moves = (await owner.get(`/api/items/${item.id}/movements`)).data;
  assert.deepEqual(moves.map((m) => [m.reason, m.change, m.balance]), [
    ['adjusted', -3, 12], ['received', 10, 15], ['cancel', 7, 5], ['invoice', -7, -2], ['received', 5, 5]
  ]);
  assert.equal(moves[0].by, 'Brian');
  assert.equal(moves[3].reference, inv.data.number);
});

test('items used on documents are archived, not deleted', async () => {
  const used = (await owner.post('/api/items', { name: 'Used item', unitPrice: 1 })).data;
  const c = (await owner.post('/api/clients', { name: 'Item user' })).data;
  await owner.post('/api/quotations', { clientId: c.id, items: [{ description: 'Used item', quantity: 1, unitPrice: 1, itemId: used.id }] });
  assert.equal((await owner.del(`/api/items/${used.id}`)).status, 204);
  assert.equal((await owner.get('/api/items')).data.find((i) => i.id === used.id).active, false);
});

/* ---------- currency ---------- */

test('foreign-currency invoices store their rate; the dashboard converts at that rate', async () => {
  const noRate = await h.basics(owner, { currency: 'USD' }).catch((e) => e);
  assert.match(String(noRate.message), /no exchange rate for USD/);

  assert.equal((await staff.put('/api/currencies/USD', { rateToBase: 130 })).status, 403);
  assert.equal((await accounts.put('/api/currencies/USD', { name: 'US dollar', rateToBase: 130 })).status, 200);
  assert.equal((await owner.put('/api/currencies/KES', { rateToBase: 2 })).status, 400);

  const before = (await owner.get('/api/dashboard')).data;
  const { invoice } = await h.basics(owner, { currency: 'USD', total: 100 });
  assert.equal(invoice.currency, 'USD');
  assert.equal(invoice.fxRate, 130);

  // The rate moving later doesn't re-value invoices already issued.
  await owner.put('/api/currencies/USD', { rateToBase: 150 });
  const dash = (await owner.get('/api/dashboard')).data;
  assert.equal(Math.round((dash.outstanding - before.outstanding) * 100) / 100, 13000);
  assert.equal(dash.outstandingByCurrency.USD, 100);
  assert.equal((await owner.get(`/api/invoices/${invoice.id}`)).data.fxRate, 130);

  // M-Pesa only takes shillings.
  const stk = await owner.post('/api/mpesa/stk', { invoiceId: invoice.id, phone: '0722000111', amount: 100 });
  assert.equal(stk.status, 400);
  assert.match(stk.data.error, /only takes shillings/);

  assert.equal((await owner.del('/api/currencies/USD')).status, 400, 'in use');
  assert.equal((await owner.put('/api/settings', { name: 'Test Traders Ltd', vatRate: 16, baseCurrency: 'USD' })).status, 400, 'base locked once documents exist');
});

test('past-due invoices that are partly paid count as overdue', async () => {
  const c = (await owner.post('/api/clients', { name: 'Late payer' })).data;
  const inv = await owner.post('/api/invoices', { clientId: c.id, vatRate: 0, items: [{ description: 'x', quantity: 1, unitPrice: 100 }] });
  await h.db.knex('invoices').where({ id: inv.data.id }).update({ date: '2026-01-01', due_date: '2026-01-15' });
  await accounts.post('/api/payments', { invoiceId: inv.data.id, amount: 40, date: '2026-01-10' });
  const got = (await owner.get(`/api/invoices/${inv.data.id}`)).data;
  assert.equal(got.status, 'overdue');
  assert.equal(got.age, '60+');
});

test('bad input gets plain-English errors, not 500s', async () => {
  const c = (await owner.post('/api/clients', { name: 'Validation' })).data;
  const cases = [
    ['/api/invoices', { clientId: 'nope', items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }, /Pick a client/],
    ['/api/invoices', { clientId: c.id, items: [] }, /at least one line/],
    ['/api/invoices', { clientId: c.id, items: [{ description: 'x', quantity: -1, unitPrice: 1 }] }, /negative/],
    ['/api/invoices', { clientId: c.id, vatRate: 250, items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }, /VAT rate/],
    ['/api/invoices', { clientId: c.id, dueDate: '31/02/2026', items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }, /Dates must/],
    ['/api/payments', { invoiceId: 'nope', amount: 1 }, /Pick the invoice/],
    ['/api/clients', { name: '' }, /name is required/],
    ['/api/clients', { name: 'x', email: 'not-an-email' }, /doesn't look like an email/]
  ];
  for (const [url, body, message] of cases) {
    const r = await owner.post(url, body);
    assert.equal(r.status, 400, `${url} ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.data)}`);
    assert.match(r.data.error, message);
  }
  const broken = await fetch(`${app.base}/api/clients`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie }, body: '{nope' });
  assert.equal(broken.status, 400);
});
