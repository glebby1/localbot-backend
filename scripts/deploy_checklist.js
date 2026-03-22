// Checklist de déploiement LocalBot
// Vérifie automatiquement que l'environnement est prêt avant de déployer
// Usage : node scripts/deploy_checklist.js

require('dotenv').config();

const REQUIRED_VARS = [
  'ANTHROPIC_API_KEY',
  'META_VERIFY_TOKEN',
  'META_APP_SECRET',
  'WHATSAPP_TOKEN',
  'DATABASE_URL',
  'BUBBLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
];

const OPTIONAL_VARS = ['INSTAGRAM_TOKEN', 'SENDGRID_API_KEY'];

let passed = 0;
let failed = 0;

function ok(label, details = '') {
  console.log(`  ✓ ${label}${details ? ' — ' + details : ''}`);
  passed++;
}

function fail(label, details = '') {
  console.log(`  ✗ ${label}${details ? ' — ' + details : ''}`);
  failed++;
}

async function main() {
  console.log('\n══ LocalBot — Checklist de déploiement ══\n');

  // 1. Variables d'environnement obligatoires
  console.log('[ Variables d\'environnement ]');
  for (const v of REQUIRED_VARS) {
    if (process.env[v] && process.env[v].trim() !== '') {
      ok(`ENV ${v}`);
    } else {
      fail(`ENV ${v}`, 'manquante ou vide');
    }
  }

  // Variables optionnelles (warn seulement)
  for (const v of OPTIONAL_VARS) {
    if (!process.env[v] || process.env[v].trim() === '') {
      console.log(`  ⚠ ${v} non défini (optionnel)`);
    }
  }

  // 2. Connexion PostgreSQL
  console.log('\n[ Connexion PostgreSQL ]');
  try {
    const pool = require('../db/client');
    await pool.query('SELECT 1');
    ok('Connexion PostgreSQL', 'OK');
    await pool.end();
  } catch (err) {
    fail('Connexion PostgreSQL', err.message);
  }

  // 3. Claude API
  console.log('\n[ Claude API ]');
  try {
    const { callClaude } = require('../claude/call_claude');
    const result = await callClaude(
      [{ role: 'user', content: 'Réponds juste OK' }],
      'Tu es un assistant de test. Réponds uniquement OK.',
    );
    if (result?.text) {
      ok('Claude API', result.text.substring(0, 50).trim());
    } else {
      fail('Claude API', 'Réponse vide');
    }
  } catch (err) {
    fail('Claude API', err.message);
  }

  // 4. Stripe API
  console.log('\n[ Stripe API ]');
  try {
    const Stripe = require('stripe');
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');
    await stripe.accounts.retrieve();
    ok('Stripe API', 'OK');
  } catch (err) {
    fail('Stripe API', err.message);
  }

  // 5. Webhook Meta (seulement si PUBLIC_URL est défini)
  console.log('\n[ Webhook Meta ]');
  if (process.env.PUBLIC_URL && process.env.META_VERIFY_TOKEN) {
    try {
      const axios = require('axios');
      const url   = `${process.env.PUBLIC_URL}/webhook/whatsapp`
        + `?hub.mode=subscribe`
        + `&hub.verify_token=${encodeURIComponent(process.env.META_VERIFY_TOKEN)}`
        + `&hub.challenge=test_challenge`;
      const res = await axios.get(url, { timeout: 5000 });
      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      if (body.includes('test_challenge')) {
        ok('Webhook Meta WhatsApp', 'challenge reçu');
      } else {
        fail('Webhook Meta WhatsApp', `réponse inattendue: ${body.substring(0, 50)}`);
      }
    } catch (err) {
      fail('Webhook Meta WhatsApp', err.message);
    }
  } else {
    console.log('  ⚠ Webhook Meta non testé (PUBLIC_URL non défini)');
  }

  // ── Résumé ────────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log('\n════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ✓ Prêt pour le déploiement (${passed}/${total})`);
  } else {
    console.log(`  ✗ ${failed} point(s) en échec — corriger avant de déployer`);
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[checklist] Erreur inattendue :', err.message);
  process.exit(1);
});
