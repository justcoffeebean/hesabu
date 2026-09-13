/**
 * Invoice and quotation PDFs, drawn directly with PDFKit so there is no
 * headless browser to install. A4, the built-in Helvetica faces, and the
 * same quiet ledger look as the screen.
 */
const PDFDocument = require('pdfkit');
const { documentContext } = require('./documents');
const db = require('../db');

const INK = '#1b2a27';
const SOFT = '#5f6863';
const RULE = '#c9ccc3';
const GREEN = '#1f6b4d';
const RED = '#a3361f';

const A4 = { width: 595.28, height: 841.89 };
const M = 50; // page margin
const RIGHT = A4.width - M;
const BOTTOM = A4.height - 60;

// Characters Helvetica's WinAnsi encoding can print beyond Latin-1.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const safe = (s) => String(s ?? '')
  .replace(/[−‐‑]/g, '-')
  .replace(/[  ]/g, ' ')
  .replace(/[^\n\r\t\x20-\xff]/g, (c) => (WIN_ANSI_EXTRA.has(c) ? c : '?'));

const money = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function longDate(iso) {
  if (!iso) return '-';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${Number(d)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

const STATUS_COLOR = { paid: GREEN, overdue: RED, cancelled: SOFT, declined: RED, accepted: GREEN };

function render({ kind, doc: d, client, company, payments }) {
  const pdf = new PDFDocument({
    size: 'A4', margins: { top: M, bottom: M, left: M, right: M }, bufferPages: true,
    info: { Title: `${kind === 'invoice' ? 'Invoice' : 'Quotation'} ${d.number}`, Author: company.name, Creator: 'Hesabu' }
  });
  const chunks = [];
  pdf.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

  const text = (str, x, y, opts = {}) => {
    pdf.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 9.5).fillColor(opts.color || INK);
    pdf.text(safe(str), x, y, { width: opts.width, align: opts.align || 'left', lineGap: opts.lineGap ?? 1.5, lineBreak: opts.width !== undefined });
    return pdf.y;
  };
  const rule = (y, color = RULE, width = 0.6) => pdf.moveTo(M, y).lineTo(RIGHT, y).lineWidth(width).strokeColor(color).stroke();

  /* ----- heading ----- */
  let y = M;
  text(company.name, M, y, { bold: true, size: 17, width: 300 });
  const companyLines = [company.address, company.email, company.phone, company.kraPin ? `KRA PIN ${company.kraPin}` : '']
    .filter(Boolean).join('\n');
  const leftBottom = text(companyLines, M, pdf.y + 4, { size: 9, color: SOFT, width: 300 });

  const title = kind === 'invoice' ? (d.kind === 'opening' ? 'OPENING BALANCE' : 'INVOICE') : 'QUOTATION';
  text(title, 330, M, { bold: true, size: 20, width: RIGHT - 330, align: 'right' });
  const meta = kind === 'invoice'
    ? [d.number, `Issued ${longDate(d.date)}`, `Due ${longDate(d.dueDate)}`, d.reference ? `Ref ${d.reference}` : '']
    : [d.number, `Issued ${longDate(d.date)}`, `Valid until ${longDate(d.validUntil)}`];
  text(meta.filter(Boolean).join('\n'), 330, pdf.y + 4, { size: 9.5, color: SOFT, width: RIGHT - 330, align: 'right' });
  const statusLabel = String(d.status).toUpperCase().replace('-', ' ');
  const rightBottom = text(statusLabel, 330, pdf.y + 4, { bold: true, size: 9, color: STATUS_COLOR[d.status] || SOFT, width: RIGHT - 330, align: 'right' });

  y = Math.max(leftBottom, rightBottom) + 22;
  rule(y, INK, 1);
  y += 14;

  /* ----- parties ----- */
  text(kind === 'invoice' ? 'BILLED TO' : 'PREPARED FOR', M, y, { bold: true, size: 8, color: SOFT, width: 250 });
  const clientLines = [client?.name, client?.address, client?.email, client?.phone, client?.kra_pin ? `KRA PIN ${client.kra_pin}` : '']
    .filter(Boolean);
  text(clientLines[0] || '-', M, y + 13, { bold: true, size: 10.5, width: 260 });
  const partyBottom = text(clientLines.slice(1).join('\n'), M, pdf.y + 2, { size: 9, color: SOFT, width: 260 });

  if (kind === 'invoice') {
    text('AMOUNT DUE', 330, y, { bold: true, size: 8, color: SOFT, width: RIGHT - 330, align: 'right' });
    text(`${d.currency} ${money(d.balance)}`, 330, y + 12, { bold: true, size: 18, width: RIGHT - 330, align: 'right', color: d.balance > 0 ? INK : GREEN });
  } else {
    text('TOTAL', 330, y, { bold: true, size: 8, color: SOFT, width: RIGHT - 330, align: 'right' });
    text(`${d.currency} ${money(d.total)}`, 330, y + 12, { bold: true, size: 18, width: RIGHT - 330, align: 'right' });
  }
  y = Math.max(partyBottom, y + 40) + 20;

  /* ----- lines ----- */
  const col = { desc: M, qty: 330, price: 400, amount: 480 };
  const tableHead = (top) => {
    text('Description', col.desc, top, { bold: true, size: 8.5, color: SOFT, width: 270 });
    text('Qty', col.qty, top, { bold: true, size: 8.5, color: SOFT, width: 60, align: 'right' });
    text('Unit price', col.price, top, { bold: true, size: 8.5, color: SOFT, width: 75, align: 'right' });
    text('Amount', col.amount, top, { bold: true, size: 8.5, color: SOFT, width: RIGHT - col.amount, align: 'right' });
    rule(top + 14, INK, 0.8);
    return top + 22;
  };
  y = tableHead(y);

  const newPage = () => {
    pdf.addPage();
    y = tableHead(M);
  };

  for (const line of d.lines) {
    pdf.font('Helvetica').fontSize(9.5);
    const h = Math.max(pdf.heightOfString(safe(line.description), { width: 270, lineGap: 1.5 }), 12);
    if (y + h > BOTTOM) newPage();
    text(line.description, col.desc, y, { width: 270 });
    text(formatQty(line.quantity), col.qty, y, { width: 60, align: 'right' });
    text(money(line.unitPrice), col.price, y, { width: 75, align: 'right' });
    text(money(line.lineTotal), col.amount, y, { width: RIGHT - col.amount, align: 'right' });
    y += h + 7;
    rule(y - 4);
  }

  /* ----- totals ----- */
  const rows = [['Subtotal', money(d.subtotal)]];
  if (d.discount) rows.push(['Discount', `-${money(d.discount)}`]);
  rows.push([`VAT at ${d.vatRate}%`, money(d.vat)]);
  rows.push([`Total ${d.currency}`, money(d.total), true]);
  if (kind === 'invoice') {
    rows.push(['Paid', d.paid ? `-${money(d.paid)}` : money(0)]);
    rows.push([`Balance due ${d.currency}`, money(d.balance), true]);
  }
  if (y + rows.length * 18 + 20 > BOTTOM) { pdf.addPage(); y = M; }
  y += 6;
  for (const [label, value, strong] of rows) {
    if (strong) { pdf.moveTo(340, y - 3).lineTo(RIGHT, y - 3).lineWidth(0.6).strokeColor(INK).stroke(); }
    text(label, 340, y, { width: 120, bold: strong, size: strong ? 10.5 : 9.5, color: strong ? INK : SOFT });
    text(value, 440, y, { width: RIGHT - 440, align: 'right', bold: strong, size: strong ? 10.5 : 9.5 });
    y += strong ? 20 : 16;
  }

  // KRA wants the VAT figure in shillings even when the invoice is in another currency.
  if (d.currency !== company.baseCurrency && d.vat) {
    text(`VAT in ${company.baseCurrency} at 1 ${d.currency} = ${d.fxRate} ${company.baseCurrency}: ${company.baseCurrency} ${money(d.vat * d.fxRate)}`,
      M, y + 2, { size: 8.5, color: SOFT, width: RIGHT - M, align: 'right' });
    y = pdf.y + 6;
  }

  /* ----- notes, payment instructions, payments ----- */
  const block = (heading, body) => {
    if (!body) return;
    pdf.font('Helvetica').fontSize(9.5);
    const h = pdf.heightOfString(safe(body), { width: RIGHT - M, lineGap: 1.5 }) + 20;
    if (y + h > BOTTOM) { pdf.addPage(); y = M; }
    y += 14;
    text(heading, M, y, { bold: true, size: 8, color: SOFT, width: RIGHT - M });
    y = text(body, M, y + 12, { size: 9.5, width: RIGHT - M });
  };
  block('NOTES', d.notes);
  if (kind === 'invoice' && d.balance > 0) block('HOW TO PAY', company.paymentInstructions);

  if (kind === 'invoice' && payments.length) {
    if (y + 40 > BOTTOM) { pdf.addPage(); y = M; }
    y += 16;
    text('PAYMENTS RECEIVED', M, y, { bold: true, size: 8, color: SOFT, width: 200 });
    y += 14;
    for (const p of payments) {
      if (y + 14 > BOTTOM) { pdf.addPage(); y = M; }
      text(longDate(p.date), M, y, { size: 9, color: SOFT, width: 90 });
      text(`${p.method}${p.reference ? ` ${p.reference}` : ''}`, M + 90, y, { size: 9, width: 260 });
      text(money(p.amount_cents / 100), 440, y, { size: 9, width: RIGHT - 440, align: 'right' });
      y += 14;
    }
  }

  /* ----- footer on every page ----- */
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    pdf.page.margins.bottom = 0; // writing in the margin must not spawn a new page
    const footer = `${company.name} · ${d.number}`;
    text(footer, M, A4.height - 38, { size: 8, color: SOFT, width: 300 });
    text(`Page ${i + 1} of ${range.count}`, RIGHT - 120, A4.height - 38, { size: 8, color: SOFT, width: 120, align: 'right' });
  }

  pdf.end();
  return done;
}

const formatQty = (q) => (Number.isInteger(q) ? String(q) : String(Number(q.toFixed(3))));

async function documentPdf(kind, id, conn = db.knex) {
  const ctx = await documentContext(conn, kind, id);
  const buffer = await render(ctx);
  const filename = `${ctx.doc.number}.pdf`;
  return { buffer, filename, ctx };
}

/** Download by default; ?inline=1 opens it in the browser's viewer instead. */
function sendPdf(req, res, buffer, filename) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Length': buffer.length,
    'Content-Disposition': `${req.query.inline ? 'inline' : 'attachment'}; filename="${filename}"`,
    'Cache-Control': 'private, no-store'
  });
  res.end(buffer);
}

module.exports = { documentPdf, sendPdf, render, safe };
