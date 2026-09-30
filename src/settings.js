/** Defaults for the settings blobs. Stored values are merged over these. */
const db = require('./db');

const COMPANY = {
  name: 'Your Company Ltd',
  email: 'accounts@yourcompany.co.ke',
  phone: '+254 700 000 000',
  address: 'Nairobi, Kenya',
  kraPin: 'P000000000X',
  vatRate: 16,
  baseCurrency: 'KES',
  paymentTerms: 14,
  paymentInstructions: ''
};

const REMINDERS = {
  enabled: false, // off until the owner turns it on, so an upgrade never surprises clients
  email: true,
  sms: false,
  // Days relative to the due date: 3 days before, on the day, then 7/14/30 days late.
  offsets: [-3, 0, 7, 14, 30]
};

const SECURITY = {
  // When on, owner and accounts users must set up two-step sign-in before they can use the app.
  requireTwoStep: false
};

const company = (conn = db.knex) => db.getSetting(conn, 'company', COMPANY);
const reminders = (conn = db.knex) => db.getSetting(conn, 'reminders', REMINDERS);

const security = (conn = db.knex) => db.getSetting(conn, 'security', SECURITY);

module.exports = { COMPANY, REMINDERS, SECURITY, company, reminders, security };
