/* The account button in the rail: change password, two-step sign-in, sign out. */
import { api, app, state, openSheet, closeSheet, val, toast, esc } from '../core.js';
import { enrolTwoStep, disableTwoStep, newRecoveryCodes } from '../twostep.js';

function twoStepBlock() {
  const me = state.me;
  if (!me.twoStep) {
    return `<fieldset><legend>Two-step sign-in</legend>
      <p class="sub" style="margin-top:0"><span class="pill off">off</span> Anyone with your password can sign in as you.</p>
      <p><button type="button" class="ghost" data-act="two-step-on">Turn on</button></p></fieldset>`;
  }
  const low = me.recoveryCodesLeft <= 3;
  return `<fieldset><legend>Two-step sign-in</legend>
    <p class="sub" style="margin-top:0"><span class="pill active">on</span> Sign-in asks for a code from your phone.
      <span class="${low ? 'late' : ''}">${me.recoveryCodesLeft} recovery code${me.recoveryCodesLeft === 1 ? '' : 's'} left.</span></p>
    <p><button type="button" class="ghost" data-act="two-step-codes">New recovery codes</button>
      <button type="button" class="ghost danger" data-act="two-step-off">Turn off</button></p></fieldset>`;
}

const refreshed = async (me, message) => {
  state.me = me || await api('/auth/me');
  toast(message);
};

export const actions = {
  account: () => openSheet(`Signed in as ${state.me.name}`, `
    <p class="sub" style="margin-top:0">${esc(state.me.email)} · <span style="text-transform:capitalize">${esc(state.me.role)}</span></p>
    <fieldset><legend>Change password</legend>
      <div class="field"><label for="a-current">Current password</label><input id="a-current" name="currentPassword" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="a-new">New password</label><input id="a-new" name="newPassword" type="password" autocomplete="new-password" aria-describedby="a-new-hint">
        <p class="hint" id="a-new-hint">At least 10 characters. Changing it signs you out on your other devices.</p></div>
    </fieldset>
    ${twoStepBlock()}
    <button type="button" class="ghost danger" data-act="sign-out">Sign out</button>`,
  async () => {
    if (!val('currentPassword') && !val('newPassword')) return closeSheet();
    await api('/auth/password', 'POST', { currentPassword: val('currentPassword'), newPassword: val('newPassword') });
    closeSheet();
    toast('Password changed.');
  }, 'Change password', { cancelLabel: 'Close' }),

  'two-step-on': () => enrolTwoStep((me) => refreshed(me, 'Two-step sign-in is on.')),
  'two-step-off': () => disableTwoStep((me) => refreshed(me, 'Two-step sign-in is off.')),
  'two-step-codes': () => newRecoveryCodes(() => refreshed(null, 'New recovery codes saved.')),

  'sign-out': async () => {
    closeSheet();
    await api('/auth/logout', 'POST');
    app.signOut();
  }
};
