import {
  api, app, can, state, esc, money, pill, shortDate, dateTime, table, toast, openSheet, closeSheet, val, field,
  selectField, plusDays, today, sheetBody, setSaveLabel
} from '../core.js';
import { documentHtml, documentForm, emailSheet, pdfLink } from './docs.js';

let current = null;

const FILTERS = [['', 'All'], ['unpaid', 'Unpaid'], ['part-paid', 'Part paid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['cancelled', 'Cancelled']];

export const routes = {
  invoices: {
    title: (id) => (id && current ? current.number : 'Invoices'),
    permission: 'invoices:read',
    async render(id, query) {
      if (id) return detail(id);
      const status = query.status || '';
      const clientId = query.client || '';
      const params = new URLSearchParams({ ...(status ? { status } : {}), ...(clientId ? { clientId } : {}) });
      const list = await api(`/invoices?${params}`);
      const client = clientId ? state.clients.find((c) => c.id === clientId) : null;
      const write = can('invoices:write');
      const tabHref = (key) => {
        const p = new URLSearchParams({ ...(key ? { status: key } : {}), ...(clientId ? { client: clientId } : {}) }).toString();
        return `#/invoices${p ? `?${p}` : ''}`;
      };
      return `
        <div class="head"><h1>Invoices</h1>${client ? `<p>for ${esc(client.name)} · <a href="#/invoices${status ? `?status=${status}` : ''}">show everyone</a></p>` : ''}<div class="spacer"></div>
          <div class="actions">
            ${can('import:run') ? '<a class="ghost button-link" href="#/import">Import opening balances</a>' : ''}
            ${write ? '<button class="solid" data-act="new-invoice">New invoice</button>' : ''}
          </div></div>
        <nav class="tabs" aria-label="Filter invoices">
          ${FILTERS.map(([key, label]) => `<a href="${tabHref(key)}" ${key === status ? 'aria-current="true"' : ''}>${label}</a>`).join('')}
        </nav>
        <section class="sheet-block">
          ${list.length ? table('Invoices', [['Number'], ['Client'], ['Due'], ['Status'], ['Total', 'right'], ['Balance', 'right'], ['']], list.map((i) => `<tr>
              <td class="num"><a href="#/invoices/${esc(i.id)}">${esc(i.number)}</a><div class="sub">${shortDate(i.date)}${i.recurringId ? ' · repeats' : ''}</div></td>
              <td>${esc(i.clientName)}</td>
              <td class="num sub ${i.status === 'overdue' ? 'late' : ''}">${shortDate(i.dueDate)}</td>
              <td>${pill(i.status)}</td>
              <td class="right num">${i.currency !== state.currencies.base ? `<span class="sub">${esc(i.currency)}</span> ` : ''}${money(i.total)}</td>
              <td class="right num strong">${money(i.balance)}</td>
              <td class="actions">
                <a class="link" href="#/invoices/${esc(i.id)}" aria-label="Open ${esc(i.number)}">Open</a>
                ${i.balance > 0 && can('payments:write') ? `<button class="link" data-act="pay" data-id="${esc(i.id)}" aria-label="Record payment for ${esc(i.number)}">Record payment</button>` : ''}
              </td></tr>`).join(''))
          : `<div class="empty"><p>${status ? 'No invoices with that status.' : 'No invoices yet. Bill a client directly, or convert an accepted quotation.'}</p>
              ${write && !status ? '<button class="solid" data-act="new-invoice">New invoice</button>' : ''}</div>`}
        </section>`;
    }
  }
};

async function detail(id) {
  const i = await api(`/invoices/${id}`);
  current = i;
  const live = i.status !== 'cancelled';
  const owing = live && i.balance > 0;
  const send = can('invoices:send');

  return `
    <div class="head"><h1>${esc(i.number)}</h1><p>${esc(i.clientName)}</p><div class="spacer"></div>
      <div class="actions no-print">
        <a class="ghost button-link" href="#/invoices">All invoices</a>
        ${pdfLink('invoice', i.id)}
        ${send && live ? '<button class="ghost" data-act="email-invoice">Email</button>' : ''}
        ${owing && send ? '<button class="ghost" data-act="remind">Send reminder</button>' : ''}
        ${owing && i.currency === 'KES' && can('mpesa:request') ? '<button class="ghost" data-act="stk">Request M-Pesa</button>' : ''}
        ${owing && can('payments:write') ? `<button class="solid" data-act="pay" data-id="${esc(i.id)}">Record payment</button>` : ''}
      </div></div>

    ${i.quotationId ? `<p class="sub no-print" style="margin-top:-12px">Made from a quotation — <a href="#/quotations/${esc(i.quotationId)}">view it</a>.</p>` : ''}
    ${i.recurringId ? `<p class="sub no-print" style="margin-top:-12px">Created by a <a href="#/recurring">recurring schedule</a>.</p>` : ''}

    ${documentHtml('invoice', i, i.company, i.client)}

    ${i.payments.length ? `<h2 class="section-title">Payments</h2><section class="sheet-block">
      ${table('Payments against this invoice', [['Date'], ['Method'], ['Reference'], ['Recorded by'], ['Amount', 'right'], ['']], i.payments.map((p) => `<tr>
        <td class="num sub">${shortDate(p.date)}</td>
        <td>${esc(p.method)}${p.source === 'mpesa' ? ' <span class="sub">(automatic)</span>' : ''}</td>
        <td class="num sub">${esc(p.reference || '—')}</td>
        <td class="sub">${esc(p.by || '—')}</td>
        <td class="right num ${p.reversed ? 'struck' : 'strong'}">${money(p.amount)}</td>
        <td class="actions">${p.reversed ? `<span class="sub">Reversed: ${esc(p.reversalReason)}</span>` : can('payments:write') ? `<button class="link danger" data-act="reverse" data-id="${esc(p.id)}" data-label="${esc(`${i.currency} ${money(p.amount)} ${p.method}`)}">Reverse</button>` : ''}</td>
      </tr>`).join(''))}</section>` : ''}

    ${i.mpesaRequests.length ? `<h2 class="section-title">M-Pesa requests</h2><section class="sheet-block">
      ${table('M-Pesa payment requests', [['Sent'], ['Phone'], ['Amount', 'right'], ['Result']], i.mpesaRequests.map((r) => `<tr>
        <td class="num sub">${dateTime(r.createdAt)}</td><td class="num">${esc(r.phone)}</td>
        <td class="right num">${money(r.amount)}</td>
        <td>${pill(r.status)} ${r.resultDesc && r.status !== 'paid' ? `<span class="sub">${esc(r.resultDesc)}</span>` : ''}
          ${r.status === 'pending' ? `<button class="link" data-act="stk-check" data-id="${esc(r.id)}">Check status</button>` : ''}</td>
      </tr>`).join(''))}</section>` : ''}

    ${i.messages.length ? `<h2 class="section-title">Sent to the client</h2><section class="sheet-block">
      ${table('Messages sent about this invoice', [['When'], ['What'], ['To'], ['Status']], i.messages.map((m) => `<tr>
        <td class="num sub">${dateTime(m.at)}</td><td>${m.purpose === 'reminder' ? 'Reminder' : 'Invoice'} by ${m.channel === 'sms' ? 'SMS' : 'email'}</td>
        <td class="sub">${esc(m.to)}</td><td>${pill(m.status)}${m.error ? ` <span class="sub">${esc(m.error)}</span>` : ''}</td>
      </tr>`).join(''))}</section>` : ''}

    ${i.history && i.history.length ? `<h2 class="section-title">History</h2><section class="sheet-block">
      ${table('Changes to this invoice and its payments', [['When'], ['Who'], ['What']], i.history.map((e) => `<tr>
        <td class="num sub">${dateTime(e.at)}</td><td>${esc(e.userName)}</td><td>${esc(e.summary)}</td></tr>`).join(''))}</section>` : ''}

    <div class="no-print" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px">
      ${live && i.kind !== 'opening' && can('recurring:write') && !i.recurringId ? '<button class="ghost" data-act="make-recurring">Repeat this invoice…</button>' : ''}
      ${live && can('invoices:write') ? `<button class="ghost danger" data-act="cancel-invoice">Cancel invoice</button>` : ''}
    </div>`;
}

/* ---------- M-Pesa STK push ---------- */

let poll = null;
const stopPolling = () => { clearTimeout(poll); poll = null; };

function stkWaiting(request) {
  setSaveLabel('', true);
  sheetBody().innerHTML = `<div class="stk-wait" role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <p class="big">Check the phone ending ${esc(request.phone.slice(-3))}</p>
    <p class="sub">The customer should see a prompt to pay KES ${money(request.amount)} and enter their M-Pesa PIN. This updates by itself.</p>
    <p><button type="button" class="link" data-act="stk-check" data-id="${esc(request.id)}">Check status now</button></p>
  </div>`;
  const started = Date.now();
  const tick = async () => {
    try {
      const r = await api(`/mpesa/stk/${request.id}`);
      if (r.status !== 'pending') return stkDone(r);
      if (Date.now() - started > 120000) {
        sheetBody().querySelector('.big').textContent = 'Still waiting for M-Pesa…';
        return;
      }
    } catch { /* keep trying */ }
    poll = setTimeout(tick, 3000);
  };
  poll = setTimeout(tick, 3000);
}

function stkDone(r) {
  stopPolling();
  setSaveLabel('', true);
  const paid = r.status === 'paid';
  sheetBody().innerHTML = `<div class="stk-wait" role="${paid ? 'status' : 'alert'}">
    <p class="big ${paid ? '' : 'late'}">${paid ? `Paid — KES ${money(r.amount)} received` : "The payment didn't go through"}</p>
    <p class="sub">${paid ? 'It has been recorded against the invoice.' : esc(r.resultDesc || 'M-Pesa reported a failure.')}</p>
  </div>`;
  document.getElementById('sheetCancel').textContent = 'Close';
  if (paid) app.render();
}

export const actions = {
  'new-invoice': () => documentForm('invoice'),
  'email-invoice': () => emailSheet('invoice', current, current.client, () => app.render()),

  stk: () => {
    const suggested = Math.ceil(current.balance);
    openSheet(`Request M-Pesa payment for ${current.number}`, `
      <p class="sub" style="margin-top:0">The customer gets a prompt on their phone to pay the paybill. When they enter their PIN, the payment records itself here.</p>
      <div class="row">
        ${field('Safaricom number', 'phone', { type: 'tel', value: current.client?.phone || '', attrs: 'autocomplete="tel" inputmode="tel"' })}
        ${field('Amount (KES)', 'amount', { type: 'number', value: suggested, attrs: 'min="1" step="1"', hint: `Whole shillings. Balance is ${money(current.balance)}.` })}
      </div>`,
    async () => {
      const r = await api('/mpesa/stk', 'POST', { invoiceId: current.id, phone: val('phone'), amount: val('amount') });
      stkWaiting(r.request);
    }, 'Send request', { onClose: stopPolling });
  },

  'stk-check': async (el) => {
    const r = await api(`/mpesa/stk/${el.dataset.id}/check`, 'POST');
    if (document.getElementById('sheet').open) {
      if (r.status === 'pending') toast('Still waiting for the customer.');
      else stkDone(r);
    } else {
      toast(r.status === 'pending' ? 'Still waiting for the customer.' : r.status === 'paid' ? 'Paid.' : r.resultDesc || 'Failed.', r.status === 'failed');
      app.render();
    }
  },

  remind: () => openSheet(`Send a reminder for ${current.number}`, `
    <p class="sub" style="margin-top:0">Balance ${esc(current.currency)} ${money(current.balance)}, due ${shortDate(current.dueDate)}.</p>
    ${selectField('Send by', 'channel', [
      ['email', `Email${current.client?.email ? ` to ${current.client.email}` : ' (no email on file)'}`],
      ['sms', `SMS${current.client?.phone ? ` to ${current.client.phone}` : ' (no phone on file)'}`]
    ], current.client?.email ? 'email' : 'sms')}`,
  async () => {
    const r = await api(`/invoices/${current.id}/remind`, 'POST', { channel: val('channel') });
    closeSheet();
    if (r.status === 'failed') toast(`Couldn't send to ${r.to}. See Reminders → Messages for the reason.`, true);
    else toast(r.status === 'logged' ? `Reminder to ${r.to} written to the server log (not connected).` : `Reminder sent to ${r.to}.`);
    app.render();
  }, 'Send reminder'),

  'make-recurring': () => openSheet(`Repeat ${current.number}`, `
    <p class="sub" style="margin-top:0">A new invoice with the same lines, discount and VAT is created on each date. You can pause or change it any time under Recurring.</p>
    <div class="row">
      ${selectField('How often', 'frequency', [['monthly', 'Every month'], ['weekly', 'Every week'], ['quarterly', 'Every 3 months'], ['yearly', 'Every year']], 'monthly')}
      ${field('Next invoice on', 'nextDate', { type: 'date', value: nextMonth(current.date), attrs: `min="${plusDays(1)}"` })}
    </div>
    <div class="row">
      ${field('Payment due after (days)', 'dueDays', { type: 'number', value: 14, attrs: 'min="0" max="365" step="1"' })}
      ${field('Stop after (optional)', 'endDate', { type: 'date' })}
    </div>
    <label class="check"><input type="checkbox" name="autoEmail" ${current.client?.email ? 'checked' : ''}> Email each new invoice to ${esc(current.client?.email || 'the client')} automatically</label>`,
  async () => {
    await api('/recurring', 'POST', {
      fromInvoiceId: current.id, frequency: val('frequency'), nextDate: val('nextDate'),
      dueDays: val('dueDays'), endDate: val('endDate') || null, autoEmail: val('autoEmail')
    });
    closeSheet();
    toast(`${current.clientName} will be billed automatically.`);
    app.go('#/recurring');
  }, 'Start repeating'),

  'cancel-invoice': async () => {
    if (!confirm(`Cancel ${current.number}? It stays on record as cancelled, and any stock on it is put back.`)) return;
    await api(`/invoices/${current.id}/cancel`, 'POST');
    toast(`${current.number} cancelled.`);
    app.render();
  }
};

function nextMonth(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  let year = y;
  let month = m + 1;
  while (true) {
    if (month > 12) { month = 1; year += 1; }
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const candidate = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
    if (candidate > today()) return candidate;
    month += 1;
  }
}
