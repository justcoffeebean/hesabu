/* The account button in the rail: change password, sign out. */
import { api, app, state, openSheet, closeSheet, val, toast, esc } from '../core.js';

export const actions = {
  account: () => openSheet(`Signed in as ${state.me.name}`, `
    <p class="sub" style="margin-top:0">${esc(state.me.email)} · <span style="text-transform:capitalize">${esc(state.me.role)}</span></p>
    <fieldset><legend>Change password</legend>
      <div class="field"><label for="a-current">Current password</label><input id="a-current" name="currentPassword" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="a-new">New password</label><input id="a-new" name="newPassword" type="password" autocomplete="new-password" aria-describedby="a-new-hint">
        <p class="hint" id="a-new-hint">At least 10 characters. Changing it signs you out on your other devices.</p></div>
    </fieldset>
    <button type="button" class="ghost danger" data-act="sign-out">Sign out</button>`,
  async () => {
    if (!val('currentPassword') && !val('newPassword')) return closeSheet();
    await api('/auth/password', 'POST', { currentPassword: val('currentPassword'), newPassword: val('newPassword') });
    closeSheet();
    toast('Password changed.');
  }, 'Change password', { cancelLabel: 'Close' }),

  'sign-out': async () => {
    closeSheet();
    await api('/auth/logout', 'POST');
    app.signOut();
  }
};
