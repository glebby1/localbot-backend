// Appel à l'API Claude — retry automatique + mesure de durée

const Anthropic = require('@anthropic-ai/sdk');
const { CLAUDE_MODEL, CLAUDE_MAX_TOKENS } = require('../config/constants');

// Instance unique réutilisée pour toutes les requêtes
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Retry ──────────────────────────────────────────────────────────────────────
const MAX_RETRIES   = 3;
const BACKOFF_MS    = [1_000, 2_000, 4_000]; // délais entre tentatives

/**
 * Attend `ms` millisecondes.
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Appel principal ────────────────────────────────────────────────────────────

/**
 * Appelle Claude avec un historique de messages et un prompt système.
 * Relance automatiquement jusqu'à MAX_RETRIES fois en cas d'erreur transitoire.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 *   Historique de la conversation, du plus ancien au plus récent.
 * @param {string} systemPrompt
 *   Instruction système injectée avant les messages.
 *
 * @returns {Promise<{ text: string, tokensUsed: number }>}
 *   Texte généré et nombre total de tokens consommés (input + output).
 */
async function callClaude(messages, systemPrompt) {
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const startedAt = Date.now();

    try {
      const response = await client.messages.create({
        model:      CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system:     systemPrompt,
        messages,
      });

      const durationMs  = Date.now() - startedAt;
      const text        = response.content[0]?.text ?? '';
      const tokensUsed  = (response.usage?.input_tokens ?? 0)
                        + (response.usage?.output_tokens ?? 0);

      console.log(JSON.stringify({
        event:      'claude_call_success',
        model:      CLAUDE_MODEL,
        attempt:    attempt + 1,
        durationMs,
        tokensUsed,
      }));

      return { text, tokensUsed };

    } catch (err) {
      lastError = err;
      const durationMs = Date.now() - startedAt;

      console.warn(JSON.stringify({
        event:      'claude_call_error',
        attempt:    attempt + 1,
        durationMs,
        error:      err.message,
        status:     err.status ?? null,
      }));

      // Pas de retry sur les erreurs client (4xx sauf 429 rate-limit)
      const status = err.status ?? 0;
      if (status >= 400 && status < 500 && status !== 429) {
        throw err;
      }

      // Attente avant la prochaine tentative (sauf après le dernier essai)
      if (attempt < MAX_RETRIES - 1) {
        await sleep(BACKOFF_MS[attempt]);
      }
    }
  }

  // Toutes les tentatives ont échoué
  console.error(JSON.stringify({
    event:   'claude_call_failed',
    retries: MAX_RETRIES,
    error:   lastError?.message,
  }));
  throw lastError;
}

module.exports = { callClaude };
