// Vérification de l'abonnement Stripe du merchant
// Cache en mémoire avec TTL 1 heure pour éviter de surcharger l'API Stripe

const Stripe = require('stripe');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 3_600_000; // 1 heure
const cache = new Map(); // Map<subscriptionId, { result: boolean, cachedAt: number }>

// ── Stripe client (initialisé lazily pour permettre les tests sans clé) ────────

let _stripeClient = null;
function getStripeClient() {
  if (!_stripeClient) {
    _stripeClient = Stripe(process.env.STRIPE_SECRET_KEY || '');
  }
  return _stripeClient;
}

// ── Fonction de retrieve — remplaçable dans les tests ─────────────────────────

let _retrieveFn = null;

async function doRetrieve(subscriptionId) {
  if (_retrieveFn) return _retrieveFn(subscriptionId);
  return getStripeClient().subscriptions.retrieve(subscriptionId);
}

// ── API publique ───────────────────────────────────────────────────────────────

/**
 * Vérifie si le merchant a un abonnement Stripe actif.
 *
 * Règles :
 *  - plan === 'trial'                   → true (période d'essai, pas de vérification)
 *  - stripe_subscription_id === null    → true (accès libre, pas encore abonné)
 *  - Sinon : interroge Stripe (avec cache 1h)
 *    - ['active', 'trialing', 'past_due'] → true
 *    - ['canceled', 'unpaid', 'incomplete_expired'] → false
 *    - Erreur Stripe → true (fail open — ne pas couper sur erreur réseau)
 *
 * @param {object} merchant - Objet merchant avec { plan, stripe_subscription_id }
 * @returns {Promise<boolean>}
 */
async function isMerchantActive(merchant) {
  if (merchant.plan === 'trial') return true;
  if (!merchant.stripe_subscription_id) return true;

  const subscriptionId = merchant.stripe_subscription_id;

  // Vérification du cache
  const cached = cache.get(subscriptionId);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const subscription = await doRetrieve(subscriptionId);
    const result = ['active', 'trialing', 'past_due'].includes(subscription.status);

    cache.set(subscriptionId, { result, cachedAt: Date.now() });
    return result;

  } catch (err) {
    logger.warn('stripe_check_error', {
      subscriptionId,
      error: err.message,
    });
    return true; // fail open
  }
}

// ── Helpers de test ────────────────────────────────────────────────────────────
// Exposés uniquement pour les tests — ne pas utiliser en production

function _setRetrieveFn(fn) {
  _retrieveFn = fn;
}

function _clearRetrieveFn() {
  _retrieveFn = null;
}

function _clearCache() {
  cache.clear();
}

module.exports = { isMerchantActive, _setRetrieveFn, _clearRetrieveFn, _clearCache };
