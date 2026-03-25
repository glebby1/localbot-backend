const pool = require('./client');

// Seuil de similarité trigram (0 = aucune, 1 = identique)
// 0.6 filtre les reformulations proches tout en laissant passer les vraies nouvelles questions
const SIMILARITY_THRESHOLD = 0.6;

/**
 * Sauvegarde une question client comme suggestion FAQ.
 * Ignorée si une question trop similaire existe déjà dans faq_suggestion ou dans faq.
 */
async function saveFaqSuggestion(merchantId, question, conversationId) {
  await pool.query(
    `INSERT INTO faq_suggestion (merchant_id, question, conversation_id)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (
       SELECT 1 FROM faq_suggestion
       WHERE merchant_id = $1
         AND similarity(lower(question), lower($2)) > $4
     )
     AND NOT EXISTS (
       SELECT 1 FROM faq
       WHERE merchant_id = $1
         AND similarity(lower(question), lower($2)) > $4
     )`,
    [merchantId, question, conversationId, SIMILARITY_THRESHOLD],
  );
}

module.exports = { saveFaqSuggestion };
