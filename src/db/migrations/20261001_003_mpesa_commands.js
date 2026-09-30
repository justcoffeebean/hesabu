/**
 * Receipt lookups and refunds. Both are asynchronous on Safaricom's side: we
 * ask, get an acknowledgement, and the real answer arrives later at
 * /hooks/async/<secret>/result. Each request waits here until then.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('mpesa_commands', (t) => {
    t.string('id', 24).primary();
    t.string('kind', 10).notNullable(); // lookup | refund
    t.string('receipt', 40).notNullable();
    t.string('invoice_id', 24).references('id').inTable('invoices'); // lookup: where to put the money if found
    t.string('mpesa_transaction_id', 24).references('id').inTable('mpesa_transactions'); // refund: what's refunded; lookup: what was found
    t.bigInteger('amount_cents');
    t.string('reason', 200);
    t.string('status', 10).notNullable(); // pending | done | failed | unknown
    t.string('originator_conversation_id', 100).unique();
    t.string('conversation_id', 100);
    t.string('result_code', 20);
    t.string('result_desc', 300);
    t.text('result_raw');
    t.string('requested_by', 24);
    t.timestamp('created_at', { useTz: true }).notNullable();
    t.timestamp('updated_at', { useTz: true });
    t.index(['receipt']);
    t.index(['conversation_id']);
  });

  await knex.schema.alterTable('mpesa_transactions', (t) => {
    t.timestamp('refunded_at', { useTz: true }); // the money went back to the customer
    t.string('refund_receipt', 40); // M-Pesa's receipt for the reversal
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('mpesa_transactions', (t) => {
    t.dropColumn('refunded_at');
    t.dropColumn('refund_receipt');
  });
  await knex.schema.dropTableIfExists('mpesa_commands');
};
