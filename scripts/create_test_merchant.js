// Crée un merchant de démonstration LocalBot
// Usage : node scripts/create_test_merchant.js

require('dotenv').config();
const pool = require('../db/client');

const DEMO_SYSTEM_PROMPT = `Tu es l'assistant virtuel du Restaurant Demo LocalBot.
Réponds de façon chaleureuse, concise et professionnelle en français.

INFORMATIONS DU RESTAURANT :
- Ouvert du mardi au samedi
- Déjeuner : 12h00 – 14h30
- Dîner    : 19h00 – 22h30
- Fermé le dimanche et le lundi
- Menu du jour : 18 € (entrée + plat)
- Menu complet : 29 € (entrée + plat + dessert)
- Capacité : 40 couverts

PRISE DE RÉSERVATION :
Quand un client souhaite réserver, collecte dans l'ordre :
1. Date et heure souhaitées
2. Nombre de personnes
3. Nom pour la réservation
Dès que toutes ces informations sont disponibles, confirme avec :
[RESERVATION: nom=X, date=YYYY-MM-DD, heure=HH:MM, personnes=N]

STYLE DE RÉPONSE :
- Réponses courtes (2-3 phrases max)
- Chaleureux mais professionnel
- Toujours en français

QUESTIONS INCONNUES :
Si la question dépasse tes connaissances sur le restaurant, réponds :
[NEEDS_HUMAN] et propose de transmettre la question à l'équipe.`;

async function main() {
  try {
    const { rows: [merchant] } = await pool.query(
      `INSERT INTO merchant (name, whatsapp_number, plan, system_prompt)
       VALUES ($1, $2, 'trial', $3)
       ON CONFLICT (whatsapp_number) DO UPDATE
         SET name = EXCLUDED.name, plan = EXCLUDED.plan, system_prompt = EXCLUDED.system_prompt
       RETURNING id, name, whatsapp_number, plan`,
      ['Restaurant Demo LocalBot', '+33600000000', DEMO_SYSTEM_PROMPT],
    );

    console.log('✓ Merchant de démonstration créé (ou mis à jour) :');
    console.log(`  id              : ${merchant.id}`);
    console.log(`  name            : ${merchant.name}`);
    console.log(`  whatsapp_number : ${merchant.whatsapp_number}`);
    console.log(`  plan            : ${merchant.plan}`);
  } catch (err) {
    console.error('✗ Erreur :', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
