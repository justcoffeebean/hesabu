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
| Team | Invite people, set their role, switch accounts off, send password reset links, require two-step sign-in, reset two-step for a lost phone |
| Settings | Company details, payment instructions, currencies and rates, M-Pesa/email/SMS status |

Rules the app enforces: quotations lock once invoiced; payments can't exceed the balance, even when two arrive at the same moment; payments are reversed with a reason, never deleted; clients with documents can't be removed; money is held in integer cents.

## Who can do what

| | Owner | Accounts | Staff |
|---|:-:|:-:|:-:|
| Jobs board, quotations, stock counts, ask a customer to pay by M-Pesa | ✓ | ✓ | ✓ |
| See invoices and clients | ✓ | ✓ | ✓ |
| Clients, items, invoices, payments, recurring, send documents, imports, audit log | ✓ | ✓ | |
| Team, company settings, reminder schedule, M-Pesa registration, M-Pesa refunds | ✓ | | |

The full list is in `src/permissions.js`. Change a role there and both the API and the screens follow.

## Configuration

Copy `.env.example` to `.env`. Everything is optional locally. Passwords and API keys only ever live in `.env`, never in the Settings screen.

### Email and SMS

- **Email:** set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`. Any SMTP provider works (Gmail with an app password, Zoho, Mailgun, your host).
- **SMS:** set `AT_USERNAME` and `AT_API_KEY` from [Africa's Talking](https://africastalking.com). Use username `sandbox` to test.
- `MAIL_TRANSPORT=log` / `SMS_TRANSPORT=log` print messages to the terminal instead of sending. Useful to see what clients would get.

Reminders are **off** until the owner turns them on under Reminders, so upgrading never surprises a client.

### M-Pesa (Daraja)

What you get once it's connected:

- **Request M-Pesa** on a shilling invoice sends a PIN prompt to the customer's phone; the payment records itself.
- Payments customers make to your paybill or till **on their own** are recorded and matched automatically.
- **Look up M-Pesa code** (Payments): a customer shows you the SMS for a payment that never arrived; Hesabu asks Safaricom and records it. *(Needs an initiator, step 5.)*
- **Refund** (owner only): sends a whole M-Pesa payment back to the customer and reverses it in the books once Safaricom confirms. The owner confirms their password (and two-step code) first. *(Needs an initiator, step 5.)*

#### 1. Sandbox first

1. Sign up at the [Daraja portal](https://developer.safaricom.co.ke), create an app with the M-Pesa sandbox products, and copy its **consumer key** and **consumer secret**.
2. From the portal's test credentials, note the **Lipa na M-Pesa Online** shortcode (`174379`) and its **passkey**.
3. Give Safaricom an https address that reaches your computer. Locally, run a tunnel such as `cloudflared tunnel --url http://localhost:3000` and use the https URL it prints. Daraja refuses callback addresses containing `mpesa`, `safaricom`, `sql`, `exe`, `cmd` or `query`, so pick a domain without them.
4. In `.env`:

   ```bash
   PUBLIC_URL=https://your-tunnel-or-domain.example.com
   DARAJA_ENV=sandbox
   DARAJA_CONSUMER_KEY=...
   DARAJA_CONSUMER_SECRET=...
   DARAJA_PASSKEY=...
   DARAJA_SHORTCODE=174379
   DARAJA_TYPE=paybill
   # A long random string. It becomes part of the callback URLs, so anyone who knows it can post fake payments.
   MPESA_CALLBACK_SECRET=   # node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

5. *Optional, for lookups and refunds:* the portal's test credentials also list an **initiator name** and a way to generate a **security credential** (the initiator's password encrypted with Safaricom's certificate). Add:

   ```bash
   DARAJA_INITIATOR_NAME=testapi
   DARAJA_SECURITY_CREDENTIAL=...   # from the portal's generator
   # …or let Hesabu encrypt it: the initiator's password plus Safaricom's public certificate (.cer) from the Daraja docs.
   # DARAJA_INITIATOR_PASSWORD=...
   # DARAJA_CERT_FILE=/path/to/SandboxCertificate.cer
   ```

6. Restart Hesabu and open **Settings → Test connection**. It checks every setting, that your callback address is one Safaricom will call, that your keys get a token from Safaricom, and that the initiator is usable. It never moves money.
7. Try it for real: make a KES 1 invoice, click **Request M-Pesa**, and enter the phone number registered on the sandbox test credentials (or yours, once live).

The sandbox uses a different test shortcode for paybill (C2B) payments (`600xxx`) than for STK push (`174379`), so test those separately. The connection test warns if the shortcode doesn't fit the environment.

#### 2. Paybill payments customers make on their own

Click **Settings → Register paybill URLs** once (again whenever `PUBLIC_URL` changes). Payments are matched by the account number the customer types:

- an invoice number (`INV-2026-0007`, `inv20260007`) pays that invoice;
- a client's account code (`ACME`) pays that client's oldest invoices first;
- anything else, or anything left over, waits under **Payments → M-Pesa money waiting to be placed**.

For a Buy Goods till, set `DARAJA_TYPE=till`, `DARAJA_SHORTCODE` to the store (head office) number and `DARAJA_PARTY_B` to the till number.

#### 3. Going live

1. Use **Go Live** on the Daraja portal for your real paybill or till. Safaricom sends the production passkey once it's approved.
2. Set `DARAJA_ENV=production`, the production consumer key and secret, the passkey, and your real shortcode. Use your real https domain for `PUBLIC_URL`, and set `NODE_ENV=production`.
3. For lookups and refunds, your business needs an **API operator (initiator)** on the M-Pesa org portal with permission for Transaction Status and Reversal. Your Safaricom account manager can set that up. Use the *production* certificate for its security credential.
4. Restart, run **Test connection**, and click **Register paybill URLs** again.
5. Optional: set `DARAJA_ALLOWED_IPS` to Safaricom's callback addresses (ask Safaricom for the current list) so only they can reach `/hooks`.

#### Trying callbacks without Safaricom

Simulate a paybill payment:

```bash
curl -X POST http://localhost:3000/hooks/c2b/YOUR_MPESA_CALLBACK_SECRET/confirm \
  -H 'Content-Type: application/json' \
  -d '{"TransID":"TEST000001","TransTime":"20260913143015","TransAmount":"5000","BillRefNumber":"ACME","MSISDN":"254711220340","FirstName":"TEST"}'
```

Lookups and refunds are answered at `/hooks/async/YOUR_MPESA_CALLBACK_SECRET/result`. A lookup or refund Safaricom never answers is marked after an hour: a lookup as failed, a refund as "no answer". Check your M-Pesa statement before retrying a refund. M-Pesa won't reverse the same payment twice.

### PostgreSQL

Set `DATABASE_URL=postgres://user:pass@host:5432/hesabu` and start the app; tables are created automatically. SQLite handles one office on one machine well. Use PostgreSQL when the app is hosted and several people use it at once.

Moving existing SQLite data to PostgreSQL isn't automated. For a small business the simplest route is Import (clients, items, opening balances) on the new server.

## Putting it online

- Run it behind a reverse proxy that terminates HTTPS (Caddy, nginx), set `NODE_ENV=production`, `PUBLIC_URL=https://…` and `TRUST_PROXY=1`. With `NODE_ENV=production` the app refuses to start without a valid `PUBLIC_URL`, because sign-in links and M-Pesa callbacks are built from it. Without `PUBLIC_URL` (fine on one computer), invite links use the address in the owner's browser, never a `Host` header a stranger could set.
- Back up the database: copy `data/hesabu.sqlite` while the app is stopped, or use `pg_dump` for PostgreSQL.
- Recurring invoices and reminders run inside the app each morning after `JOBS_HOUR`. Keep the process running (systemd, pm2, Docker). If it was off, it catches up on start.
- The security basics are built in: hashed passwords (scrypt), sessions stored hashed, HttpOnly/SameSite cookies, same-origin checks on every change (Origin, or Sec-Fetch-Site when a browser leaves Origin out), a strict Content-Security-Policy, HSTS when `PUBLIC_URL` is https, and an audit log of sign-ins and changes.
- Guessing is rate limited, and the counts are kept in the database, so a restart doesn't reset them and several servers share them: sign-in per account per IP address (8 per 15 minutes), per IP address across all accounts (30), the first-run setup code (10), and password or two-step checks while signed in (8). Behind a proxy, set `TRUST_PROXY` so they count real visitors rather than the proxy.
- An account under attack from many addresses (20 wrong tries in 15 minutes) pauses sign-in **from new devices only**. Browsers that have signed in to that account before carry a `hesabu_device` cookie and keep working, so an attacker can't lock the real person out.
- **Two-step sign-in:** anyone can turn it on under their name (bottom left) with any authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…). They get ten one-time recovery codes for a lost phone; if those are gone too, an owner can reset it under Team. A reset link changes the password but still asks for the code. Under **Team → Sign-in rules** the owner can require it for owners and accounts; anyone in those roles without it is asked to set it up before they can do anything else.
- Sessions slide forward while used (`SESSION_DAYS`, default 7) but always end `SESSION_MAX_DAYS` (default 30) after sign-in.

## Files

```
server.js                 starts the app, runs migrations and the daily jobs
src/app.js                Express app: security headers, /api, /hooks, static files
src/config.js             every setting, read from .env
src/auth.js               passwords, sessions, CSRF, route guards, rate limits, known devices
src/totp.js               two-step sign-in codes (RFC 6238) and recovery codes
src/permissions.js        roles → what they can do
src/db/                   Knex setup, schema migration, one-time JSON import
src/routes/               REST endpoints, one file per area
src/services/documents.js invoices and quotations: totals, stock, status
src/services/payments.js  recording and reversing payments (row-locked)
src/services/mpesa.js     STK push, paybill confirmations, matching receipts
src/services/daraja.js    Safaricom API client, connection test, initiator credential
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
