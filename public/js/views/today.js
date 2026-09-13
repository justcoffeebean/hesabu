import { api, can, esc, money, pill, shortDate, today as todayIso, plural, table } from '../core.js';

export const routes = {
  today: {
    title: 'Today',
    permission: 'dashboard:read',
    async render() {
      const d = await api('/dashboard');
      const bars = [
        ['current', 'var(--green)', 'Not due yet'],
        ['1-30', 'var(--amber)', '1–30 days late'],
        ['31-60', 'var(--rust)', '31–60 days late'],
        ['60+', 'var(--oxblood)', 'Over 60 days late']
      ];
      const totalAging = Object.values(d.aging).reduce((a, b) => a + b, 0) || 1;
      const foreign = Object.entries(d.outstandingByCurrency).filter(([code]) => code !== d.currency);

      return `
        <div class="head"><h1>Today</h1><p>${shortDate(todayIso())}</p></div>

        ${d.unallocatedMpesa.count && can('payments:write') ? `<div class="callout">
          <p><b>${plural(d.unallocatedMpesa.count, 'M-Pesa payment')}</b> (${esc(d.currency)} ${money(d.unallocatedMpesa.amount)}) came in with an account number we couldn't match.</p>
          <a class="button-link" href="#/payments">Place them</a></div>` : ''}

        <section class="ledger-top" aria-label="Money position">
          <div class="headline">
            <div class="label">Owed to you right now</div>
            <div class="value num"><small>${esc(d.currency)}</small>${money(d.outstanding)}</div>
            ${foreign.length ? `<div class="also">Includes ${foreign.map(([code, amt]) => `<span class="num">${esc(code)} ${money(amt)}</span>`).join(', ')} at each invoice's rate</div>` : ''}
          </div>
          <div class="side">
            <div><div class="label">Past due</div><div class="value num debt">${money(d.overdue)}</div></div>
            <div><div class="label">Received this month</div><div class="value num credit">${money(d.collectedThisMonth)}</div></div>
            <div><div class="label">Invoiced this month</div><div class="value num">${money(d.invoicedThisMonth)}</div></div>
          </div>
        </section>

        <section class="aging" aria-label="How late the money is">
          <div class="aging-bar" aria-hidden="true">
            ${bars.map(([k, c]) => `<span style="width:${(d.aging[k] / totalAging) * 100}%;background:${c}"></span>`).join('')}
          </div>
          <ul class="aging-key">
            ${bars.map(([k, c, label]) => `<li><i style="background:${c}" aria-hidden="true"></i>${label} · <b class="num">${money(d.aging[k])}</b></li>`).join('')}
          </ul>
        </section>

        <div class="grid-2">
          <section class="sheet-block">
            <h2>Chase these first</h2>
            ${d.topDebtors.length ? table('Largest unpaid balances', [['Client'], ['Status', 'right'], ['Balance', 'right']], d.topDebtors.map((i) => `<tr>
                <td><a href="#/invoices/${esc(i.id)}" class="strong">${esc(i.clientName)}</a><div class="sub num">${esc(i.number)} · due ${shortDate(i.dueDate)}</div></td>
                <td class="right">${pill(i.status)}</td>
                <td class="right num strong">${i.currency !== d.currency ? `<span class="sub">${esc(i.currency)}</span> ` : ''}${money(i.balance)}</td>
              </tr>`).join(''))
            : '<div class="empty"><p>Nothing outstanding. Everyone has paid.</p></div>'}
          </section>

          <section class="sheet-block">
            <h2>Needs a decision</h2>
            ${table('Things waiting on someone', [['Item'], ['Count', 'right']], `
              <tr><td><a href="#/quotations">Quotations still open</a></td><td class="right num strong">${d.openQuotations}</td></tr>
              <tr><td><a href="#/quotations">Accepted, not yet invoiced</a></td><td class="right num strong">${d.awaitingInvoice}</td></tr>
              <tr><td><a href="#/operations">Jobs due today or earlier</a></td><td class="right num strong">${d.jobsDueToday}</td></tr>
              <tr><td><a href="#/items">Items at or below reorder level</a></td><td class="right num strong ${d.lowStock.length ? 'late' : ''}">${d.lowStock.length}</td></tr>`)}
            ${d.lowStock.length ? `<div class="pad sub">Running low: ${d.lowStock.slice(0, 4).map((i) => `${esc(i.name)} (<span class="num">${i.stockQty}</span> left)`).join(', ')}${d.lowStock.length > 4 ? '…' : ''}</div>` : ''}
          </section>
        </div>`;
    }
  }
};
