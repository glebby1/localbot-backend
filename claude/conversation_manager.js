// Gestion des conversations et messages dans PostgreSQL

const pool = require('../db/client');

/**
 * Retourne la conversation active existante pour ce client/merchant,
 * ou en crée une nouvelle si aucune n'existe.
 *
 * @param {string} merchantId
 * @param {string} customerPhone - Numéro au format E.164
 * @param {string} channel       - 'whatsapp' | 'instagram'
 * @returns {Promise<string>} conversationId (UUID)
 */
async function getOrCreateConversation(merchantId, customerPhone, channel) {
  try {
    // Recherche d'une conversation active existante
    const { rows } = await pool.query(
      `SELECT id FROM conversation
       WHERE merchant_id    = $1
         AND customer_phone = $2
         AND status         = 'active'
       ORDER BY started_at DESC
       LIMIT 1`,
      [merchantId, customerPhone],
    );

    if (rows.length > 0) {
      console.log(JSON.stringify({
        event:          'conversation_found',
        conversationId: rows[0].id,
        merchantId,
        customerPhone,
      }));
      return rows[0].id;
    }

    // Aucune conversation active → on en crée une nouvelle
    const { rows: inserted } = await pool.query(
      `INSERT INTO conversation (merchant_id, customer_phone, channel, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`,
      [merchantId, customerPhone, channel],
    );

    console.log(JSON.stringify({
      event:          'conversation_created',
      conversationId: inserted[0].id,
      merchantId,
      customerPhone,
      channel,
    }));

    return inserted[0].id;

  } catch (err) {
    console.error(JSON.stringify({
      event:         'db_get_or_create_conversation_error',
      merchantId,
      customerPhone,
      error:         err.message,
    }));
    throw err;
  }
}

/**
 * Persiste un message (user ou assistant) dans la table message.
 * Les erreurs sont catchées et loguées sans bloquer le flux principal.
 *
 * @param {string} conversationId
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {number} tokensUsed
 * @returns {Promise<string|null>} UUID du message créé, ou null en cas d'erreur
 */
async function saveMessage(conversationId, role, content, tokensUsed) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO message (conversation_id, role, content, tokens_used)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [conversationId, role, content, tokensUsed],
    );

    console.log(JSON.stringify({
      event:          'message_saved',
      messageId:      rows[0].id,
      conversationId,
      role,
      tokensUsed,
    }));

    return rows[0].id;

  } catch (err) {
    // Non bloquant : on log mais on ne propage pas l'erreur
    console.error(JSON.stringify({
      event:          'db_save_message_error',
      conversationId,
      role,
      error:          err.message,
    }));
    return null;
  }
}

/**
 * Met à jour le statut d'une conversation.
 *
 * @param {string} conversationId
 * @param {'active'|'closed'|'needs_human'} status
 * @returns {Promise<void>}
 */
async function setConversationStatus(conversationId, status) {
  try {
    await pool.query(
      'UPDATE conversation SET status = $1 WHERE id = $2',
      [status, conversationId],
    );

    console.log(JSON.stringify({
      event:          'conversation_status_updated',
      conversationId,
      status,
    }));

  } catch (err) {
    console.error(JSON.stringify({
      event:          'db_set_conversation_status_error',
      conversationId,
      status,
      error:          err.message,
    }));
    throw err;
  }
}

module.exports = { getOrCreateConversation, saveMessage, setConversationStatus };
