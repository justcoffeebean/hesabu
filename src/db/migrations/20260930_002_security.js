/**
 * Sign-in protection that has to survive restarts and be shared between
 * servers: failure counters, browsers that have signed in before, and
 * two-step sign-in (TOTP) for each user.
 */

exports.up = async function up(knex) {
  // Fixed-window failure counters, e.g. "login-ip:203.0.113.7". window_start is epoch milliseconds.
  await knex.schema.createTable('rate_limits', (t) => {
    t.string('bucket', 300).primary();
    t.bigInteger('window_start').notNullable();
    t.integer('hits').notNullable();
    t.index(['window_start']);
  });

  // A browser that has signed in to an account. device_hash is sha256 of the hesabu_device cookie.
  await knex.schema.createTable('known_devices', (t) => {
    t.string('device_hash', 64).notNullable();
    t.string('user_id', 24).notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable();
    t.timestamp('last_seen_at', { useTz: true }).notNullable();
    t.primary(['device_hash', 'user_id']);
    t.index(['last_seen_at']);
  });

  await knex.schema.alterTable('users', (t) => {
    t.string('totp_secret', 64); // base32; set once two-step sign-in is on
    t.string('totp_pending', 64); // secret being set up, not yet confirmed with a code
    t.bigInteger('totp_last_step'); // last 30-second step accepted, so a code can't be replayed
    t.text('totp_recovery'); // JSON array of sha256 hashes of unused recovery codes
    t.timestamp('totp_enabled_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('totp_secret');
    t.dropColumn('totp_pending');
    t.dropColumn('totp_last_step');
    t.dropColumn('totp_recovery');
    t.dropColumn('totp_enabled_at');
  });
  await knex.schema.dropTableIfExists('known_devices');
  await knex.schema.dropTableIfExists('rate_limits');
};
