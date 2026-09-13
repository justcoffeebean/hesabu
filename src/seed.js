/**
 * Fills the database with a few weeks of believable trading so every screen
 * has something to show. Running this REPLACES all business data (clients,
 * documents, payments, stock, jobs, messages, audit log). Team accounts are
 * kept; if there are none, three demo accounts are created.
 *
 *   npm run seed                      demo password is generated and printed
 *   SEED_PASSWORD=... npm run seed    choose the demo password
 */
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const settings = require('./settings');
const { audit, SYSTEM } = require('./audit');
const { today, addDays, addMonths } = require('./dates');
const { documentTotals } = require('./totals');

if (config.production && !process.argv.includes('--force')) {
  console.error('Refusing to wipe a production database. Run with --force if you really mean it.');
  process.exit(1);
}

const day = (offset) => addDays(today(), offset);
const at = (offset) => `${day(offset)}T09:00:00.000Z`;
const line = (description, quantity, unitPrice, itemId = null) => ({ description, quantity, unitPriceCents: unitPrice * 100, itemId });

const ITEMS = [
  ['it-dg20', 'Industrial degreaser, 20L drum', 'DG-20', 'drum', 7800, true, 8, 10],
  ['it-fc5', 'Floor cleaner concentrate, 5L', 'FC-5', 'jerrycan', 1450, true, 60, 20],
  ['it-hs5', 'Hand soap refill, 5L', 'HS-5', 'jerrycan', 990, true, 45, 15],
  ['it-ld20', 'Livestock disinfectant, 20L', 'LD-20', 'drum', 6400, true, 22, 5],
  ['it-sa1', 'Spray applicator', 'SA-1', 'pc', 4200, true, 6, 2],
  ['it-gc5', 'Glass cleaner, 5L', 'GC-5', 'jerrycan', 1200, true, 40, 10],
  ['it-mc12', 'Microfibre cloths, pack of 12', 'MC-12', 'pack', 1850, true, 18, 5],
  ['it-bl20', 'Bleach, 20L', 'BL-20', 'drum', 2100, true, 30, 10],
  ['it-del', 'Delivery', 'DEL', 'trip', 3500, false, 0, 0]
];

const clients = [
  { id: 'cl1', name: 'Acme Hardware Ltd', email: 'orders@acmehardware.co.ke', phone: '+254 711 220 340', address: 'Enterprise Road, Industrial Area, Nairobi', kra_pin: 'P051234567A', account_code: 'ACME', currency: 'KES', created_at: at(-90) },
  { id: 'cl2', name: 'Riverside Apartments', email: 'facilities@riverside.co.ke', phone: '+254 722 884 019', address: 'Riverside Drive, Westlands, Nairobi', account_code: 'RIVER', currency: 'KES', created_at: at(-64) },
  { id: 'cl3', name: 'Njoro Farm Supplies', email: 'accounts@njorofarm.co.ke', phone: '+254 733 512 776', address: 'Njoro, Nakuru County', account_code: 'NJORO', currency: 'KES', created_at: at(-40) },
  { id: 'cl4', name: 'Coast Clean Services', email: 'hello@coastclean.co.ke', phone: '+254 700 345 981', address: 'Nyali, Mombasa', account_code: 'COAST', currency: 'KES', created_at: at(-12) },
  { id: 'cl5', name: 'Mara Plains Safari Camps', email: 'procurement@maraplains.com', phone: '+254 745 600 210', address: 'Talek, Narok County', account_code: 'MARA', currency: 'USD', created_at: at(-20) }
];

const quotations = [
  { id: 'qt1', number: 'QT-2026-0001', client_id: 'cl1', date: day(-52), valid_until: day(-22), discount: 0, vat: 16, status: 'accepted', invoice_id: 'in1', notes: 'Delivery within 5 working days.', lines: [line('Industrial degreaser, 20L drum', 12, 7800, 'it-dg20'), line('Delivery to Industrial Area', 1, 3500, 'it-del')] },
  { id: 'qt2', number: 'QT-2026-0002', client_id: 'cl2', date: day(-34), valid_until: day(-4), discount: 5000, vat: 16, status: 'accepted', invoice_id: 'in2', notes: 'Monthly supply, invoiced on delivery.', lines: [line('Floor cleaner concentrate, 5L', 40, 1450, 'it-fc5'), line('Hand soap refill, 5L', 24, 990, 'it-hs5')] },
  { id: 'qt3', number: 'QT-2026-0003', client_id: 'cl3', date: day(-9), valid_until: day(21), discount: 0, vat: 16, status: 'sent', invoice_id: null, notes: 'Prices hold for 30 days.', lines: [line('Livestock disinfectant, 20L', 15, 6400, 'it-ld20'), line('Spray applicator', 3, 4200, 'it-sa1')] },
  { id: 'qt4', number: 'QT-2026-0004', client_id: 'cl4', date: day(-2), valid_until: day(28), discount: 0, vat: 16, status: 'draft', invoice_id: null, notes: '', lines: [line('Glass cleaner, 5L', 30, 1200, 'it-gc5'), line('Microfibre cloths, pack of 12', 10, 1850, 'it-mc12')] }
];

const invoices = [
  { id: 'in1', number: 'INV-2026-0001', client_id: 'cl1', quotation_id: 'qt1', date: day(-50), due_date: day(-36), discount: 0, vat: 16, notes: 'Paybill 400200, account ACME.', lines: quotations[0].lines },
  { id: 'in2', number: 'INV-2026-0002', client_id: 'cl2', quotation_id: 'qt2', date: day(-30), due_date: day(-16), discount: 5000, vat: 16, notes: 'Paybill 400200, account RIVER.', lines: quotations[1].lines },
  { id: 'in3', number: 'INV-2026-0003', client_id: 'cl1', date: day(-18), due_date: day(-4), discount: 0, vat: 16, notes: '', lines: [line('Industrial degreaser, 20L drum', 6, 7800, 'it-dg20')] },
  { id: 'in4', number: 'INV-2026-0004', client_id: 'cl4', date: day(-3), due_date: day(11), discount: 0, vat: 16, notes: 'Payment on delivery.', lines: [line('Bleach, 20L', 20, 2100, 'it-bl20'), line('Delivery to Mombasa', 1, 12000)] },
  { id: 'in5', number: 'INV-2026-0005', client_id: 'cl5', date: day(-6), due_date: day(24), discount: 0, vat: 16, currency: 'USD', fx_rate: 129.5, notes: 'Bank transfer in USD to the account on file.', lines: [line('Housekeeping chemicals, lodge bundle', 2, 425), line('Road freight to Talek', 1, 180)] }
];

const payments = [
  { id: 'pm1', invoice_id: 'in1', amount: 60000, method: 'M-Pesa', reference: 'SJ84K2LQ01', date: day(-44), source: 'manual' },
  { id: 'pm2', invoice_id: 'in1', amount: 49768, method: 'Bank transfer', reference: 'FT2603117', date: day(-31), source: 'manual' },
  { id: 'pm3', invoice_id: 'in2', amount: 40000, method: 'M-Pesa', reference: 'SJ91R4TMZ8', date: day(-11), source: 'manual' }
];

const tasks = [
  { id: 'tk1', title: 'Deliver 6 drums to Acme, Enterprise Road', assignee: 'Brian', client_id: 'cl1', due_date: day(0), priority: 'high', status: 'doing' },
  { id: 'tk2', title: 'Call Riverside about the overdue balance', assignee: 'Wanjiru', client_id: 'cl2', due_date: day(-1), priority: 'high', status: 'todo' },
  { id: 'tk3', title: 'Restock degreaser — under 10 drums left', assignee: 'Otieno', client_id: null, due_date: day(2), priority: 'normal', status: 'todo' },
  { id: 'tk4', title: 'Send Njoro Farm the revised quotation', assignee: 'Wanjiru', client_id: 'cl3', due_date: day(1), priority: 'normal', status: 'todo' },
  { id: 'tk5', title: 'File last month\'s VAT return', assignee: 'Wanjiru', client_id: null, due_date: day(-4), priority: 'high', status: 'done' }
];

const BUSINESS_TABLES = [
  'audit_log', 'job_runs', 'outbox', 'tasks', 'mpesa_requests', 'payments', 'mpesa_transactions',
  'invoice_lines', 'invoices', 'recurring_lines', 'recurring_invoices', 'quotation_lines', 'quotations',
  'stock_movements', 'items', 'clients', 'currencies', 'counters'
];

async function seed() {
  await db.migrate();
  const created = [];

  await db.tx(async (trx) => {
    for (const t of BUSINESS_TABLES) await trx(t).del();
    await trx('settings').whereIn('key', ['company', 'reminders', 'legacy_import']).del();
    // The old JSON file would otherwise be imported on next start; mark it handled.
    await db.putSetting(trx, 'legacy_import', { skipped: true, reason: 'seeded', at: db.now() });

    await db.putSetting(trx, 'company', {
      ...settings.COMPANY,
      name: 'Zawadi Chemicals Ltd', email: 'accounts@zawadichem.co.ke', phone: '+254 720 118 443',
      address: 'Baba Dogo Road, Ruaraka, Nairobi', kraPin: 'P051448392M', vatRate: 16, baseCurrency: 'KES', paymentTerms: 14,
      paymentInstructions: 'M-Pesa Paybill 400200, account number = your invoice number.\nBank: KCB Industrial Area, A/C 1180 442 901, Zawadi Chemicals Ltd.'
    });
    await db.putSetting(trx, 'reminders', { ...settings.REMINDERS, enabled: false });
    await trx('currencies').insert([
      { code: 'USD', name: 'US dollar', rate_to_base: 129.5, updated_at: db.now() },
      { code: 'EUR', name: 'Euro', rate_to_base: 141.2, updated_at: db.now() }
    ]);

    for (const [id, name, sku, unit, price, track, qty, reorder] of ITEMS) {
      await trx('items').insert({ id, name, sku, unit, unit_price_cents: price * 100, track_stock: track, stock_qty: qty, reorder_level: reorder, active: true, version: 1, created_at: at(-95) });
      if (track) await trx('stock_movements').insert({ item_id: id, change: qty, balance_after: qty, reason: 'received', note: 'Opening stock', created_at: at(-95) });
    }

    for (const c of clients) await trx('clients').insert({ reminders: true, version: 1, ...c });

    const writeLines = (table, key, id, lines) => trx(table).insert(lines.map((l, position) => ({
      [key]: id, position, item_id: l.itemId, description: l.description, quantity: l.quantity, unit_price_cents: l.unitPriceCents
    })));
    const money = (d) => {
      const t = documentTotals(d.lines, d.discount * 100, d.vat);
      return { discount_cents: t.discount, vat_rate: d.vat, subtotal_cents: t.subtotal, vat_cents: t.vat, total_cents: t.total };
    };

    // Riverside is a monthly client: bill them from a schedule instead of retyping.
    let next = addMonths(invoices[1].date, 1);
    while (next <= today()) next = addMonths(next, 1, Number(invoices[1].date.slice(8, 10)));
    await trx('recurring_invoices').insert({
      id: 'rc1', client_id: 'cl2', currency: 'KES', discount_cents: 500000, vat_rate: 16, notes: 'Monthly supply. Paybill 400200, account RIVER.',
      frequency: 'monthly', anchor_day: Number(invoices[1].date.slice(8, 10)), next_date: next, due_days: 14, auto_email: false,
      status: 'active', version: 1, created_at: at(-30)
    });
    await writeLines('recurring_lines', 'recurring_id', 'rc1', quotations[1].lines);

    for (const inv of invoices) {
      await trx('invoices').insert({
        id: inv.id, number: inv.number, kind: 'standard', client_id: inv.client_id, quotation_id: null,
        date: inv.date, due_date: inv.due_date, currency: inv.currency || 'KES', fx_rate: inv.fx_rate || 1, notes: inv.notes,
        status: 'open', version: 1, created_at: `${inv.date}T08:30:00.000Z`, ...money(inv)
      });
      await writeLines('invoice_lines', 'invoice_id', inv.id, inv.lines);
    }
    for (const q of quotations) {
      await trx('quotations').insert({
        id: q.id, number: q.number, client_id: q.client_id, date: q.date, valid_until: q.valid_until, currency: 'KES', fx_rate: 1,
        notes: q.notes, status: q.status, invoice_id: q.invoice_id, version: 1, created_at: `${q.date}T08:00:00.000Z`, ...money(q)
      });
      await writeLines('quotation_lines', 'quotation_id', q.id, q.lines);
    }
    for (const inv of invoices.filter((i) => i.quotation_id)) {
      await trx('invoices').where({ id: inv.id }).update({ quotation_id: inv.quotation_id });
    }

    for (const { amount, ...p } of payments) {
      await trx('payments').insert({ ...p, amount_cents: amount * 100, created_at: `${p.date}T12:00:00.000Z` });
    }

    // Someone paid the paybill with an account number that matches nothing — it waits to be placed.
    await trx('mpesa_transactions').insert({
      id: 'mt1', receipt: 'SJK7Q2M9PL', source: 'c2b', amount_cents: 1500000, allocated_cents: 0, phone: '254733512776',
      payer_name: 'JOHN KAMAU', bill_ref: 'NJORO FARM', date: day(-1), raw: '{}', created_at: at(-1)
    });

    for (const t of tasks) await trx('tasks').insert({ ...t, version: 1, created_at: at(-5) });
    await trx('counters').insert([{ kind: 'quotation', value: 4 }, { kind: 'invoice', value: 5 }]);

    if (!(await trx('users').first('id'))) {
      const password = process.env.SEED_PASSWORD || crypto.randomBytes(9).toString('base64url');
      const hash = await auth.hashPassword(password);
      const people = [
        ['Amina Odhiambo', 'owner@zawadichem.co.ke', 'owner'],
        ['Wanjiru Mwangi', 'wanjiru@zawadichem.co.ke', 'accounts'],
        ['Brian Otieno', 'brian@zawadichem.co.ke', 'staff']
      ];
      for (const [name, email, role] of people) {
        await trx('users').insert({ id: db.newId(), name, email, role, password_hash: hash, active: true, created_at: db.now() });
        created.push({ name, email, role });
      }
      created.password = password;
    }

    await audit(trx, SYSTEM, { action: 'seed', entity: 'settings', summary: 'Loaded demo data' });
  });

  console.log('Seeded 5 clients, 9 items, 4 quotations, 5 invoices, 3 payments, 1 recurring invoice, 1 unmatched M-Pesa receipt and 5 jobs.');
  if (created.length) {
    console.log('\nDemo sign-ins (same password for all three):');
    created.forEach((u) => console.log(`  ${u.role.padEnd(8)} ${u.email}`));
    console.log(`  password ${created.password}\n`);
  } else {
    console.log('Your existing team accounts were kept.');
  }
  console.log('Start the app with: npm start');
}

seed()
  .then(() => db.close())
  .catch(async (err) => {
    console.error(err);
    await db.close();
    process.exit(1);
  });
