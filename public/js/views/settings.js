import { api, app, can, state, esc, shortDate, table, toast, openSheet, closeSheet, val, field, loadReference } from '../core.js';

export const routes = {
  settings: {
    title: 'Settings',
    permission: 'settings:read',
    async render() {
      const owner = can('settings:write');
      const [s, cur, integrations] = await Promise.all([
        api('/settings'), api('/currencies'), owner ? api('/settings/integrations') : Promise.resolve(null)
      ]);
      state.settings = s;
      const dis = owner ? '' : 'readonly';
      return `
        <div class="head"><h1>Settings</h1><p>These details print on every quotation and invoice</p></div>

        <div class="grid-2">
          <section class="sheet-block">
            <h2>Company</h2>
            <form class="pad" id="companyForm" novalidate>
              ${field('Company name', 'name', { value: s.name, attrs: dis })}
              <div class="row">${field('Email', 'email', { type: 'email', value: s.email, attrs: dis })}${field('Phone', 'phone', { value: s.phone, attrs: dis })}</div>
              ${field('Address', 'address', { value: s.address, attrs: dis })}
              <div class="row">
                ${field('KRA PIN', 'kraPin', { value: s.kraPin, attrs: dis })}
                ${field('Default VAT rate (%)', 'vatRate', { type: 'number', value: s.vatRate, attrs: `min="0" max="100" step="0.5" ${dis}` })}
                ${field('Payment terms (days)', 'paymentTerms', { type: 'number', value: s.paymentTerms, attrs: `min="0" max="365" step="1" ${dis}` })}
              </div>
              <div class="field"><label for="f-paymentInstructions">How to pay</label>
                <textarea id="f-paymentInstructions" name="paymentInstructions" ${dis} aria-describedby="f-pi-hint" placeholder="M-Pesa Paybill 400200, account = invoice number&#10;Bank: KCB, A/C 1180 442 901">${esc(s.paymentInstructions)}</textarea>
                <p class="hint" id="f-pi-hint">Printed on unpaid invoices and included in reminders.</p></div>
              ${owner ? '<button type="submit" class="solid">Save company details</button>' : '<p class="sub">Only the owner can change these.</p>'}
            </form>
          </section>

          <section class="sheet-block">
            <h2>Currencies<span class="spacer"></span>${can('currencies:write') ? '<button class="ghost" data-act="add-currency">Add currency</button>' : ''}</h2>
            <p class="pad sub" style="margin:0;padding-bottom:0">Your books are kept in <b>${esc(cur.base)}</b>. Invoices in another currency store the rate on the day they're issued, so later rate changes don't alter them.</p>
            ${cur.currencies.length ? table('Exchange rates', [['Currency'], [`1 unit in ${cur.base}`, 'right'], ['Updated'], ['']], cur.currencies.map((c) => `<tr>
                <td><span class="num strong">${esc(c.code)}</span> <span class="sub">${esc(c.name)}</span></td>
                <td class="right num">${c.rateToBase}</td>
                <td class="num sub">${shortDate(c.updatedAt)}</td>
                <td class="actions">${can('currencies:write') ? `<button class="link" data-act="edit-currency" data-code="${esc(c.code)}" data-name="${esc(c.name)}" data-rate="${c.rateToBase}" aria-label="Update ${esc(c.code)} rate">Update rate</button>
                  <button class="link danger" data-act="del-currency" data-code="${esc(c.code)}" aria-label="Remove ${esc(c.code)}">Remove</button>` : ''}</td></tr>`).join(''))
            : '<div class="empty"><p>Only shillings so far.</p></div>'}
          </section>
        </div>

        ${integrations ? `
          <h2 class="section-title">Connections</h2>
          <p class="lede">Passwords and API keys live in the server's <code>.env</code> file, never in this screen. See the README for each one.</p>
          <div class="grid-2">
            <section class="sheet-block">
              <h2>M-Pesa (Daraja)</h2>
              <div class="pad">
                ${integrations.mpesa.ready
                  ? `<p style="margin-top:0"><span class="pill active">connected</span> ${esc(integrations.mpesa.env)} · ${integrations.mpesa.type === 'till' ? 'till' : 'paybill'} ${esc(integrations.mpesa.shortcode)}</p>
                     <p class="sub">"Request M-Pesa" on an invoice sends a payment prompt to the customer's phone. To have paybill payments customers make on their own recorded automatically, register your confirmation URL with Safaricom once:</p>
                     <button class="ghost" data-act="register-c2b">Register paybill URLs</button>`
                  : `<p style="margin-top:0"><span class="pill off">not set up</span></p><p class="sub">Add your Daraja keys, shortcode, passkey, PUBLIC_URL and MPESA_CALLBACK_SECRET to <code>.env</code> and restart. Until then payments are recorded by hand.</p>`}
              </div>
            </section>
            <section class="sheet-block">
              <h2>Email and SMS</h2>
              <div class="pad">
                <p style="margin-top:0">Email: ${channel(integrations.channels.email)}</p>
                <p>SMS: ${channel(integrations.channels.sms)}</p>
                ${integrations.jobs.length ? `<p class="sub">Last automatic runs: ${integrations.jobs.slice(0, 4).map((j) => `${esc(j.job)} ${esc(j.date)}${j.result && j.result.error ? ' (failed)' : ''}`).join(' · ')}</p>` : '<p class="sub">Automatic jobs haven\'t run yet. They run each morning once the server is up.</p>'}
              </div>
            </section>
          </div>` : ''}`;
    },
    mount(root) {
      const form = root.querySelector('#companyForm');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(form));
        try {
          const saved = await api('/settings', 'PUT', f);
          state.settings = saved;
          document.getElementById('companyName').textContent = saved.name;
          toast('Company details saved.');
        } catch (err) {
          toast(err.message, true);
        }
      });
    }
  }
};

function channel(status) {
  return {
    smtp: '<span class="pill active">connected</span>',
    africastalking: '<span class="pill active">connected</span> (Africa\'s Talking)',
    log: '<span class="pill logged">test mode</span> <span class="sub">— messages are written to the server log, not sent</span>',
    off: '<span class="pill off">not set up</span>'
  }[status] || esc(status);
}

function currencySheet({ code = '', name = '', rate = '' } = {}) {
  const editing = Boolean(code);
  openSheet(editing ? `Update ${code} rate` : 'Add a currency', `
    <div class="row">
      ${field('Code', 'code', { value: code, attrs: `maxlength="3" placeholder="USD" autocapitalize="characters" ${editing ? 'readonly' : ''}` })}
      ${field('Name', 'name', { value: name, attrs: 'placeholder="US dollar"' })}
    </div>
    ${field(`How many ${state.currencies.base} is 1 unit worth?`, 'rate', { type: 'number', value: rate, attrs: 'min="0" step="any"', hint: 'Used for new documents from now on.' })}`,
  async () => {
    await api(`/currencies/${encodeURIComponent(val('code').trim().toUpperCase())}`, 'PUT', { name: val('name'), rateToBase: val('rate') });
    closeSheet();
    await loadReference(true);
    toast('Saved.');
    app.render();
  }, editing ? 'Update rate' : 'Add currency');
}

export const actions = {
  'add-currency': () => currencySheet(),
  'edit-currency': (el) => currencySheet({ code: el.dataset.code, name: el.dataset.name, rate: el.dataset.rate }),
  'del-currency': async (el) => {
    if (!confirm(`Remove ${el.dataset.code}?`)) return;
    await api(`/currencies/${el.dataset.code}`, 'DELETE');
    await loadReference(true);
    toast('Removed.');
    app.render();
  },
  'register-c2b': async () => {
    await api('/settings/mpesa/register-urls', 'POST');
    toast('Registered. Paybill payments will now record themselves.');
  }
};
