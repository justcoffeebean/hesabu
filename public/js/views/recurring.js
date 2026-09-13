import { api, app, can, state, esc, money, pill, shortDate, table, toast, openSheet, closeSheet, val, field, selectField, clientOptions, plusDays, loadReference, plural } from '../core.js';
import { lineEditor, readLines, recalc } from '../lines.js';

let schedules = [];
let frequencies = {};

export const routes = {
  recurring: {
    title: 'Recurring invoices',
    permission: 'recurring:read',
    async render() {
      const data = await api('/recurring');
      schedules = data.schedules;
      frequencies = data.frequencies;
      const write = can('recurring:write');
      const active = schedules.filter((s) => s.status === 'active');
      return `
        <div class="head"><h1>Recurring invoices</h1><p>${plural(active.length, 'active schedule')}</p><div class="spacer"></div>
          <div class="actions">
            ${write && active.length ? '<button class="ghost" data-act="run-recurring">Bill anything due now</button>' : ''}
            ${write ? '<button class="solid" data-act="new-recurring">New recurring invoice</button>' : ''}
          </div></div>
        <p class="lede">Hesabu creates these invoices by itself each morning on the scheduled date${write ? ', and can email them to the client too' : ''}. To start one from an existing invoice, open the invoice and choose "Repeat this invoice".</p>
        <section class="sheet-block">
          ${schedules.length ? table('Recurring invoices', [['Client'], ['How often'], ['Next invoice'], ['Amount', 'right'], ['Status'], ['']], schedules.map((s) => `<tr>
              <td><span class="strong">${esc(s.clientName)}</span><div class="sub">${esc(s.lines.map((l) => l.description).join(', ').slice(0, 90))}</div></td>
              <td>${esc(s.frequencyLabel)}<div class="sub">due after ${s.dueDays} days${s.autoEmail ? ' · emailed' : ''}</div></td>
              <td class="num">${s.status === 'ended' ? '—' : shortDate(s.nextDate)}${s.endDate ? `<div class="sub">until ${shortDate(s.endDate)}</div>` : ''}</td>
              <td class="right num strong">${s.currency !== state.currencies.base ? `<span class="sub">${esc(s.currency)}</span> ` : ''}${money(s.total)}</td>
              <td>${pill(s.status)}<div class="sub">${plural(s.invoiceCount, 'invoice')} so far</div></td>
              <td class="actions">${write ? `
                ${s.status !== 'ended' ? `<button class="link" data-act="edit-recurring" data-id="${esc(s.id)}" aria-label="Edit schedule for ${esc(s.clientName)}">Edit</button>` : ''}
                ${s.status === 'active' ? `<button class="link" data-act="recurring-status" data-id="${esc(s.id)}" data-status="paused" aria-label="Pause schedule for ${esc(s.clientName)}">Pause</button>` : ''}
                ${s.status === 'paused' ? `<button class="link" data-act="resume-recurring" data-id="${esc(s.id)}" aria-label="Resume schedule for ${esc(s.clientName)}">Resume</button>` : ''}
                ${s.status !== 'ended' ? `<button class="link danger" data-act="recurring-status" data-id="${esc(s.id)}" data-status="ended" aria-label="End schedule for ${esc(s.clientName)}">End</button>` : ''}` : ''}
              </td></tr>`).join(''))
          : `<div class="empty"><p>No recurring invoices yet. Monthly clients get billed automatically once you set one up.</p>
              ${write ? '<button class="solid" data-act="new-recurring">New recurring invoice</button>' : ''}</div>`}
        </section>`;
    }
  }
};

const freqOptions = () => Object.entries(frequencies).map(([k, v]) => [k, v]);

function scheduleFields(s = {}) {
  return `
    <div class="row">
      ${selectField('How often', 'frequency', freqOptions(), s.frequency || 'monthly')}
      ${field('Next invoice on', 'nextDate', { type: 'date', value: s.nextDate || plusDays(1), attrs: `min="${plusDays(0)}"` })}
    </div>
    <div class="row">
      ${field('Payment due after (days)', 'dueDays', { type: 'number', value: s.dueDays ?? state.settings.paymentTerms ?? 14, attrs: 'min="0" max="365" step="1"' })}
      ${field('Stop after (optional)', 'endDate', { type: 'date', value: s.endDate || '' })}
    </div>
    <label class="check"><input type="checkbox" name="autoEmail" ${s.autoEmail ? 'checked' : ''}> Email each new invoice to the client automatically</label>`;
}

export const actions = {
  'new-recurring': async () => {
    await loadReference();
    openSheet('New recurring invoice', `
      ${selectField('Client', 'clientId', clientOptions())}
      ${scheduleFields()}
      ${lineEditor({ currency: state.clients[0]?.currency })}
      <div class="field" style="margin-top:12px"><label for="f-notes">Notes on each invoice</label><textarea id="f-notes" name="notes"></textarea></div>`,
    async () => {
      await api('/recurring', 'POST', {
        clientId: val('clientId'), frequency: val('frequency'), nextDate: val('nextDate'), dueDays: val('dueDays'),
        endDate: val('endDate') || null, autoEmail: val('autoEmail'), items: readLines(),
        currency: val('currency'), discount: val('discount'), vatRate: val('vatRate'), notes: val('notes')
      });
      closeSheet();
      toast('Recurring invoice set up.');
      app.render();
    }, 'Start schedule', { wide: true });
    recalc();
  },

  'edit-recurring': async (el) => {
    await loadReference();
    const s = schedules.find((x) => x.id === el.dataset.id);
    openSheet(`Edit schedule for ${s.clientName}`, `
      ${scheduleFields(s)}
      ${lineEditor({ items: s.lines, vatRate: s.vatRate, discount: s.discount, currency: s.currency })}
      <div class="field" style="margin-top:12px"><label for="f-notes">Notes on each invoice</label><textarea id="f-notes" name="notes">${esc(s.notes)}</textarea></div>
      <p class="hint">Changes apply to invoices created from now on. Invoices already sent stay as they are.</p>`,
    async () => {
      await api(`/recurring/${s.id}`, 'PUT', {
        version: s.version, frequency: val('frequency'), nextDate: val('nextDate'), dueDays: val('dueDays'),
        endDate: val('endDate') || null, autoEmail: val('autoEmail'), items: readLines(),
        discount: val('discount'), vatRate: val('vatRate'), notes: val('notes')
      });
      closeSheet();
      toast('Schedule saved.');
      app.render();
    }, 'Save changes', { wide: true });
    // Currency is fixed once a schedule exists.
    const cur = document.querySelector('#sheet [name="currency"]');
    if (cur) cur.disabled = true;
    recalc();
  },

  'recurring-status': async (el) => {
    const s = schedules.find((x) => x.id === el.dataset.id);
    if (el.dataset.status === 'ended' && !confirm(`End the schedule for ${s.clientName}? No more invoices will be created. Past invoices are kept.`)) return;
    await api(`/recurring/${s.id}`, 'PUT', { status: el.dataset.status, version: s.version });
    toast(el.dataset.status === 'paused' ? 'Paused. No invoices until you resume.' : 'Schedule ended.');
    app.render();
  },

  'resume-recurring': (el) => {
    const s = schedules.find((x) => x.id === el.dataset.id);
    openSheet(`Resume billing ${s.clientName}`, `
      ${field('Next invoice on', 'nextDate', { type: 'date', value: s.nextDate > plusDays(0) ? s.nextDate : plusDays(1), attrs: `min="${plusDays(0)}"`, hint: 'Periods missed while paused are not billed.' })}`,
    async () => {
      await api(`/recurring/${s.id}`, 'PUT', { status: 'active', nextDate: val('nextDate'), version: s.version });
      closeSheet();
      toast('Resumed.');
      app.render();
    }, 'Resume');
  },

  'run-recurring': async () => {
    const r = await api('/recurring/run', 'POST');
    if (r.errors.length) toast(`Created ${plural(r.created.length, 'invoice')}. Problem: ${r.errors[0].error}`, true);
    else toast(r.created.length ? `Created ${r.created.map((c) => c.number).join(', ')}.` : 'Nothing is due yet.');
    app.render();
  }
};
