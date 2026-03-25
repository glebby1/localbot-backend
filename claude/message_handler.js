// Handler mutualisé WhatsApp + Instagram
// Orchestre le flux complet : conversation → contexte → Claude → envoi → persistance

const { buildContext }                              = require('./build_context');
const { callClaude }                                = require('./call_claude');
const { getOrCreateConversation, saveMessage,
        setConversationStatus }                     = require('./conversation_manager');
const { extractReservationData, hasNeedsHuman,
        cleanResponseText }                         = require('./intent_detector');
const { saveFaqSuggestion }                         = require('../db/faq_suggestion');
const { createReservationEvent }                    = require('../calendar/create_event');
const { saveReservation }                           = require('../calendar/save_reservation');
const { sendReservationConfirmation }               = require('../notifications/send_confirmation');
const { sendPushAlert }                             = require('../notifications/push_alert');
// Import du module complet (non destructuré) pour permettre le mock dans les tests
const stripeCheck                                   = require('../payments/stripe_check');

/**
 * Flux complet de traitement d'un message entrant (WhatsApp ou Instagram).
 *
 * @param {object}   params
 * @param {string}   params.merchantId      - UUID du merchant
 * @param {object}   params.merchant        - Objet merchant complet (évite une requête SQL)
 * @param {string}   params.customerPhone   - Identifiant du client (téléphone ou instagram user id)
 * @param {string}   params.messageText     - Contenu du message reçu
 * @param {string}   params.channel         - 'whatsapp' | 'instagram'
 * @param {Function} params.sendFunction    - Fonction d'envoi (signature: (phoneNumberId, to, text) => Promise)
 * @param {string}   params.phoneNumberId   - ID de canal sortant (whatsapp phone id ou instagram page id)
 *
 * @returns {Promise<{ responseText: string, cleanedText: string, conversationId: string }>}
 */
async function handleMessage({ merchantId, merchant, customerPhone, messageText, channel, sendFunction, phoneNumberId }) {
  // 0. Vérifier que l'abonnement Stripe est actif
  const isActive = await stripeCheck.isMerchantActive(merchant);
  if (!isActive) {
    await sendFunction(phoneNumberId, customerPhone, 'Ce service est temporairement suspendu.');
    console.log(JSON.stringify({
      event:      'merchant_suspended',
      merchantId,
    }));
    return { responseText: '', cleanedText: '', conversationId: null };
  }

  // 1. Récupérer ou créer la conversation
  const conversationId = await getOrCreateConversation(merchantId, customerPhone, channel);

  // 2. Construire le contexte (system_prompt + historique)
  const { systemPrompt, messages } = await buildContext(merchantId, conversationId, merchant);

  // 3. Appeler Claude avec le message courant ajouté à l'historique
  const messagesWithCurrent = [...messages, { role: 'user', content: messageText }];
  const { text: responseText, tokensUsed } = await callClaude(messagesWithCurrent, systemPrompt);

  // 4. Nettoyer les tags avant envoi au client
  const cleanedText = cleanResponseText(responseText);

  // 5. Envoyer la réponse via le canal approprié
  await sendFunction(phoneNumberId, customerPhone, cleanedText);

  // 6. Persister le message client
  await saveMessage(conversationId, 'user', messageText, 0);

  // 7. Persister la réponse complète (avec tags pour analyse future)
  await saveMessage(conversationId, 'assistant', responseText, tokensUsed);

  // 8. Détection [NEEDS_HUMAN]
  if (hasNeedsHuman(responseText)) {
    await setConversationStatus(conversationId, 'needs_human');
    console.log(JSON.stringify({
      event:          'needs_human_detected',
      conversationId,
      merchantId,
    }));
    sendPushAlert(merchantId, 'needs_human',
      'Question en attente de réponse manuelle',
      { conversationId, customerPhone, lastMessage: messageText },
    );
    // Sauvegarder la question comme suggestion FAQ (non bloquant)
    saveFaqSuggestion(merchantId, messageText, conversationId).catch((err) => {
      console.error(JSON.stringify({ event: 'faq_suggestion_error', error: err.message }));
    });
  }

  // 9. Détection [RESERVATION:...] — flux complet de réservation
  const reservationData = extractReservationData(responseText);
  if (reservationData) {
    console.log(JSON.stringify({
      event:          'reservation_detected',
      data:           reservationData,
      conversationId,
      merchantId,
    }));

    try {
      // 9a. Créer l'événement Google Calendar (null si Calendar non configuré)
      const googleEventId = await createReservationEvent(merchant, {
        ...reservationData,
        conversationId,
        customerPhone,
      });

      // 9b. Sauvegarder la réservation en base
      const reservationId = await saveReservation(conversationId, { ...reservationData, customerPhone }, googleEventId);

      // 9b'. Notification push pour le commerçant
      sendPushAlert(merchantId, 'new_reservation',
        `Nouvelle réservation : ${reservationData.customerName} — ${reservationData.date} à ${reservationData.time}`,
        { reservationId, customerName: reservationData.customerName, date: reservationData.date, time: reservationData.time, partySize: reservationData.partySize },
      );

      // 9c. Envoyer la confirmation au client
      await sendReservationConfirmation({
        channel,
        phoneNumberId,
        customerPhone: reservationData.customerPhone || customerPhone,
        merchantName:  merchant.name,
        date:          reservationData.date,
        time:          reservationData.time,
        partySize:     reservationData.partySize,
        customerName:  reservationData.customerName,
        sendFn:        sendFunction,
      });
    } catch (err) {
      console.error(JSON.stringify({
        event:          'reservation_flow_error',
        error:          err.message,
        conversationId,
        merchantId,
      }));
    }
  }

  return { responseText, cleanedText, conversationId };
}

module.exports = { handleMessage };
