// Détection d'intentions dans les réponses de Claude
// Extrait les tags structurés [RESERVATION:...] et [NEEDS_HUMAN]

/**
 * Extrait les données de réservation du tag [RESERVATION:...].
 *
 * @param {string} responseText
 * @returns {{ customerName: string, date: string, time: string, partySize: string }|null}
 */
function extractReservationData(responseText) {
  const match = responseText.match(
    /\[RESERVATION:\s*nom=([^,]+),\s*date=([^,]+),\s*heure=([^,]+),\s*personnes=(\d+)\]/i,
  );
  if (!match) return null;
  return {
    customerName: match[1].trim(),
    date:         match[2].trim(),
    time:         match[3].trim(),
    partySize:    match[4].trim(),
  };
}

/**
 * Retourne true si la réponse contient le tag [NEEDS_HUMAN].
 *
 * @param {string} responseText
 * @returns {boolean}
 */
function hasNeedsHuman(responseText) {
  return /\[NEEDS_HUMAN\]/i.test(responseText);
}

/**
 * Supprime les tags [RESERVATION:...] et [NEEDS_HUMAN] du texte
 * avant envoi au client.
 *
 * @param {string} responseText
 * @returns {string}
 */
function cleanResponseText(responseText) {
  return responseText
    .replace(/\[RESERVATION:[^\]]*\]/gi, '')
    .replace(/\[NEEDS_HUMAN\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { extractReservationData, hasNeedsHuman, cleanResponseText };
