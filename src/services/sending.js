/** Emailing documents to clients: the "Email invoice" / "Email quotation" buttons and recurring auto-send. */
const db = require('../db');
const settings = require('../settings');
const { audit } = require('../audit');
const { fail } = require('../errors');
const documents = require('./documents');
const messages = require('./messages');
const templates = require('./templates');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function emailDocument(actor, kind, id, { to, note } = {}) {
  const doc = kind === 'invoice' ? await documents.getInvoice(db.knex, id) : await documents.getQuotation(db.knex, id);
  if (doc.status === 'cancelled') fail(400, `${doc.number} was cancelled.`);
  const client = await db.knex('clients').where({ id: doc.clientId }).first();
  const recipient = String(to || client.email || '').trim();
  if (!EMAIL.test(recipient)) fail(400, `${client.name} has no valid email address. Add one on the client, or type one in.`);

  const company = await settings.company();
  const cleanNote = String(note || '').trim().slice(0, 2000);
  const { subject, body } = kind === 'invoice'
    ? templates.invoiceEmail(doc, client, company, cleanNote)
    : templates.quotationEmail(doc, client, company, cleanNote);

  const row = await db.tx(async (trx) => {
    const r = await messages.queue(trx, actor, {
      channel: 'email', to: recipient, subject, body, purpose: kind,
      attachment: `${kind}-pdf`, invoiceId: kind === 'invoice' ? id : null, quotationId: kind === 'quotation' ? id : null
    });
    if (kind === 'quotation' && doc.status === 'draft') {
      await trx('quotations').where({ id }).update({ status: 'sent', updated_at: db.now() });
    }
    await audit(trx, actor, { action: 'email', entity: kind, entityId: id, summary: `Emailed ${doc.number} to ${recipient}` });
    return r;
  });
  const status = await messages.deliver(row.id);
  return { id: row.id, status, to: recipient };
}

const emailInvoice = (actor, id, opts) => emailDocument(actor, 'invoice', id, opts);
const emailQuotation = (actor, id, opts) => emailDocument(actor, 'quotation', id, opts);

module.exports = { emailInvoice, emailQuotation, EMAIL };
