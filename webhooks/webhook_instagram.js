// Webhook Instagram Graph API — vérification Meta + réception des DM entrants

const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');

const { handleMessage }              = require('../claude/message_handler');
const { getMerchantByInstagramId }   = require('../claude/merchant_cache');

const router = express.Router();

// ── Déduplication des messages ─────────────────────────────────────────────────
const processedMessages = new Map();
const DEDUP_TTL_MS = 60_000;

function purgeExpiredMessages() {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL_MS) processedMessages.delete(id);
  }
}

// ── Validation de signature ────────────────────────────────────────────────────

function isValidSignature(rawBody, signature) {
  if (process.env.NODE_ENV !== 'production') return true;
  const secret = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;
  if (!signature || !secret) return false;
  try {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Envoi de message Instagram ─────────────────────────────────────────────────

/**
 * Envoie un message texte via l'API Instagram Graph.
 *
 * @param {string} pageId      - ID de la page Instagram Business (non utilisé dans l'URL /me/)
 * @param {string} recipientId - Instagram user ID du destinataire
 * @param {string} text        - Texte à envoyer
 * @returns {Promise<boolean>}
 */
async function sendInstagramMessage(pageId, recipientId, text) {
  try {
    await axios.post(
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: recipientId },
        message:   { text },
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.INSTAGRAM_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );

    console.log(JSON.stringify({
      event:       'instagram_message_sent',
      pageId,
      recipientId,
      textLength:  text.length,
    }));

    return true;

  } catch (err) {
    console.error(JSON.stringify({
      event:        'instagram_send_error',
      pageId,
      recipientId,
      error:        err.message,
      status:       err.response?.status ?? null,
      responseData: err.response?.data   ?? null,
    }));
    return false;
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/**
 * GET /instagram
 * Handshake de vérification Meta.
 */
router.get('/instagram', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log(JSON.stringify({ event: 'instagram_webhook_verified' }));
    return res.status(200).send(challenge);
  }

  console.warn(JSON.stringify({ event: 'instagram_webhook_verification_failed', token }));
  res.sendStatus(403);
});

/**
 * POST /instagram
 * Réception des messages Instagram Direct.
 *
 * Ordre des opérations :
 *  1. Valider la signature Meta (HMAC-SHA256)
 *  2. Répondre 200 immédiatement
 *  3. Traiter le payload de façon asynchrone
 */
router.post('/instagram', (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const rawBody   = req.rawBody;

  if (!isValidSignature(rawBody, signature)) {
    console.warn(JSON.stringify({ event: 'instagram_invalid_signature' }));
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  (async () => {
    try {
      const body = req.body;

      if (body.object !== 'instagram') return;

      for (const entry of (body.entry || [])) {
        const instagramPageId = entry.id;

        for (const messaging of (entry.messaging || [])) {
          // Ignorer les messages sans texte (likes, stickers, etc.)
          if (!messaging.message?.text) {
            console.log(JSON.stringify({
              event:     'instagram_non_text_ignored',
              messageId: messaging.message?.mid,
            }));
            continue;
          }

          const messageId  = messaging.message.mid;
          const senderId   = messaging.sender.id;
          const messageText = messaging.message.text;

          // Déduplication
          purgeExpiredMessages();
          if (processedMessages.has(messageId)) {
            console.log(JSON.stringify({ event: 'instagram_duplicate_ignored', messageId }));
            continue;
          }
          processedMessages.set(messageId, Date.now());

          // Identification du merchant via l'instagram page id
          const merchant = await getMerchantByInstagramId(instagramPageId);
          if (!merchant) {
            console.warn(JSON.stringify({
              event:            'unknown_instagram_page',
              instagramPageId,
              messageId,
            }));
            continue;
          }

          if (merchant.plan === 'inactive') {
            console.log(JSON.stringify({ event: 'merchant_inactive', merchantId: merchant.id }));
            continue;
          }

          console.log(JSON.stringify({
            event:            'instagram_message_received',
            messageId,
            instagramPageId,
            senderId,
            merchantId:       merchant.id,
            messageText,
            timestamp:        new Date().toISOString(),
          }));

          await handleMessage({
            merchantId:   merchant.id,
            merchant,
            customerPhone: senderId,
            messageText,
            channel:      'instagram',
            sendFunction: sendInstagramMessage,
            phoneNumberId: instagramPageId,
          });
        }
      }
    } catch (err) {
      console.error(JSON.stringify({
        event:   'instagram_processing_error',
        message: err.message,
        stack:   err.stack,
      }));
    }
  })();
});

module.exports = { router, sendInstagramMessage };
