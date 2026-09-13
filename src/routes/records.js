/** Read-only records: the audit log and the message outbox. Plus CSV import. */
const express = require('express');
const db = require('../db');
const { allow } = require('../auth');
const { fail } = require('../errors');
const messages = require('../services/messages');
const importer = require('../services/importer');

const router = express.Router();

/* ---------- audit log ---------- */

router.get('/audit', allow('audit:read'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const q = db.knex('audit_log').orderBy('id', 'desc').limit(limit + 1);
  if (req.query.before) q.where('id', '<', Number(req.query.before));
  if (req.query.entity) q.where({ entity: req.query.entity });
  if (req.query.entityId) q.where({ entity_id: req.query.entityId });
  if (req.query.userId) q.where({ user_id: req.query.userId });
  if (req.query.q) {
    const pattern = `%${String(req.query.q).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    q.whereRaw("lower(summary) like ? escape '\\'", [pattern]);
  }
  const rows = await q;
  res.json({
    entries: rows.slice(0, limit).map((r) => ({
      id: r.id, at: r.at, userId: r.user_id, userName: r.user_name, action: r.action, entity: r.entity,
      entityId: r.entity_id, summary: r.summary, changes: r.changes ? JSON.parse(r.changes) : null, ip: r.ip
    })),
    more: rows.length > limit
  });
});

/* ---------- outbox ---------- */

router.get('/messages', allow('reminders:read'), async (_req, res) => {
  const rows = await db.knex('outbox').leftJoin('invoices', 'invoices.id', 'outbox.invoice_id')
    .leftJoin('quotations', 'quotations.id', 'outbox.quotation_id')
    .whereNot('outbox.purpose', 'invite') // sign-in links are nobody else's business
    .orderBy('outbox.created_at', 'desc').limit(200)
    .select('outbox.*', 'invoices.number as invoice_number', 'quotations.number as quotation_number');
  res.json({
    channels: messages.channelStatus(),
    messages: rows.map((m) => ({
      id: m.id, channel: m.channel, to: m.recipient, subject: m.subject, body: m.body, purpose: m.purpose,
      stage: m.reminder_stage, status: m.status, attempts: m.attempts, error: m.error,
      document: m.invoice_number || m.quotation_number || null, invoiceId: m.invoice_id, quotationId: m.quotation_id,
      createdAt: m.created_at, sentAt: m.sent_at
    }))
  });
});

router.post('/messages/:id/retry', allow('invoices:send'), async (req, res) => {
  const row = await db.knex('outbox').where({ id: req.params.id }).first();
  if (!row || row.purpose === 'invite') fail(404, 'Message not found.');
  res.json({ status: await messages.retry(req.params.id) });
});

/* ---------- CSV import ---------- */

router.get('/import/:kind/template', allow('import:run'), (req, res) => {
  const csv = importer.template(req.params.kind);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="hesabu-${req.params.kind}-template.csv"` });
  res.send(csv);
});

router.post('/import/:kind/preview', allow('import:run'), async (req, res) => {
  res.json(await importer.preview(req.params.kind, req.body?.csv));
});

router.post('/import/:kind/commit', allow('import:run'), async (req, res) => {
  res.json(await importer.commit(req, req.params.kind, req.body?.csv));
});

module.exports = router;
