import { api, app, esc, dateTime, table } from '../core.js';

const ENTITIES = [['', 'Everything'], ['invoice', 'Invoices'], ['payment', 'Payments'], ['quotation', 'Quotations'], ['client', 'Clients'], ['item', 'Items & stock'], ['recurring', 'Recurring'], ['task', 'Jobs'], ['user', 'Team & sign-ins'], ['settings', 'Settings'], ['currency', 'Currencies']];

const show = (v) => {
  if (v === null || v === undefined || v === '') return '<i>empty</i>';
  if (typeof v === 'object') return esc(JSON.stringify(v).slice(0, 300));
  return esc(String(v).slice(0, 300));
};

function changesHtml(changes) {
  if (!changes) return '';
  const rows = Object.entries(changes).map(([key, value]) => {
    if (Array.isArray(value) && value.length === 2) {
      return `<li><b>${esc(key)}</b>: <span class="from">${show(value[0])}</span> → <span class="to">${show(value[1])}</span></li>`;
    }
    return `<li><b>${esc(key)}</b>: ${show(value)}</li>`;
  });
  return rows.length ? `<details><summary>Details</summary><ul class="diff">${rows.join('')}</ul></details>` : '';
}

export const routes = {
  audit: {
    title: 'Audit log',
    permission: 'audit:read',
    async render(_id, query) {
      const params = new URLSearchParams({ limit: '100', ...(query.entity ? { entity: query.entity } : {}), ...(query.q ? { q: query.q } : {}), ...(query.before ? { before: query.before } : {}) });
      const { entries, more } = await api(`/audit?${params}`);
      const last = entries[entries.length - 1];
      const nextQuery = new URLSearchParams({ ...(query.entity ? { entity: query.entity } : {}), ...(query.q ? { q: query.q } : {}), ...(last ? { before: last.id } : {}) });
      return `
        <div class="head"><h1>Audit log</h1><p>Who changed what, and when. Entries can't be edited or deleted.</p></div>
        <form class="row no-print" id="auditFilter" style="align-items:flex-end;margin-bottom:14px" role="search">
          <div class="field" style="margin:0"><label for="a-q">Search</label><input id="a-q" name="q" value="${esc(query.q || '')}" placeholder="INV-2026-0004, Riverside, reversed…"></div>
          <div class="field" style="margin:0"><label for="a-entity">Show</label><select id="a-entity" name="entity">
            ${ENTITIES.map(([v, l]) => `<option value="${v}" ${v === (query.entity || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div style="flex:0 0 auto"><button class="ghost" type="submit">Filter</button></div>
        </form>
        <section class="sheet-block">
          ${entries.length ? table('Audit entries', [['When'], ['Who'], ['What happened']], entries.map((e) => `<tr>
              <td class="num sub" style="white-space:nowrap">${dateTime(e.at)}</td>
              <td>${esc(e.userName)}${e.ip ? `<div class="sub num">${esc(e.ip)}</div>` : ''}</td>
              <td>${esc(e.summary)}${changesHtml(e.changes)}</td></tr>`).join(''))
          : '<div class="empty"><p>No entries match.</p></div>'}
        </section>
        <p style="margin-top:14px">${query.before ? `<a href="#/audit?${new URLSearchParams({ ...(query.entity ? { entity: query.entity } : {}), ...(query.q ? { q: query.q } : {}) })}">Newest</a> · ` : ''}${more ? `<a href="#/audit?${nextQuery}">Older entries</a>` : ''}</p>`;
    },
    mount(root) {
      root.querySelector('#auditFilter').addEventListener('submit', (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const p = new URLSearchParams([...f.entries()].filter(([, v]) => v));
        app.go(`#/audit${p.toString() ? `?${p}` : ''}`);
      });
    }
  }
};
