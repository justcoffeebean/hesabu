/* Setting up two-step sign-in, in the dialog: password → add to the app → type a code → save recovery codes. */
import { api, openSheet, closeSheet, sheetBody, setSaveLabel, val, esc, copyToClipboard } from './core.js';

/** Groups a base32 key in fours so it's easier to type into an app: "ABCD EFGH …". */
const grouped = (key) => key.replace(/(.{4})/g, '$1 ').trim();

function showRecovery(codes, intro) {
  setSaveLabel("I've saved them");
  document.getElementById('sheetCancel').hidden = true;
  sheetBody().innerHTML = `
    <p style="margin-top:0">${intro}</p>
    <p>If you lose your phone, each of these codes lets you sign in once instead of the 6-digit code.
      <b>Save them somewhere safe now</b> (a password manager, or printed and locked away). They won't be shown again.</p>
    <ol class="recovery-codes num" id="recoveryCodes">${codes.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
    <button type="button" class="ghost" id="copyRecovery">Copy codes</button>`;
  document.getElementById('copyRecovery').onclick = () => copyToClipboard(codes.join('\n'));
}

/** However the dialog closes (button, ×, Escape), put Cancel back and, if the change happened, report it. */
function whenClosed(changed, onDone) {
  return () => {
    document.getElementById('sheetCancel').hidden = false;
    const result = changed();
    if (result) Promise.resolve(onDone(result)).catch(() => {});
  };
}

/** Opens the set-up dialog. onDone(me) runs once two-step is on and the codes are acknowledged. */
export function enrolTwoStep(onDone) {
  let me = null;
  let step = 'password';

  openSheet('Turn on two-step sign-in', `
    <p style="margin-top:0">After your password, Hesabu will also ask for a 6-digit code from an app on your phone,
      so a stolen password alone can't get in.</p>
    <p class="hint">Any authenticator app works: Google Authenticator, Microsoft Authenticator, Authy, 1Password…</p>
    <div class="field"><label for="ts-password">Your password</label>
      <input id="ts-password" name="password" type="password" autocomplete="current-password"></div>`,
  async () => {
    if (step === 'password') {
      const r = await api('/auth/two-step/start', 'POST', { password: val('password') });
      step = 'code';
      setSaveLabel('Turn on');
      sheetBody().innerHTML = `
        <p style="margin-top:0"><b>1.</b> In your authenticator app, add an account and choose <i>Enter a setup key</i>.</p>
        <div class="field"><label for="ts-key">Setup key (time based)</label>
          <div class="link-box"><input id="ts-key" readonly value="${esc(grouped(r.secret))}" class="num">
          <button type="button" class="ghost" id="copyKey">Copy</button></div>
          <p class="hint">On this phone? <a href="${esc(r.uri)}">Open it in your authenticator app</a> instead.</p></div>
        <p><b>2.</b> Type the 6-digit code the app shows.</p>
        <div class="field"><label for="ts-code">Code from the app</label>
          <input id="ts-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" class="num"></div>`;
      document.getElementById('copyKey').onclick = () => copyToClipboard(r.secret);
      document.getElementById('ts-code').focus();
      return;
    }
    if (step === 'code') {
      const r = await api('/auth/two-step/enable', 'POST', { code: val('code') });
      me = r.me;
      step = 'codes';
      showRecovery(r.recoveryCodes, 'Two-step sign-in is on. Your other devices have been signed out.');
      return;
    }
    closeSheet();
  }, 'Continue', { onClose: whenClosed(() => me, onDone) });
}

/** Password + current code, then a fresh set of recovery codes. */
export function newRecoveryCodes(onDone) {
  let made = false;
  openSheet('New recovery codes', `
    <p style="margin-top:0">This replaces your old recovery codes; they stop working.</p>
    <div class="field"><label for="rc-password">Your password</label>
      <input id="rc-password" name="password" type="password" autocomplete="current-password"></div>
    <div class="field"><label for="rc-code">Code from your authenticator app</label>
      <input id="rc-code" name="code" inputmode="numeric" autocomplete="one-time-code" class="num"></div>`,
  async () => {
    if (made) return closeSheet();
    const r = await api('/auth/two-step/recovery-codes', 'POST', { password: val('password'), code: val('code') });
    made = true;
    showRecovery(r.recoveryCodes, 'Here are your new recovery codes.');
  }, 'Make new codes', { onClose: whenClosed(() => made, onDone) });
}

export function disableTwoStep(onDone) {
  openSheet('Turn off two-step sign-in', `
    <p style="margin-top:0">Your password alone will be enough to sign in.</p>
    <div class="field"><label for="td-password">Your password</label>
      <input id="td-password" name="password" type="password" autocomplete="current-password"></div>
    <div class="field"><label for="td-code">Code from your authenticator app (or a recovery code)</label>
      <input id="td-code" name="code" autocomplete="one-time-code" class="num"></div>`,
  async () => {
    const me = await api('/auth/two-step/disable', 'POST', { password: val('password'), code: val('code') });
    closeSheet();
    await onDone(me);
  }, 'Turn off');
}
