// Notifications push en base — alertes temps réel pour le dashboard commerçant

const pool = require('../db/client');

/**
 * Insère une notification en base pour le merchant.
 * Non-bloquant : les erreurs sont capturées et loguées sans propager.
 *
 * @param {string} merchantId
 * @param {'new_reservation'|'needs_human'|'daily_summary'} type
 * @param {string} message     - Texte lisible de la notification
 * @param {object} [data={}]   - Données JSON additionnelles
 */
async function sendPushAlert(merchantId, type, message, data = {}) {
  try {
    await pool.query(
      `INSERT INTO notification (merchant_id, type, message, data, read, created_at)
       VALUES ($1, $2, $3, $4, false, now())`,
      [merchantId, type, message, JSON.stringify(data)],
    );

    console.log(JSON.stringify({
      event:      'push_alert_sent',
      merchantId,
      type,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      event:      'push_alert_error',
      merchantId,
      type,
      error:      err.message,
    }));
  }
}

module.exports = { sendPushAlert };
