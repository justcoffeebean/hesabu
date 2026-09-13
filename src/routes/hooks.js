/**
 * Callbacks from Safaricom. These sit outside /api and outside sign-in; they
 * are protected by the secret in the URL (MPESA_CALLBACK_SECRET) and,
 * optionally, a list of Safaricom's IP addresses (DARAJA_ALLOWED_IPS).
 *
 * Paths avoid words like "mpesa" on purpose — Daraja rejects callback URLs
 * that contain them.
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const { today } = require('../dates');
const mpesa = require('../services/mpesa');

const router = express.Router();
const ACCEPTED = { ResultCode: 0, ResultDesc: 'Accepted' };

function secretOk(given) {
  const expected = config.daraja.callbackSecret;
  if (!expected) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function guard(req, res, next) {
  if (!secretOk(req.params.secret)) return res.status(404).json({ error: 'Not found' });
  if (config.daraja.allowedIps.length && !config.daraja.allowedIps.includes(req.ip)) {
    console.warn(`[hooks] refused callback from ${req.ip}`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

/**
 * Never lose a receipt: if processing blows up (say a database hiccup), store
 * the raw payload so it shows up as unallocated money instead of vanishing.
 */
async function rescue(kind, body, err) {
  console.error(`[hooks] ${kind} processing failed: ${err.message}`, JSON.stringify(body));
  try {
    const receipt = kind === 'c2b' ? body?.TransID : (body?.Body?.stkCallback?.CallbackMetadata?.Item || []).find((i) => i.Name === 'MpesaReceiptNumber')?.Value;
    const amount = kind === 'c2b' ? body?.TransAmount : (body?.Body?.stkCallback?.CallbackMetadata?.Item || []).find((i) => i.Name === 'Amount')?.Value;
    if (!receipt || !amount) return;
    const exists = await db.knex('mpesa_transactions').where({ receipt: String(receipt) }).first();
    if (exists) return;
    await db.knex('mpesa_transactions').insert({
      id: db.newId(), receipt: String(receipt), source: kind, amount_cents: Math.round(Number(amount) * 100), allocated_cents: 0,
      phone: body?.MSISDN || null, bill_ref: body?.BillRefNumber || null, date: today(),
      raw: JSON.stringify(body), created_at: db.now()
    });
  } catch (e) {
    console.error('[hooks] could not even store the raw receipt:', e.message);
  }
}

router.post('/hooks/stk/:secret', guard, async (req, res) => {
  try {
    await mpesa.handleStkCallback(req.body);
  } catch (err) {
    await rescue('stk', req.body, err);
  }
  res.json(ACCEPTED);
});

/** Called before a paybill payment completes, if Safaricom has validation switched on for you. We accept everything and sort it out on confirmation. */
router.post('/hooks/c2b/:secret/validate', guard, (_req, res) => res.json(ACCEPTED));

router.post('/hooks/c2b/:secret/confirm', guard, async (req, res) => {
  try {
    await mpesa.handleC2bConfirmation(req.body);
  } catch (err) {
    await rescue('c2b', req.body, err);
  }
  res.json(ACCEPTED);
});

router.use('/hooks', (_req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;
