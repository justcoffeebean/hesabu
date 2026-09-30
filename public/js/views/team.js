import { api, app, state, esc, dateTime, table, toast, openSheet, closeSheet, val, field, selectField, copyToClipboard, sheetBody, setSaveLabel } from '../core.js';

let users = [];
let security = { requireTwoStep: false };

const ROLES = [
  ['staff', 'Staff — jobs, quotations, stock counts, M-Pesa requests'],
  ['accounts', 'Accounts — clients, invoices, payments, reminders, imports'],
  ['owner', 'Owner — everything, including team and settings']
];

export const routes = {
  team: {
    title: 'Team',
    permission: 'users:manage',
    async render() {
      [users, security] = await Promise.all([api('/users'), api('/team/security')]);
      return `
        <div class="head"><h1>Team</h1><p>Everyone who can sign in to Hesabu</p><div class="spacer"></div>
          <button class="solid" data-act="invite">Add someone</button></div>
        <section class="sheet-block">
          ${table('Team members', [['Name'], ['Role'], ['Last signed in'], ['Two-step'], ['Status'], ['']], users.map((u) => `<tr>
            <td><span class="strong">${esc(u.name)}</span>${u.id === state.me.id ? ' <span class="sub">(you)</span>' : ''}<div class="sub">${esc(u.email)}</div></td>
            <td style="text-transform:capitalize">${esc(u.role)}</td>
            <td class="num sub">${u.lastLoginAt ? dateTime(u.lastLoginAt) : u.hasPassword ? 'Never' : 'Invite not accepted'}</td>
            <td>${u.twoStep ? '<span class="pill active">on</span>' : `<span class="pill ${security.requireTwoStep && u.role !== 'staff' ? 'off' : ''}">off</span>`}</td>
            <td>${u.active ? '<span class="pill active">active</span>' : '<span class="pill off">switched off</span>'}</td>
            <td class="actions">
              <button class="link" data-act="edit-user" data-id="${esc(u.id)}" aria-label="Edit ${esc(u.name)}">Edit</button>
              ${u.twoStep && u.id !== state.me.id ? `<button class="link" data-act="reset-two-step" data-id="${esc(u.id)}" aria-label="Reset two-step sign-in for ${esc(u.name)}">Reset two-step</button>` : ''}
              ${u.active ? `<button class="link" data-act="reset-link" data-id="${esc(u.id)}" aria-label="${u.hasPassword ? 'Password reset link' : 'New invite link'} for ${esc(u.name)}">${u.hasPassword ? 'Reset password' : 'Resend invite'}</button>` : ''}
              ${u.id !== state.me.id ? `<button class="link ${u.active ? 'danger' : ''}" data-act="toggle-user" data-id="${esc(u.id)}" aria-label="${u.active ? 'Switch off' : 'Switch on'} ${esc(u.name)}">${u.active ? 'Switch off' : 'Switch on'}</button>` : ''}
            </td></tr>`).join(''))}
        </section>
        <p class="lede" style="margin-top:14px">Switching someone off signs them out straight away. Their name stays on everything they did.</p>
        <section class="sheet-block" style="margin-top:18px" aria-labelledby="sec-h">
          <h2 id="sec-h">Sign-in rules</h2>
          <div class="pad"><label class="check"><input type="checkbox" data-act="require-two-step" ${security.requireTwoStep ? 'checked' : ''}>
            Require two-step sign-in for owners and accounts</label>
          <p class="hint">They handle the money, so a stolen password shouldn't be enough. Anyone in those roles without it
            is asked to set it up the next time they use Hesabu. ${state.me.twoStep ? '' : 'Turn it on for yourself first (your name, bottom left).'}</p></div>
        </section>`;
    }
  }
};

function showLink(result, name) {
  setSaveLabel('', true);
  document.getElementById('sheetCancel').textContent = 'Done';
  sheetBody().innerHTML = `
    <p style="margin-top:0">${result.emailed ? `We've emailed ${esc(name)} this link.` : `Email isn't connected, so send ${esc(name)} this link yourself (WhatsApp, SMS…).`}
      It works once and expires in ${result.expiresInHours} hours.</p>
    <div class="link-box"><label class="sr-only" for="inviteLink">Sign-in link</label>
      <input id="inviteLink" readonly value="${esc(result.link)}">
      <button type="button" class="ghost" data-act="copy-link">Copy</button></div>`;
  sheetBody().querySelector('#inviteLink').select();
}

export const actions = {
  invite: () => openSheet('Add someone to the team', `
    <div class="row">${field('Name', 'name')}${field('Email', 'email', { type: 'email' })}</div>
    ${selectField('What they can do', 'role', ROLES, 'staff')}
    <p class="hint">They'll get a link to choose their own password.</p>`,
  async () => {
    const r = await api('/users', 'POST', { name: val('name'), email: val('email'), role: val('role') });
    showLink(r, r.user.name);
    app.render();
  }, 'Add and get link'),

  'copy-link': () => copyToClipboard(document.getElementById('inviteLink').value),

  'edit-user': (el) => {
    const u = users.find((x) => x.id === el.dataset.id);
    openSheet(`Edit ${u.name}`, `
      ${field('Name', 'name', { value: u.name })}
      ${selectField('What they can do', 'role', ROLES, u.role, { hint: 'A role change takes effect the next time they sign in.' })}`,
    async () => {
      await api(`/users/${u.id}`, 'PUT', { name: val('name'), role: val('role') });
      closeSheet();
      toast('Saved.');
      if (u.id === state.me.id && val('role') !== u.role) location.reload();
      app.render();
    }, 'Save');
  },

  'reset-link': async (el) => {
    const u = users.find((x) => x.id === el.dataset.id);
    openSheet(u.hasPassword ? `Reset ${u.name}'s password` : `New invite for ${u.name}`, '<p>Creating a link…</p>', null, '', { hideSave: true });
    try {
      const r = await api(`/users/${u.id}/reset-link`, 'POST');
      showLink(r, u.name);
    } catch (err) {
      closeSheet();
      throw err;
    }
  },

  'reset-two-step': async (el) => {
    const u = users.find((x) => x.id === el.dataset.id);
    if (!confirm(`Turn off two-step sign-in for ${u.name}? Do this when they've lost their phone and their recovery codes. They're signed out, then sign in with just their password and can set it up again.`)) return;
    await api(`/users/${u.id}/two-step/reset`, 'POST');
    toast(`Two-step sign-in is off for ${u.name}.`);
    app.render();
  },

  'require-two-step': async (el) => {
    const on = el.checked;
    try {
      await api('/team/security', 'PUT', { requireTwoStep: on });
      toast(on ? 'Two-step sign-in is now required for owners and accounts.' : 'Two-step sign-in is now optional.');
    } finally {
      app.render();
    }
  },

  'toggle-user': async (el) => {
    const u = users.find((x) => x.id === el.dataset.id);
    if (u.active && !confirm(`Switch off ${u.name}? They're signed out immediately and can't sign in until you switch them back on.`)) return;
    await api(`/users/${u.id}`, 'PUT', { active: !u.active });
    toast(u.active ? `${u.name} switched off.` : `${u.name} switched on.`);
    app.render();
  }
};
