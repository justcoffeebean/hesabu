/**
 * One Knex instance for the whole app.
 *
 * Locally this is a SQLite file (nothing to install). Set DATABASE_URL and the
 * same queries run against PostgreSQL. Money is stored as integer cents in
 * BIGINT columns; calendar dates as 'YYYY-MM-DD' strings.
 *
 * Rule for anything that reads-then-writes (numbering, balances, allocation):
 * do it inside tx() and pass `trx` down. Never call `knex` inside a transaction
 * callback — on SQLite there is one connection, so it would wait on itself.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Knex = require('knex');
const config = require('../config');

const isPg = config.db.client === 'pg';

if (isPg) {
  const { types } = require('pg');
  types.setTypeParser(20, (v) => Number(v)); // BIGINT cents → number (exact below 9e15)
  types.setTypeParser(1700, (v) => Number(v)); // NUMERIC
  types.setTypeParser(1082, (v) => v); // DATE stays 'YYYY-MM-DD', no timezone shift
} else {
  fs.mkdirSync(path.dirname(config.db.filename), { recursive: true });
}

const knex = Knex(
  isPg
    ? { client: 'pg', connection: config.db.connection, pool: { min: 0, max: 10 } }
    : {
        client: 'better-sqlite3',
        connection: { filename: config.db.filename },
        useNullAsDefault: true,
        acquireConnectionTimeout: 15000,
        pool: {
          afterCreate(conn, done) {
            conn.pragma('journal_mode = WAL');
            conn.pragma('foreign_keys = ON');
            conn.pragma('busy_timeout = 5000');
            done();
          }
        }
      }
);

const migrations = { directory: path.join(__dirname, 'migrations'), loadExtensions: ['.js'] };

async function migrate() {
  await knex.migrate.latest(migrations);
}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

function now() {
  return new Date().toISOString();
}

/** Run fn inside a transaction. Rolls back if it throws. */
function tx(fn) {
  return knex.transaction(fn);
}

/** Row lock on Postgres; SQLite already serialises writers on its single connection. */
function lock(query) {
  return isPg ? query.forUpdate() : query;
}

/** Sequential, year-stamped document numbers: QT-2026-0007, INV-2026-0007, OB-2026-0001. */
async function nextNumber(trx, kind) {
  const prefix = { quotation: 'QT', invoice: 'INV', opening: 'OB' }[kind];
  const row = await lock(trx('counters').where({ kind })).first();
  const value = (row ? row.value : 0) + 1;
  if (row) await trx('counters').where({ kind }).update({ value });
  else await trx('counters').insert({ kind, value });
  const { today } = require('../dates');
  return `${prefix}-${today().slice(0, 4)}-${String(value).padStart(4, '0')}`;
}

/** Settings are small JSON blobs keyed by name ('company', 'reminders'). */
async function getSetting(db, key, fallback) {
  const row = await db('settings').where({ key }).first();
  if (!row) return structuredClone(fallback);
  return { ...structuredClone(fallback), ...JSON.parse(row.value) };
}

async function putSetting(db, key, value) {
  const json = JSON.stringify(value);
  const exists = await db('settings').where({ key }).first();
  if (exists) await db('settings').where({ key }).update({ value: json, updated_at: now() });
  else await db('settings').insert({ key, value: json, updated_at: now() });
  return value;
}

async function close() {
  await knex.destroy();
}

module.exports = { knex, isPg, migrate, newId, now, tx, lock, nextNumber, getSetting, putSetting, close };
