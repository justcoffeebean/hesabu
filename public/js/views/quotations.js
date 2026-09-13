import { api, app, can, esc, money, pill, shortDate, table, toast, openSheet, closeSheet, val, field, plusDays, today, state } from '../core.js';
import { documentHtml, documentForm, emailSheet, pdfLink, createdToast } from './docs.js';

let current = null;

export const routes = {
  quotations: {
    title: (id) => (id && current ? current.number : 'Quotations'),
    permission: 'quotations:read',
    async render(id) {
      if (id) return detail(id);
      const list = await api('/quotations');
      return `
        <div class="head"><h1>Quotations</h1><div class="spacer"></div>
          ${can('quotations:write') ? '<button class="solid" data-act="new-quote">New quotation</button>' : ''}</div>
        <section class="sheet-block">
          ${list.length ? table('Quotations', [['Number'], ['Client'], ['Valid until'], ['Status'], ['Total', 'right'], ['']], list.map((q) => `<tr>
              <td class="num"><a href="#/quotations/${esc(q.id)}">${esc(q.number)}</a><div class="sub">${shortDate(q.date)}</div></td>
              <td>${esc(q.clientName)}</td>
              <td class="num sub ${!q.invoiceId && q.status !== 'declined' && q.validUntil < today() ? 'late' : ''}">${shortDate(q.validUntil)}</td>
              <td>${pill(q.status)}${q.invoiceId ? ' <span class="sub">invoiced</span>' : ''}</td>
              <td class="right num strong">${q.currency !== state.currencies.base ? `<span class="sub">${esc(q.currency)}</span> ` : ''}${money(q.total)}</td>
              <td class="actions">
                <a class="link" href="#/quotations/${esc(q.id)}" aria-label="Open ${esc(q.number)}">Open</a>
                ${!q.invoiceId && q.status !== 'declined' && can('invoices:write') ? `<button class="link" data-act="convert" data-id="${esc(q.id)}" aria-label="Make invoice from ${esc(q.number)}">Make invoice</button>` : ''}
              </td></tr>`).join(''))
          : `<div class="empty"><p>Quote a job to get it on the books.</p>
              ${can('quotations:write') ? '<button class="solid" data-act="new-quote">New quotation</button>' : ''}</div>`}
        </section>`;
    }
  }
};

async function detail(id) {
  const q = await api(`/quotations/${id}`);
  current = q;
  const client = state.clients.find((c) => c.id === q.clientId);
  const open = !q.invoiceId;
  const write = can('quotations:write');
  return `
    <div class="head"><h1>${esc(q.number)}</h1><p>${esc(q.clientName)}</p><div class="spacer"></div>
      <div class="actions no-print">
        <a class="ghost button-link" href="#/quotations">All quotations</a>
        ${pdfLink('quotation', q.id)}
        ${write && q.status !== 'declined' ? `<button class="ghost" data-act="email-quote">Email</button>` : ''}
        ${write && open ? `<button class="ghost" data-act="edit-quote">Edit</button>` : ''}
        ${write && open && q.status === 'draft' ? `<button class="ghost" data-act="quote-status" data-id="${esc(q.id)}" data-status="sent">Mark sent</button>` : ''}
        ${open && q.status !== 'declined' && can('invoices:write') ? `<button class="solid" data-act="convert" data-id="${esc(q.id)}">Make invoice</button>` : ''}
        ${q.invoiceId ? `<a class="solid" href="#/invoices/${esc(q.invoiceId)}">View invoice</a>` : ''}
      </div></div>
    ${documentHtml('quotation', q, state.settings, client)}
    ${write && open ? `<div class="no-print" style="display:flex;gap:10px;flex-wrap:wrap">
      ${q.status !== 'declined' ? `<button class="ghost danger" data-act="quote-status" data-id="${esc(q.id)}" data-status="declined">Client declined</button>` : `<button class="ghost" data-act="quote-status" data-id="${esc(q.id)}" data-status="accepted">Client changed their mind — mark accepted</button>`}
      <button class="ghost danger" data-act="delete-quote" data-id="${esc(q.id)}">Delete quotation</button></div>` : ''}`;
}

export const actions = {
  'new-quote': () => documentForm('quotation'),
  'edit-quote': () => documentForm('quotation', current),
  'email-quote': () => emailSheet('quotation', current, state.clients.find((c) => c.id === current.clientId), () => app.render()),

  'quote-status': async (el) => {
    const q = await api(`/quotations/${el.dataset.id}`, 'PUT', { status: el.dataset.status });
    toast(`${q.number} marked ${el.dataset.status}.`);
    app.render();
  },

  'delete-quote': async (el) => {
    if (!confirm('Delete this quotation? This cannot be undone.')) return;
    await api(`/quotations/${el.dataset.id}`, 'DELETE');
    toast('Quotation deleted.');
    app.go('#/quotations');
  },

  convert: (el) => openSheet('Turn quotation into an invoice', `
    <p class="sub" style="margin-top:0">The lines, discount and VAT carry over exactly. Tracked stock is taken out, and the quotation is locked.</p>
    ${field('Payment due by', 'dueDate', { type: 'date', value: plusDays(Number(state.settings.paymentTerms ?? 14)) })}`,
  async () => {
    const inv = await api(`/quotations/${el.dataset.id}/convert`, 'POST', { dueDate: val('dueDate') });
    closeSheet();
    createdToast(`Invoice ${inv.number} created.`, inv.warnings);
    app.go(`#/invoices/${inv.id}`);
  }, 'Create invoice')
};
