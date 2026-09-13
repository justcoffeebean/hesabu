/** The operations board: daily jobs and who is on them. */
const express = require('express');
const db = require('../db');
const { allow } = require('../auth');
const { audit } = require('../audit');
const { fail, checkVersion } = require('../errors');
const { text, oneOf } = require('../validate');
const { today, isIsoDate } = require('../dates');

const router = express.Router();
const STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['low', 'normal', 'high'];

const taskOut = (t) => ({
  id: t.id, title: t.title, assignee: t.assignee || '', clientId: t.client_id, clientName: t.client_name || null,
  dueDate: t.due_date, priority: t.priority, status: t.status, version: t.version
});

const load = (conn, id) => conn('tasks').leftJoin('clients', 'clients.id', 'tasks.client_id')
  .select('tasks.*', 'clients.name as client_name').where('tasks.id', id).first();

router.get('/tasks', allow('tasks:read'), async (_req, res) => {
  const rows = await db.knex('tasks').leftJoin('clients', 'clients.id', 'tasks.client_id')
    .select('tasks.*', 'clients.name as client_name').orderBy('tasks.due_date');
  res.json(rows.map(taskOut));
});

router.post('/tasks', allow('tasks:write'), async (req, res) => {
  const b = req.body || {};
  const title = text(b.title, 300);
  if (!title) fail(400, 'Give the job a title.');
  const dueDate = b.dueDate || today();
  if (!isIsoDate(dueDate)) fail(400, 'Due date must be a date.');
  const out = await db.tx(async (trx) => {
    if (b.clientId && !(await trx('clients').where({ id: b.clientId }).first())) fail(400, 'That client no longer exists.');
    const row = {
      id: db.newId(), title, assignee: text(b.assignee, 120), client_id: b.clientId || null, due_date: dueDate,
      priority: PRIORITIES.includes(b.priority) ? b.priority : 'normal', status: 'todo',
      created_by: req.user.id, created_at: db.now(), version: 1
    };
    await trx('tasks').insert(row);
    await audit(trx, req, { action: 'create', entity: 'task', entityId: row.id, summary: `Added job "${title}"` });
    return taskOut(await load(trx, row.id));
  });
  res.status(201).json(out);
});

router.put('/tasks/:id', allow('tasks:write'), async (req, res) => {
  const b = req.body || {};
  const out = await db.tx(async (trx) => {
    const task = await db.lock(trx('tasks').where({ id: req.params.id })).first();
    if (!task) fail(404, 'Job not found.');
    checkVersion(task, b.version, 'job');
    const patch = {};
    if (b.title !== undefined) patch.title = text(b.title, 300) || task.title;
    if (b.assignee !== undefined) patch.assignee = text(b.assignee, 120);
    if (b.dueDate !== undefined) {
      if (!isIsoDate(b.dueDate)) fail(400, 'Due date must be a date.');
      patch.due_date = b.dueDate;
    }
    if (b.priority !== undefined) patch.priority = oneOf(b.priority, PRIORITIES, 'Priority');
    if (b.status !== undefined) patch.status = oneOf(b.status, STATUSES, 'Status');
    await trx('tasks').where({ id: task.id }).update({ ...patch, updated_at: db.now(), version: task.version + 1 });
    const after = await trx('tasks').where({ id: task.id }).first();
    const moved = patch.status && patch.status !== task.status;
    await audit(trx, req, {
      action: moved ? 'status' : 'update', entity: 'task', entityId: task.id,
      summary: moved ? `Moved "${task.title}" to ${{ todo: 'to do', doing: 'in progress', done: 'done' }[patch.status]}` : `Edited job "${after.title}"`,
      before: task, after
    });
    return taskOut(await load(trx, task.id));
  });
  res.json(out);
});

router.delete('/tasks/:id', allow('tasks:write'), async (req, res) => {
  await db.tx(async (trx) => {
    const task = await trx('tasks').where({ id: req.params.id }).first();
    if (!task) fail(404, 'Job not found.');
    await trx('tasks').where({ id: task.id }).del();
    await audit(trx, req, { action: 'delete', entity: 'task', entityId: task.id, summary: `Deleted job "${task.title}"`, before: task });
  });
  res.status(204).end();
});

module.exports = router;
