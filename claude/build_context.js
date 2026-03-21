// Construction du contexte conversationnel pour Claude
// Récupère le system_prompt du merchant et les N derniers messages depuis PostgreSQL

const pool = require('../db/client');
const { MAX_CONTEXT_MESSAGES, DEFAULT_SYSTEM_PROMPT, MESSAGE_ROLE } = require('../config/constants');
const { generateSystemPrompt } = require('./generate_system_prompt');

// ── Récupération merchant ──────────────────────────────────────────────────────

/**
 * Charge les données d'un merchant depuis PostgreSQL.
 * Retourne null si non trouvé ou en cas d'erreur.
 *
 * @param {string} merchantId - UUID du merchant
 * @returns {Promise<object|null>}
 */
async function fetchMerchant(merchantId) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM merchant WHERE id = $1',
      [merchantId],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error(JSON.stringify({
      event:      'db_fetch_merchant_error',
      merchantId,
      error:      err.message,
    }));
    return null;
  }
}

// ── Récupération messages ──────────────────────────────────────────────────────

/**
 * Charge les N derniers messages d'une conversation depuis PostgreSQL,
 * triés du plus récent au plus ancien, puis réordonnés chronologiquement
 * pour constituer un historique correct pour Claude.
 *
 * @param {string} conversationId
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
async function fetchMessages(conversationId) {
  try {
    const { rows } = await pool.query(
      `SELECT role, content FROM message
       WHERE conversation_id = $1
       ORDER BY sent_at DESC
       LIMIT $2`,
      [conversationId, MAX_CONTEXT_MESSAGES],
    );

    // Réordonnancement chronologique (du plus ancien au plus récent)
    // pour que Claude lise l'historique dans le bon sens
    return rows
      .reverse()
      .map((row) => ({
        role:    row.role === MESSAGE_ROLE.ASSISTANT ? MESSAGE_ROLE.ASSISTANT : MESSAGE_ROLE.USER,
        content: String(row.content ?? ''),
      }))
      .filter((msg) => msg.content.trim().length > 0);

  } catch (err) {
    console.error(JSON.stringify({
      event:          'db_fetch_messages_error',
      conversationId,
      error:          err.message,
    }));
    // En cas d'erreur on renvoie un tableau vide : Claude répondra sans historique
    return [];
  }
}

// ── Point d'entrée principal ───────────────────────────────────────────────────

/**
 * Construit le contexte complet nécessaire pour un appel Claude :
 *  - system_prompt du merchant via generateSystemPrompt (génération auto si vide)
 *  - historique des MAX_CONTEXT_MESSAGES derniers messages de la conversation
 *
 * @param {string}      merchantId
 * @param {string}      conversationId
 * @param {object|null} [merchant=null] - Objet merchant déjà chargé (évite une requête SQL)
 *
 * @returns {Promise<{
 *   systemPrompt:    string,
 *   messages:        Array<{role: string, content: string}>,
 *   conversationId:  string,
 * }>}
 */
async function buildContext(merchantId, conversationId, merchant = null) {
  // Chargements en parallèle pour minimiser la latence
  const [resolvedMerchant, messages] = await Promise.all([
    merchant ? Promise.resolve(merchant) : fetchMerchant(merchantId),
    fetchMessages(conversationId),
  ]);

  // Fallback ultime si merchant introuvable (ne devrait pas arriver en prod)
  const systemPrompt = resolvedMerchant
    ? generateSystemPrompt(resolvedMerchant)
    : DEFAULT_SYSTEM_PROMPT;

  if (!resolvedMerchant) {
    console.warn(JSON.stringify({
      event:      'context_fallback_system_prompt',
      merchantId,
      reason:     'merchant introuvable',
    }));
  }

  console.log(JSON.stringify({
    event:          'context_built',
    merchantId,
    conversationId,
    messageCount:   messages.length,
    usingFallback:  !resolvedMerchant,
  }));

  return { systemPrompt, messages, conversationId };
}

module.exports = { buildContext };
