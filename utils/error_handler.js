// Middleware Express global de gestion d'erreurs

const logger = require('./logger');

/**
 * Middleware d'erreur Express (4 paramètres requis par Express).
 * Doit être enregistré en DERNIER dans index.js après tous les autres middlewares.
 *
 * @param {Error}    err
 * @param {object}   req
 * @param {object}   res
 * @param {Function} next
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isWebhook = req.path?.startsWith('/webhook');
  const isApi     = req.path?.startsWith('/api');

  // ── Erreur Anthropic API (surcharge ou erreur serveur) ──────────────────────
  if (err.status === 529 || (err.status === 500 && err.name === 'APIError')) {
    logger.error('anthropic_api_error', err, { path: req.path });
    if (isWebhook) {
      // Meta exige toujours 200 pour éviter les relivraisons
      return res.sendStatus(200);
    }
    return res.status(500).json({ error: 'Internal server error' });
  }

  // ── Erreur Google Calendar ──────────────────────────────────────────────────
  if (err.code === 'ENOTFOUND' || (err.errors && err.errors[0]?.domain === 'calendar')) {
    logger.warn('google_calendar_error', { error: err.message, path: req.path });
    if (isWebhook) return res.sendStatus(200);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // ── Erreur PostgreSQL connexion ─────────────────────────────────────────────
  if (err.code === 'ECONNRESET' || err.code === '57P01') {
    logger.error('postgresql_connection_error', err, { path: req.path });
    // Pas de retry automatique ici (doit être géré au niveau métier)
    if (isWebhook) return res.sendStatus(200);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // ── Erreur générique ────────────────────────────────────────────────────────
  logger.error('unhandled_error', err, { path: req.path, method: req.method });

  if (isWebhook) {
    return res.sendStatus(200);
  }

  if (isApi || res.headersSent === false) {
    return res.status(500).json({ error: 'Internal server error' });
  }

  next(err);
}

module.exports = { errorHandler };
