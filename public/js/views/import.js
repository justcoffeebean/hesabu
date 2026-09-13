import { api, app, esc, money, table, toast, readFile, plural } from '../core.js';

const KINDS = [
  ['clients', 'Clients', 'Name is required. Account code is what they type as the M-Pesa account number. Clients whose name already exists are flagged, not duplicated.'],
  ['items', 'Items & opening stock', 'Name is required. Put "yes" in track_stock and a number in stock_qty to start counting stock.'],
  ['balances', 'Opening balances', "What each client still owed in your old system. Each row becomes an OB- invoice with no VAT (it was charged on the original). Import clients first; match them by name or account code. Dates can be 2026-03-31 or 31/03/2026."]
];

const pending = {};

export const routes = {
  import: {
    title: 'Import',
    permission: 'import:run',
    render() {
      return `
        <div class="head"><h1>Import from a spreadsheet</h1></div>
        <p class="lede">Moving from Excel or another system? Save each sheet as CSV, check it here, then import. Nothing is saved until the whole file checks out, so you can fix and retry safely.</p>
        ${KINDS.map(([kind, label, help]) => `
          <section class="sheet-block" style="margin-bottom:16px" aria-labelledby="imp-${kind}">
            <h2 id="imp-${kind}">${label}<span class="spacer"></span><a class="link" href="/api/import/${kind}/template" download>Download template</a></h2>
            <div class="pad">
              <p class="sub" style="margin-top:0">${esc(help)}</p>
              <div class="row" style="align-items:flex-end">
                <div class="field" style="margin:0"><label for="file-${kind}">CSV file</label>
                  <input type="file" id="file-${kind}" accept=".csv,text/csv" data-kind="${kind}"></div>
                <div style="flex:0 0 auto"><button class="solid" data-act="commit-import" data-kind="${kind}" id="commit-${kind}" disabled>Import</button></div>
              </div>
              <div id="preview-${kind}" aria-live="polite"></div>
            </div>
          </section>`).join('')}`;
    },
    mount(root) {
      root.querySelectorAll('input[type=file]').forEach((input) => {
        input.addEventListener('change', async () => {
          const kind = input.dataset.kind;
          const box = root.querySelector(`#preview-${kind}`);
          const button = root.querySelector(`#commit-${kind}`);
          button.disabled = true;
          delete pending[kind];
          if (!input.files[0]) { box.innerHTML = ''; return; }
          box.innerHTML = '<p class="sub">Checking…</p>';
          try {
            const csv = await readFile(input.files[0]);
            const result = await api(`/import/${kind}/preview`, 'POST', { csv });
            pending[kind] = csv;
            box.innerHTML = previewHtml(kind, result);
            button.disabled = !(result.total && result.valid === result.total);
            button.textContent = result.total ? `Import ${plural(result.total, 'row')}` : 'Import';
          } catch (err) {
            box.innerHTML = `<p class="late" role="alert">${esc(err.message)}</p>`;
          }
        });
      });
    }
  }
};

function previewHtml(kind, r) {
  const bad = r.rows.filter((row) => row.errors.length);
  const cols = {
    clients: [['Name', (v) => esc(v.name)], ['Email', (v) => esc(v.email || '')], ['Account', (v) => esc(v.account_code || '')], ['Currency', (v) => esc(v.currency)]],
    items: [['Name', (v) => esc(v.name)], ['SKU', (v) => esc(v.sku || '')], ['Price', (v) => money(v.unit_price_cents / 100)], ['Stock', (v) => (v.track_stock ? v.stock_qty : '—')]],
    balances: [['Client', (v) => esc(v.clientName || '?')], ['Ref', (v) => esc(v.reference || '')], ['Due', (v) => esc(v.dueDate)], ['Amount', (v) => `${esc(v.currency)} ${money(v.amount)}`]]
  }[kind];
  const shown = (bad.length ? bad : r.rows).slice(0, 50);
  return `
    <p class="${bad.length ? 'late' : ''}" style="margin:14px 0 8px" ${bad.length ? 'role="alert"' : ''}>
      ${bad.length ? `${plural(bad.length, 'row')} of ${r.total} need fixing before anything can be imported:` : `All ${plural(r.total, 'row')} look good.`}
      ${r.ignoredColumns.length ? `<span class="sub"> Ignored columns: ${r.ignoredColumns.map(esc).join(', ')}.</span>` : ''}
    </p>
    ${shown.length ? `<div class="sheet-block">${table('Preview', [['Line'], ...cols.map(([label]) => [label]), ['Problems']], shown.map((row) => `<tr>
      <td class="num sub">${row.line}</td>
      ${cols.map(([, get]) => `<td>${get(row.value)}</td>`).join('')}
      <td class="${row.errors.length ? 'late' : 'sub'}">${row.errors.length ? row.errors.map(esc).join('<br>') : 'OK'}</td></tr>`).join(''))}</div>` : ''}
    ${(bad.length || r.rows.length) > 50 ? '<p class="sub">Showing the first 50.</p>' : ''}`;
}

export const actions = {
  'commit-import': async (el) => {
    const kind = el.dataset.kind;
    if (!pending[kind]) return;
    el.disabled = true;
    try {
      const r = await api(`/import/${kind}/commit`, 'POST', { csv: pending[kind] });
      delete pending[kind];
      toast(`Imported ${plural(r.imported, 'row')}.`);
      app.render();
    } catch (err) {
      el.disabled = false;
      throw err;
    }
  }
};
