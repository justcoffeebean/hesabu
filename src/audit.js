/**
 * Append-only record of who changed what. Always written inside the same
 * transaction as the change itself, so a rolled-back change leaves no entry
 * and a committed one always has one.
 */
const { now } = require('./db');

const SYSTEM = { id: null, name: 'System' };

/** Field-by-field differences between two plain objects, ignoring bookkeeping columns. */
function diff(before, after) {
  const skip = new Set(['updated_at', 'version', 'password_hash']);
  const out = {};
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (skip.has(key)) continue;
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = [a ?? null, b ?? null];
  }
  return out;
}

/**
 * @param trx     transaction (or knex) to write with
 * @param actor   req (uses req.user and req.ip) or { id, name } for system work
 */
async function audit(trx, actor, { action, entity, entityId, summary, before, after, changes }) {
  const user = actor && actor.user ? actor.user : actor || SYSTEM;
  let detail = changes;
  if (!detail && before && after) detail = diff(before, after);
  else if (!detail && (before || after)) detail = before ? { before } : { after };
  await trx('audit_log').insert({
    at: now(),
    user_id: user.id || null,
    user_name: user.name || user.email || 'System',
    action,
    entity,
    entity_id: entityId || null,
    summary: String(summary).slice(0, 400),
    changes: detail && Object.keys(detail).length ? JSON.stringify(detail) : null,
    ip: actor && actor.ip ? String(actor.ip).slice(0, 64) : null
  });
}

module.exports = { audit, diff, SYSTEM };
