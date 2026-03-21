// Cache mémoire des merchants avec TTL — évite des requêtes SQL répétées
// pour des données peu volatiles (system_prompt, numéros de canal, plan, etc.)

const pool = require('../db/client');
const { CACHE_TTL_MS } = require('../config/constants');

// Map<key, { data: object, cachedAt: number }>
const cache = new Map();

// ── Helpers cache ──────────────────────────────────────────────────────────────

/**
 * Retourne l'entrée du cache si elle existe et n'est pas expirée.
 * @param {string} key
 * @returns {object|null}
 */
function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Stocke une valeur dans le cache avec timestamp.
 * @param {string} key
 * @param {object} data
 */
function setInCache(key, data) {
  cache.set(key, { data, cachedAt: Date.now() });
}

// ── API publique ───────────────────────────────────────────────────────────────

/**
 * Récupère un merchant par son numéro WhatsApp.
 * Utilise le cache (TTL 5 min) pour éviter une requête SQL à chaque message.
 *
 * @param {string} waNumber - Numéro WhatsApp Business (format E.164 sans +)
 * @returns {Promise<object|null>}
 */
async function getMerchantByWhatsappNumber(waNumber) {
  const cacheKey = `wa:${waNumber}`;
  const cached   = getFromCache(cacheKey);
  if (cached) {
    console.log(JSON.stringify({ event: 'merchant_cache_hit', cacheKey }));
    return cached;
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM merchant WHERE whatsapp_number = $1',
      [waNumber],
    );

    const merchant = rows[0] ?? null;

    if (!merchant) {
      console.warn(JSON.stringify({
        event:    'merchant_not_found',
        waNumber,
      }));
      return null;
    }

    setInCache(cacheKey, merchant);
    return merchant;

  } catch (err) {
    console.error(JSON.stringify({
      event:    'db_get_merchant_by_whatsapp_error',
      waNumber,
      error:    err.message,
    }));
    return null;
  }
}

/**
 * Récupère un merchant par son UUID.
 * Utilise le cache (TTL 5 min).
 *
 * @param {string} merchantId - UUID
 * @returns {Promise<object|null>}
 */
async function getMerchantById(merchantId) {
  const cacheKey = `id:${merchantId}`;
  const cached   = getFromCache(cacheKey);
  if (cached) return cached;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM merchant WHERE id = $1',
      [merchantId],
    );

    const merchant = rows[0] ?? null;

    if (!merchant) {
      console.warn(JSON.stringify({
        event:      'merchant_not_found',
        merchantId,
      }));
      return null;
    }

    setInCache(cacheKey, merchant);
    return merchant;

  } catch (err) {
    console.error(JSON.stringify({
      event:      'db_get_merchant_by_id_error',
      merchantId,
      error:      err.message,
    }));
    return null;
  }
}

/**
 * Invalide les entrées de cache pour un merchant donné.
 * À appeler après une mise à jour du merchant (ex: changement de system_prompt).
 *
 * @param {string} merchantId - UUID
 */
function invalidateCache(merchantId) {
  // Supprime l'entrée par id
  cache.delete(`id:${merchantId}`);

  // Supprime aussi l'entrée par numéro WhatsApp si elle est présente
  for (const [key, entry] of cache) {
    if (entry.data?.id === merchantId) {
      cache.delete(key);
    }
  }

  console.log(JSON.stringify({ event: 'merchant_cache_invalidated', merchantId }));
}

/**
 * Récupère un merchant par son instagram_id (page ID Meta).
 * Utilise le cache (TTL 5 min).
 *
 * @param {string} instagramPageId - ID de la page Instagram Business
 * @returns {Promise<object|null>}
 */
async function getMerchantByInstagramId(instagramPageId) {
  const cacheKey = `ig:${instagramPageId}`;
  const cached   = getFromCache(cacheKey);
  if (cached) {
    console.log(JSON.stringify({ event: 'merchant_cache_hit', cacheKey }));
    return cached;
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM merchant WHERE instagram_id = $1',
      [instagramPageId],
    );

    const merchant = rows[0] ?? null;

    if (!merchant) {
      console.warn(JSON.stringify({
        event:            'merchant_not_found',
        instagramPageId,
      }));
      return null;
    }

    setInCache(cacheKey, merchant);
    return merchant;

  } catch (err) {
    console.error(JSON.stringify({
      event:            'db_get_merchant_by_instagram_error',
      instagramPageId,
      error:            err.message,
    }));
    return null;
  }
}

module.exports = { getMerchantByWhatsappNumber, getMerchantById, getMerchantByInstagramId, invalidateCache };
