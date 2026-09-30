/** Team management (owner only): invite people, change roles, switch accounts off, send reset links, two-step sign-in. */
const express = require('express');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const { allow } = auth;
const { ROLES } = require('../permissions');
const { audit } = require('../audit');
const { fail } = require('../errors');
const { text, email, oneOf } = require('../validate');
const messages = require('../services/messages');
const settings = require('../settings');

const router = express.Router();
const LINK_HOURS = { invite: 72, reset: 24 };

/**
 * Where links in emails point. PUBLIC_URL when set (it must be in production).
 * Otherwise the address the owner's own browser is on — taken from Origin,
 * which sameOrigin() has already matched to this server — never from a bare
 * Host header, which anyone can set to their own domain.
 */
function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const origin = req.get('origin');
  if (!origin) fail(400, 'Set PUBLIC_URL in .env so sign-in links point at the right address.');
  return new URL(origin).origin;
}

/** Creates a one-time link, and emails it when email is set up. The owner always sees the link to share another way. */
async function issueLink(trx, req, user, purpose) {
  const raw = auth.token();
  await trx('password_tokens').where({ user_id: user.id }).whereNull('used_at').del();
  await trx('password_tokens').insert({
    id: auth.sha256(raw), user_id: user.id, purpose, created_by: req.user.id, created_at: db.now(),
    expires_at: new Date(Date.now() + LINK_HOURS[purpose] * 3600000).toISOString()
  });
  const link = `${baseUrl(req)}/#/link/${raw}`;
  let emailed = null;
  if (messages.channelReady('email')) {
    const company = await require('../settings').company(trx);
    emailed = await messages.queue(trx, req, {
      channel: 'email', to: user.email, purpose: 'invite',
      subject: purpose === 'invite' ? `You've been added to ${company.name} on Hesabu` : `Reset your Hesabu password`,
      body: `Hello ${user.name},\n\n${purpose === 'invite'
        ? `${req.user.name} has added you to ${company.name} on Hesabu. Choose a password to get started:`
        : `${req.user.name} sent you a link to set a new password:`}\n\n${link}\n\nThe link works once and expires in ${LINK_HOURS[purpose]} hours.`
    });
  }
  return { link, expiresInHours: LINK_HOURS[purpose], emailed };
}

const userOut = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, active: Boolean(u.active),
  hasPassword: Boolean(u.password_hash), twoStep: Boolean(u.totp_secret), lastLoginAt: u.last_login_at || null, createdAt: u.created_at
});

router.get('/users', allow('users:manage'), async (_req, res) => {
  res.json((await db.knex('users').orderBy('name')).map(userOut));
});

router.post('/users', allow('users:manage'), async (req, res) => {
  const name = text(req.body?.name, 120);
  const address = email(req.body?.email);
  if (!name) fail(400, 'Enter their name.');
  if (!address) fail(400, 'Enter their email address. They sign in with it.');
  const role = oneOf(req.body?.role, ROLES, 'Role');

  const out = await db.tx(async (trx) => {
    if (await trx('users').where({ email: address }).first()) fail(409, `${address} is already on the team.`);
    const user = { id: db.newId(), email: address, name, role, active: true, created_at: db.now() };
    await trx('users').insert(user);
    const link = await issueLink(trx, req, user, 'invite');
    await audit(trx, req, { action: 'create', entity: 'user', entityId: user.id, summary: `Invited ${name} (${address}) as ${role}` });
    return { user: userOut(user), ...link };
  });
  if (out.emailed) messages.kick(out.emailed);
  res.status(201).json({ ...out, emailed: Boolean(out.emailed) && messages.channelStatus().email === 'smtp' });
});

router.put('/users/:id', allow('users:manage'), async (req, res) => {
  const out = await db.tx(async (trx) => {
    const user = await db.lock(trx('users').where({ id: req.params.id })).first();
    if (!user) fail(404, 'User not found.');
    const patch = {};
    if (req.body.name !== undefined) patch.name = text(req.body.name, 120) || user.name;
    if (req.body.role !== undefined) patch.role = oneOf(req.body.role, ROLES, 'Role');
    if (req.body.active !== undefined) patch.active = Boolean(req.body.active);

    // Never leave the business without an active owner.
    const losingOwner = user.role === 'owner' && user.active && ((patch.role && patch.role !== 'owner') || patch.active === false);
    if (losingOwner) {
      const owners = await trx('users').where({ role: 'owner', active: true }).whereNot({ id: user.id }).count({ n: '*' }).first();
      if (!Number(owners.n)) fail(400, 'This is the only owner. Make someone else an owner first.');
    }

    await trx('users').where({ id: user.id }).update({ ...patch, updated_at: db.now() });
    if (patch.active === false || (patch.role && patch.role !== user.role)) {
      await trx('sessions').where({ user_id: user.id }).del(); // new permissions apply from their next sign-in
    }
    const after = await trx('users').where({ id: user.id }).first();
    const what = patch.active === false ? 'Switched off' : patch.active === true && !user.active ? 'Switched on' : 'Updated';
    await audit(trx, req, { action: 'update', entity: 'user', entityId: user.id, summary: `${what} ${after.name}`, before: userOut(user), after: userOut(after) });
    return userOut(after);
  });
  res.json(out);
});

router.post('/users/:id/reset-link', allow('users:manage'), async (req, res) => {
  const out = await db.tx(async (trx) => {
    const user = await trx('users').where({ id: req.params.id }).first();
    if (!user) fail(404, 'User not found.');
    if (!user.active) fail(400, 'Switch this account on first.');
    const link = await issueLink(trx, req, user, user.password_hash ? 'reset' : 'invite');
    await audit(trx, req, { action: 'reset-link', entity: 'user', entityId: user.id, summary: `Sent ${user.name} a ${user.password_hash ? 'password reset' : 'new invite'} link` });
    return link;
  });
  if (out.emailed) messages.kick(out.emailed);
  res.json({ ...out, emailed: Boolean(out.emailed) && messages.channelStatus().email === 'smtp' });
});

/** Lost phone: turn two-step off for someone so they can sign in with just their password and set it up again. */
router.post('/users/:id/two-step/reset', allow('users:manage'), async (req, res) => {
  if (req.params.id === req.user.id) fail(400, 'Turn your own two-step sign-in off from your account, or ask another owner.');
  const out = await db.tx(async (trx) => {
    const user = await db.lock(trx('users').where({ id: req.params.id })).first();
    if (!user) fail(404, 'User not found.');
    if (!user.totp_secret) fail(400, `${user.name} doesn't have two-step sign-in on.`);
    await trx('users').where({ id: user.id }).update({
      totp_secret: null, totp_pending: null, totp_last_step: null, totp_recovery: null, totp_enabled_at: null, updated_at: db.now()
    });
    await trx('sessions').where({ user_id: user.id }).del();
    await audit(trx, req, { action: 'two-step', entity: 'user', entityId: user.id, summary: `Turned off two-step sign-in for ${user.name}` });
    return userOut(await trx('users').where({ id: user.id }).first());
  });
  res.json(out);
});

/* ---------- business-wide sign-in rules ---------- */

router.get('/team/security', allow('users:manage'), async (_req, res) => {
  res.json(await settings.security());
});

router.put('/team/security', allow('users:manage'), async (req, res) => {
  const requireTwoStep = Boolean(req.body?.requireTwoStep);
  // Otherwise the owner switching it on would be the first person locked behind it.
  if (requireTwoStep && !req.user.twoStep) fail(400, 'Turn on two-step sign-in for yourself first (your name, bottom left).');
  const out = await db.tx(async (trx) => {
    const before = await settings.security(trx);
    const after = { ...before, requireTwoStep };
    await db.putSetting(trx, 'security', after);
    await audit(trx, req, {
      action: 'update', entity: 'settings',
      summary: requireTwoStep ? 'Required two-step sign-in for owner and accounts' : 'Made two-step sign-in optional', before, after
    });
    return after;
  });
  res.json(out);
});

module.exports = router;
