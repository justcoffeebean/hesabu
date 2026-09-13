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

const hook = (path, body) => fetch(`${app.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, data: await r.json() }));

const stkSuccess = (checkoutId, amount, receipt, phone = 254722000111) => ({
  Body: { stkCallback: {
    MerchantRequestID: 'm', CheckoutRequestID: checkoutId, ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
    CallbackMetadata: { Item: [
      { Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt },
      { Name: 'TransactionDate', Value: 20260913101530 }, { Name: 'PhoneNumber', Value: phone }
    ] }
  } }
});

const c2b = (overrides) => ({
  TransactionType: 'Pay Bill', TransID: `R${Math.random().toString(36).slice(2, 10).toUpperCase()}`, TransTime: '20260913143015',
  TransAmount: '1000.00', BusinessShortCode: '174379', BillRefNumber: '', MSISDN: '254722000111', FirstName: 'JOHN', LastName: 'KAMAU',
  ...overrides
});

test('phone numbers are normalised the way Safaricom wants them', () => {
  const { normalizePhone } = require('../src/services/mpesa');
  assert.equal(normalizePhone('0722 884 019'), '254722884019');
  assert.equal(normalizePhone('+254 722-884-019'), '254722884019');
  assert.equal(normalizePhone('722884019'), '254722884019');
  assert.equal(normalizePhone('0110 123 456'), '254110123456');
  assert.equal(normalizePhone('020 123 4567'), null);
  assert.equal(normalizePhone('12345'), null);
});

test('STK push: staff can ask; Daraja gets a correctly signed request; callback records the payment once', async () => {
  const { invoice } = await h.basics(owner, { total: 2500 });
  h.daraja.calls.length = 0;

  const res = await staff.post('/api/mpesa/stk', { invoiceId: invoice.id, phone: '0722 000 111', amount: 2500 });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.request.status, 'pending');

  const auth = h.daraja.calls.find((c) => c.path === '/oauth/v1/generate');
  assert.equal(auth.auth, `Basic ${Buffer.from('key:secret').toString('base64')}`);
  const push = h.daraja.calls.find((c) => c.path === '/mpesa/stkpush/v1/processrequest').body;
  assert.equal(push.BusinessShortCode, '174379');
  assert.equal(push.TransactionType, 'CustomerPayBillOnline');
  assert.equal(push.Amount, 2500);
  assert.equal(push.PhoneNumber, '254722000111');
  assert.equal(push.CallBackURL, 'https://hesabu.example.com/hooks/stk/cb-secret-123');
  assert.equal(push.AccountReference, invoice.number.replace(/-/g, '').slice(0, 12));
  assert.ok(push.TransactionDesc.length <= 13);
  assert.match(push.Timestamp, /^\d{14}$/);
  assert.equal(Buffer.from(push.Password, 'base64').toString(), `174379passkey${push.Timestamp}`);

  const checkoutId = (await h.db.knex('mpesa_requests').where({ id: res.data.request.id }).first()).checkout_request_id;
  const cb = stkSuccess(checkoutId, 2500, 'SJT0000001');
  assert.deepEqual((await hook('/hooks/stk/cb-secret-123', cb)).data, { ResultCode: 0, ResultDesc: 'Accepted' });
  await hook('/hooks/stk/cb-secret-123', cb); // Safaricom retries sometimes

  const inv = (await owner.get(`/api/invoices/${invoice.id}`)).data;
  assert.equal(inv.status, 'paid');
  assert.equal(inv.payments.length, 1);
  assert.equal(inv.payments[0].reference, 'SJT0000001');
  assert.equal(inv.payments[0].source, 'mpesa');
  assert.equal((await staff.get(`/api/mpesa/stk/${res.data.request.id}`)).data.status, 'paid');
});

test('STK failure codes become a message a person can act on', async () => {
  const { invoice } = await h.basics(owner, { total: 100 });
  const res = await staff.post('/api/mpesa/stk', { invoiceId: invoice.id, phone: '0722000111', amount: 100 });
  const row = await h.db.knex('mpesa_requests').where({ id: res.data.request.id }).first();
  await hook('/hooks/stk/cb-secret-123', { Body: { stkCallback: { CheckoutRequestID: row.checkout_request_id, ResultCode: 1032, ResultDesc: 'Request cancelled by user' } } });
  const got = (await staff.get(`/api/mpesa/stk/${res.data.request.id}`)).data;
  assert.equal(got.status, 'failed');
  assert.match(got.resultDesc, /cancelled the request/);
  assert.equal((await owner.get(`/api/invoices/${invoice.id}`)).data.balance, 100);
});

test('STK amount rules: whole shillings, within the balance, sane phone', async () => {
  const { invoice } = await h.basics(owner, { total: 99.5 });
  assert.equal((await staff.post('/api/mpesa/stk', { invoiceId: invoice.id, phone: '0722000111', amount: 101 })).status, 400);
  assert.equal((await staff.post('/api/mpesa/stk', { invoiceId: invoice.id, phone: '12345', amount: 50 })).status, 400);
  assert.equal((await staff.post('/api/mpesa/stk', { invoiceId: invoice.id, phone: '0722000111', amount: 0 })).status, 400);
  // 99.50 owed → asking for 100 is allowed; only 99.50 is applied and 0.50 waits as unallocated.
  const ok = await staff.post('/api/mpesa/stk', { invoiceId: invoice.id, phone: '0722000111', amount: 100 });
  assert.equal(ok.status, 201);
  const row = await h.db.knex('mpesa_requests').where({ id: ok.data.request.id }).first();
  await hook('/hooks/stk/cb-secret-123', stkSuccess(row.checkout_request_id, 100, 'SJT0000002'));
  assert.equal((await owner.get(`/api/invoices/${invoice.id}`)).data.status, 'paid');
  const left = (await accounts.get('/api/payments')).data.unallocated.find((u) => u.receipt === 'SJT0000002');
  assert.equal(left.left, 0.5);
});

test('"Check status" settles a request whose callback never came; a late callback just fills in the receipt', async () => {
  const { invoice } = await h.basics(owner, { total: 700 });
  const res = await staff.post('/api/mpesa/stk', { invoiceId: invoice.id, phone: '0722000111', amount: 700 });
  const checked = await staff.post(`/api/mpesa/stk/${res.data.request.id}/check`);
  assert.equal(checked.data.status, 'paid');
  let inv = (await owner.get(`/api/invoices/${invoice.id}`)).data;
  assert.equal(inv.status, 'paid');
  assert.equal(inv.payments.length, 1);

  const row = await h.db.knex('mpesa_requests').where({ id: res.data.request.id }).first();
  await hook('/hooks/stk/cb-secret-123', stkSuccess(row.checkout_request_id, 700, 'SJLATE0001'));
  inv = (await owner.get(`/api/invoices/${invoice.id}`)).data;
  assert.equal(inv.payments.length, 1, 'no double payment');
  assert.equal(inv.payments[0].reference, 'SJLATE0001');
});

test('Daraja rejecting the request surfaces its reason', async () => {
  const { invoice } = await h.basics(owner, { total: 100 });
  h.daraja.stkResponse = { ResponseCode: '1', ResponseDescription: 'Invalid PhoneNumber' };
  const res = await staff.post('/api/mpesa/stk', { invoiceId: invoice.id, phone: '0722000111', amount: 100 });
  h.daraja.stkResponse = null;
  assert.equal(res.status, 502);
  assert.match(res.data.error, /Invalid PhoneNumber/);
});

test('paybill payment with the invoice number as account goes straight to that invoice', async () => {
  const { invoice } = await h.basics(owner, { total: 1000 });
  const body = c2b({ BillRefNumber: invoice.number.toLowerCase().replace(/-/g, ' '), TransAmount: '600.00' });
  await hook('/hooks/c2b/cb-secret-123/confirm', body);
  await hook('/hooks/c2b/cb-secret-123/confirm', body); // duplicate delivery
  const inv = (await owner.get(`/api/invoices/${invoice.id}`)).data;
  assert.equal(inv.paid, 600);
  assert.equal(inv.payments[0].reference, body.TransID);
});

test('paybill payment with a client account code pays their oldest invoices first; extra waits unallocated', async () => {
  const c = (await owner.post('/api/clients', { name: 'FIFO Ltd', accountCode: 'FIFO' })).data;
  const mk = async (amount, due) => {
    const r = await owner.post('/api/invoices', { clientId: c.id, vatRate: 0, dueDate: due, items: [{ description: 'x', quantity: 1, unitPrice: amount }] });
    return r.data;
  };
  const later = await mk(300, '2099-02-01');
  const older = await mk(500, '2099-01-01');

  const body = c2b({ BillRefNumber: 'fifo', TransAmount: '1000' });
  await hook('/hooks/c2b/cb-secret-123/confirm', body);
  assert.equal((await owner.get(`/api/invoices/${older.id}`)).data.status, 'paid');
  assert.equal((await owner.get(`/api/invoices/${later.id}`)).data.status, 'paid');
  const waiting = (await accounts.get('/api/payments')).data.unallocated.find((u) => u.receipt === body.TransID);
  assert.equal(waiting.left, 200);
  assert.equal(waiting.payerName, 'JOHN KAMAU');
});

test('unmatched receipts can be placed by hand, and reversing puts the money back in the pile', async () => {
  const { invoice } = await h.basics(owner, { total: 400 });
  const body = c2b({ BillRefNumber: 'my shop', TransAmount: '1500' });
  await hook('/hooks/c2b/cb-secret-123/confirm', body);
  const txn = (await accounts.get('/api/payments')).data.unallocated.find((u) => u.receipt === body.TransID);
  assert.equal(txn.left, 1500);

  assert.equal((await staff.post(`/api/mpesa/transactions/${txn.id}/allocate`, { invoiceId: invoice.id })).status, 403);
  const tooMuch = await accounts.post(`/api/mpesa/transactions/${txn.id}/allocate`, { invoiceId: invoice.id, amount: 2000 });
  assert.equal(tooMuch.status, 400);
  const placed = await accounts.post(`/api/mpesa/transactions/${txn.id}/allocate`, { invoiceId: invoice.id });
  assert.deepEqual(placed.data, { placed: 400, left: 1100 });

  const payment = (await owner.get(`/api/invoices/${invoice.id}`)).data.payments[0];
  await accounts.post(`/api/payments/${payment.id}/reverse`, { reason: 'Belongs to another client' });
  assert.equal((await accounts.get('/api/payments')).data.unallocated.find((u) => u.id === txn.id).left, 1500);
});

test('callbacks need the secret; the URLs avoid words Daraja rejects', async () => {
  assert.equal((await hook('/hooks/c2b/wrong-secret/confirm', c2b({ BillRefNumber: 'x' }))).status, 404);
  assert.equal((await hook('/hooks/stk/', {})).status, 404);
  const validate = await hook('/hooks/c2b/cb-secret-123/validate', c2b({}));
  assert.deepEqual(validate.data, { ResultCode: 0, ResultDesc: 'Accepted' });

  h.daraja.calls.length = 0;
  await owner.post('/api/settings/mpesa/register-urls');
  const { ConfirmationURL, ValidationURL } = h.daraja.calls.find((c) => c.path === '/mpesa/c2b/v1/registerurl').body;
  for (const url of [ConfirmationURL, ValidationURL]) {
    const path = new URL(url).pathname.toLowerCase();
    for (const word of ['mpesa', 'm-pesa', 'safaricom', 'query', 'exe', 'sql', 'cmd']) assert.ok(!path.includes(word), `${path} contains ${word}`);
  }
});

test('owner can register the paybill confirmation URLs', async () => {
  h.daraja.calls.length = 0;
  const r = await owner.post('/api/settings/mpesa/register-urls');
  assert.equal(r.status, 200);
  const call = h.daraja.calls.find((c) => c.path === '/mpesa/c2b/v1/registerurl').body;
  assert.equal(call.ConfirmationURL, 'https://hesabu.example.com/hooks/c2b/cb-secret-123/confirm');
  assert.equal(call.ResponseType, 'Completed');
  assert.equal((await accounts.post('/api/settings/mpesa/register-urls')).status, 403);
});
