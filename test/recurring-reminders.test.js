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

const recurring = () => require('../src/services/recurring');
const reminders = () => require('../src/services/reminders');
const { today, addDays } = require('../src/dates');

test('months roll over without drifting off the 31st', () => {
  const { addMonths } = require('../src/dates');
  assert.equal(addMonths('2027-01-31', 1, 31), '2027-02-28');
  assert.equal(addMonths('2027-02-28', 1, 31), '2027-03-31');
  assert.equal(addMonths('2028-01-31', 1, 31), '2028-02-29');
  assert.equal(addMonths('2027-11-30', 3, 30), '2028-02-29');
  assert.equal(addMonths('2027-12-15', 1), '2028-01-15');
});

test('a monthly schedule made from an invoice bills every missed month, once', async () => {
  const { invoice, client } = await h.basics(owner, { total: 5000 });
  assert.equal((await staff.post('/api/recurring', { fromInvoiceId: invoice.id, frequency: 'monthly', nextDate: '2099-01-31' })).status, 403);

  const past = await accounts.post('/api/recurring', { fromInvoiceId: invoice.id, frequency: 'monthly', nextDate: '2020-01-31' });
  assert.equal(past.status, 400);

  const made = await accounts.post('/api/recurring', { fromInvoiceId: invoice.id, frequency: 'monthly', nextDate: addDays(today(), 1), dueDays: 7 });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.clientId, client.id);
  assert.equal(made.data.total, 5000);

  // Pretend it was set up a while ago on the 31st and the server has been off since.
  await h.db.knex('recurring_invoices').where({ id: made.data.id }).update({ next_date: '2027-01-31', anchor_day: 31 });
  const first = await recurring().runDue('2027-04-02');
  const mine = first.created.filter((c) => c.templateId === made.data.id);
  assert.deepEqual(mine.map((c) => c.date), ['2027-01-31', '2027-02-28', '2027-03-31']);
  assert.equal(first.errors.length, 0);

  const again = await recurring().runDue('2027-04-02');
  assert.equal(again.created.filter((c) => c.templateId === made.data.id).length, 0, 'second run creates nothing');

  const detail = (await accounts.get(`/api/recurring/${made.data.id}`)).data;
  assert.equal(detail.nextDate, '2027-04-30');
  assert.equal(detail.invoices.length, 3);
  const feb = detail.invoices.find((i) => i.date === '2027-02-28');
  assert.equal(feb.dueDate, '2027-03-07');
  assert.equal(feb.total, 5000);
  assert.equal(feb.recurringId, made.data.id);
});

test('paused schedules skip; end dates end them; resuming needs a future date', async () => {
  const { client } = await h.basics(owner);
  const t = (await accounts.post('/api/recurring', {
    clientId: client.id, frequency: 'weekly', nextDate: addDays(today(), 1), items: [{ description: 'Weekly service', quantity: 1, unitPrice: 100 }]
  })).data;

  await accounts.put(`/api/recurring/${t.id}`, { status: 'paused' });
  await h.db.knex('recurring_invoices').where({ id: t.id }).update({ next_date: '2027-06-01' });
  assert.equal((await recurring().runDue('2027-06-20')).created.filter((c) => c.templateId === t.id).length, 0);

  await h.db.knex('recurring_invoices').where({ id: t.id }).update({ next_date: addDays(today(), -10) });
  const resumeStale = await accounts.put(`/api/recurring/${t.id}`, { status: 'active' });
  assert.equal(resumeStale.status, 400);
  assert.match(resumeStale.data.error, /in the past/);

  await h.db.knex('recurring_invoices').where({ id: t.id }).update({ status: 'active', next_date: '2027-06-01', end_date: '2027-06-10' });
  const run = await recurring().runDue('2027-06-20');
  assert.deepEqual(run.created.filter((c) => c.templateId === t.id).map((c) => c.date), ['2027-06-01', '2027-06-08']);
  assert.equal((await accounts.get(`/api/recurring/${t.id}`)).data.status, 'ended');

  const log = (await owner.get(`/api/audit?entity=recurring&entityId=${t.id}`)).data.entries.map((e) => e.action);
  assert.ok(log.includes('pause') && log.includes('create'));
});

test('auto-email sends the new invoice with its PDF', async () => {
  const { invoice } = await h.basics(owner, { total: 50 });
  const t = (await accounts.post('/api/recurring', { fromInvoiceId: invoice.id, frequency: 'monthly', nextDate: addDays(today(), 1), autoEmail: true })).data;
  await h.db.knex('recurring_invoices').where({ id: t.id }).update({ next_date: '2027-08-01' });
  const run = await recurring().runDue('2027-08-01');
  const made = run.created.find((c) => c.templateId === t.id);
  const msg = await h.db.knex('outbox').where({ invoice_id: made.invoiceId, purpose: 'invoice' }).first();
  assert.equal(msg.status, 'logged');
  assert.equal(msg.attachment, 'invoice-pdf');
  assert.equal(msg.recipient, 'client@example.com');
});

/* ---------- reminders ---------- */

test('reminder stage: latest one due, and never before the invoice existed', () => {
  const inv = { date: '2027-03-01', dueDate: '2027-03-15' };
  const offsets = [-3, 0, 7, 14, 30];
  assert.equal(reminders().currentStage(inv, offsets, '2027-03-11'), null);
  assert.equal(reminders().currentStage(inv, offsets, '2027-03-12'), -3);
  assert.equal(reminders().currentStage(inv, offsets, '2027-03-15'), 0);
  assert.equal(reminders().currentStage(inv, offsets, '2027-04-01'), 14);
  assert.equal(reminders().currentStage({ date: '2027-03-14', dueDate: '2027-03-15' }, offsets, '2027-03-14'), null, 'no "due in 3 days" on the day of issue');
});

test('reminders are off until switched on; then go out once per stage per channel', async () => {
  const c = (await owner.post('/api/clients', { name: 'Slow Payer', email: 'slow@example.com', phone: '0733 123 456' })).data;
  const inv = (await owner.post('/api/invoices', { clientId: c.id, vatRate: 0, items: [{ description: 'x', quantity: 1, unitPrice: 800 }] })).data;
  await h.db.knex('invoices').where({ id: inv.id }).update({ date: '2027-05-01', due_date: '2027-05-15' });

  const off = await reminders().run('2027-05-22');
  assert.match(off.skipped, /turned off/);

  assert.equal((await accounts.put('/api/settings/reminders', { enabled: true })).status, 403, 'owner decides');
  const saved = await owner.put('/api/settings/reminders', { enabled: true, email: true, sms: true, offsets: '30, 7, -3, 0' });
  assert.deepEqual(saved.data.offsets, [-3, 0, 7, 30]);

  await reminders().run('2027-05-22');
  let rows = await h.db.knex('outbox').where({ invoice_id: inv.id, purpose: 'reminder' });
  assert.deepEqual(rows.map((r) => [r.channel, r.reminder_stage, r.status]).sort(), [['email', 'd7', 'logged'], ['sms', 'd7', 'logged']]);
  const email = rows.find((r) => r.channel === 'email');
  assert.match(email.subject, /^Overdue: invoice/);
  assert.match(email.body, /was due on 15 May 2027, 7 days ago/);
  assert.equal(email.attachment, 'invoice-pdf');
  assert.equal(rows.find((r) => r.channel === 'sms').recipient, '+254733123456');

  await reminders().run('2027-05-23');
  await Promise.all([reminders().run('2027-05-24'), reminders().run('2027-05-24')]);
  rows = await h.db.knex('outbox').where({ invoice_id: inv.id, purpose: 'reminder' });
  assert.equal(rows.length, 2, 'no repeats, even with overlapping runs');

  // Server off for weeks: only the latest stage goes, not a backlog.
  await reminders().run('2027-06-20');
  rows = await h.db.knex('outbox').where({ invoice_id: inv.id, purpose: 'reminder' });
  assert.deepEqual([...new Set(rows.map((r) => r.reminder_stage))].sort(), ['d30', 'd7']);

  // Paid invoices and opted-out clients hear nothing.
  await accounts.post('/api/payments', { invoiceId: inv.id, amount: 800 });
  const other = (await owner.post('/api/invoices', { clientId: c.id, vatRate: 0, items: [{ description: 'y', quantity: 1, unitPrice: 5 }] })).data;
  await h.db.knex('invoices').where({ id: other.id }).update({ date: '2027-05-01', due_date: '2027-05-15' });
  await owner.put(`/api/clients/${c.id}`, { reminders: false });
  await reminders().run('2027-07-20');
  assert.equal((await h.db.knex('outbox').whereIn('invoice_id', [inv.id, other.id]).where({ purpose: 'reminder' })).length, 4, 'still just d7 + d30 on two channels');

  await owner.put('/api/settings/reminders', { enabled: false, email: true, sms: false, offsets: [-3, 0, 7, 14, 30] });
});

test('"Send reminder" works on demand and lists on the invoice', async () => {
  const { invoice } = await h.basics(owner, { total: 120 });
  assert.equal((await staff.post(`/api/invoices/${invoice.id}/remind`)).status, 403);
  const sent = await accounts.post(`/api/invoices/${invoice.id}/remind`, { channel: 'email' });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.status, 'logged');
  const sms = await accounts.post(`/api/invoices/${invoice.id}/remind`, { channel: 'sms' });
  assert.equal(sms.data.to, '+254722000111');
  const detail = (await accounts.get(`/api/invoices/${invoice.id}`)).data;
  assert.equal(detail.messages.filter((m) => m.purpose === 'reminder').length, 2);
});

test('emailing an invoice or quotation attaches the PDF and records it', async () => {
  const { invoice, client } = await h.basics(owner, { total: 10 });
  const r = await accounts.post(`/api/invoices/${invoice.id}/email`, { note: 'As discussed.' });
  assert.equal(r.status, 200);
  const msg = await h.db.knex('outbox').where({ id: r.data.id }).first();
  assert.match(msg.body, /As discussed\./);
  assert.ok((await h.db.knex('invoices').where({ id: invoice.id }).first()).emailed_at);

  const noEmail = (await owner.post('/api/clients', { name: 'No Email' })).data;
  const inv2 = (await owner.post('/api/invoices', { clientId: noEmail.id, items: [{ description: 'x', quantity: 1, unitPrice: 1 }] })).data;
  assert.equal((await accounts.post(`/api/invoices/${inv2.id}/email`)).status, 400);
  assert.equal((await accounts.post(`/api/invoices/${inv2.id}/email`, { to: 'typed@example.com' })).status, 200);

  const q = (await staff.post('/api/quotations', { clientId: client.id, items: [{ description: 'Quote', quantity: 1, unitPrice: 9 }] })).data;
  const qm = await staff.post(`/api/quotations/${q.id}/email`);
  assert.equal(qm.status, 200);
  assert.equal((await staff.get(`/api/quotations/${q.id}`)).data.status, 'sent', 'emailing a draft marks it sent');
});

test('a failed send is kept, retried by the scheduler, and can be retried by hand', async () => {
  const messages = require('../src/services/messages');
  const { invoice } = await h.basics(owner, { total: 10 });
  const row = await h.db.tx((trx) => messages.queue(trx, null, { channel: 'email', to: 'x@example.com', subject: 's', body: 'b', purpose: 'invoice', invoiceId: invoice.id, attachment: 'invoice-pdf' }));
  // Point the attachment at a document that doesn't exist, so building the email fails.
  await h.db.knex('outbox').where({ id: row.id }).update({ attachment: 'quotation-pdf', quotation_id: null });
  assert.equal(await messages.deliver(row.id), 'failed');
  const failed = await h.db.knex('outbox').where({ id: row.id }).first();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.ok(failed.error);

  await h.db.knex('outbox').where({ id: row.id }).update({ attachment: null });
  assert.equal((await accounts.post(`/api/messages/${row.id}/retry`)).data.status, 'logged');
});

test('the scheduler runs each daily job once per day, however often it ticks', async () => {
  const scheduler = require('../src/services/scheduler');
  const config = require('../src/config');
  config.jobs.hour = 0;
  await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
  const runs = await h.db.knex('job_runs').where({ run_key: today() });
  assert.deepEqual(runs.map((r) => r.job).sort(), ['recurring', 'reminders']);
  assert.ok(runs.every((r) => r.finished_at));
});
