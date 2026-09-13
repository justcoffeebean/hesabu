import { api, app, can, esc, money, pill, dateTime, table, toast, plural } from '../core.js';

const CHANNEL_TEXT = {
  smtp: 'connected', africastalking: 'connected', log: 'test mode — written to the server log, not sent', off: 'not set up on the server'
};

const failedCount = (outbox) => outbox.messages.filter((m) => m.status === 'failed').length;

const describe = (offset) => (offset < 0 ? `${-offset} day${offset === -1 ? '' : 's'} before due` : offset === 0 ? 'on the due date' : `${offset} day${offset === 1 ? '' : 's'} late`);

export const routes = {
  reminders: {
    title: 'Reminders',
    permission: 'reminders:read',
    async render() {
      const [cfg, preview, outbox] = await Promise.all([api('/settings/reminders'), api('/reminders/preview'), api('/messages')]);
      const owner = can('reminders:write');
      const dis = owner ? '' : 'disabled';
      return `
        <div class="head"><h1>Reminders</h1><p>${cfg.enabled ? 'On' : 'Off'} · ${cfg.offsets.map(describe).join(', ')}</p></div>

        <section class="sheet-block" style="max-width:640px;margin-bottom:26px">
            <h2>Automatic payment reminders</h2>
            <form class="pad" id="reminderForm" novalidate>
              <label class="check"><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''} ${dis}> Send reminders for unpaid invoices every morning</label>
              <fieldset><legend>Send by</legend>
                <label class="check"><input type="checkbox" name="email" ${cfg.email ? 'checked' : ''} ${dis} aria-describedby="r-email-status"> Email, with the invoice attached</label>
                <p class="hint" id="r-email-status" style="margin:-6px 0 10px 24px">Email is ${CHANNEL_TEXT[cfg.channels.email]}.</p>
                <label class="check"><input type="checkbox" name="sms" ${cfg.sms ? 'checked' : ''} ${dis} aria-describedby="r-sms-status"> SMS</label>
                <p class="hint" id="r-sms-status" style="margin:-6px 0 10px 24px">SMS is ${CHANNEL_TEXT[cfg.channels.sms]}.</p>
              </fieldset>
              <div class="field"><label for="r-offsets">Days relative to the due date</label>
                <input id="r-offsets" name="offsets" class="num" value="${esc(cfg.offsets.join(', '))}" ${dis} aria-describedby="r-offsets-hint">
                <p class="hint" id="r-offsets-hint">Negative is before the due date, 0 is the day itself, positive is days late. Each client gets each reminder once. Clients marked "no reminders" are skipped.</p></div>
              ${owner ? '<button type="submit" class="solid">Save</button>' : '<p class="sub">Only the owner can change this.</p>'}
            </form>
        </section>

        <section class="sheet-block">
          <h2>Due to go out today<span class="spacer"></span>${owner && preview.items.length ? '<button class="ghost" data-act="run-reminders">Send these now</button>' : ''}</h2>
          ${preview.items.length && !preview.enabled ? '<p class="pad sub" style="margin:0;padding-bottom:0">Reminders are off, so these won\'t go out on their own.</p>' : ''}
          ${preview.items.length ? table('Reminders due today', [['Invoice'], ['Client'], ['Send to'], ['Stage'], ['Balance', 'right']], preview.items.map((i) => `<tr>
              <td class="num"><a href="#/invoices/${esc(i.invoiceId)}">${esc(i.number)}</a></td>
              <td>${esc(i.clientName)}</td>
              <td class="sub">${i.channel === 'sms' ? 'SMS' : 'Email'}: ${esc(i.to)}</td>
              <td class="sub">${describe(i.offset)}</td>
              <td class="right num">${esc(i.currency)} ${money(i.balance)}</td></tr>`).join(''))
          : `<div class="empty"><p>${!preview.channels.length ? 'No reminder channel is both switched on here and set up on the server.' : 'Nothing is due today.'}</p></div>`}
        </section>

        <h2 class="section-title">Messages sent</h2>
        <p class="lede">Every invoice, quotation and reminder sent from Hesabu, newest first.${failedCount(outbox) ? ` <span class="late">${plural(failedCount(outbox), 'message')} failed.</span>` : ''}</p>
        <section class="sheet-block">
          ${outbox.messages.length ? table('Messages', [['When'], ['What'], ['To'], ['Status'], ['']], outbox.messages.map((m) => `<tr>
              <td class="num sub">${dateTime(m.sentAt || m.createdAt)}</td>
              <td>${{ invoice: 'Invoice', quotation: 'Quotation', reminder: 'Reminder' }[m.purpose] || m.purpose}${m.document ? ` <a class="num" href="#/${m.quotationId ? `quotations/${esc(m.quotationId)}` : `invoices/${esc(m.invoiceId)}`}">${esc(m.document)}</a>` : ''}
                <div class="sub">${m.channel === 'sms' ? 'SMS' : esc(m.subject || '')}</div></td>
              <td class="sub">${esc(m.to)}</td>
              <td>${pill(m.status, m.status === 'sent' ? 'sent-ok' : m.status)}${m.error ? `<div class="sub late">${esc(m.error)}</div>` : ''}</td>
              <td class="actions">${m.status === 'failed' && can('invoices:send') ? `<button class="link" data-act="retry-message" data-id="${esc(m.id)}">Retry</button>` : ''}</td>
            </tr>`).join(''))
          : '<div class="empty"><p>Nothing sent yet.</p></div>'}
        </section>`;
    },
    mount(root) {
      const form = root.querySelector('#reminderForm');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        try {
          await api('/settings/reminders', 'PUT', {
            enabled: f.get('enabled') === 'on', email: f.get('email') === 'on', sms: f.get('sms') === 'on', offsets: f.get('offsets')
          });
          toast('Reminder settings saved.');
          app.render();
        } catch (err) {
          toast(err.message, true);
        }
      });
    }
  }
};

export const actions = {
  'run-reminders': async () => {
    const r = await api('/reminders/run', 'POST');
    toast(r.skipped || `Queued ${plural(r.queued, 'reminder')}.`, Boolean(r.skipped));
    app.render();
  },
  'retry-message': async (el) => {
    const r = await api(`/messages/${el.dataset.id}/retry`, 'POST');
    toast(r.status === 'failed' ? 'Failed again. Check the server settings.' : 'Sent.', r.status === 'failed');
    app.render();
  }
};
