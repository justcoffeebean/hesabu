# Hesabu

Quotations, invoices, payments and daily jobs for a small business. One Node.js app: SQLite on your laptop, PostgreSQL when a team uses it.

## Run it in VS Code

1. Open the folder: **File → Open Folder → hesabu**
2. Open the terminal: **Ctrl + `** (Cmd + ` on Mac)
3. Install and start (needs Node.js 22 or newer):

```bash
npm install
npm run seed     # optional: demo clients, invoices, stock and three demo sign-ins
npm start
```

4. Open http://localhost:3000

**First run without the demo data:** the terminal prints a setup code. Enter it on the setup screen to create the owner account. Only someone who can see the server's terminal can do this.

**With the demo data:** `npm run seed` prints three sign-ins (owner, accounts, staff) sharing one password. Set `SEED_PASSWORD=...` to choose it.

**Coming from the old version?** On first start, everything in `data/hesabu.json` is copied into the new database. The JSON file is left untouched as a backup.

Press **F5** to run under the debugger. `npm run dev` restarts the server whenever you save.

## What it does

| Screen | What happens there |
|---|---|
| Today | What you're owed (in shillings, with foreign invoices converted), aging, who to chase, low stock, unmatched M-Pesa money |
| Quotations | Draft → sent → accepted, email as PDF, convert to an invoice in one click |
| Invoices | Totals, VAT, balance; download or email the PDF; send a reminder; ask the customer to pay by M-Pesa |
| Recurring | Monthly/weekly/quarterly/yearly invoices that create (and optionally email) themselves |
| Payments | Record M-Pesa, bank, cheque or cash; reverse with a reason; place M-Pesa money that didn't match |
| Operations | To do / in progress / done board for daily jobs |
| Items & stock | Product catalogue; invoicing takes stock out, cancelling puts it back; receive and count stock |
| Clients | Contacts, M-Pesa account code, billing currency, what each one owes |
| Reminders | Automatic email/SMS reminders before and after the due date, and a log of everything sent |
| Import | CSV import of clients, items with opening stock, and opening balances |
| Audit log | Who changed what and when, field by field. Append-only |
| Team | Invite people, set their role, switch accounts off, send password reset links |
| Settings | Company details, payment instructions, currencies and rates, M-Pesa/email/SMS status |

Rules the app enforces: quotations lock once invoiced; payments can't exceed the balance, even when two arrive at the same moment; payments are reversed with a reason, never deleted; clients with documents can't be removed; money is held in integer cents.

## Who can do what

| | Owner | Accounts | Staff |
|---|:-:|:-:|:-:|
| Jobs board, quotations, stock counts, ask a customer to pay by M-Pesa | ✓ | ✓ | ✓ |
| See invoices and clients | ✓ | ✓ | ✓ |
| Clients, items, invoices, payments, recurring, send documents, imports, audit log | ✓ | ✓ | |
| Team, company settings, reminder schedule, M-Pesa registration | ✓ | | |

The full list is in `src/permissions.js`. Change a role there and both the API and the screens follow.

## Configuration

Copy `.env.example` to `.env`. Everything is optional locally. Passwords and API keys only ever live in `.env`, never in the Settings screen.

### Email and SMS

- **Email:** set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`. Any SMTP provider works (Gmail with an app password, Zoho, Mailgun, your host).
- **SMS:** set `AT_USERNAME` and `AT_API_KEY` from [Africa's Talking](https://africastalking.com). Use username `sandbox` to test.
- `MAIL_TRANSPORT=log` / `SMS_TRANSPORT=log` print messages to the terminal instead of sending. Useful to see what clients would get.

Reminders are **off** until the owner turns them on under Reminders, so upgrading never surprises a client.

### M-Pesa (Daraja)

1. Create an app on the [Daraja portal](https://developer.safaricom.co.ke) and copy the consumer key and secret.
2. In `.env` set `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_PASSKEY`, `DARAJA_SHORTCODE`, a random `MPESA_CALLBACK_SECRET`, and `PUBLIC_URL`. `PUBLIC_URL` must be an https address Safaricom can reach; locally, use a tunnel such as `cloudflared tunnel --url http://localhost:3000`.
3. Restart. **Request M-Pesa** now appears on shilling invoices: the customer gets a PIN prompt, and the payment records itself when they pay.
4. So that customers who pay the paybill **on their own** are recorded too, click **Settings → Register paybill URLs** once. Payments are matched by the account number the customer types:
   - an invoice number (`INV-2026-0007`, `inv20260007`) pays that invoice;
   - a client's account code (`ACME`) pays that client's oldest invoices first;
   - anything else, or anything left over, waits under **Payments → M-Pesa money waiting to be placed**.

Go-live: switch `DARAJA_ENV=production` with your production keys after Safaricom approves the app.

Simulate a paybill payment locally:

```bash
curl -X POST http://localhost:3000/hooks/c2b/YOUR_MPESA_CALLBACK_SECRET/confirm \
  -H 'Content-Type: application/json' \
  -d '{"TransID":"TEST0001","TransTime":"20260913143015","TransAmount":"5000","BillRefNumber":"ACME","MSISDN":"254711220340","FirstName":"TEST"}'
```

### PostgreSQL

Set `DATABASE_URL=postgres://user:pass@host:5432/hesabu` and start the app; tables are created automatically. SQLite handles one office on one machine well. Use PostgreSQL when the app is hosted and several people use it at once.

Moving existing SQLite data to PostgreSQL isn't automated. For a small business the simplest route is Import (clients, items, opening balances) on the new server.

## Putting it online

- Run it behind a reverse proxy that terminates HTTPS (Caddy, nginx), set `PUBLIC_URL=https://…` and `TRUST_PROXY=1`.
- Back up the database: copy `data/hesabu.sqlite` while the app is stopped, or use `pg_dump` for PostgreSQL.
- Recurring invoices and reminders run inside the app each morning after `JOBS_HOUR`. Keep the process running (systemd, pm2, Docker). If it was off, it catches up on start.
- The security basics are built in: hashed passwords (scrypt), sessions stored hashed, HttpOnly/SameSite cookies, same-origin checks on every change (Origin, or Sec-Fetch-Site when a browser leaves Origin out), a strict Content-Security-Policy, HSTS when `PUBLIC_URL` is https, and an audit log of sign-ins and changes.
- Guessing is rate limited: sign-in per account and per IP address, the first-run setup code, and the current-password check. Limits reset when the app restarts. Behind a proxy, set `TRUST_PROXY` so they count real visitors rather than the proxy.
- Sessions slide forward while used (`SESSION_DAYS`, default 7) but always end `SESSION_MAX_DAYS` (default 30) after sign-in.

## Files

```
server.js                 starts the app, runs migrations and the daily jobs
src/app.js                Express app: security headers, /api, /hooks, static files
src/config.js             every setting, read from .env
src/auth.js               passwords, sessions, CSRF, route guards
src/permissions.js        roles → what they can do
src/db/                   Knex setup, schema migration, one-time JSON import
src/routes/               REST endpoints, one file per area
src/services/documents.js invoices and quotations: totals, stock, status
src/services/payments.js  recording and reversing payments (row-locked)
src/services/mpesa.js     STK push, paybill confirmations, matching receipts
src/services/daraja.js    Safaricom API client
src/services/recurring.js recurring invoice schedules
src/services/reminders.js reminder stages from the aging data
src/services/messages.js  email/SMS outbox, delivery and retries
src/services/pdf.js       invoice and quotation PDFs
src/services/importer.js  CSV parsing, validation, all-or-nothing import
src/totals.js             subtotal, discount, VAT, balance, aging (in cents)
public/                   the browser app: plain ES modules, no build step
test/                     API tests (node:test)
```

## Tests

```bash
npm test                                                     # SQLite
TEST_DATABASE_URL=postgres://…/hesabu_test npm run test:pg   # PostgreSQL (drops all tables in that database!)
```

The tests run the real app against a throwaway database and a fake Daraja server. They cover sign-in and roles, concurrent payments, stock, currencies, the audit log, M-Pesa callbacks and matching, recurring schedules, reminders, PDFs, CSV import and the JSON upgrade.

## Starting fresh

Run `npm run seed` again (it keeps team accounts), or stop the app and delete `data/hesabu.sqlite`. Also move `data/hesabu.json` out of the way if it's still there, or it will be imported again.
