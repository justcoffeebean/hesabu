/**
 * Outgoing email and SMS.
 *
 * A message is always written to the outbox first (inside the caller's
 * transaction) and delivered only once that has committed, so a rolled-back
 * change never emails anyone. Failures are retried by the scheduler. The
 * outbox doubles as the record of what each client was sent and when.
 *
 * Transports (set in .env):
 *   MAIL_TRANSPORT  smtp | log | off      (smtp when SMTP_HOST is set)
 *   SMS_TRANSPORT   africastalking | log | off   (africastalking when AT_API_KEY is set)
 * `log` prints to the console and marks the message "logged" — handy locally.
 */
const nodemailer = require('nodemailer');
const config = require('../config');
const db = require('../db');
const { fail } = require('../errors');
const settings = require('../settings');

const MAX_ATTEMPTS = 3;
let mailer = null;

function channelStatus() {
  return {
    email: config.mail.transport === 'smtp' && !config.mail.host ? 'off' : config.mail.transport,
    sms: config.sms.transport === 'africastalking' && !config.sms.apiKey ? 'off' : config.sms.transport
  };
}

const channelReady = (channel) => channelStatus()[channel] !== 'off';

function requireChannel(channel) {
  if (channelReady(channel)) return;
  fail(400, channel === 'email'
    ? "Email isn't set up on this server. Add SMTP_HOST, SMTP_USER and SMTP_PASS to .env (or MAIL_TRANSPORT=log to try it out)."
    : "SMS isn't set up on this server. Add AT_USERNAME and AT_API_KEY to .env (or SMS_TRANSPORT=log to try it out).");
}

async function queue(trx, actor, msg) {
  requireChannel(msg.channel);
  const row = {
    id: db.newId(),
    channel: msg.channel,
    recipient: msg.to,
    subject: msg.subject || null,
    body: msg.body,
    attachment: msg.attachment || null,
    invoice_id: msg.invoiceId || null,
    quotation_id: msg.quotationId || null,
    purpose: msg.purpose,
    reminder_stage: msg.reminderStage || null,
    status: 'queued',
    attempts: 0,
    created_by: actor?.user?.id || null,
    created_at: db.now()
  };
  await trx('outbox').insert(row);
  return row;
}

/* ---------- transports ---------- */

async function sendEmail(row) {
  const company = await settings.company();
  const from = config.mail.from || `"${company.name.replace(/"/g, '')}" <${company.email}>`;
  const attachments = [];
  if (row.attachment) {
    const { documentPdf } = require('./pdf');
    const kind = row.attachment === 'invoice-pdf' ? 'invoice' : 'quotation';
    const { buffer, filename } = await documentPdf(kind, kind === 'invoice' ? row.invoice_id : row.quotation_id);
    attachments.push({ filename, content: buffer, contentType: 'application/pdf' });
  }

  if (config.mail.transport === 'log') {
    console.log(`\n[email:log] to ${row.recipient}: ${row.subject}${attachments.length ? ` (+${attachments[0].filename})` : ''}\n${row.body}\n`);
    return { status: 'logged', providerId: null };
  }

  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined
    });
  }
  const info = await mailer.sendMail({
    from, to: row.recipient, replyTo: company.email || undefined, subject: row.subject, text: row.body, attachments
  });
  return { status: 'sent', providerId: info.messageId || null };
}

async function sendSms(row) {
  if (config.sms.transport === 'log') {
    console.log(`\n[sms:log] to ${row.recipient}: ${row.body}\n`);
    return { status: 'logged', providerId: null };
  }
  const host = config.sms.username === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const form = new URLSearchParams({ username: config.sms.username, to: row.recipient, message: row.body });
  if (config.sms.senderId) form.set('from', config.sms.senderId);
  const res = await fetch(`${host}/version1/messaging`, {
    method: 'POST',
    headers: { apiKey: config.sms.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Africa's Talking HTTP ${res.status}: ${text.slice(0, 200)}`);
  const recipient = JSON.parse(text)?.SMSMessageData?.Recipients?.[0];
  // 100 Processed, 101 Sent, 102 Queued — anything else is a rejection.
  if (!recipient || ![100, 101, 102].includes(Number(recipient.statusCode))) {
    throw new Error(`SMS rejected: ${recipient ? recipient.status : JSON.parse(text)?.SMSMessageData?.Message || 'no recipient'}`);
  }
  return { status: 'sent', providerId: recipient.messageId || null };
}

/* ---------- delivery ---------- */

async function deliver(id) {
  // Claim the row so two workers can't send the same message.
  const claimed = await db.knex('outbox').where({ id }).whereIn('status', ['queued', 'failed'])
    .where('attempts', '<', MAX_ATTEMPTS).update({ status: 'sending', claimed_at: db.now() });
  if (!claimed) return null;
  const row = await db.knex('outbox').where({ id }).first();
  try {
    const result = row.channel === 'email' ? await sendEmail(row) : await sendSms(row);
    await db.knex('outbox').where({ id }).update({
      status: result.status, provider_id: result.providerId, sent_at: db.now(), attempts: row.attempts + 1, error: null,
      // Invite and reset emails carry a sign-in link; don't keep it lying around once it's gone out.
      ...(row.purpose === 'invite' ? { body: '[Sign-in link removed after sending]' } : {})
    });
    if (row.invoice_id && row.purpose === 'invoice' && row.channel === 'email') {
      await db.knex('invoices').where({ id: row.invoice_id }).update({ emailed_at: db.now() });
    }
    return result.status;
  } catch (err) {
    await db.knex('outbox').where({ id }).update({
      status: 'failed', attempts: row.attempts + 1, error: String(err.message || err).slice(0, 1000)
    });
    console.error(`[outbox] ${row.channel} to ${row.recipient} failed: ${err.message}`);
    return 'failed';
  }
}

/** Fire-and-forget delivery after the caller's transaction commits. */
function kick(rows) {
  const ids = (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map((r) => r.id || r);
  if (!ids.length) return Promise.resolve();
  return Promise.all(ids.map((id) => deliver(id).catch((e) => console.error('[outbox]', e))));
}

async function deliverPending() {
  // A crash mid-send leaves 'sending' behind; give those another go after ten minutes.
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await db.knex('outbox').where({ status: 'sending' }).where('claimed_at', '<', stale).update({ status: 'failed' });
  const rows = await db.knex('outbox').whereIn('status', ['queued', 'failed']).where('attempts', '<', MAX_ATTEMPTS).select('id').limit(50);
  for (const r of rows) await deliver(r.id);
  return rows.length;
}

/** Retry a message a person chose to resend (resets the attempt counter). */
async function retry(id) {
  const row = await db.knex('outbox').where({ id }).first();
  if (!row) fail(404, 'Message not found.');
  if (row.status !== 'failed') fail(400, 'Only failed messages can be retried.');
  requireChannel(row.channel);
  await db.knex('outbox').where({ id }).update({ status: 'queued', attempts: 0 });
  return deliver(id);
}

/** International format for SMS: +2547XXXXXXXX. */
function smsNumber(phone) {
  const { normalizePhone } = require('./mpesa');
  const n = normalizePhone(phone);
  return n ? `+${n}` : null;
}

module.exports = { channelStatus, channelReady, requireChannel, queue, deliver, kick, deliverPending, retry, smsNumber, MAX_ATTEMPTS };
