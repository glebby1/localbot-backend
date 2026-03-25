const pool = require('./client');

/**
 * Sauvegarde une question client comme suggestion FAQ.
 * Évite les doublons : si la même question existe déjà pour ce merchant, ne rien faire.
 */
async function saveFaqSuggestion(merchantId, question, conversationId) {
  await pool.query(
    `INSERT INTO faq_suggestion (merchant_id, question, conversation_id)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (
       SELECT 1 FROM faq_suggestion
       WHERE merchant_id = $1 AND lower(question) = lower($2)
     )`,
    [merchantId, question, conversationId],
  );
}

module.exports = { saveFaqSuggestion };
