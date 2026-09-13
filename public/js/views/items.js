import { api, app, can, state, esc, money, pill, dateTime, table, toast, openSheet, closeSheet, val, field } from '../core.js';

let items = [];

const qty = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

export const routes = {
  items: {
    title: 'Items & stock',
    permission: 'items:read',
    async render(_id, query) {
      items = await api('/items');
      state.items = items;
      const showArchived = query.archived === '1';
      const list = items.filter((i) => showArchived || i.active);
      const write = can('items:write');
      const low = items.filter((i) => i.active && i.low);
      return `
        <div class="head"><h1>Items & stock</h1><p>${low.length ? `<span class="late">${low.length} running low</span>` : 'What you sell'}</p><div class="spacer"></div>
          <div class="actions">
            ${can('import:run') ? '<a class="ghost button-link" href="#/import">Import from CSV</a>' : ''}
            ${write ? '<button class="solid" data-act="new-item">Add item</button>' : ''}
          </div></div>
        <p class="lede">Pick these by name when writing a quotation or invoice. For items with stock tracking on, invoicing takes stock out and cancelling puts it back.</p>
        <section class="sheet-block">
          ${list.length ? table('Items', [['Item'], ['Unit price', 'right'], ['In stock', 'right'], ['Reorder at', 'right'], ['']], list.map((i) => `<tr>
              <td><span class="strong ${i.active ? '' : 'struck'}">${esc(i.name)}</span><div class="sub">${[i.sku, i.unit && `per ${i.unit}`].filter(Boolean).map(esc).join(' · ')}${i.active ? '' : ' · archived'}</div></td>
              <td class="right num">${money(i.unitPrice)}</td>
              <td class="right num ${i.low ? 'late strong' : ''}">${i.trackStock ? `${qty(i.stockQty)}${i.low ? ' ' + pill('low', 'low-stock') : ''}` : '<span class="sub">not tracked</span>'}</td>
              <td class="right num sub">${i.trackStock ? qty(i.reorderLevel) : ''}</td>
              <td class="actions">
                ${i.trackStock && can('stock:adjust') ? `<button class="link" data-act="stock" data-mode="received" data-id="${esc(i.id)}" aria-label="Receive stock of ${esc(i.name)}">Receive</button>
                  <button class="link" data-act="stock" data-mode="count" data-id="${esc(i.id)}" aria-label="Count stock of ${esc(i.name)}">Count</button>
                  <button class="link" data-act="stock-history" data-id="${esc(i.id)}" aria-label="Stock history of ${esc(i.name)}">History</button>` : ''}
                ${write ? `<button class="link" data-act="edit-item" data-id="${esc(i.id)}" aria-label="Edit ${esc(i.name)}">Edit</button>` : ''}
                ${write && i.active ? `<button class="link danger" data-act="del-item" data-id="${esc(i.id)}" aria-label="Remove ${esc(i.name)}">Remove</button>` : ''}
              </td></tr>`).join(''))
          : `<div class="empty"><p>No items yet. Add what you sell so invoices fill in prices and track stock.</p>
              ${write ? '<button class="solid" data-act="new-item">Add item</button>' : ''}</div>`}
        </section>
        ${items.some((i) => !i.active) ? `<p class="sub" style="margin-top:12px"><a href="#/items${showArchived ? '' : '?archived=1'}">${showArchived ? 'Hide' : 'Show'} archived items</a></p>` : ''}`;
    }
  }
};

function itemForm(i = {}) {
  return `
    ${field('Name', 'name', { value: i.name || '', attrs: 'placeholder="Industrial degreaser, 20L drum"' })}
    <div class="row">
      ${field('SKU / code (optional)', 'sku', { value: i.sku || '' })}
      ${field('Unit', 'unit', { value: i.unit || '', attrs: 'placeholder="drum, litre, pc, hour"' })}
      ${field('Unit price', 'unitPrice', { type: 'number', value: i.unitPrice ?? '', attrs: 'min="0" step="0.01"' })}
    </div>
    <label class="check"><input type="checkbox" name="trackStock" ${i.trackStock ? 'checked' : ''}> Track stock for this item</label>
    <div class="row">
      ${i.id ? '' : field('Opening stock', 'stockQty', { type: 'number', value: 0, attrs: 'min="0" step="any"' })}
      ${field('Warn me when stock falls to', 'reorderLevel', { type: 'number', value: i.reorderLevel ?? 0, attrs: 'min="0" step="any"' })}
    </div>
    ${i.id && !i.active ? '<label class="check"><input type="checkbox" name="active"> Bring back (un-archive)</label>' : ''}`;
}

const readForm = () => ({
  name: val('name'), sku: val('sku'), unit: val('unit'), unitPrice: val('unitPrice'), trackStock: val('trackStock'),
  reorderLevel: val('reorderLevel') || 0
});

export const actions = {
  'new-item': () => openSheet('Add item', itemForm(), async () => {
    await api('/items', 'POST', { ...readForm(), stockQty: val('stockQty') || 0 });
    closeSheet();
    toast('Item added.');
    app.render();
  }, 'Add item'),

  'edit-item': (el) => {
    const i = items.find((x) => x.id === el.dataset.id);
    openSheet(`Edit ${i.name}`, itemForm(i), async () => {
      const body = { ...readForm(), version: i.version };
      if (!i.active && val('active')) body.active = true;
      await api(`/items/${i.id}`, 'PUT', body);
      closeSheet();
      toast('Item saved.');
      app.render();
    }, 'Save changes');
  },

  'del-item': async (el) => {
    const i = items.find((x) => x.id === el.dataset.id);
    if (!confirm(`Remove ${i.name}? If it's on any quotation or invoice it is archived instead, so history stays intact.`)) return;
    await api(`/items/${i.id}`, 'DELETE');
    toast('Item removed.');
    app.render();
  },

  stock: (el) => {
    const i = items.find((x) => x.id === el.dataset.id);
    const counting = el.dataset.mode === 'count';
    openSheet(counting ? `Count ${i.name}` : `Receive ${i.name}`, `
      <p class="sub" style="margin-top:0">On record: <span class="num">${qty(i.stockQty)}</span> ${esc(i.unit)}</p>
      ${field(counting ? 'How many are on the shelf?' : 'How many came in?', 'quantity', { type: 'number', attrs: `min="${counting ? 0 : 0.001}" step="any"` })}
      ${field('Note (optional)', 'note', { attrs: `placeholder="${counting ? 'Two drums leaking, written off' : 'Delivery note number, supplier'}"` })}`,
    async () => {
      const r = await api(`/items/${i.id}/stock`, 'POST', { mode: el.dataset.mode, quantity: val('quantity'), note: val('note') });
      closeSheet();
      toast(`${i.name}: ${qty(r.stockQty)} ${i.unit} in stock.`);
      app.render();
    }, counting ? 'Save count' : 'Add to stock');
  },

  'stock-history': async (el) => {
    const i = items.find((x) => x.id === el.dataset.id);
    const moves = await api(`/items/${i.id}/movements`);
    const reason = { invoice: 'Invoiced', cancel: 'Invoice cancelled', received: 'Received', adjusted: 'Stock count', import: 'Imported' };
    openSheet(`Stock history: ${i.name}`, moves.length ? table('Stock movements', [['When'], ['What'], ['Change', 'right'], ['After', 'right'], ['By']], moves.map((m) => `<tr>
        <td class="num sub">${dateTime(m.at)}</td>
        <td>${reason[m.reason] || m.reason}${m.reference ? ` <span class="num">${esc(m.reference)}</span>` : ''}${m.note ? `<div class="sub">${esc(m.note)}</div>` : ''}</td>
        <td class="right num ${m.change < 0 ? 'late' : ''}">${m.change > 0 ? '+' : ''}${qty(m.change)}</td>
        <td class="right num">${qty(m.balance)}</td>
        <td class="sub">${esc(m.by)}</td></tr>`).join('')) : '<p class="empty">No movements yet.</p>',
    null, '', { hideSave: true, cancelLabel: 'Close', wide: true });
  }
};
