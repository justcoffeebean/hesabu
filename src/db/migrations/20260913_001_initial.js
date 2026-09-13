/**
 * Initial schema. Money columns are integer cents (BIGINT); rates and
 * quantities are doubles because they are multipliers, not money.
 */

const timestamps = (t) => {
  t.timestamp('created_at', { useTz: true }).notNullable();
  t.timestamp('updated_at', { useTz: true });
};

const lines = (knex, table, parent, parentTable) =>
  knex.schema.createTable(table, (t) => {
    t.increments('id');
    t.string(parent, 24).notNullable().references('id').inTable(parentTable).onDelete('CASCADE');
    t.integer('position').notNullable();
    t.string('item_id', 24).references('id').inTable('items').onDelete('SET NULL');
    t.text('description').notNullable();
    t.double('quantity').notNullable();
    t.bigInteger('unit_price_cents').notNullable();
    t.index([parent]);
  });

exports.up = async function up(knex) {
  await knex.schema.createTable('settings', (t) => {
    t.string('key', 40).primary();
    t.text('value').notNullable();
    t.timestamp('updated_at', { useTz: true });
  });

  await knex.schema.createTable('counters', (t) => {
    t.string('kind', 20).primary();
    t.integer('value').notNullable();
  });

  /* ---------- people & access ---------- */

  await knex.schema.createTable('users', (t) => {
    t.string('id', 24).primary();
    t.string('email', 200).notNullable().unique();
    t.string('name', 120).notNullable();
    t.string('role', 20).notNullable();
    t.string('password_hash', 200);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('last_login_at', { useTz: true });
    timestamps(t);
  });

  await knex.schema.createTable('sessions', (t) => {
    t.string('id', 64).primary(); // sha256 of the cookie token; the token itself is never stored
    t.string('user_id', 24).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('last_seen_at', { useTz: true }).notNullable();
    t.string('ip', 64);
    t.string('user_agent', 300);
    t.timestamp('created_at', { useTz: true }).notNullable();
    t.index(['user_id']);
  });

  await knex.schema.createTable('password_tokens', (t) => {
    t.string('id', 64).primary(); // sha256 of the token in the link
    t.string('user_id', 24).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('purpose', 10).notNullable(); // invite | reset
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true });
    t.string('created_by', 24);
    t.timestamp('created_at', { useTz: true }).notNullable();
  });

  /* ---------- reference data ---------- */

  await knex.schema.createTable('currencies', (t) => {
    t.string('code', 3).primary();
    t.string('name', 60).notNullable();
    t.double('rate_to_base').notNullable(); // base units for one unit of this currency
    t.timestamp('updated_at', { useTz: true });
  });

  await knex.schema.createTable('clients', (t) => {
    t.string('id', 24).primary();
    t.string('name', 200).notNullable();
    t.string('email', 200);
    t.string('phone', 40);
    t.string('address', 300);
    t.string('kra_pin', 20);
    t.string('account_code', 20).unique(); // what they type as the M-Pesa account number
    t.string('currency', 3).notNullable();
    t.boolean('reminders').notNullable().defaultTo(true);
    t.integer('version').notNullable().defaultTo(1);
    timestamps(t);
  });

  await knex.schema.createTable('items', (t) => {
    t.string('id', 24).primary();
    t.string('name', 200).notNullable();
    t.string('sku', 60).unique();
    t.string('unit', 30);
    t.bigInteger('unit_price_cents').notNullable().defaultTo(0);
    t.boolean('track_stock').notNullable().defaultTo(false);
    t.double('stock_qty').notNullable().defaultTo(0);
    t.double('reorder_level').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('version').notNullable().defaultTo(1);
    timestamps(t);
  });

  await knex.schema.createTable('stock_movements', (t) => {
    t.increments('id');
    t.string('item_id', 24).notNullable().references('id').inTable('items').onDelete('CASCADE');
    t.double('change').notNullable();
    t.double('balance_after').notNullable();
    t.string('reason', 20).notNullable(); // invoice | cancel | received | adjusted | import
    t.string('ref_type', 20);
    t.string('ref_id', 24);
    t.string('note', 300);
    t.string('user_id', 24);
    t.timestamp('created_at', { useTz: true }).notNullable();
    t.index(['item_id']);
  });

  /* ---------- documents ---------- */

  await knex.schema.createTable('quotations', (t) => {
    t.string('id', 24).primary();
    t.string('number', 30).notNullable().unique();
    t.string('client_id', 24).notNullable().references('id').inTable('clients');
    t.date('date').notNullable();
    t.date('valid_until');
    t.string('currency', 3).notNullable();
    t.double('fx_rate').notNullable().defaultTo(1);
    t.bigInteger('discount_cents').notNullable().defaultTo(0);
    t.double('vat_rate').notNullable().defaultTo(0);
    t.bigInteger('subtotal_cents').notNullable().defaultTo(0);
    t.bigInteger('vat_cents').notNullable().defaultTo(0);
    t.bigInteger('total_cents').notNullable().defaultTo(0);
    t.text('notes');
    t.string('status', 12).notNullable();
    t.string('invoice_id', 24);
    t.string('created_by', 24);
    t.integer('version').notNullable().defaultTo(1);
    timestamps(t);
    t.index(['client_id']);
  });
  await lines(knex, 'quotation_lines', 'quotation_id', 'quotations');

  await knex.schema.createTable('recurring_invoices', (t) => {
    t.string('id', 24).primary();
    t.string('client_id', 24).notNullable().references('id').inTable('clients');
    t.string('currency', 3).notNullable();
    t.bigInteger('discount_cents').notNullable().defaultTo(0);
    t.double('vat_rate').notNullable().defaultTo(0);
    t.text('notes');
    t.string('frequency', 12).notNullable(); // weekly | monthly | quarterly | yearly
    t.integer('anchor_day').notNullable();
    t.date('next_date').notNullable();
    t.date('end_date');
    t.integer('due_days').notNullable().defaultTo(14);
    t.boolean('auto_email').notNullable().defaultTo(false);
    t.string('status', 10).notNullable(); // active | paused | ended
    t.timestamp('last_run_at', { useTz: true });
    t.string('created_by', 24);
    t.integer('version').notNullable().defaultTo(1);
    timestamps(t);
  });
  await lines(knex, 'recurring_lines', 'recurring_id', 'recurring_invoices');

  await knex.schema.createTable('invoices', (t) => {
    t.string('id', 24).primary();
    t.string('number', 30).notNullable().unique();
    t.string('kind', 10).notNullable().defaultTo('standard'); // standard | opening
    t.string('client_id', 24).notNullable().references('id').inTable('clients');
    t.string('quotation_id', 24).references('id').inTable('quotations');
    t.string('recurring_id', 24).references('id').inTable('recurring_invoices').onDelete('SET NULL');
    t.string('reference', 60); // their old number, for imported opening balances
    t.date('date').notNullable();
    t.date('due_date').notNullable();
    t.string('currency', 3).notNullable();
    t.double('fx_rate').notNullable().defaultTo(1);
    t.bigInteger('discount_cents').notNullable().defaultTo(0);
    t.double('vat_rate').notNullable().defaultTo(0);
    t.bigInteger('subtotal_cents').notNullable().defaultTo(0);
    t.bigInteger('vat_cents').notNullable().defaultTo(0);
    t.bigInteger('total_cents').notNullable().defaultTo(0);
    t.text('notes');
    t.string('status', 12).notNullable(); // open | cancelled (paid/overdue are computed)
    t.timestamp('cancelled_at', { useTz: true });
    t.timestamp('emailed_at', { useTz: true });
    t.string('created_by', 24);
    t.integer('version').notNullable().defaultTo(1);
    timestamps(t);
    t.index(['client_id']);
    t.index(['due_date']);
  });
  await lines(knex, 'invoice_lines', 'invoice_id', 'invoices');

  /* ---------- money in ---------- */

  await knex.schema.createTable('mpesa_transactions', (t) => {
    t.string('id', 24).primary();
    t.string('receipt', 40).unique(); // M-Pesa receipt, e.g. SJ84K2LQ01
    t.string('source', 4).notNullable(); // stk | c2b
    t.bigInteger('amount_cents').notNullable();
    t.bigInteger('allocated_cents').notNullable().defaultTo(0);
    t.string('phone', 64);
    t.string('payer_name', 120);
    t.string('bill_ref', 60);
    t.date('date').notNullable();
    t.text('raw');
    t.timestamp('created_at', { useTz: true }).notNullable();
  });

  await knex.schema.createTable('payments', (t) => {
    t.string('id', 24).primary();
    t.string('invoice_id', 24).notNullable().references('id').inTable('invoices');
    t.bigInteger('amount_cents').notNullable();
    t.string('method', 30).notNullable();
    t.string('reference', 60);
    t.date('date').notNullable();
    t.string('source', 10).notNullable().defaultTo('manual'); // manual | mpesa
    t.string('mpesa_transaction_id', 24).references('id').inTable('mpesa_transactions');
    t.string('created_by', 24);
    t.timestamp('created_at', { useTz: true }).notNullable();
    t.timestamp('reversed_at', { useTz: true });
    t.string('reversed_by', 24);
    t.string('reversal_reason', 200);
    t.index(['invoice_id']);
  });

  await knex.schema.createTable('mpesa_requests', (t) => {
    t.string('id', 24).primary();
    t.string('invoice_id', 24).notNullable().references('id').inTable('invoices');
    t.string('phone', 20).notNullable();
    t.bigInteger('amount_cents').notNullable();
    t.string('merchant_request_id', 60);
    t.string('checkout_request_id', 60).unique();
    t.string('status', 12).notNullable(); // pending | paid | failed
    t.string('result_code', 10);
    t.string('result_desc', 300);
    t.string('mpesa_transaction_id', 24).references('id').inTable('mpesa_transactions');
    t.string('created_by', 24);
    timestamps(t);
  });

  /* ---------- work ---------- */

  await knex.schema.createTable('tasks', (t) => {
    t.string('id', 24).primary();
    t.string('title', 300).notNullable();
    t.string('assignee', 120);
    t.string('client_id', 24).references('id').inTable('clients').onDelete('SET NULL');
    t.date('due_date');
    t.string('priority', 8).notNullable();
    t.string('status', 8).notNullable();
    t.string('created_by', 24);
    t.integer('version').notNullable().defaultTo(1);
    timestamps(t);
  });

  /* ---------- messages, jobs, audit ---------- */

  await knex.schema.createTable('outbox', (t) => {
    t.string('id', 24).primary();
    t.string('channel', 5).notNullable(); // email | sms
    t.string('recipient', 200).notNullable();
    t.string('subject', 300);
    t.text('body').notNullable();
    t.string('attachment', 20); // invoice-pdf | quotation-pdf
    t.string('invoice_id', 24).references('id').inTable('invoices').onDelete('SET NULL');
    t.string('quotation_id', 24).references('id').inTable('quotations').onDelete('SET NULL');
    t.string('purpose', 12).notNullable(); // invoice | quotation | reminder
    t.string('reminder_stage', 10);
    t.string('status', 8).notNullable(); // queued | sent | failed | logged
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('claimed_at', { useTz: true });
    t.text('error');
    t.string('provider_id', 120);
    t.string('created_by', 24);
    t.timestamp('created_at', { useTz: true }).notNullable();
    t.timestamp('sent_at', { useTz: true });
    // One reminder per invoice, stage and channel — even if two job runs overlap.
    t.unique(['invoice_id', 'reminder_stage', 'channel']);
  });

  await knex.schema.createTable('job_runs', (t) => {
    t.string('job', 20).notNullable();
    t.string('run_key', 20).notNullable();
    t.timestamp('started_at', { useTz: true }).notNullable();
    t.timestamp('finished_at', { useTz: true });
    t.text('result');
    t.primary(['job', 'run_key']);
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.increments('id');
    t.timestamp('at', { useTz: true }).notNullable();
    t.string('user_id', 24);
    t.string('user_name', 120).notNullable();
    t.string('action', 30).notNullable();
    t.string('entity', 20).notNullable();
    t.string('entity_id', 24);
    t.string('summary', 400).notNullable();
    t.text('changes');
    t.string('ip', 64);
    t.index(['entity', 'entity_id']);
    t.index(['at']);
  });
};

exports.down = async function down(knex) {
  const tables = [
    'audit_log', 'job_runs', 'outbox', 'tasks', 'mpesa_requests', 'payments', 'mpesa_transactions',
    'invoice_lines', 'invoices', 'recurring_lines', 'recurring_invoices', 'quotation_lines', 'quotations',
    'stock_movements', 'items', 'clients', 'currencies', 'password_tokens', 'sessions', 'users',
    'counters', 'settings'
  ];
  for (const t of tables) await knex.schema.dropTableIfExists(t);
};
