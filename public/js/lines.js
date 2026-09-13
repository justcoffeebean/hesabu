/* The line-item editor used by quotations, invoices and recurring invoices.
   Typing an item's name from the catalogue links the line to it (so stock
   moves) and fills in the price if you haven't typed one. */
import { state, esc, money, val, sheetBody, field, selectField, currencyOptions, toast } from './core.js';

const blank = { description: '', quantity: 1, unitPrice: 0, itemId: null };

export function lineEditor({ items = [blank], vatRate = state.settings.vatRate ?? 16, discount = 0, currency = state.currencies.base } = {}) {
  const active = state.items.filter((i) => i.active);
  return `
    <datalist id="itemList">${active.map((i) => `<option value="${esc(i.name)}">${i.trackStock ? `${i.stockQty} ${esc(i.unit)} in stock` : ''}</option>`).join('')}</datalist>
    <table class="items">
      <caption class="sr-only">Lines</caption>
      <thead><tr><th scope="col">Description</th><th scope="col" style="width:84px">Qty</th><th scope="col" style="width:130px">Unit price</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead>
      <tbody id="lines">${items.map((l, i) => lineRow(l, i)).join('')}</tbody>
    </table>
    <button type="button" class="link" id="addLine">Add another line</button>
    <div class="row" style="margin-top:14px">
      ${selectField('Currency', 'currency', currencyOptions(), currency)}
      ${field('Discount', 'discount', { type: 'number', value: discount, attrs: 'min="0" step="0.01"' })}
      ${field('VAT rate (%)', 'vatRate', { type: 'number', value: vatRate, attrs: 'min="0" max="100" step="0.5"' })}
    </div>
    <div class="totals num" id="liveTotals" aria-live="polite"></div>`;
}

function lineRow(l = blank, index = 0) {
  const n = index + 1;
  return `<tr data-item-id="${esc(l.itemId || '')}">
    <td><input class="d" list="itemList" value="${esc(l.description)}" placeholder="What are you billing for?" aria-label="Line ${n} description" autocomplete="off"></td>
    <td><input class="q num" type="number" min="0" step="any" value="${l.quantity}" aria-label="Line ${n} quantity"></td>
    <td><input class="p num" type="number" min="0" step="0.01" value="${l.unitPrice}" aria-label="Line ${n} unit price"></td>
    <td><button type="button" class="icon rm" aria-label="Remove line ${n}">&times;</button></td>
  </tr>`;
}

export function readLines() {
  return [...sheetBody().querySelectorAll('#lines tr')].map((tr) => ({
    description: tr.querySelector('.d').value,
    quantity: Number(tr.querySelector('.q').value) || 0,
    unitPrice: Number(tr.querySelector('.p').value) || 0,
    itemId: tr.dataset.itemId || null
  }));
}

function relabel() {
  sheetBody().querySelectorAll('#lines tr').forEach((tr, i) => {
    tr.querySelector('.d').setAttribute('aria-label', `Line ${i + 1} description`);
    tr.querySelector('.q').setAttribute('aria-label', `Line ${i + 1} quantity`);
    tr.querySelector('.p').setAttribute('aria-label', `Line ${i + 1} unit price`);
    tr.querySelector('.rm').setAttribute('aria-label', `Remove line ${i + 1}`);
  });
}

export function recalc() {
  const box = sheetBody().querySelector('#liveTotals');
  if (!box) return;
  const subtotal = readLines().reduce((s, l) => s + Math.round(l.quantity * l.unitPrice * 100), 0) / 100;
  const discount = Math.min(Number(val('discount')) || 0, subtotal);
  const vat = Math.round((subtotal - discount) * (Number(val('vatRate')) || 0)) / 100;
  const currency = val('currency') || state.currencies.base;
  box.innerHTML = `
    <div><span>Subtotal</span><span>${money(subtotal)}</span></div>
    ${discount ? `<div><span>Discount</span><span>−${money(discount)}</span></div>` : ''}
    <div><span>VAT</span><span>${money(vat)}</span></div>
    <div class="grand"><span>Total</span><span>${esc(currency)} ${money(subtotal - discount + vat)}</span></div>`;
}

const sheet = document.getElementById('sheet');

sheet.addEventListener('input', (e) => {
  if (e.target.classList.contains('d')) {
    const tr = e.target.closest('tr');
    const item = state.items.find((i) => i.active && i.name === e.target.value);
    tr.dataset.itemId = item ? item.id : '';
    const price = tr.querySelector('.p');
    if (item && !(Number(price.value) > 0)) price.value = item.unitPrice;
  }
  if (sheet.querySelector('#liveTotals')) recalc();
});

sheet.addEventListener('change', (e) => {
  // Picking a client switches the currency to theirs.
  if (e.target.name === 'clientId' && sheet.querySelector('[name="currency"]')) {
    const client = state.clients.find((c) => c.id === e.target.value);
    if (client) sheet.querySelector('[name="currency"]').value = client.currency;
    recalc();
  }
});

sheet.addEventListener('click', (e) => {
  if (e.target.id === 'addLine') {
    const body = sheet.querySelector('#lines');
    body.insertAdjacentHTML('beforeend', lineRow(blank, body.children.length));
    body.lastElementChild.querySelector('.d').focus();
    recalc();
  }
  if (e.target.classList.contains('rm')) {
    const rows = sheet.querySelectorAll('#lines tr');
    if (rows.length > 1) {
      const tr = e.target.closest('tr');
      const next = tr.nextElementSibling || tr.previousElementSibling;
      tr.remove();
      relabel();
      next.querySelector('.d').focus();
    } else {
      toast('A document needs at least one line.', true);
    }
    recalc();
  }
});
