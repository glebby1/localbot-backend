// Webhook WhatsApp Business API — vérification Meta + réception des messages entrants

const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');

const { handleMessage }               = require('../claude/message_handler');
const { getMerchantByWhatsappNumber } = require('../claude/merchant_cache');

const router = express.Router();

// ── Déduplication des messages ─────────────────────────────────────────────────
// Map<messageId, timestamp> — évite de traiter deux fois le même message
// (Meta peut renvoyer un même événement en cas d'échec de livraison)
const processedMessages = new Map();
const DEDUP_TTL_MS = 60_000; // 60 secondes

/**
 * Supprime les entrées expirées du cache de déduplication.
 * Appelé avant chaque insertion pour éviter une fuite mémoire.
 */
function purgeExpiredMessages() {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL_MS) processedMessages.delete(id);
  }
}

// ── Validation de signature ────────────────────────────────────────────────────

/**
 * Vérifie la signature HMAC-SHA256 envoyée par Meta dans le header
 * x-hub-signature-256. Utilise une comparaison à temps constant pour
 * prévenir les attaques par timing.
 *
 * @param {Buffer} rawBody   - Corps brut de la requête (Buffer)
 * @param {string} signature - Valeur du header x-hub-signature-256
 * @returns {boolean}
 */
function isValidSignature(rawBody, signature) {
  if (!signature || !process.env.META_APP_SECRET) return false;

  try {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', process.env.META_APP_SECRET)
      .update(rawBody)
      .digest('hex');

    // timingSafeEqual exige deux buffers de même longueur
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

// ── Envoi de message WhatsApp ──────────────────────────────────────────────────

/**
 * Envoie un message texte via l'API WhatsApp Business.
 *
 * @param {string} phoneNumberId - ID du numéro WhatsApp Business expéditeur
 * @param {string} to            - Numéro destinataire (format E.164, ex: 33612345678)
 * @param {string} text          - Texte à envoyer
 * @returns {Promise<boolean>}   - true si succès, false sinon
 */
async function sendWhatsAppMessage(phoneNumberId, to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );

    console.log(JSON.stringify({
      event:         'whatsapp_message_sent',
      phoneNumberId,
      to,
      textLength:    text.length,
    }));

    return true;

  } catch (err) {
    console.error(JSON.stringify({
      event:         'whatsapp_send_error',
      phoneNumberId,
      to,
      error:         err.message,
      status:        err.response?.status ?? null,
      responseData:  err.response?.data  ?? null,
    }));
    return false;
  }
}

// ── Traitement métier ──────────────────────────────────────────────────────────

/**
 * Flux complet de traitement d'un message WhatsApp entrant :
 *  0. Identifie le merchant (via le numéro WhatsApp Business)
 *  1. Récupère / crée la conversation en BDD
 *  2. Construit le contexte (system_prompt + historique) depuis PostgreSQL
 *  3. Appelle Claude pour générer la réponse
 *  4. Envoie la réponse au client via WhatsApp
 *  5. Persiste le message client et la réponse en BDD
 *
 * @param {object} data
 * @param {string} data.phoneNumberId - ID du numéro WhatsApp Business
 * @param {string} data.customerPhone - Numéro de l'expéditeur (format E.164)
 * @param {string} data.messageText   - Contenu textuel du message
 * @param {string} data.messageId     - ID unique du message WhatsApp
 */
async function handleIncomingMessage({ phoneNumberId, customerPhone, messageText, messageId }) {
  // 0. Identifier le merchant via le numéro WhatsApp Business
  const merchant = await getMerchantByWhatsappNumber(phoneNumberId);
  if (!merchant) {
    console.warn(JSON.stringify({ event: 'unknown_whatsapp_number', phoneNumberId, messageId }));
    return;
  }
  if (merchant.plan === 'inactive') {
    console.log(JSON.stringify({ event: 'merchant_inactive', merchantId: merchant.id }));
    return;
  }

  const merchantId = merchant.id;

  console.log(JSON.stringify({
    event:         'whatsapp_message_received',
    messageId,
    phoneNumberId,
    customerPhone,
    merchantId,
    messageText,
    timestamp:     new Date().toISOString(),
  }));

  await handleMessage({
    merchantId,
    merchant,
    customerPhone,
    messageText,
    channel:      'whatsapp',
    sendFunction: sendWhatsAppMessage,
    phoneNumberId,
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/**
 * GET /webhook/whatsapp
 * Handshake de vérification Meta — appelé une seule fois lors de la
 * configuration du webhook dans le portail Meta for Developers.
 */
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log(JSON.stringify({ event: 'whatsapp_webhook_verified' }));
    return res.status(200).send(challenge);
  }

  console.warn(JSON.stringify({ event: 'whatsapp_webhook_verification_failed', token }));
  res.sendStatus(403);
});

/**
 * POST /webhook/whatsapp
 * Réception des événements WhatsApp (messages, statuts de livraison, etc.).
 *
 * Ordre des opérations :
 *  1. Valider la signature Meta (HMAC-SHA256)
 *  2. Répondre 200 immédiatement (Meta exige < 5 s)
 *  3. Traiter le payload de façon asynchrone
 */
router.post('/', (req, res) => {
  // 1. Validation de la signature
  const signature = req.headers['x-hub-signature-256'];
  // req.rawBody est peuplé par le middleware express.json({ verify }) dans index.js.
  // C'est le seul moyen fiable de valider le HMAC sur le payload exact reçu de Meta.
  const rawBody = req.rawBody;

  if (!isValidSignature(rawBody, signature)) {
    console.warn(JSON.stringify({ event: 'whatsapp_invalid_signature' }));
    return res.sendStatus(403);
  }

  // 2. Accusé de réception immédiat
  res.sendStatus(200);

  // 3. Traitement asynchrone (sans bloquer la réponse HTTP)
  (async () => {
    try {
      const body = req.body;

      // Ignorer les pings de vérification renvoyés hors handshake initial
      if (body.object !== 'whatsapp_business_account') return;

      for (const entry of (body.entry || [])) {
        for (const change of (entry.changes || [])) {
          const value = change.value || {};

          // Ignorer les notifications de statut de livraison (sent, delivered, read)
          if (value.statuses && value.statuses.length > 0) continue;

          const messages      = value.messages || [];
          const phoneNumberId = value.metadata?.phone_number_id;

          for (const message of messages) {
            // Ignorer les messages non-texte (audio, image, video, sticker, etc.)
            if (message.type !== 'text') {
              console.log(JSON.stringify({
                event:       'whatsapp_non_text_ignored',
                messageType: message.type,
                messageId:   message.id,
              }));
              continue;
            }

            const messageId = message.id;

            // Déduplication : ignorer si déjà traité dans les 60 dernières secondes
            purgeExpiredMessages();
            if (processedMessages.has(messageId)) {
              console.log(JSON.stringify({ event: 'whatsapp_duplicate_ignored', messageId }));
              continue;
            }
            processedMessages.set(messageId, Date.now());

            await handleIncomingMessage({
              phoneNumberId,
              customerPhone: message.from,
              messageText:   message.text.body,
              messageId,
            });
          }
        }
      }
    } catch (err) {
      console.error(JSON.stringify({
        event:   'whatsapp_processing_error',
        message: err.message,
        stack:   err.stack,
      }));
    }
  })();
});

module.exports = { router, handleIncomingMessage, sendWhatsAppMessage };
