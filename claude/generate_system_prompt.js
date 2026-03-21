// Génération dynamique du system prompt pour un merchant
// Si system_prompt est défini en DB : retourne tel quel
// Sinon : construit un prompt structuré à partir des champs du merchant

/**
 * Génère le system prompt à envoyer à Claude pour un merchant donné.
 *
 * @param {object} merchantData - Données du merchant (colonnes de la table merchant)
 * @returns {string} System prompt final
 */
function generateSystemPrompt(merchantData) {
  // Prompt custom défini manuellement → retour direct
  if (merchantData.system_prompt?.trim()) {
    return merchantData.system_prompt.trim();
  }

  const { name, type, address, hours, services, rules } = merchantData;

  let prompt = `Tu es l'assistant de ${name || 'ce commerce'}.`;

  if (type)    prompt += `\nC'est un(e) ${type}.`;
  if (address) prompt += `\nAdresse : ${address}.`;

  if (hours) {
    prompt += `\n\nHORAIRES :\n${hours}`;
  }

  if (services) {
    prompt += `\n\nSERVICES/MENU :\n${services}`;
  }

  if (rules) {
    prompt += `\n\nRÈGLES :\n${rules}`;
  }

  prompt += `

STYLE DE RÉPONSE :
- Réponds toujours en français, ton chaleureux et professionnel
- Phrases courtes, pas d'émojis, vouvoie le client

RÉSERVATIONS :
- Quand le client veut réserver, collecte dans l'ordre les infos manquantes uniquement : date, heure, nombre de personnes, prénom, numéro de téléphone
- Ne redemande jamais une info déjà donnée dans le message
- Une fois les 5 infos collectées, confirme avec le tag :
  [RESERVATION: nom=X, date=YYYY-MM-DD, heure=HH:MM, personnes=N]

QUESTIONS INCONNUES :
- Si tu ne connais pas la réponse, dis : "Je transmets votre question à notre équipe."
- Ajoute [NEEDS_HUMAN] à la fin de ta réponse
- Ne jamais inventer d'informations sur le commerce.`;

  return prompt;
}

module.exports = { generateSystemPrompt };
