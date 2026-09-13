const config = require('./src/config');
const db = require('./src/db');
const { createApp } = require('./src/app');
const auth = require('./src/auth');
const scheduler = require('./src/services/scheduler');
const { importLegacyJson } = require('./src/db/import-json');

async function main() {
  await db.migrate();
  await importLegacyJson();

  const app = createApp();
  const server = app.listen(config.port, async () => {
    console.log(`\n  Hesabu is running →  http://localhost:${config.port}`);
    console.log(`  Database: ${db.isPg ? 'PostgreSQL' : config.db.filename}`);
    if (!(await db.knex('users').first('id'))) {
      console.log(`\n  First run: open the app and create the owner account.`);
      console.log(`  Setup code: ${auth.setupCode()}\n`);
    }
  });

  scheduler.start();

  const shutdown = async () => {
    scheduler.stop();
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
