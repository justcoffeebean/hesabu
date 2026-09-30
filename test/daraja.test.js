const h = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../src/config');
const daraja = require('../src/services/daraja');
const mpesa = require('../src/services/mpesa');
const totp = require('../src/totp');

let app;
let owner;
let accounts;
let staff;
before(async () => {
  app = await h.start();
  ({ owner, accounts, staff } = await h.team(app.base));
});
after(() => app.stop());

const hook = (url, body) => fetch(`${app.base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, data: await r.json() }));

const lastCall = (p) => h.daraja.calls.filter((c) => c.path === p).at(-1);

/** What Safaricom posts to ResultURL. */
function result(accepted, { code = 0, desc = 'The service request is processed successfully.', params = {}, transactionId = 'RVS00000001' } = {}) {
  return {
    Result: {
      ResultType: 0, ResultCode: code, ResultDesc: desc,
      OriginatorConversationID: accepted.originator, ConversationID: accepted.conversation, TransactionID: transactionId,
      ResultParameters: { ResultParameter: Object.entries(params).map(([Key, Value]) => ({ Key, Value })) },
      ReferenceData: { ReferenceItem: { Key: 'Occasion' } }
    }
  };
}

/** The IDs the fake Daraja handed back for the latest command. */
const accepted = () => ({ originator: `oc-${h.daraja.counter}`, conversation: `AG_2026_${h.daraja.counter}` });

const found = (receipt, amount, extra = {}) => ({
  ReceiptNo: receipt, Amount: amount, TransactionStatus: 'Completed', FinalisedTime: 20260913143015,
  DebitPartyName: '254722000111 - JANE WAMBUI', CreditPartyName: '174379 - Test Traders', ...extra
});

/* ---------- connection test ---------- */

test('connection test: owner only, and it checks settings, callback address and keys against Safaricom', async () => {
  assert.equal((await accounts.post('/api/settings/mpesa/test')).status, 403);
  const r = await owner.post('/api/settings/mpesa/test');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true, JSON.stringify(r.data.checks));
  const byName = Object.fromEntries(r.data.checks.map((c) => [c.name, c]));
  assert.equal(byName['Consumer key and secret'].status, 'ok');
  assert.equal(byName['Callback address'].status, 'ok');
  assert.equal(byName['Lookups and refunds'].status, 'ok');
  assert.ok(h.daraja.calls.some((c) => c.path === '/oauth/v1/generate'), 'it really asked Safaricom for a token');
});

test('connection test explains the common mistakes', async (t) => {
  const saved = { ...config.daraja, publicUrl: config.publicUrl };
  t.after(() => { const { publicUrl, ...d } = saved; Object.assign(config.daraja, d); config.publicUrl = publicUrl; h.daraja.rejectKeys = false; daraja.resetTokenCache(); });
  const check = async (name) => (await owner.post('/api/settings/mpesa/test')).data.checks.find((c) => c.name === name);

  h.daraja.rejectKeys = true;
  const keys = await check('Consumer key and secret');
  assert.equal(keys.status, 'error');
  assert.match(keys.detail, /Invalid Authentication passed.*DARAJA_ENV=production/);
  h.daraja.rejectKeys = false;

  config.publicUrl = 'http://localhost:3000';
  assert.match((await check('Callback address')).detail, /only calls https/);
  config.publicUrl = 'https://192.168.1.20';
  assert.match((await check('Callback address')).detail, /can't be reached from the internet/);
  config.publicUrl = 'https://mpesa.shop.co.ke';
  assert.match((await check('Callback address')).detail, /rejects callback URLs containing "mpesa"/);
  config.publicUrl = saved.publicUrl;

  config.daraja.env = 'production';
  assert.equal((await check('Shortcode')).status, 'error', '174379 is the sandbox shortcode');
  config.daraja.env = 'sandbox';
  config.daraja.shortcode = '888880';
  assert.equal((await check('Shortcode')).status, 'warn');
  config.daraja.shortcode = saved.shortcode;

  config.daraja.securityCredential = '';
  config.daraja.initiatorPassword = 'x';
  config.daraja.certFile = '/nope/cert.cer';
  assert.match((await check('Lookups and refunds')).detail, /DARAJA_CERT_FILE \(no such file\)/);
});

test('the security credential is the initiator password encrypted with Safaricom\'s certificate', (t) => {
  const dir = fs.mkdtempSync(path.join(h.tmp, 'cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.cer'), '-days', '1', '-subj', '/CN=test'], { stdio: 'ignore' });
  const saved = { ...config.daraja };
  t.after(() => { Object.assign(config.daraja, saved); daraja.resetTokenCache(); });
  Object.assign(config.daraja, { securityCredential: '', initiatorPassword: 'Safaricom999!*!', certFile: path.join(dir, 'cert.cer') });
  daraja.resetTokenCache();

  const credential = daraja.securityCredential();
  fs.writeFileSync(path.join(dir, 'cred.bin'), Buffer.from(credential, 'base64'));
  const plain = execFileSync('openssl', ['pkeyutl', '-decrypt', '-inkey', path.join(dir, 'key.pem'), '-in', path.join(dir, 'cred.bin'), '-pkeyopt', 'rsa_padding_mode:pkcs1']);
  assert.equal(plain.toString(), 'Safaricom999!*!');
});

/* ---------- looking up a missed payment ---------- */

test('lookup: a missed payment is found and put on the invoice it was for', async () => {
  const { invoice } = await h.basics(owner, { total: 2500 });
  assert.equal((await staff.post('/api/mpesa/lookup', { receipt: 'SJ84K2LQ01' })).status, 403);
  assert.equal((await accounts.post('/api/mpesa/lookup', { receipt: 'not a code!' })).status, 400);

  const r = await accounts.post('/api/mpesa/lookup', { receipt: 'sj84 k2lq01', invoiceId: invoice.id });
  assert.equal(r.status, 202);
  assert.equal(r.data.status, 'pending');
  assert.equal(r.data.receipt, 'SJ84K2LQ01');

  const sent = lastCall('/mpesa/transactionstatus/v1/query').body;
  assert.equal(sent.CommandID, 'TransactionStatusQuery');
  assert.equal(sent.TransactionID, 'SJ84K2LQ01');
  assert.equal(sent.Initiator, 'testapi');
  assert.equal(sent.SecurityCredential, 'test-security-credential');
  assert.equal(sent.PartyA, '174379');
  for (const url of [sent.ResultURL, sent.QueueTimeOutURL]) {
    const p = new URL(url).pathname.toLowerCase();
    for (const word of ['mpesa', 'm-pesa', 'safaricom', 'query', 'exe', 'sql', 'cmd']) assert.ok(!p.includes(word), `${p} contains ${word}`);
  }
  assert.equal(sent.ResultURL, 'https://hesabu.example.com/hooks/async/cb-secret-123/result');

  // Asking twice while waiting doesn't send a second request.
  const before = h.daraja.calls.length;
  assert.equal((await accounts.post('/api/mpesa/lookup', { receipt: 'SJ84K2LQ01' })).data.id, r.data.id);
  assert.equal(h.daraja.calls.length, before);

  const answer = result(accepted(), { params: found('SJ84K2LQ01', 2500) });
  assert.equal((await hook('/hooks/async/wrong-secret/result', answer)).status, 404);
  await hook('/hooks/async/cb-secret-123/result', answer);
  await hook('/hooks/async/cb-secret-123/result', answer); // Safaricom retries

  const inv = (await owner.get(`/api/invoices/${invoice.id}`)).data;
  assert.equal(inv.paid, 2500);
  assert.equal(inv.payments.length, 1);
  assert.equal(inv.payments[0].reference, 'SJ84K2LQ01');
  const cmd = (await accounts.get(`/api/mpesa/commands/${r.data.id}`)).data;
  assert.equal(cmd.status, 'done');
  assert.match(cmd.resultDesc, /Found KES 2,500\.00 from JANE WAMBUI\. Put KES 2,500\.00 on INV-/);

  const again = await accounts.post('/api/mpesa/lookup', { receipt: 'SJ84K2LQ01' });
  assert.equal(again.status, 409);
});

test('lookup without an invoice leaves the money waiting to be placed; an answer that beats the IDs still lands', async () => {
  const r = await accounts.post('/api/mpesa/lookup', { receipt: 'SJ84K2LQ02' });
  // Answer arrives with IDs we haven't matched (as if it beat our save); the receipt is enough.
  await hook('/hooks/async/cb-secret-123/result', result({ originator: 'unseen', conversation: 'unseen' }, { params: found('SJ84K2LQ02', 700) }));
  assert.equal((await accounts.get(`/api/mpesa/commands/${r.data.id}`)).data.status, 'done');
  const waiting = (await accounts.get('/api/payments')).data.unallocated.find((t) => t.receipt === 'SJ84K2LQ02');
  assert.equal(waiting.left, 700);
  assert.equal(waiting.payerName, 'JANE WAMBUI');
});

test('lookup refuses what isn\'t ours or isn\'t finished, and says why', async () => {
  const cases = [
    [{ params: found('SJ84K2LQ03', 100, { CreditPartyName: '999999 - Someone Else' }) }, /went to 999999, not to your paybill/],
    [{ params: found('SJ84K2LQ03', 100, { TransactionStatus: 'Pending' }) }, /"Pending", not completed/],
    [{ code: 2001, desc: 'The initiator information is invalid.' }, /initiator information is invalid/]
  ];
  for (const [answer, message] of cases) {
    const r = await accounts.post('/api/mpesa/lookup', { receipt: 'SJ84K2LQ03' });
    await hook('/hooks/async/cb-secret-123/result', result(accepted(), answer));
    const cmd = (await accounts.get(`/api/mpesa/commands/${r.data.id}`)).data;
    assert.equal(cmd.status, 'failed');
    assert.match(cmd.resultDesc, message);
  }
  assert.equal(await h.db.knex('mpesa_transactions').where({ receipt: 'SJ84K2LQ03' }).first(), undefined);

  const r = await accounts.post('/api/mpesa/lookup', { receipt: 'SJ84K2LQ04' });
  await hook('/hooks/async/cb-secret-123/timeout', result(accepted(), { code: 1, desc: 'timeout' }));
  assert.equal((await accounts.get(`/api/mpesa/commands/${r.data.id}`)).data.status, 'failed');

  h.daraja.commandResponse = { errorCode: '500.001.1001', errorMessage: 'Unable to lock subscriber' };
  const refused = await accounts.post('/api/mpesa/lookup', { receipt: 'SJ84K2LQ05' });
  h.daraja.commandResponse = null;
  assert.equal(refused.status, 502);
  assert.match(refused.data.error, /didn't accept it/);
});

/* ---------- refunds ---------- */

async function paidByPaybill(total, receipt) {
  const { invoice } = await h.basics(owner, { total });
  await hook('/hooks/c2b/cb-secret-123/confirm', {
    TransactionType: 'Pay Bill', TransID: receipt, TransTime: '20260913143015', TransAmount: String(total),
    BusinessShortCode: '174379', BillRefNumber: invoice.number, MSISDN: '254722000111', FirstName: 'JOHN', LastName: 'KAMAU'
  });
  const txn = await h.db.knex('mpesa_transactions').where({ receipt }).first();
  return { invoice, txn };
}

test('refund: owner only, confirms their password, and sends the whole receipt back', async () => {
  const { invoice, txn } = await paidByPaybill(1500, 'RFD0000001');
  const url = `/api/mpesa/transactions/${txn.id}/refund`;
  assert.equal((await accounts.post(url, { password: 'accounts-password-1', reason: 'x' })).status, 403);
  assert.equal((await owner.post(url, { password: 'wrong-password-x', reason: 'Double payment' })).status, 400);
  assert.equal((await owner.post(url, { password: 'owner-password-1' })).status, 400, 'a reason is required');

  const r = await owner.post(url, { password: 'owner-password-1', reason: 'Customer paid twice' });
  assert.equal(r.status, 202);
  assert.equal(r.data.status, 'pending');
  const sent = lastCall('/mpesa/reversal/v1/request').body;
  assert.equal(sent.CommandID, 'TransactionReversal');
  assert.equal(sent.TransactionID, 'RFD0000001');
  assert.equal(sent.Amount, '1500');
  assert.equal(sent.ReceiverParty, '174379');
  assert.equal(sent.RecieverIdentifierType, '11');
  assert.equal(sent.Remarks, 'Customer paid twice');
  const ids = accepted();

  // While it's with Safaricom: no second refund, and the money can't be moved around.
  assert.equal((await owner.post(url, { password: 'owner-password-1', reason: 'again' })).status, 409);
  assert.equal((await owner.get(`/api/invoices/${invoice.id}`)).data.paid, 1500, 'books unchanged until Safaricom confirms');
  const listed = (await owner.get('/api/payments')).data.payments.find((p) => p.reference === 'RFD0000001');
  assert.equal(listed.mpesa.refund.status, 'pending');

  const answer = result(ids, { transactionId: 'RVS0000001', params: { OriginalTransactionID: 'RFD0000001', Amount: 1500 } });
  await hook('/hooks/async/cb-secret-123/result', answer);
  await hook('/hooks/async/cb-secret-123/result', answer);

  const inv = (await owner.get(`/api/invoices/${invoice.id}`)).data;
  assert.equal(inv.paid, 0, 'the invoice is owed again');
  assert.equal(inv.payments[0].reversed, true);
  assert.match(inv.payments[0].reversalReason, /Refunded to the customer by M-Pesa \(RVS0000001\): Customer paid twice/);
  const after = await h.db.knex('mpesa_transactions').where({ id: txn.id }).first();
  assert.ok(after.refunded_at);
  assert.equal(after.refund_receipt, 'RVS0000001');
  assert.ok(!(await owner.get('/api/payments')).data.unallocated.some((t) => t.id === txn.id), 'refunded money is not waiting to be placed');
  assert.equal((await owner.post(url, { password: 'owner-password-1', reason: 'again' })).status, 400);
  assert.equal((await accounts.post(`/api/mpesa/transactions/${txn.id}/allocate`, { invoiceId: invoice.id })).status, 400);

  const log = await h.db.knex('audit_log').where({ action: 'mpesa-refund' }).first();
  assert.match(log.summary, /refund KES 1,500\.00 \(RFD0000001\) to JOHN KAMAU: Customer paid twice/);
});

test('refund refused by Safaricom changes nothing; a timeout stays open as "unknown" and can be retried', async () => {
  const { invoice, txn } = await paidByPaybill(800, 'RFD0000002');
  const url = `/api/mpesa/transactions/${txn.id}/refund`;

  const first = await owner.post(url, { password: 'owner-password-1', reason: 'Wrong paybill' });
  await hook('/hooks/async/cb-secret-123/result', result(accepted(), { code: 'R000002', desc: 'The OriginalTransactionID is invalid.' }));
  const failed = (await owner.get(`/api/mpesa/commands/${first.data.id}`)).data;
  assert.equal(failed.status, 'failed');
  assert.match(failed.resultDesc, /OriginalTransactionID is invalid/);
  assert.equal((await owner.get(`/api/invoices/${invoice.id}`)).data.paid, 800);

  const second = await owner.post(url, { password: 'owner-password-1', reason: 'Wrong paybill' });
  await hook('/hooks/async/cb-secret-123/timeout', result(accepted(), { code: 1, desc: 'queue timeout' }));
  assert.equal((await owner.get(`/api/mpesa/commands/${second.data.id}`)).data.status, 'unknown');

  const third = await owner.post(url, { password: 'owner-password-1', reason: 'Wrong paybill' });
  assert.equal(third.status, 202, 'unknown can be retried; M-Pesa refuses a true duplicate itself');
  assert.equal((await owner.get(`/api/mpesa/commands/${second.data.id}`)).data.status, 'failed');
  // Safaricom confirms the retry.
  await hook('/hooks/async/cb-secret-123/result', result(accepted(), { transactionId: 'RVS0000002' }));
  assert.equal((await owner.get(`/api/mpesa/commands/${third.data.id}`)).data.status, 'done');
  assert.equal((await owner.get(`/api/invoices/${invoice.id}`)).data.paid, 0);
});

test('with two-step on, a refund needs the code as well as the password', async (t) => {
  t.after(() => h.db.knex('users').where({ email: 'owner@test.co.ke' }).update({ totp_secret: null, totp_last_step: null, totp_recovery: null }));
  const { txn } = await paidByPaybill(300, 'RFD0000003');
  const started = await owner.post('/api/auth/two-step/start', { password: 'owner-password-1' });
  await owner.post('/api/auth/two-step/enable', { code: totp.codeAt(started.data.secret, totp.stepAt()) });

  const url = `/api/mpesa/transactions/${txn.id}/refund`;
  const noCode = await owner.post(url, { password: 'owner-password-1', reason: 'x' });
  assert.equal(noCode.status, 400);
  assert.equal(noCode.data.needsCode, true);
  assert.equal((await owner.post(url, { password: 'owner-password-1', reason: 'x', code: '000000' })).status, 400);
  const ok = await owner.post(url, { password: 'owner-password-1', reason: 'x', code: totp.codeAt(started.data.secret, totp.stepAt() + 1) });
  assert.equal(ok.status, 202);
});

test('requests Safaricom never answers: lookups fail, refunds become "unknown"', async () => {
  const lookup = await accounts.post('/api/mpesa/lookup', { receipt: 'SJ84K2LQ09' });
  const { txn } = await paidByPaybill(200, 'RFD0000004');
  const url = `/api/mpesa/transactions/${txn.id}/refund`;
  const refund = await owner.post(url, { password: 'owner-password-1', reason: 'x' });
  assert.equal(refund.status, 202, JSON.stringify(refund.data));

  await h.db.knex('mpesa_commands').whereIn('id', [lookup.data.id, refund.data.id]).update({ created_at: new Date(Date.now() - 2 * 3600000).toISOString() });
  await mpesa.expireCommands();
  assert.equal((await owner.get(`/api/mpesa/commands/${lookup.data.id}`)).data.status, 'failed');
  const r = (await owner.get(`/api/mpesa/commands/${refund.data.id}`)).data;
  assert.equal(r.status, 'unknown');
  assert.match(r.resultDesc, /Check your M-Pesa statement/);
});
