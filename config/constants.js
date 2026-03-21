// Constantes globales de l'application LocalBot

module.exports = {

  // ── Contexte conversationnel ───────────────────────────────────────────────
  // Nombre maximum de messages chargés pour construire le contexte Claude
  MAX_CONTEXT_MESSAGES: 10,

  // ── Claude API ─────────────────────────────────────────────────────────────
  // Modèle utilisé pour toutes les inférences
  CLAUDE_MODEL: 'claude-haiku-4-5-20251001',
  // Nombre maximum de tokens générés par réponse
  CLAUDE_MAX_TOKENS: 1024,

  // ── Réservations ───────────────────────────────────────────────────────────
  // Durée par défaut d'une réservation en minutes (créneaux Google Calendar)
  DEFAULT_RESERVATION_DURATION_MINUTES: 90,

  // ── Cache ──────────────────────────────────────────────────────────────────
  // Durée de vie du cache en millisecondes (5 minutes)
  // Utilisé pour les données Bubble peu volatiles (merchant, FAQ)
  CACHE_TTL_MS: 300_000,

  // ── Statuts de conversation ────────────────────────────────────────────────
  CONVERSATION_STATUS: {
    ACTIVE:       'active',
    CLOSED:       'closed',
    NEEDS_HUMAN:  'needs_human',
  },

  // ── Canaux de messagerie ───────────────────────────────────────────────────
  CHANNEL: {
    WHATSAPP:  'whatsapp',
    INSTAGRAM: 'instagram',
  },

  // ── Rôles des messages (contexte Claude) ──────────────────────────────────
  MESSAGE_ROLE: {
    USER:      'user',
    ASSISTANT: 'assistant',
  },

  // ── Prompt système de fallback ─────────────────────────────────────────────
  // Utilisé quand le merchant n'est pas encore trouvé en base (tests, erreurs BDD).
  // À remplacer par le system_prompt stocké dans Bubble en production.
  DEFAULT_SYSTEM_PROMPT: `Tu es l'assistant virtuel du restaurant "Le Bouchon Test".
Réponds de façon chaleureuse, concise et professionnelle en français.

INFORMATIONS DU RESTAURANT :
- Ouvert du mardi au samedi
- Déjeuner : 12h00 – 14h00
- Dîner    : 19h00 – 22h00
- Fermé le dimanche et le lundi
- Menu fixe unique : 32 € (entrée + plat + dessert)
- Capacité : 40 couverts

PRISE DE RÉSERVATION :
Quand un client souhaite réserver, collecte dans l'ordre :
1. Date et heure souhaitées
2. Nombre de personnes
3. Nom pour la réservation
4. Numéro de téléphone de confirmation
Puis confirme la réservation en utilisant exactement ce format sur une ligne séparée :
[RESERVATION:date=YYYY-MM-DD;time=HH:MM;party=N;name=Prénom Nom]

RÈGLES :
- Si tu ne connais pas la réponse, dis-le honnêtement et propose de joindre l'équipe.
- Ne mentionne jamais d'autres restaurants ni de concurrents.
- Ne donne pas d'informations non listées ci-dessus (allergènes, carte du jour, etc.)
  sans demander d'abord à l'équipe.`,
};
