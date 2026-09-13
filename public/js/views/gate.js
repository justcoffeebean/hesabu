/* Signed-out screens: sign in, first-run setup, and choosing a password from an invite or reset link. */
import { api, app, esc } from '../core.js';

const gate = document.getElementById('gate');

function show(html, onSubmit) {
  document.getElementById('shell').hidden = true;
  gate.hidden = false;
  gate.innerHTML = `<main class="gate-card">
    <div class="mark"><span class="mark-glyph" aria-hidden="true">h</span><span class="mark-name">Hesabu</span></div>
    ${html}</main>`;
  const form = gate.querySelector('form');
  const error = gate.querySelector('.form-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    error.textContent = '';
    try {
      const data = Object.fromEntries(new FormData(form));
      await onSubmit(data);
    } catch (err) {
      error.textContent = err.message;
      const first = form.querySelector('input[aria-invalid], input');
      if (first) first.focus();
    } finally {
      button.disabled = false;
    }
  });
  const first = form.querySelector('input');
  if (first) first.focus();
}

const input = (label, name, type = 'text', attrs = '') =>
  `<div class="field"><label for="g-${name}">${label}</label><input id="g-${name}" name="${name}" type="${type}" ${attrs}></div>`;

export function showSignIn() {
  document.title = 'Sign in · Hesabu';
  show(`
    <h1>Sign in</h1>
    <p class="lede">Use the email your Hesabu owner added you with.</p>
    <form novalidate>
      ${input('Email', 'email', 'email', 'autocomplete="username" required')}
      ${input('Password', 'password', 'password', 'autocomplete="current-password" required')}
      <p class="form-error" role="alert"></p>
      <button type="submit" class="solid">Sign in</button>
    </form>
    <p class="hint" style="margin-top:16px">Forgot your password? Ask the owner to send you a reset link from Team.</p>`,
  async (data) => {
    const me = await api('/auth/login', 'POST', { email: data.email, password: data.password });
    await app.enter(me);
  });
}

export function showSetup() {
  document.title = 'Set up · Hesabu';
  show(`
    <h1>Set up Hesabu</h1>
    <p class="lede">You'll be the owner: you can add your team and choose what each person can do.</p>
    <form novalidate>
      ${input('Business name', 'companyName', 'text', 'autocomplete="organization"')}
      ${input('Your name', 'name', 'text', 'autocomplete="name" required')}
      ${input('Your email', 'email', 'email', 'autocomplete="email" required')}
      <div class="field"><label for="g-password">Password</label>
        <input id="g-password" name="password" type="password" autocomplete="new-password" minlength="10" required aria-describedby="g-pw-hint">
        <p class="hint" id="g-pw-hint">At least 10 characters. A short sentence works well.</p></div>
      <div class="field"><label for="g-setupCode">Setup code</label>
        <input id="g-setupCode" name="setupCode" autocomplete="one-time-code" required aria-describedby="g-code-hint" class="num">
        <p class="hint" id="g-code-hint">Printed in the terminal where the server is running. It proves you're the person who installed it.</p></div>
      <p class="form-error" role="alert"></p>
      <button type="submit" class="solid">Create owner account</button>
    </form>`,
  async (data) => {
    const me = await api('/auth/setup', 'POST', data);
    await app.enter(me);
  });
}

export async function showLink(token) {
  document.title = 'Choose a password · Hesabu';
  let info;
  try {
    info = await api(`/auth/link/${encodeURIComponent(token || '')}`);
  } catch (err) {
    show(`<h1>Link not valid</h1><p class="lede">${esc(err.message)}</p>
      <form novalidate><p class="form-error" role="alert"></p><button type="submit" class="solid">Go to sign in</button></form>`,
    async () => { location.hash = ''; showSignIn(); });
    return;
  }
  show(`
    <h1>${info.purpose === 'invite' ? `Welcome, ${esc(info.name)}` : 'Choose a new password'}</h1>
    <p class="lede">You'll sign in as <b>${esc(info.email)}</b>.</p>
    <form novalidate>
      <input type="email" name="username" value="${esc(info.email)}" autocomplete="username" hidden>
      <div class="field"><label for="g-password">New password</label>
        <input id="g-password" name="password" type="password" autocomplete="new-password" minlength="10" required aria-describedby="g-pw-hint">
        <p class="hint" id="g-pw-hint">At least 10 characters.</p></div>
      ${input('Type it again', 'confirm', 'password', 'autocomplete="new-password" required')}
      <p class="form-error" role="alert"></p>
      <button type="submit" class="solid">Save password and continue</button>
    </form>`,
  async (data) => {
    if (data.password !== data.confirm) throw new Error("The two passwords don't match.");
    const me = await api(`/auth/link/${encodeURIComponent(token)}`, 'POST', { password: data.password });
    history.replaceState(null, '', '#/today');
    await app.enter(me);
  });
}
