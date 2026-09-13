/**
 * Recurring invoices: a template (client, lines, terms) plus a schedule.
 * Each run bills every period that has come due — if the server was off for
 * two months, both months get their invoice, each dated on its own day.
 */
const db = require('../db');
const settings = require('../settings');
const { audit, SYSTEM } = require('../audit');
const { fail, checkVersion } = require('../errors');
const { today, addDays, addMonths, isIsoDate } = require('../dates');
const { toAmount, documentTotals } = require('../totals');
const documents = require('./documents');
const { emailInvoice } = require('./sending');

const FREQUENCIES = { weekly: 'Every week', monthly: 'Every month', quarterly: 'Every 3 months', yearly: 'Every year' };

function advance(date, frequency, anchorDay) {
  if (frequency === 'weekly') return addDays(date, 7);
  if (frequency === 'monthly') return addMonths(date, 1, anchorDay);
  if (frequency === 'quarterly') return addMonths(date, 3, anchorDay);
  if (frequency === 'yearly') return addMonths(date, 12, anchorDay);
  throw new Error(`Unknown frequency ${frequency}`);
}

function validate(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.frequency !== undefined) {
    if (!FREQUENCIES[input.frequency]) fail(400, 'Choose how often to bill: weekly, monthly, quarterly or yearly.');
    out.frequency = input.frequency;
  }
  if (!partial || input.nextDate !== undefined) {
    if (!isIsoDate(input.nextDate)) fail(400, 'Pick the date of the first (next) invoice.');
    out.next_date = input.nextDate;
    out.anchor_day = Number(input.nextDate.slice(8, 10));
  }
  if (input.endDate !== undefined) {
    if (input.endDate && !isIsoDate(input.endDate)) fail(400, 'End date must look like 2026-12-31.');
    out.end_date = input.endDate || null;
  }
  if (input.dueDays !== undefined) {
    const n = Number(input.dueDays);
    if (!(Number.isInteger(n) && n >= 0 && n <= 365)) fail(400, 'Payment terms must be between 0 and 365 days.');
    out.due_days = n;
  }
  if (input.autoEmail !== undefined) out.auto_email = Boolean(input.autoEmail);
  return out;
}

async function templateOut(conn, rows) {
  const lines = await documents.readLines(conn, 'recurring_lines', 'recurring_id', rows.map((r) => r.id));
  const counts = new Map();
  if (rows.length) {
    (await conn('invoices').whereIn('recurring_id', rows.map((r) => r.id)).select('recurring_id').count({ n: '*' }).groupBy('recurring_id'))
      .forEach((r) => counts.set(r.recurring_id, Number(r.n)));
  }
  return rows.map((r) => {
    const l = lines.get(r.id) || [];
    const totals = documentTotals(l, Number(r.discount_cents), Number(r.vat_rate));
    return {
      id: r.id, clientId: r.client_id, clientName: r.client_name, currency: r.currency,
      frequency: r.frequency, frequencyLabel: FREQUENCIES[r.frequency], nextDate: r.next_date, endDate: r.end_date,
      dueDays: r.due_days, autoEmail: Boolean(r.auto_email), status: r.status, lastRunAt: r.last_run_at,
      discount: toAmount(r.discount_cents), vatRate: Number(r.vat_rate), notes: r.notes || '',
      total: toAmount(totals.total), lines: documents.linesOut(l), invoiceCount: counts.get(r.id) || 0, version: r.version
    };
  });
}

async function list(conn = db.knex, ids) {
  const q = conn('recurring_invoices').join('clients', 'clients.id', 'recurring_invoices.client_id')
    .select('recurring_invoices.*', 'clients.name as client_name').orderBy('recurring_invoices.next_date');
  if (ids) q.whereIn('recurring_invoices.id', ids);
  return templateOut(conn, await q);
}

async function get(conn, id) {
  const [t] = await list(conn, [id]);
  if (!t) fail(404, 'Recurring invoice not found.');
  return t;
}

async function create(actor, input) {
  return db.tx(async (trx) => {
    const client = await trx('clients').where({ id: input.clientId }).first();
    if (!client) fail(400, 'Pick a client first.');
    const lines = await documents.validateLines(trx, input.items);
    const { currency } = await documents.rateFor(trx, input.currency || client.currency);
    const schedule = validate({ dueDays: 14, autoEmail: false, ...input });
    if (schedule.next_date < today()) fail(400, "The next invoice date can't be in the past.");

    const row = {
      id: db.newId(), client_id: client.id, currency,
      discount_cents: Math.max(0, Math.round(Number(input.discountCents) || 0)),
      vat_rate: input.vatRate === undefined || input.vatRate === '' ? Number((await settings.company(trx)).vatRate) : Number(input.vatRate),
      notes: input.notes || '', status: 'active', created_by: actor?.user?.id || null, created_at: db.now(), version: 1,
      ...schedule
    };
    await trx('recurring_invoices').insert(row);
    await documents.writeLines(trx, 'recurring_lines', 'recurring_id', row.id, lines);
    await audit(trx, actor, {
      action: 'create', entity: 'recurring', entityId: row.id,
      summary: `${FREQUENCIES[row.frequency]} for ${client.name}, starting ${row.next_date}`,
      after: { client: client.name, frequency: row.frequency, nextDate: row.next_date, lines: documents.linesOut(lines) }
    });
    return get(trx, row.id);
  });
}

async function update(actor, id, input) {
  return db.tx(async (trx) => {
    const row = await db.lock(trx('recurring_invoices').where({ id })).first();
    if (!row) fail(404, 'Recurring invoice not found.');
    checkVersion(row, input.version, 'recurring invoice');
    if (row.status === 'ended') fail(400, 'This schedule has ended. Create a new one instead.');

    const patch = validate(input, { partial: true });
    if (input.status !== undefined) {
      if (!['active', 'paused', 'ended'].includes(input.status)) fail(400, 'Status must be active, paused or ended.');
      patch.status = input.status;
    }
    if (input.items !== undefined) {
      const lines = await documents.validateLines(trx, input.items);
      await documents.writeLines(trx, 'recurring_lines', 'recurring_id', id, lines);
    }
    if (input.discountCents !== undefined) patch.discount_cents = Math.max(0, Math.round(Number(input.discountCents) || 0));
    if (input.vatRate !== undefined) patch.vat_rate = Number(input.vatRate) || 0;
    if (input.notes !== undefined) patch.notes = input.notes;
    // Resuming a long-paused schedule shouldn't back-bill every missed period.
    if (patch.status === 'active' && row.status === 'paused' && (patch.next_date || row.next_date) < today()) {
      fail(400, 'The next invoice date is in the past. Set a new next date when resuming.');
    }

    const before = { ...row };
    await trx('recurring_invoices').where({ id }).update({ ...patch, updated_at: db.now(), version: row.version + 1 });
    const after = await trx('recurring_invoices').where({ id }).first();
    const verb = patch.status && patch.status !== row.status ? { active: 'resume', paused: 'pause', ended: 'end' }[patch.status] : 'update';
    const client = await trx('clients').where({ id: row.client_id }).first();
    const summary = `${{ resume: 'Resumed', pause: 'Paused', end: 'Ended', update: 'Updated' }[verb]} recurring invoice for ${client.name}`;
    await audit(trx, actor, { action: verb, entity: 'recurring', entityId: id, summary, before, after });
    return get(trx, id);
  });
}

/** Bills everything due on or before `on`. Returns what was created, and what failed and why. */
async function runDue(on = today(), actor = SYSTEM) {
  const due = await db.knex('recurring_invoices').where({ status: 'active' }).where('next_date', '<=', on).select('id');
  const created = [];
  const errors = [];

  for (const { id } of due) {
    try {
      const made = await db.tx(async (trx) => {
        const t = await db.lock(trx('recurring_invoices').where({ id })).first();
        if (!t || t.status !== 'active') return [];
        const lines = (await documents.readLines(trx, 'recurring_lines', 'recurring_id', [id])).get(id) || [];
        const out = [];
        let next = t.next_date;
        let guard = 0;
        while (next <= on && (!t.end_date || next <= t.end_date) && guard++ < 60) {
          const { invoice, warnings } = await documents.createInvoice(trx, actor, {
            clientId: t.client_id, items: lines, discountCents: Number(t.discount_cents), vatRate: Number(t.vat_rate),
            notes: t.notes, currency: t.currency, date: next, dueDate: addDays(next, t.due_days), recurringId: t.id
          });
          out.push({ templateId: t.id, invoiceId: invoice.id, number: invoice.number, date: next, autoEmail: Boolean(t.auto_email), warnings });
          next = advance(next, t.frequency, t.anchor_day);
        }
        const ended = t.end_date && next > t.end_date;
        await trx('recurring_invoices').where({ id }).update({
          next_date: next, status: ended ? 'ended' : 'active', last_run_at: db.now(), updated_at: db.now(), version: t.version + 1
        });
        return out;
      });
      created.push(...made);
    } catch (err) {
      errors.push({ templateId: id, error: err.message });
      console.error(`[recurring] ${id}: ${err.message}`);
    }
  }

  // Emailing happens after the invoices are safely committed.
  for (const c of created.filter((x) => x.autoEmail)) {
    try {
      await emailInvoice(actor, c.invoiceId);
    } catch (err) {
      errors.push({ templateId: c.templateId, error: `${c.number} was created but not emailed: ${err.message}` });
    }
  }
  return { created, errors };
}

module.exports = { FREQUENCIES, advance, list, get, create, update, runDue };
