/** Builds the Express app. server.js starts it; tests mount it on a random port. */
const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const { HttpError } = require('./errors');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // TRUST_PROXY=1 (hops), true, or a list of proxy addresses like "loopback, 10.0.0.0/8".
  if (config.trustProxy) {
    const v = config.trustProxy;
    app.set('trust proxy', v === 'true' ? true : /^\d+$/.test(v) ? Number(v) : v);
  }

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        // Inline style attributes are used for widths and colours; scripts must come from our own files.
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
        "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    });
    next();
  });

  // Safaricom callbacks: no session, own body limit.
  app.use(express.json({ limit: '5mb' }));
  app.use(require('./routes/hooks'));

  const api = express.Router();
  api.use(auth.sameOrigin);
  api.use(auth.loadUser);
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(require('./routes/auth'));
  api.use(require('./routes/users'));
  api.use(require('./routes/settings'));
  api.use(require('./routes/clients'));
  api.use(require('./routes/items'));
  api.use(require('./routes/quotations'));
  api.use(require('./routes/invoices'));
  api.use(require('./routes/payments'));
  api.use(require('./routes/recurring'));
  api.use(require('./routes/tasks'));
  api.use(require('./routes/dashboard'));
  api.use(require('./routes/records'));
  api.use((_req, res) => res.status(404).json({ error: 'No such endpoint.' }));
  app.use('/api', api);

  app.use(express.static(path.join(config.root, 'public'), { index: 'index.html' }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: "The request body isn't valid JSON." });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
    if (err instanceof HttpError || (err.status && err.status < 500)) {
      return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    }
    if (err.status === 502) return res.status(502).json({ error: err.message });
    console.error(`[${req.method} ${req.originalUrl}]`, err);
    const unique = /unique|duplicate key/i.test(err.message || '');
    res.status(unique ? 409 : 500).json({
      error: unique ? 'That clashes with something that already exists. Reload and try again.' : 'Something broke on the server. It has been logged.'
    });
  });

  return app;
}

module.exports = { createApp };
