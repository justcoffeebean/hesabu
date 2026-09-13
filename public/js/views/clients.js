import { api, app, can, state, esc, money, table, toast, openSheet, closeSheet, val, field, selectField, currencyOptions, loadReference } from '../core.js';

let clients = [];

export const routes = {
  clients: {
    title: 'Clients',
    permission: 'clients:read',
    async render() {
      await loadReference();
      clients = await api('/clients');
      state.clients = clients;
      const write = can('clients:write');
      return `
        <div class="head"><h1>Clients</h1><div class="spacer"></div>
          <div class="actions">
            ${can('import:run') ? '<a class="ghost button-link" href="#/import">Import from CSV</a>' : ''}
            ${write ? '<button class="solid" data-act="new-client">Add client</button>' : ''}
          </div></div>
        <section class="sheet-block">
          ${clients.length ? table('Clients', [['Name'], ['Contact'], ['M-Pesa account'], ['Outstanding', 'right'], ['']], clients.map((c) => {
            const byCur = Object.entries(c.outstandingByCurrency || {});
            return `<tr>
              <td><a class="strong" href="#/invoices?client=${esc(c.id)}" aria-label="${esc(c.name)} — see their invoices">${esc(c.name)}</a><div class="sub">${esc(c.address)}</div></td>
              <td class="sub">${esc(c.email || '—')}<br>${esc(c.phone)}</td>
              <td class="num">${esc(c.accountCode || '—')}${c.currency !== state.currencies.base ? `<div class="sub">bills in ${esc(c.currency)}</div>` : ''}${c.reminders ? '' : '<div class="sub">no reminders</div>'}</td>
              <td class="right num ${c.outstanding > 0 ? 'strong' : 'sub'}">${byCur.length ? byCur.map(([cur, amt]) => `${cur !== state.currencies.base ? `<span class="sub">${esc(cur)}</span> ` : ''}${money(amt)}`).join('<br>') : money(0)}</td>
              <td class="actions">
                ${write ? `<button class="link" data-act="edit-client" data-id="${esc(c.id)}" aria-label="Edit ${esc(c.name)}">Edit</button>
                <button class="link danger" data-act="del-client" data-id="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">Remove</button>` : ''}
              </td></tr>`;
          }).join(''))
          : `<div class="empty"><p>No clients yet. Add the first one to start quoting.</p>
              ${write ? '<button class="solid" data-act="new-client">Add client</button>' : ''}</div>`}
        </section>`;
    }
  }
};

function clientForm(c = {}) {
  return `
    ${field('Name', 'name', { value: c.name || '', attrs: 'placeholder="Acme Hardware Ltd"' })}
    <div class="row">
      ${field('Email', 'email', { type: 'email', value: c.email || '' })}
      ${field('Phone', 'phone', { type: 'tel', value: c.phone || '', attrs: 'placeholder="0722 123 456"' })}
    </div>
    ${field('Address', 'address', { value: c.address || '' })}
    <div class="row">
      ${field('KRA PIN (optional)', 'kraPin', { value: c.kraPin || '' })}
      ${field('M-Pesa account code (optional)', 'accountCode', { value: c.accountCode || '', attrs: 'placeholder="ACME" autocapitalize="characters"', hint: 'If they pay your paybill with this as the account number, the money is matched to their oldest invoices.' })}
    </div>
    <div class="row">
      ${selectField('Bills in', 'currency', currencyOptions(), c.currency || state.currencies.base, { hint: 'The default for new quotations and invoices.' })}
      <div class="field"><span class="label">Reminders</span>
        <label class="check"><input type="checkbox" name="reminders" ${c.reminders === false ? '' : 'checked'}> Send automatic payment reminders</label></div>
    </div>`;
}

const readForm = () => ({
  name: val('name'), email: val('email'), phone: val('phone'), address: val('address'),
  kraPin: val('kraPin'), accountCode: val('accountCode'), currency: val('currency'), reminders: val('reminders')
});

export const actions = {
  'new-client': async () => {
    await loadReference();
    openSheet('Add client', clientForm(), async () => {
      await api('/clients', 'POST', readForm());
      closeSheet();
      toast('Client added.');
      app.render();
    }, 'Add client');
  },

  'edit-client': (el) => {
    const c = clients.find((x) => x.id === el.dataset.id);
    openSheet(`Edit ${c.name}`, clientForm(c), async () => {
      await api(`/clients/${c.id}`, 'PUT', { ...readForm(), version: c.version });
      closeSheet();
      toast('Client saved.');
      app.render();
    }, 'Save changes');
  },

  'del-client': async (el) => {
    const c = clients.find((x) => x.id === el.dataset.id);
    if (!confirm(`Remove ${c.name}?`)) return;
    await api(`/clients/${c.id}`, 'DELETE');
    toast('Client removed.');
    app.render();
  }
};
