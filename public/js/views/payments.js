import { api, app, can, state, esc, money, shortDate, dateTime, table, toast, openSheet, closeSheet, val, field, selectField, today, plural, sheetBody, setSaveLabel } from '../core.js';

let methods = ['M-Pesa', 'Bank transfer', 'Cheque', 'Cash', 'Card', 'Other'];

const COMMAND_STATUS = { pending: ['', 'waiting'], done: ['active', 'done'], failed: ['off', 'failed'], unknown: ['off', 'no answer'] };
const commandPill = (status) => `<span class="pill ${COMMAND_STATUS[status][0]}">${COMMAND_STATUS[status][1]}</span>`;

/** "Refund" link, or where a refund of this receipt has got to. */
function refundCell(t, { refundable }) {
  if (t.refund && ['pending', 'unknown'].includes(t.refund.status)) {
    return `<span class="sub">Refund ${t.refund.status === 'pending' ? 'waiting for Safaricom' : 'unconfirmed'}</span>${t.refund.status === 'unknown' && refundable ? ` <button class="link danger" data-act="refund" data-id="${esc(t.transactionId)}" data-receipt="${esc(t.receipt)}" data-amount="${t.amount}">Try again</button>` : ''}`;
  }
  return refundable ? `<button class="link danger" data-act="refund" data-id="${esc(t.transactionId)}" data-receipt="${esc(t.receipt)}" data-amount="${t.amount}" data-who="${esc(t.who || '')}">Refund</button>` : '';
}

export const routes = {
  payments: {
    title: 'Payments',
    permission: 'payments:read',
    async render() {
      const data = await api('/payments');
      methods = data.methods;
      const live = data.payments.filter((p) => !p.reversed);
      const write = can('payments:write');
      const refunds = can('mpesa:refund') && data.commandsReady;
      return `
        <div class="head"><h1>Payments</h1><p>${plural(live.length, 'payment')} recorded</p>
          <div class="spacer"></div>
          ${write && data.commandsReady ? '<button class="ghost" data-act="lookup">Look up M-Pesa code</button>' : ''}
          ${write ? '<button class="solid" data-act="pay">Record payment</button>' : ''}</div>

        ${data.unallocated.length ? `
          <h2 class="section-title" style="margin-top:0">M-Pesa money waiting to be placed</h2>
          <p class="lede">These came into your paybill with an account number that didn't match an invoice or client code, or were more than was owed. Place each against the invoice it pays.</p>
          <section class="sheet-block" style="margin-bottom:26px">
            ${table('Unmatched M-Pesa receipts', [['Date'], ['From'], ['Account typed'], ['Receipt'], ['Left to place', 'right'], ['']], data.unallocated.map((t) => `<tr>
              <td class="num sub">${shortDate(t.date)}</td>
              <td>${esc(t.payerName || '—')}<div class="sub num">${esc(t.phone || '')}</div></td>
              <td class="num">${esc(t.billRef || '—')}</td>
              <td class="num sub">${esc(t.receipt || 'pending')}</td>
              <td class="right num strong">${money(t.left)}${t.left !== t.amount ? `<div class="sub">of ${money(t.amount)}</div>` : ''}</td>
              <td class="actions">${write && !(t.refund && ['pending', 'unknown'].includes(t.refund.status)) ? `<button class="link" data-act="place" data-id="${esc(t.id)}" data-left="${t.left}" data-label="${esc(`${t.receipt || ''} ${t.payerName || ''}`.trim())}">Place</button>` : ''}
                ${t.receipt ? refundCell({ transactionId: t.id, receipt: t.receipt, amount: t.amount, who: t.payerName || t.phone, refund: t.refund }, { refundable: refunds }) : ''}</td>
            </tr>`).join(''))}
          </section>` : ''}

        <section class="sheet-block">
          ${data.payments.length ? table('Payments received', [['Date'], ['Client'], ['Invoice'], ['Method'], ['Reference'], ['Amount', 'right'], ['']], data.payments.map((p) => `<tr>
              <td class="num sub">${shortDate(p.date)}</td>
              <td>${esc(p.clientName)}</td>
              <td class="num"><a href="#/invoices/${esc(p.invoiceId)}">${esc(p.invoiceNumber)}</a></td>
              <td>${esc(p.method)}${p.source === 'mpesa' ? ' <span class="sub">(auto)</span>' : ''}</td>
              <td class="num sub">${esc(p.reference || '—')}</td>
              <td class="right num ${p.reversed ? 'struck' : 'strong'}">${p.currency !== state.currencies.base ? `<span class="sub">${esc(p.currency)}</span> ` : ''}${money(p.amount)}</td>
              <td class="actions">${p.reversed
                ? `<span class="sub">Reversed by ${esc(p.reversedBy || (p.mpesa?.refunded ? 'M-Pesa' : '—'))}: ${esc(p.reversalReason)}</span>`
                : `${write && !(p.mpesa?.refund && ['pending', 'unknown'].includes(p.mpesa.refund.status)) ? `<button class="link danger" data-act="reverse" data-id="${esc(p.id)}" data-label="${esc(`${p.currency} ${money(p.amount)} on ${p.invoiceNumber}`)}">Reverse</button>` : ''}
                   ${p.mpesa && p.reference && !p.mpesa.refunded ? refundCell({ transactionId: p.mpesa.transactionId, receipt: p.reference, amount: p.mpesa.receiptAmount, who: p.clientName, refund: p.mpesa.refund }, { refundable: refunds }) : ''}`}</td>
            </tr>`).join(''))
          : `<div class="empty"><p>Payments you record against invoices show up here.</p>
              ${write ? '<button class="solid" data-act="pay">Record payment</button>' : ''}</div>`}
        </section>

        ${data.commands.length ? `
          <h2 class="section-title">M-Pesa lookups and refunds</h2>
          <section class="sheet-block">
            ${table('Recent M-Pesa lookups and refunds', [['When'], ['What'], ['Receipt'], ['Status'], ['Result']], data.commands.map((c) => `<tr>
              <td class="num sub">${dateTime(c.createdAt)}</td>
              <td>${c.kind === 'refund' ? `Refund${c.amount !== null ? ` of KES ${money(c.amount)}` : ''}` : 'Lookup'}</td>
              <td class="num">${esc(c.receipt)}</td>
              <td>${commandPill(c.status)}</td>
              <td class="sub">${esc(c.resultDesc || (c.status === 'pending' ? 'Waiting for Safaricom…' : ''))}</td>
            </tr>`).join(''))}
          </section>` : ''}`;
    }
  }
};

async function openInvoices(currency) {
  const list = await api('/invoices?open=1');
  return currency ? list.filter((i) => i.currency === currency) : list;
}

export async function recordPaymentSheet(invoiceId) {
  const invoices = await openInvoices();
  if (!invoices.length) return toast('Nothing is waiting to be paid.', true);
  const picked = invoices.find((i) => i.id === invoiceId) || invoices[0];
  openSheet('Record payment', `
    ${selectField('Against invoice', 'invoiceId', invoices.map((i) => [i.id, `${i.number} — ${i.clientName} — ${i.currency} ${money(i.balance)} due`]), picked.id)}
    <div class="row">
      ${field('Amount', 'amount', { type: 'number', value: picked.balance, attrs: 'min="0.01" step="0.01"' })}
      ${field('Date received', 'date', { type: 'date', value: today(), attrs: `max="${today()}"` })}
    </div>
    <div class="row">
      ${selectField('Method', 'method', methods.map((m) => [m, m]), 'M-Pesa')}
      ${field('Reference', 'reference', { value: '', attrs: 'placeholder="M-Pesa code, cheque no."' })}
    </div>`,
  async () => {
    await api('/payments', 'POST', { invoiceId: val('invoiceId'), amount: val('amount'), method: val('method'), reference: val('reference'), date: val('date') });
    closeSheet();
    toast('Payment recorded.');
    app.render();
  }, 'Record payment');

  const select = document.querySelector('#sheet [name="invoiceId"]');
  select.addEventListener('change', () => {
    const inv = invoices.find((i) => i.id === select.value);
    if (inv) document.querySelector('#sheet [name="amount"]').value = inv.balance;
  });
}

export function reverseSheet(paymentId, label) {
  openSheet('Reverse payment', `
    <p style="margin-top:0">Reverse <b>${esc(label)}</b>? The invoice balance goes back up. The payment stays on record, marked reversed.</p>
    <p class="sub">If it came in through M-Pesa, the money goes back to the "waiting to be placed" list so you can put it on the right invoice.</p>
    ${field('Reason', 'reason', { attrs: 'required placeholder="e.g. Cheque bounced, recorded on the wrong invoice"' })}`,
  async () => {
    await api(`/payments/${paymentId}/reverse`, 'POST', { reason: val('reason') });
    closeSheet();
    toast('Payment reversed.');
    app.render();
  }, 'Reverse payment');
}

/** Asks every 3 seconds until Safaricom answers (usually a few seconds), for up to a minute. */
async function waitForAnswer(id, onDone) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (!document.getElementById('sheet').open) return; // they closed it; the list shows the outcome
    const c = await api(`/mpesa/commands/${id}`);
    if (c.status !== 'pending') return onDone(c);
  }
  onDone(null);
}

function showOutcome(c, doneText) {
  setSaveLabel('', true);
  document.getElementById('sheetCancel').textContent = 'Close';
  sheetBody().innerHTML = c
    ? `<p style="margin-top:0" role="${c.status === 'done' ? 'status' : 'alert'}">${commandPill(c.status)} ${esc(c.resultDesc || doneText)}</p>`
    : '<p style="margin-top:0" role="status">Safaricom hasn\'t answered yet. The result will show under "M-Pesa lookups and refunds" when it does.</p>';
  app.render();
}

export function lookupSheet(invoiceId) {
  return openInvoices('KES').then((invoices) => {
    openSheet('Look up an M-Pesa code', `
      <p style="margin-top:0">For a payment the customer says they made (they have the SMS) that never showed up here. Hesabu asks Safaricom about the code and records it if it paid your paybill or till.</p>
      ${field('M-Pesa code', 'receipt', { attrs: 'required autocomplete="off" maxlength="12" placeholder="e.g. SJ84K2LQ01" class="num" style="text-transform:uppercase"' })}
      ${selectField('Put it on', 'invoiceId', [['', 'Nothing yet: leave it waiting to be placed'], ...invoices.map((i) => [i.id, `${i.number} — ${i.clientName} — KES ${money(i.balance)} due`])], invoiceId || '')}`,
    async () => {
      const c = await api('/mpesa/lookup', 'POST', { receipt: val('receipt'), invoiceId: val('invoiceId') || null });
      setSaveLabel('', true);
      sheetBody().innerHTML = `<p style="margin-top:0" role="status">Asked Safaricom about <b class="num">${esc(c.receipt)}</b>. Waiting for their answer…</p>`;
      waitForAnswer(c.id, (done) => showOutcome(done, 'Done.'));
    }, 'Look it up');
  });
}

function refundSheet(el) {
  const amount = Number(el.dataset.amount);
  openSheet('Refund by M-Pesa', `
    <p style="margin-top:0">Send <b>KES ${money(amount)}</b> (receipt <span class="num">${esc(el.dataset.receipt)}</span>) back to ${esc(el.dataset.who || 'the customer')}.</p>
    <p class="sub">M-Pesa refunds the whole receipt. Once Safaricom confirms, every payment made from it is reversed in the books and those invoices are owed again. This can't be undone from Hesabu.</p>
    ${field('Reason', 'reason', { attrs: 'required maxlength="100" placeholder="e.g. Paid twice, wrong paybill"' })}
    ${field('Your password', 'password', { type: 'password', attrs: 'autocomplete="current-password"' })}
    ${state.me.twoStep ? field('Code from your authenticator app', 'code', { attrs: 'autocomplete="one-time-code" inputmode="numeric" class="num"' }) : ''}`,
  async () => {
    const c = await api(`/mpesa/transactions/${el.dataset.id}/refund`, 'POST', { reason: val('reason'), password: val('password'), code: val('code') || undefined });
    setSaveLabel('', true);
    sheetBody().innerHTML = '<p style="margin-top:0" role="status">Sent to Safaricom. Waiting for them to confirm the refund…</p>';
    app.render();
    waitForAnswer(c.id, (done) => showOutcome(done, 'Refunded.'));
  }, `Refund KES ${money(amount)}`);
}

export const actions = {
  pay: (el) => recordPaymentSheet(el.dataset.id),
  lookup: (el) => lookupSheet(el.dataset.id),
  refund: (el) => refundSheet(el),
  reverse: (el) => reverseSheet(el.dataset.id, el.dataset.label),

  place: async (el) => {
    const invoices = await openInvoices('KES');
    if (!invoices.length) return toast('There are no unpaid shilling invoices to place this against.', true);
    const left = Number(el.dataset.left);
    openSheet('Place M-Pesa payment', `
      <p class="sub" style="margin-top:0">${esc(el.dataset.label)} · KES ${money(left)} to place</p>
      ${selectField('Invoice it pays', 'invoiceId', invoices.map((i) => [i.id, `${i.number} — ${i.clientName} — KES ${money(i.balance)} due`]), invoices[0].id)}
      ${field('Amount', 'amount', { type: 'number', value: Math.min(left, invoices[0].balance), attrs: `min="0.01" max="${left}" step="0.01"`, hint: 'Anything left over stays in the list for another invoice.' })}`,
    async () => {
      const r = await api(`/mpesa/transactions/${el.dataset.id}/allocate`, 'POST', { invoiceId: val('invoiceId'), amount: val('amount') });
      closeSheet();
      toast(r.left ? `Placed KES ${money(r.placed)}. KES ${money(r.left)} still to place.` : `Placed KES ${money(r.placed)}.`);
      app.render();
    }, 'Place payment');
    const select = document.querySelector('#sheet [name="invoiceId"]');
    select.addEventListener('change', () => {
      const inv = invoices.find((i) => i.id === select.value);
      if (inv) document.querySelector('#sheet [name="amount"]').value = Math.min(left, inv.balance);
    });
  }
};
