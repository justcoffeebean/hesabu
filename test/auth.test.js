const h = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let app;
before(async () => { app = await h.start(); });
after(() => app.stop());

test('everything under /api needs a session, except sign-in itself', async () => {
  const anon = h.client(app.base);
  assert.equal((await anon.get('/api/invoices')).status, 401);
  assert.equal((await anon.get('/api/dashboard')).status, 401);
  assert.deepEqual((await anon.get('/api/auth/status')).data, { needsSetup: true, signedIn: false });
});

test('first-run setup needs the console code and only works once', async () => {
  const c = h.client(app.base);
  const wrong = await c.post('/api/auth/setup', { name: 'X', email: 'x@test.co.ke', password: 'long-enough-pw', setupCode: 'NOPE' });
  assert.equal(wrong.status, 403);

  const weak = await c.post('/api/auth/setup', { name: 'X', email: 'x@test.co.ke', password: 'short', setupCode: 'TESTCODE' });
  assert.equal(weak.status, 400);

  const ok = await c.post('/api/auth/setup', { name: 'Amina', email: 'Owner@Test.co.ke', password: 'owner-password-1', setupCode: 'testcode', companyName: 'Test Traders' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.role, 'owner');
  assert.equal(ok.data.email, 'owner@test.co.ke');
  assert.match(c.cookie, /^hesabu_session=/);
  assert.equal((await c.get('/api/settings')).data.name, 'Test Traders');

  const again = await h.client(app.base).post('/api/auth/setup', { name: 'Evil', email: 'evil@test.co.ke', password: 'evil-password-1', setupCode: 'TESTCODE' });
  assert.equal(again.status, 409);
});

test('sign in, sign out, and the cookie is HttpOnly + SameSite', async () => {
  const c = h.client(app.base);
  const bad = await c.post('/api/auth/login', { email: 'owner@test.co.ke', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  const unknown = await c.post('/api/auth/login', { email: 'nobody@test.co.ke', password: 'wrong-password' });
  assert.equal(unknown.status, 401);
  assert.equal(bad.data.error, unknown.data.error, 'same message whether or not the email exists');

  const res = await c.post('/api/auth/login', { email: 'OWNER@test.co.ke ', password: 'owner-password-1' });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.equal((await c.get('/api/auth/me')).status, 200);

  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('the session token is stored hashed, not as-is', async () => {
  const c = h.client(app.base);
  await c.post('/api/auth/login', { email: 'owner@test.co.ke', password: 'owner-password-1' });
  const raw = c.cookie.split('=')[1];
  assert.equal(await h.db.knex('sessions').where({ id: raw }).first(), undefined);
  assert.ok(await h.db.knex('sessions').where({ id: require('../src/auth').sha256(raw) }).first());
});

test('repeated wrong passwords are slowed down', async () => {
  const c = h.client(app.base);
  let last;
  for (let i = 0; i < 9; i++) last = await c.post('/api/auth/login', { email: 'brute@test.co.ke', password: `guess-${i}-xxxxx` });
  assert.equal(last.status, 429);
});

test('invite link → set password → signed in; link works once', async () => {
  const owner = h.client(app.base);
  await owner.post('/api/auth/login', { email: 'owner@test.co.ke', password: 'owner-password-1' });
  const invite = await owner.post('/api/users', { name: 'Wanjiru', email: 'wanjiru@test.co.ke', role: 'accounts' });
  assert.equal(invite.status, 201);
  assert.match(invite.data.link, /^https:\/\/hesabu\.example\.com\/#\/link\//);

  const token = invite.data.link.split('/#/link/')[1];
  const c = h.client(app.base);
  assert.deepEqual((await c.get(`/api/auth/link/${token}`)).data, { purpose: 'invite', email: 'wanjiru@test.co.ke', name: 'Wanjiru' });
  const set = await c.post(`/api/auth/link/${token}`, { password: 'wanjiru-password-1' });
  assert.equal(set.status, 200);
  assert.equal((await c.get('/api/auth/me')).data.role, 'accounts');
  assert.equal((await h.client(app.base).post(`/api/auth/link/${token}`, { password: 'another-password-1' })).status, 410);

  // The invite email body (with the link) is not readable by other users.
  const msgs = await owner.get('/api/messages');
  assert.ok(msgs.data.messages.every((m) => m.purpose !== 'invite'));
});

test('roles: staff and accounts are held to their permissions', async () => {
  const { staff, accounts, owner } = { ...(await teamFromScratch()) };
  const { invoice } = await h.basics(owner);

  assert.equal((await staff.post('/api/payments', { invoiceId: invoice.id, amount: 10 })).status, 403);
  assert.equal((await staff.get('/api/payments')).status, 403);
  assert.equal((await staff.post(`/api/invoices/${invoice.id}/cancel`)).status, 403);
  assert.equal((await staff.get('/api/audit')).status, 403);
  assert.equal((await staff.get('/api/tasks')).status, 200);
  assert.equal((await staff.post('/api/tasks', { title: 'Deliver drums' })).status, 201);
  assert.equal((await staff.get(`/api/invoices/${invoice.id}`)).status, 200);

  assert.equal((await accounts.post('/api/payments', { invoiceId: invoice.id, amount: 10 })).status, 201);
  assert.equal((await accounts.get('/api/users')).status, 403);
  assert.equal((await accounts.put('/api/settings', { name: 'Hijack', vatRate: 16 })).status, 403);
  assert.equal((await accounts.get('/api/audit')).status, 200);
});

async function teamFromScratch() {
  const owner = h.client(app.base);
  await owner.post('/api/auth/login', { email: 'owner@test.co.ke', password: 'owner-password-1' });
  const make = async (email, role) => {
    const r = await owner.post('/api/users', { name: role, email, role });
    const c = h.client(app.base);
    await c.post(`/api/auth/link/${r.data.link.split('/#/link/')[1]}`, { password: `${role}-password-12` });
    return c;
  };
  return { owner, staff: await make(`staff${Date.now()}@test.co.ke`, 'staff'), accounts: await make(`acc${Date.now()}@test.co.ke`, 'accounts') };
}

test('switching a user off ends their sessions; the last owner is protected', async () => {
  const { owner, staff } = await teamFromScratch();
  const me = (await staff.get('/api/auth/me')).data;
  assert.equal((await owner.put(`/api/users/${me.id}`, { active: false })).status, 200);
  assert.equal((await staff.get('/api/auth/me')).status, 401);

  const ownerMe = (await owner.get('/api/auth/me')).data;
  const demote = await owner.put(`/api/users/${ownerMe.id}`, { role: 'accounts' });
  assert.equal(demote.status, 400);
  assert.match(demote.data.error, /only owner/);
});

test('changing your password signs out your other sessions', async () => {
  const a = h.client(app.base);
  const b = h.client(app.base);
  await a.post('/api/auth/login', { email: 'owner@test.co.ke', password: 'owner-password-1' });
  await b.post('/api/auth/login', { email: 'owner@test.co.ke', password: 'owner-password-1' });
  assert.equal((await a.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'owner-password-2' })).status, 400);
  assert.equal((await a.post('/api/auth/password', { currentPassword: 'owner-password-1', newPassword: 'owner-password-2' })).status, 204);
  assert.equal((await a.get('/api/auth/me')).status, 200);
  assert.equal((await b.get('/api/auth/me')).status, 401);
  await a.post('/api/auth/password', { currentPassword: 'owner-password-2', newPassword: 'owner-password-1' });
});

test('cross-site requests that change data are refused', async () => {
  const c = h.client(app.base);
  await c.post('/api/auth/login', { email: 'owner@test.co.ke', password: 'owner-password-1' });
  const evil = await c.post('/api/tasks', { title: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const same = await c.post('/api/tasks', { title: 'x' }, { Origin: app.base });
  assert.equal(same.status, 201);
});

test('security headers are set', async () => {
  const res = await fetch(app.base + '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('sign-ins, failures and team changes are in the audit log', async () => {
  const owner = h.client(app.base);
  await owner.post('/api/auth/login', { email: 'owner@test.co.ke', password: 'owner-password-1' });
  const { entries } = (await owner.get('/api/audit?entity=user&limit=500')).data;
  const actions = new Set(entries.map((e) => e.action));
  for (const a of ['setup', 'login', 'login-failed', 'create', 'update', 'password']) assert.ok(actions.has(a), `missing ${a}`);
});
