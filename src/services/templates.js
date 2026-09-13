/** Wording for what clients receive. Plain text: it reads fine everywhere, including SMS. */
const config = require('../config');
const { daysBetween, today } = require('../dates');

const money = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function longDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${Number(d)} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
}

/** 'Paybill 400200, account INV-2026-0007' or 'Buy Goods till 123456', when M-Pesa is configured. */
function mpesaLine(inv) {
  const d = config.daraja;
  if (inv.currency !== 'KES' || !d.shortcode) return '';
  return d.type === 'till' ? `Buy Goods till ${d.partyB}` : `Paybill ${d.shortcode}, account ${inv.number}`;
}

const howToPay = (company, inv) => {
  const lines = [];
  if (company.paymentInstructions) lines.push(company.paymentInstructions);
  if (mpesaLine(inv)) lines.push(`M-Pesa: ${mpesaLine(inv)}`);
  return lines.length ? `\n\nHow to pay:\n${lines.join('\n')}` : '';
};

function invoiceEmail(inv, client, company, note) {
  return {
    subject: `Invoice ${inv.number} from ${company.name}`,
    body:
      `Hello ${client.name},\n\n` +
      (note ? `${note}\n\n` : '') +
      `Please find invoice ${inv.number} attached for ${inv.currency} ${money(inv.total)}` +
      (inv.balance > 0 && inv.balance < inv.total ? `, of which ${inv.currency} ${money(inv.balance)} is still due` : '') +
      (inv.balance > 0 ? `, payable by ${longDate(inv.dueDate)}.` : '. It is fully paid — thank you.') +
      (inv.balance > 0 ? howToPay(company, inv) : '') +
      `\n\nThank you for your business.\n${company.name}\n${[company.phone, company.email].filter(Boolean).join(' · ')}`
  };
}

function quotationEmail(q, client, company, note) {
  return {
    subject: `Quotation ${q.number} from ${company.name}`,
    body:
      `Hello ${client.name},\n\n` +
      (note ? `${note}\n\n` : '') +
      `Please find quotation ${q.number} attached for ${q.currency} ${money(q.total)}` +
      (q.validUntil ? `, valid until ${longDate(q.validUntil)}.` : '.') +
      `\n\nReply to this email to go ahead or if anything needs changing.\n\n${company.name}\n${[company.phone, company.email].filter(Boolean).join(' · ')}`
  };
}

function reminderWhen(inv, on) {
  const days = daysBetween(inv.dueDate, on);
  if (days < 0) return `is due in ${-days} day${days === -1 ? '' : 's'} (${longDate(inv.dueDate)})`;
  if (days === 0) return 'is due today';
  return `was due on ${longDate(inv.dueDate)}, ${days} day${days === 1 ? '' : 's'} ago`;
}

function reminderEmail(inv, client, company, on = today()) {
  const late = daysBetween(inv.dueDate, on) > 0;
  return {
    subject: `${late ? 'Overdue: ' : 'Reminder: '}invoice ${inv.number} — ${inv.currency} ${money(inv.balance)}`,
    body:
      `Hello ${client.name},\n\n` +
      `A reminder that invoice ${inv.number} ${reminderWhen(inv, on)}. ` +
      `The balance is ${inv.currency} ${money(inv.balance)}.` +
      howToPay(company, inv) +
      `\n\nIf you've already paid, thank you, and please ignore this message. A copy of the invoice is attached.` +
      `\n\n${company.name}\n${[company.phone, company.email].filter(Boolean).join(' · ')}`
  };
}

function reminderSms(inv, client, company, on = today()) {
  const pay = mpesaLine(inv) ? ` Pay via M-Pesa ${mpesaLine(inv)}.` : '';
  return `${company.name}: invoice ${inv.number} ${reminderWhen(inv, on)}. Balance ${inv.currency} ${money(inv.balance)}.${pay} Ignore if paid.`;
}

module.exports = { invoiceEmail, quotationEmail, reminderEmail, reminderSms };
