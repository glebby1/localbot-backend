// Envoi de la confirmation de réservation au client via WhatsApp ou Instagram

const DAYS_FR   = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
                   'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/**
 * Formate une date ISO en date longue française.
 * Exemple : '2026-03-21' → 'vendredi 21 mars'
 *
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @returns {string}
 */
function formatDateFr(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date      = new Date(year, month - 1, day); // constructeur local (pas UTC)
  const dayName   = DAYS_FR[date.getDay()];
  const monthName = MONTHS_FR[month - 1];
  return `${dayName} ${day} ${monthName}`;
}

/**
 * Envoie un message de confirmation de réservation au client.
 *
 * Pour éviter la dépendance circulaire (webhook → message_handler → send_confirmation → webhook),
 * la fonction d'envoi est passée en paramètre (sendFn).
 * En production, sendFn = sendWhatsAppMessage ou sendInstagramMessage.
 * En test, sendFn = mock.
 *
 * @param {object}   params
 * @param {string}   params.channel        - 'whatsapp' | 'instagram'
 * @param {string}   params.phoneNumberId  - ID du canal sortant (WA phone id ou IG page id)
 * @param {string}   params.customerPhone  - Destinataire
 * @param {string}   params.merchantName   - Nom du commerce
 * @param {string}   params.date           - 'YYYY-MM-DD'
 * @param {string}   params.time           - 'HH:MM'
 * @param {string}   params.partySize      - Nombre de personnes
 * @param {string}   params.customerName   - Prénom/nom du client
 * @param {Function} params.sendFn         - Fonction d'envoi (phoneNumberId, to, text) => Promise
 */
async function sendReservationConfirmation({
  channel, phoneNumberId, customerPhone,
  merchantName, date, time, partySize, customerName,
  sendFn,
}) {
  const dateLong = formatDateFr(date);
  const text = `Votre réservation chez ${merchantName} est confirmée !\n` +
               `${dateLong} à ${time} pour ${partySize} personne(s).\n` +
               `À bientôt, ${customerName} !`;

  await sendFn(phoneNumberId, customerPhone, text);

  console.log(JSON.stringify({
    event:        'reservation_confirmation_sent',
    channel,
    customerPhone,
    merchantName,
  }));
}

module.exports = { sendReservationConfirmation, formatDateFr };
