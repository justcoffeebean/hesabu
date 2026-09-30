const h = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../src/auth');
const config = require('../src/config');
const totp = require('../src/totp');

let app;
let team;
before(async () => {
  app = await h.start();
  team = await h.team(app.base);
});
after(() => app.stop());

const from = (ip) => ({ 'X-Forwarded-For': ip });

/* ---------- limits in the database ---------- */

test('failure counts live in the database: a restart or a second server sees them', async () => {
  const first = auth.limiter('t-shared', 3);
  await first.hit('k');
  await first.hit('k');
  const second = auth.limiter('t-shared', 3); // what a fresh process builds
  assert.equal(await second.hits('k'), 2);
  await second.hit('k');
  assert.equal(await first.blocked('k'), true);
});

test('failures arriving at the same moment are all counted', async () => {
  const l = auth.limiter('t-race', 1000);
  await Promise.all(Array.from({ length: 25 }, () => l.hit('k')));
  assert.equal(await l.hits('k'), 25);
});

test('an old window starts over, and pruning removes it', async () => {
  const l = auth.limiter('t-old', 3);
  for (let i = 0; i < 3; i++) await l.hit('k');
  await h.db.knex('rate_limits').where({ bucket: 't-old:k' }).update({ window_start: Date.now() - auth.WINDOW_MS - 1000 });
  assert.equal(await l.blocked('k'), false);
  await l.hit('k');
  assert.equal(await l.hits('k'), 1, 'a new window, not 4');
  await h.db.knex('rate_limits').where({ bucket: 't-old:k' }).update({ window_start: Date.now() - auth.WINDOW_MS - 1000 });
  await auth.prune();
  assert.equal(await h.db.knex('rate_limits').where({ bucket: 't-old:k' }).first(), undefined);
});

test('a burst of parallel guesses gets exactly the allowance, not one per request', async () => {
  const guesses = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    h.client(app.base).post('/api/auth/login', { email: 'burst@test.co.ke', password: `guess-${i}-xxxxx` }, from('192.0.2.50'))));
  const counts = guesses.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  assert.deepEqual(counts, { 401: 8, 429: 22 });
});

/* ---------- guessing from many addresses ---------- */

test('guesses spread over many addresses pause new devices, not the ones the person already uses', async () => {
  // The real person signs in once from their laptop, so it's a known device.
  const laptop = h.client(app.base);
  assert.equal((await laptop.post('/api/auth/login', { email: 'staff@test.co.ke', password: 'staff-password-1' }, from('10.1.0.1'))).status, 200);
  assert.ok(laptop.jar.get(auth.DEVICE_COOKIE));
  await laptop.post('/api/auth/logout', {}, from('10.1.0.1'));

  // A botnet: one guess each from 20 addresses, so no per-address limit trips.
  for (let i = 0; i < 20; i++) {
    const r = await h.client(app.base).post('/api/auth/login', { email: 'staff@test.co.ke', password: `guess-${i}-xxxxx` }, from(`198.18.0.${i + 1}`));
    assert.equal(r.status, 401);
  }

  // Even the right password from a new device is refused now — and before the password is checked.
  const stranger = await h.client(app.base).post('/api/auth/login', { email: 'staff@test.co.ke', password: 'staff-password-1' }, from('198.18.1.1'));
  assert.equal(stranger.status, 429);
  assert.match(stranger.data.error, /new devices is paused/);

  // The laptop still gets in.
  const back = await laptop.post('/api/auth/login', { email: 'staff@test.co.ke', password: 'staff-password-1' }, from('10.1.0.1'));
  assert.equal(back.status, 200);

  // An email that doesn't exist pauses the same way, so the message reveals nothing.
  for (let i = 0; i < 20; i++) await h.client(app.base).post('/api/auth/login', { email: 'ghost@test.co.ke', password: 'guess-xxxxxxx' }, from(`198.19.0.${i + 1}`));
  const ghost = await h.client(app.base).post('/api/auth/login', { email: 'ghost@test.co.ke', password: 'guess-xxxxxxx' }, from('198.19.1.1'));
  assert.equal(ghost.status, 429);
  assert.equal(ghost.data.error, stranger.data.error);
});

test('a made-up device cookie is not a known device', async () => {
  const c = h.client(app.base);
  c.jar.set(auth.DEVICE_COOKIE, 'a'.repeat(43));
  const r = await c.post('/api/auth/login', { email: 'staff@test.co.ke', password: 'staff-password-1' }, from('198.18.2.1'));
  assert.equal(r.status, 429);
});

/* ---------- two-step sign-in ---------- */

async function enrol(c, password, ip = '10.2.0.1') {
  const started = await c.post('/api/auth/two-step/start', { password }, from(ip));
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.match(started.data.uri, /^otpauth:\/\/totp\/.+\?secret=[A-Z2-7]+&issuer=/);
  const enabled = await c.post('/api/auth/two-step/enable', { code: totp.codeAt(started.data.secret, totp.stepAt()) }, from(ip));
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  return { secret: started.data.secret, recovery: enabled.data.recoveryCodes, me: enabled.data.me };
}

test('turning on two-step: password first, a code from the app confirms it, recovery codes shown once', async () => {
  const c = h.client(app.base);
  await c.post('/api/auth/login', { email: 'accounts@test.co.ke', password: 'accounts-password-1' }, from('10.2.0.1'));
  const other = h.client(app.base);
  await other.post('/api/auth/login', { email: 'accounts@test.co.ke', password: 'accounts-password-1' }, from('10.2.0.2'));

  assert.equal((await c.post('/api/auth/two-step/start', { password: 'wrong-password-x' }, from('10.2.0.1'))).status, 400);
  const started = await c.post('/api/auth/two-step/start', { password: 'accounts-password-1' }, from('10.2.0.1'));
  const wrong = await c.post('/api/auth/two-step/enable', { code: '000000' }, from('10.2.0.1'));
  assert.equal(wrong.status, 400);
  assert.equal((await c.get('/api/auth/me')).data.twoStep, false, 'not on until a right code');

  const enabled = await c.post('/api/auth/two-step/enable', { code: totp.codeAt(started.data.secret, totp.stepAt()) }, from('10.2.0.1'));
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.recoveryCodes.length, 10);
  assert.equal(enabled.data.me.twoStep, true);
  assert.equal(enabled.data.me.recoveryCodesLeft, 10);

  // The other browser signed in without a code, so it's signed out; this one stays in.
  assert.equal((await other.get('/api/auth/me')).status, 401);
  assert.equal((await c.get('/api/auth/me')).status, 200);

  // Stored as hashes, never the codes themselves.
  const row = await h.db.knex('users').where({ email: 'accounts@test.co.ke' }).first();
  assert.ok(!row.totp_recovery.includes(enabled.data.recoveryCodes[0]));
  assert.equal(row.totp_pending, null);
});

test('signing in with two-step: code needed, a code works once, recovery codes work once', async () => {
  const { totp_secret: secret } = await h.db.knex('users').where({ email: 'accounts@test.co.ke' }).first();
  const creds = { email: 'accounts@test.co.ke', password: 'accounts-password-1' };

  const noCode = await h.client(app.base).post('/api/auth/login', creds, from('10.3.0.1'));
  assert.equal(noCode.status, 401);
  assert.equal(noCode.data.needsCode, true);
  assert.equal(noCode.headers.get('set-cookie'), null, 'no session without the code');

  const bad = await h.client(app.base).post('/api/auth/login', { ...creds, code: '123456' }, from('10.3.0.1'));
  assert.equal(bad.status, 401);
  assert.equal(bad.data.needsCode, true);

  // The step used when enabling is spent, so use the next one (still inside the ±1 window).
  const code = totp.codeAt(secret, totp.stepAt() + 1);
  const ok = h.client(app.base);
  assert.equal((await ok.post('/api/auth/login', { ...creds, code }, from('10.3.0.1'))).status, 200);
  const replay = await h.client(app.base).post('/api/auth/login', { ...creds, code }, from('10.3.0.2'));
  assert.equal(replay.status, 401, 'a code seen over a shoulder cannot be reused');

  assert.equal((await h.client(app.base).post('/api/auth/two-step/start', {}, from('10.3.0.4'))).status, 401, 'two-step endpoints need a session');
});

test('recovery codes: sign in once each, and the count goes down', async () => {
  // A fresh person so the time-step bookkeeping from other tests doesn't matter. Any case, with or without the dash.
  const owner = team.owner;
  const made = await owner.post('/api/users', { name: 'Njeri', email: 'njeri@test.co.ke', role: 'accounts' });
  const c = h.client(app.base);
  await c.post(`/api/auth/link/${made.data.link.split('/#/link/')[1]}`, { password: 'njeri-password-1' });
  const { recovery } = await enrol(c, 'njeri-password-1');

  const creds = { email: 'njeri@test.co.ke', password: 'njeri-password-1' };
  const used = recovery[0].toLowerCase().replace('-', '');
  const first = await h.client(app.base).post('/api/auth/login', { ...creds, code: used }, from('10.4.0.1'));
  assert.equal(first.status, 200);
  assert.equal(first.data.recoveryCodesLeft, 9);
  assert.equal((await h.client(app.base).post('/api/auth/login', { ...creds, code: recovery[0] }, from('10.4.0.2'))).status, 401);

  const log = await h.db.knex('audit_log').where({ action: 'login', entity_id: first.data.id }).orderBy('id', 'desc').first();
  assert.match(log.summary, /with a recovery code/);
});

test('turning two-step off needs the password and a current code', async () => {
  const made = await team.owner.post('/api/users', { name: 'Otieno', email: 'otieno@test.co.ke', role: 'staff' });
  const c = h.client(app.base);
  await c.post(`/api/auth/link/${made.data.link.split('/#/link/')[1]}`, { password: 'otieno-password-1' });
  const { secret, recovery } = await enrol(c, 'otieno-password-1');

  assert.equal((await c.post('/api/auth/two-step/disable', { password: 'otieno-password-1', code: '000000' })).status, 400);
  assert.equal((await c.post('/api/auth/two-step/disable', { password: 'wrong-password-x', code: recovery[0] })).status, 400);

  const newCodes = await c.post('/api/auth/two-step/recovery-codes', { password: 'otieno-password-1', code: recovery[1] });
  assert.equal(newCodes.status, 200);
  assert.equal(newCodes.data.recoveryCodes.length, 10);
  assert.equal((await c.post('/api/auth/two-step/disable', { password: 'otieno-password-1', code: recovery[2] })).status, 400, 'old codes are replaced');

  const off = await c.post('/api/auth/two-step/disable', { password: 'otieno-password-1', code: totp.codeAt(secret, totp.stepAt() + 1) });
  assert.equal(off.status, 200);
  assert.equal(off.data.twoStep, false);
  assert.equal((await h.client(app.base).post('/api/auth/login', { email: 'otieno@test.co.ke', password: 'otieno-password-1' }, from('10.5.0.1'))).status, 200);
});

test('wrong two-step codes on a signed-in session share the password budget', async () => {
  const made = await team.owner.post('/api/users', { name: 'Kamau', email: 'kamau@test.co.ke', role: 'staff' });
  const c = h.client(app.base);
  await c.post(`/api/auth/link/${made.data.link.split('/#/link/')[1]}`, { password: 'kamau-password-1' });
  await enrol(c, 'kamau-password-1');
  let last;
  for (let i = 0; i < 9; i++) last = await c.post('/api/auth/two-step/disable', { password: 'kamau-password-1', code: String(100000 + i) });
  assert.equal(last.status, 429, 'knowing the password does not buy unlimited code guesses');
});

test('a reset link sets a new password but still asks for the two-step code', async () => {
  const made = await team.owner.post('/api/users', { name: 'Achieng', email: 'achieng@test.co.ke', role: 'staff' });
  const c = h.client(app.base);
  await c.post(`/api/auth/link/${made.data.link.split('/#/link/')[1]}`, { password: 'achieng-password-1' });
  const { secret } = await enrol(c, 'achieng-password-1');

  const reset = await team.owner.post(`/api/users/${made.data.user.id}/reset-link`);
  const token = reset.data.link.split('/#/link/')[1];
  const d = h.client(app.base);
  assert.equal((await d.get(`/api/auth/link/${token}`)).data.twoStep, true);
  const noCode = await d.post(`/api/auth/link/${token}`, { password: 'achieng-password-2' });
  assert.equal(noCode.status, 400);
  assert.equal(noCode.data.needsCode, true);
  const badCode = await d.post(`/api/auth/link/${token}`, { password: 'achieng-password-2', code: '000000' });
  assert.equal(badCode.status, 400);
  assert.equal(badCode.data.badCode, undefined, 'internal flag is not sent');
  const ok = await d.post(`/api/auth/link/${token}`, { password: 'achieng-password-2', code: totp.codeAt(secret, totp.stepAt() + 1) });
  assert.equal(ok.status, 200);
});

test('the owner can reset two-step for someone who lost their phone, but not for themselves', async () => {
  const made = await team.owner.post('/api/users', { name: 'Mwangi', email: 'mwangi@test.co.ke', role: 'staff' });
  const c = h.client(app.base);
  await c.post(`/api/auth/link/${made.data.link.split('/#/link/')[1]}`, { password: 'mwangi-password-1' });
  await enrol(c, 'mwangi-password-1');
  assert.equal((await team.owner.get('/api/users')).data.find((u) => u.id === made.data.user.id).twoStep, true);

  assert.equal((await team.staff.post(`/api/users/${made.data.user.id}/two-step/reset`)).status, 403);
  const ownerId = (await team.owner.get('/api/auth/me')).data.id;
  assert.equal((await team.owner.post(`/api/users/${ownerId}/two-step/reset`)).status, 400);

  const r = await team.owner.post(`/api/users/${made.data.user.id}/two-step/reset`);
  assert.equal(r.status, 200);
  assert.equal(r.data.twoStep, false);
  assert.equal((await c.get('/api/auth/me')).status, 401, 'their sessions end');
  assert.equal((await h.client(app.base).post('/api/auth/login', { email: 'mwangi@test.co.ke', password: 'mwangi-password-1' }, from('10.6.0.1'))).status, 200);
});

test('requiring two-step for owner and accounts: enrol before anything else works', async () => {
  const owner = team.owner;
  const refused = await owner.put('/api/team/security', { requireTwoStep: true });
  assert.equal(refused.status, 400, 'the owner turns it on for themselves first');

  await enrol(owner, 'owner-password-1', '10.7.0.1');
  // Turning on two-step signed out the owner's other sessions; team.owner is the one that enrolled, so it's still in.
  assert.equal((await owner.put('/api/team/security', { requireTwoStep: true })).data.requireTwoStep, true);

  // Someone in accounts without two-step: signed in, but held at enrolment.
  const made = await owner.post('/api/users', { name: 'Wairimu', email: 'wairimu@test.co.ke', role: 'accounts' });
  const c = h.client(app.base);
  const set = await c.post(`/api/auth/link/${made.data.link.split('/#/link/')[1]}`, { password: 'wairimu-password-1' });
  assert.equal(set.data.mustEnrol, true);
  const blocked = await c.get('/api/invoices');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.enrolTwoStep, true);
  assert.equal((await c.get('/api/auth/me')).status, 200);

  const { secret } = await enrol(c, 'wairimu-password-1', '10.7.0.2');
  assert.equal((await c.get('/api/invoices')).status, 200);
  const off = await c.post('/api/auth/two-step/disable', { password: 'wairimu-password-1', code: totp.codeAt(secret, totp.stepAt() + 1) });
  assert.equal(off.status, 400);
  assert.match(off.data.error, /requires two-step/);

  // Staff aren't covered by the rule.
  assert.equal((await team.staff.get('/api/tasks')).status, 200);

  assert.equal((await owner.put('/api/team/security', { requireTwoStep: false })).data.requireTwoStep, false);
  assert.equal((await team.accounts.get('/api/invoices')).status, 401, 'accounts was signed out earlier when they turned two-step on');
});

/* ---------- where sign-in links point ---------- */

test('without PUBLIC_URL, links use the browser\'s own address, never a bare Host header', async (t) => {
  const saved = config.publicUrl;
  t.after(() => { config.publicUrl = saved; });
  config.publicUrl = '';

  const noOrigin = await team.owner.post('/api/users', { name: 'Evil Host', email: 'evilhost@test.co.ke', role: 'staff' }, { Host: 'attacker.example' });
  assert.equal(noOrigin.status, 400);
  assert.match(noOrigin.data.error, /PUBLIC_URL/);

  const withOrigin = await team.owner.post('/api/users', { name: 'Good Host', email: 'goodhost@test.co.ke', role: 'staff' }, { Origin: app.base });
  assert.equal(withOrigin.status, 201);
  assert.ok(withOrigin.data.link.startsWith(`${app.base}/#/link/`));

  // A forged Origin doesn't get past sameOrigin in the first place.
  const forged = await team.owner.post('/api/users', { name: 'Forged', email: 'forged@test.co.ke', role: 'staff' }, { Origin: 'https://attacker.example' });
  assert.equal(forged.status, 403);
});

test('the server refuses to start in production without a sound PUBLIC_URL', (t) => {
  const saved = { publicUrl: config.publicUrl, production: config.production };
  t.after(() => Object.assign(config, saved));

  Object.assign(config, { production: true, publicUrl: '' });
  assert.match(config.problems().join(), /Set PUBLIC_URL/);
  Object.assign(config, { production: true, publicUrl: 'hesabu.example.com' });
  assert.match(config.problems().join(), /full http\(s\) address/);
  Object.assign(config, { production: true, publicUrl: 'https://hesabu.example.com/app' });
  assert.match(config.problems().join(), /no path/);
  Object.assign(config, { production: true, publicUrl: 'https://hesabu.example.com' });
  assert.deepEqual(config.problems(), []);
  Object.assign(config, { production: false, publicUrl: '' });
  assert.deepEqual(config.problems(), [], 'fine on your own computer');
});
