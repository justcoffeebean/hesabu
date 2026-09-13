/* Pieces shared by quotations, invoices and recurring invoices: the on-screen
   document, the create/edit form, and the "email it" dialog. */
import { state, app, api, esc, money, pill, shortDate, openSheet, closeSheet, val, toast, field, selectField, clientOptions, loadReference, plusDays } from '../core.js';
import { lineEditor, readLines, recalc } from '../lines.js';

export function documentHtml(kind, d, company, client) {
  const isInvoice = kind === 'invoice';
  const base = company.baseCurrency;
  return `
    <article class="doc" aria-label="${isInvoice ? 'Invoice' : 'Quotation'} ${esc(d.number)}">
      <div class="doc-head">
        <div><h2>${isInvoice ? (d.kind === 'opening' ? 'Opening balance' : 'Invoice') : 'Quotation'}</h2>${pill(d.status)}</div>
        <div class="meta num">
          ${esc(d.number)}<br>Issued ${shortDate(d.date)}<br>
          ${isInvoice ? `Due ${shortDate(d.dueDate)}${d.reference ? `<br>Ref ${esc(d.reference)}` : ''}` : `Valid until ${shortDate(d.validUntil)}`}
        </div>
      </div>
      <div class="doc-parties">
        <div><div class="sub">From</div><address><b>${esc(company.name)}</b><br>${esc(company.address)}<br>
          ${esc(company.email)}<br>${esc(company.phone)}${company.kraPin ? `<br>PIN ${esc(company.kraPin)}` : ''}</address></div>
        <div><div class="sub">${isInvoice ? 'Billed to' : 'Prepared for'}</div><address><b>${esc(client?.name || d.clientName || '—')}</b><br>${esc(client?.address || '')}<br>
          ${esc(client?.email || '')}<br>${esc(client?.phone || '')}</address></div>
      </div>
      <div class="table-wrap"><table>
        <caption class="sr-only">Lines</caption>
        <thead><tr><th scope="col">Description</th><th scope="col" class="right">Qty</th><th scope="col" class="right">Unit price</th><th scope="col" class="right">Amount</th></tr></thead>
        <tbody>${d.lines.map((l) => `<tr><td>${esc(l.description)}</td>
          <td class="right num">${l.quantity}</td><td class="right num">${money(l.unitPrice)}</td>
          <td class="right num">${money(l.lineTotal)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="totals num doc-totals">
        <div><span>Subtotal</span><span>${money(d.subtotal)}</span></div>
        ${d.discount ? `<div><span>Discount</span><span>−${money(d.discount)}</span></div>` : ''}
        <div><span>VAT at ${d.vatRate}%</span><span>${money(d.vat)}</span></div>
        <div class="grand"><span>Total</span><span>${esc(d.currency)} ${money(d.total)}</span></div>
        ${isInvoice ? `<div><span>Paid</span><span>${d.paid ? '−' : ''}${money(d.paid)}</span></div>
        <div class="grand"><span>Balance due</span><span>${esc(d.currency)} ${money(d.balance)}</span></div>` : ''}
        ${d.currency !== base && d.vat ? `<div class="sub"><span>VAT in ${esc(base)} at ${d.fxRate}</span><span>${money(d.vat * d.fxRate)}</span></div>` : ''}
      </div>
      ${d.notes ? `<p class="sub doc-notes">${esc(d.notes)}</p>` : ''}
      ${isInvoice && d.balance > 0 && company.paymentInstructions ? `<div class="doc-notes"><div class="sub">How to pay</div>${esc(company.paymentInstructions)}</div>` : ''}
    </article>`;
}

/** New or edit form for a quotation or invoice. */
export async function documentForm(kind, existing = null) {
  await loadReference();
  const isInvoice = kind === 'invoice';
  const d = existing || {};
  const client = state.clients.find((c) => c.id === d.clientId) || state.clients[0];
  const dateField = isInvoice
    ? field('Payment due by', 'dueDate', { type: 'date', value: d.dueDate || plusDays(Number(state.settings.paymentTerms ?? 14)) })
    : field('Valid until', 'validUntil', { type: 'date', value: d.validUntil || plusDays(30) });

  openSheet(existing ? `Edit ${d.number}` : isInvoice ? 'New invoice' : 'New quotation', `
    <div class="row">
      ${selectField('Client', 'clientId', clientOptions(), d.clientId || client?.id)}
      ${dateField}
    </div>
    ${lineEditor({
      items: d.lines ? d.lines.map((l) => ({ ...l })) : undefined,
      vatRate: d.vatRate ?? state.settings.vatRate ?? 16,
      discount: d.discount || 0,
      currency: d.currency || client?.currency || state.currencies.base
    })}
    <div class="field" style="margin-top:12px"><label for="f-notes">${isInvoice ? 'Notes on the invoice' : 'Notes for the client'}</label>
      <textarea id="f-notes" name="notes" placeholder="${isInvoice ? 'Delivery details, order number, terms' : 'Lead time, payment terms, anything they should know'}">${esc(d.notes || '')}</textarea></div>`,
  async () => {
    if (!val('clientId')) throw new Error('Add a client first (Clients → Add client).');
    const body = {
      clientId: val('clientId'), items: readLines(), notes: val('notes'), currency: val('currency'),
      discount: val('discount'), vatRate: val('vatRate'),
      ...(isInvoice ? { dueDate: val('dueDate') } : { validUntil: val('validUntil') })
    };
    let saved;
    if (existing) saved = await api(`/quotations/${d.id}`, 'PUT', { ...body, version: d.version });
    else saved = await api(isInvoice ? '/invoices' : '/quotations', 'POST', body);
    closeSheet();
    createdToast(existing ? `${saved.number} saved.` : `${saved.number} created.`, saved.warnings);
    app.go(`#/${isInvoice ? 'invoices' : 'quotations'}/${saved.id}`);
  }, existing ? 'Save changes' : isInvoice ? 'Create invoice' : 'Create quotation', { wide: true });
  recalc();
}

export function emailSheet(kind, d, client, after) {
  openSheet(`Email ${d.number}`, `
    ${field('Send to', 'to', { type: 'email', value: client?.email || '', hint: 'The PDF is attached.' })}
    <div class="field"><label for="f-note">Add a note (optional)</label>
      <textarea id="f-note" name="note" placeholder="Goes above the standard message"></textarea></div>`,
  async () => {
    const r = await api(`/${kind === 'invoice' ? 'invoices' : 'quotations'}/${d.id}/email`, 'POST', { to: val('to'), note: val('note') });
    closeSheet();
    if (r.status === 'failed') toast(`Couldn't send to ${r.to}. See Reminders → Messages for the reason.`, true);
    else toast(r.status === 'logged' ? `Email to ${r.to} written to the server log (email isn't connected).` : `Emailed to ${r.to}.`);
    if (after) after();
  }, 'Send email');
}

/** One toast, so stock warnings aren't overwritten by the success message a moment later. */
export function createdToast(message, warnings = []) {
  if (warnings && warnings.length) toast(`${message} ${warnings.join(' ')}`, true);
  else toast(message);
}

export const pdfLink = (kind, id, label = 'Download PDF') =>
  `<a class="button-link" href="/api/${kind === 'invoice' ? 'invoices' : 'quotations'}/${encodeURIComponent(id)}/pdf" download>${label}</a>`;
