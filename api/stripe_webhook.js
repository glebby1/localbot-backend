// Webhook Stripe — réception et traitement des événements d'abonnement

const express = require('express');
const Stripe  = require('stripe');
const pool    = require('../db/client');
const logger  = require('../utils/logger');

const router = express.Router();

// ── Client Stripe ──────────────────────────────────────────────────────────────

function getStripe() {
  return Stripe(process.env.STRIPE_SECRET_KEY || '');
}

// ── Helpers DB ─────────────────────────────────────────────────────────────────

async function setMerchantPlanBySubscription(subscriptionId, plan) {
  const { rows } = await pool.query(
    `UPDATE merchant SET plan = $1 WHERE stripe_subscription_id = $2 RETURNING id`,
    [plan, subscriptionId],
  );
  return rows[0]?.id ?? null;
}

// ── Route ──────────────────────────────────────────────────────────────────────

/**
 * POST /stripe/webhook
 * Reçoit les événements Stripe signés.
 * Utilise req.rawBody (capturé par express.json({ verify }) dans index.js).
 */
router.post('/webhook', (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !secret) {
    logger.warn('stripe_webhook_missing_config', { hasSig: !!sig, hasSecret: !!secret });
    return res.status(400).json({ error: 'Missing stripe config' });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.rawBody, sig, secret);
  } catch (err) {
    logger.warn('stripe_webhook_invalid_signature', { error: err.message });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Accuser réception immédiatement
  res.json({ received: true });

  // Traitement asynchrone
  (async () => {
    try {
      const type = event.type;
      const obj  = event.data.object;

      if (type === 'customer.subscription.deleted') {
        const subscriptionId = obj.id;
        const merchantId     = await setMerchantPlanBySubscription(subscriptionId, 'inactive');
        logger.info('subscription_canceled', { subscriptionId, merchantId });

      } else if (type === 'invoice.payment_failed') {
        const subscriptionId = obj.subscription;
        const attemptCount   = obj.attempt_count ?? 0;
        if (attemptCount >= 3) {
          const merchantId = await setMerchantPlanBySubscription(subscriptionId, 'inactive');
          logger.info('payment_failed_final', { subscriptionId, merchantId, attemptCount });
        }

      } else if (type === 'customer.subscription.created' || type === 'invoice.paid') {
        const subscriptionId = obj.id ?? obj.subscription;
        const merchantId     = await setMerchantPlanBySubscription(subscriptionId, 'active');
        logger.info('subscription_activated', { subscriptionId, merchantId, eventType: type });
      }

    } catch (err) {
      logger.error('stripe_webhook_processing_error', err, { eventType: event.type });
    }
  })();
});

module.exports = { router };
