/**
 * In-process daily jobs: recurring invoices and payment reminders, plus
 * retrying failed messages. Each daily job claims (job, date) in job_runs
 * before it starts, so a restart — or a second server — can't run it twice.
 */
const config = require('../config');
const db = require('../db');
const { today, localHour } = require('../dates');
const recurring = require('./recurring');
const reminders = require('./reminders');
const messages = require('./messages');

const JOBS = {
  recurring: (on) => recurring.runDue(on),
  reminders: (on) => reminders.run(on)
};

async function claim(job, runKey) {
  try {
    await db.knex('job_runs').insert({ job, run_key: runKey, started_at: db.now() });
    return true;
  } catch (err) {
    if (/unique|duplicate|primary key/i.test(err.message)) return false;
    throw err;
  }
}

async function runJob(job, on = today()) {
  const result = await JOBS[job](on);
  const summary = job === 'recurring'
    ? { created: result.created.length, errors: result.errors }
    : result;
  return summary;
}

async function tick() {
  const on = today();
  if (localHour() >= config.jobs.hour) {
    // Recurring first, so an invoice billed today can't be reminded about before it exists.
    for (const job of ['recurring', 'reminders']) {
      if (!(await claim(job, on))) continue;
      try {
        const result = await runJob(job, on);
        await db.knex('job_runs').where({ job, run_key: on }).update({ finished_at: db.now(), result: JSON.stringify(result) });
        console.log(`[jobs] ${job} ${on}: ${JSON.stringify(result)}`);
      } catch (err) {
        await db.knex('job_runs').where({ job, run_key: on }).update({ finished_at: db.now(), result: JSON.stringify({ error: err.message }) });
        console.error(`[jobs] ${job} ${on} failed: ${err.message}`);
      }
    }
  }
  await messages.deliverPending();
  // STK requests that never heard back within 15 minutes are dead; say so instead of spinning forever.
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await db.knex('mpesa_requests').where({ status: 'pending' }).where('created_at', '<', cutoff)
    .update({ status: 'failed', result_desc: 'No answer from M-Pesa. Use "Check status" or ask again.', updated_at: db.now() });
  await require('../auth').prune();
}

let timers = [];

function start() {
  if (!config.jobs.enabled) return;
  const safeTick = () => tick().catch((err) => console.error('[jobs]', err));
  timers.push(setTimeout(safeTick, 5000));
  timers.push(setInterval(safeTick, 10 * 60 * 1000));
  timers.forEach((t) => t.unref());
}

function stop() {
  timers.forEach((t) => clearTimeout(t));
  timers = [];
}

async function lastRuns(limit = 20) {
  return (await db.knex('job_runs').orderBy('started_at', 'desc').limit(limit)).map((r) => ({
    job: r.job, date: r.run_key, startedAt: r.started_at, finishedAt: r.finished_at, result: r.result ? JSON.parse(r.result) : null
  }));
}

module.exports = { start, stop, tick, runJob, lastRuns };
