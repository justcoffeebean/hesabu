/**
 * Payment reminders, driven by the same aging the dashboard shows.
 *
 * The owner sets offsets relative to the due date (default: 3 days before,
 * on the day, then 7, 14 and 30 days late). Each day the job finds, for each
 * unpaid invoice, the latest stage that has arrived and sends it once per
 * channel. If the server was off for a while it sends only the latest stage,
 * never a backlog of three reminders at once.
 */
const db = require('../db');
const settings = require('../settings');
const { audit, SYSTEM } = require('../audit');
const { fail } = require('../errors');
const { today, addDays } = require('../dates');
const documents = require('./documents');
const messages = require('./messages');
const templates = require('./templates');
const { EMAIL } = require('./sending');

const stageKey = (offset) => `d${offset}`;
const stageOffset = (key) => Number(String(key).slice(1));

/** Latest reminder stage that has arrived for this invoice, or null. */
function currentStage(inv, offsets, on) {
  let best = null;
  for (const offset of [...offsets].sort((a, b) => a - b)) {
    const sendOn = addDays(inv.dueDate, offset);
    // Only stages that fall after the invoice was issued: no "due in 3 days" on the day it's created.
    if (sendOn <= on && sendOn > inv.date) best = offset;
  }
  return best;
}

async function plan(on = today()) {
  const cfg = await settings.reminders();
  const channels = [];
  if (cfg.email && messages.channelReady('email')) channels.push('email');
  if (cfg.sms && messages.channelReady('sms')) channels.push('sms');

  const open = (await documents.listInvoices(db.knex, { on })).filter((i) => i.balanceCents > 0 && i.status !== 'cancelled');
  if (!open.length || !channels.length) return { cfg, channels, items: [] };

  const clients = new Map((await db.knex('clients').whereIn('id', [...new Set(open.map((i) => i.clientId))])).map((c) => [c.id, c]));
  // Failed ones count too: the scheduler retries those, and the unique index forbids a second row per stage.
  const sent = await db.knex('outbox').whereIn('invoice_id', open.map((i) => i.id)).whereNotNull('reminder_stage')
    .select('invoice_id', 'reminder_stage', 'channel');

  const items = [];
  for (const inv of open) {
    const client = clients.get(inv.clientId);
    if (!client || !client.reminders) continue;
    const offset = currentStage(inv, cfg.offsets, on);
    if (offset === null) continue;

    for (const channel of channels) {
      const to = channel === 'email' ? (EMAIL.test(client.email || '') ? client.email : null) : messages.smsNumber(client.phone);
      if (!to) continue;
      // Skip if this stage, or a later one, already went out on this channel.
      const already = sent.some((s) => s.invoice_id === inv.id && s.channel === channel && stageOffset(s.reminder_stage) >= offset);
      if (!already) items.push({ inv, client, channel, to, offset });
    }
  }
  return { cfg, channels, items };
}

async function run(on = today(), actor = SYSTEM, { force = false } = {}) {
  const { cfg, channels, items } = await plan(on);
  if (!cfg.enabled && !force) return { skipped: 'Reminders are turned off in Settings.', queued: 0 };
  if (!channels.length) return { skipped: 'No reminder channel is both switched on and set up on the server.', queued: 0 };

  const company = await settings.company();
  const queued = [];
  for (const { inv, client, channel, to, offset } of items) {
    const content = channel === 'email' ? templates.reminderEmail(inv, client, company, on) : { body: templates.reminderSms(inv, client, company, on) };
    try {
      const row = await db.tx(async (trx) => {
        const r = await messages.queue(trx, actor, {
          channel, to, subject: content.subject, body: content.body, purpose: 'reminder', reminderStage: stageKey(offset),
          invoiceId: inv.id, attachment: channel === 'email' ? 'invoice-pdf' : null
        });
        await audit(trx, actor, {
          action: 'remind', entity: 'invoice', entityId: inv.id,
          summary: `${channel === 'email' ? 'Emailed' : 'Texted'} ${offset < 0 ? 'upcoming' : offset === 0 ? 'due-today' : `${offset}-days-late`} reminder for ${inv.number} to ${to}`
        });
        return r;
      });
      queued.push(row);
    } catch (err) {
      // Unique (invoice, stage, channel) — another run got there first. Anything else is worth logging.
      if (!/unique|duplicate/i.test(err.message)) console.error(`[reminders] ${inv.number}: ${err.message}`);
    }
  }
  await messages.kick(queued);
  return { queued: queued.length };
}

/** The "Send reminder" button: goes out now, whatever the schedule says. */
async function sendNow(actor, invoiceId, { channel = 'email' } = {}) {
  const inv = await documents.getInvoice(db.knex, invoiceId);
  if (inv.status === 'cancelled' || inv.balanceCents <= 0) fail(400, `${inv.number} has nothing left to pay.`);
  const client = await db.knex('clients').where({ id: inv.clientId }).first();
  const company = await settings.company();
  const to = channel === 'sms' ? messages.smsNumber(client.phone) : (EMAIL.test(client.email || '') ? client.email : null);
  if (!to) fail(400, channel === 'sms' ? `${client.name} has no mobile number we can text.` : `${client.name} has no valid email address.`);
  const content = channel === 'email' ? templates.reminderEmail(inv, client, company) : { body: templates.reminderSms(inv, client, company) };

  const row = await db.tx(async (trx) => {
    const r = await messages.queue(trx, actor, {
      channel, to, subject: content.subject, body: content.body, purpose: 'reminder',
      invoiceId: inv.id, attachment: channel === 'email' ? 'invoice-pdf' : null
    });
    await audit(trx, actor, { action: 'remind', entity: 'invoice', entityId: inv.id, summary: `Sent a reminder for ${inv.number} to ${to}` });
    return r;
  });
  const status = await messages.deliver(row.id);
  return { id: row.id, status, to };
}

module.exports = { currentStage, plan, run, sendNow };
