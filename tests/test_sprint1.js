// Test d'intégration sprint 1 — mode interactif
// Lancement : node tests/test_sprint1.js

require('dotenv').config();

if (!process.env.META_APP_SECRET)   process.env.META_APP_SECRET   = 'test-secret-sprint1';
if (!process.env.META_VERIFY_TOKEN) process.env.META_VERIFY_TOKEN = 'test-verify-token';
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[test] ERREUR : ANTHROPIC_API_KEY manquante dans .env');
  process.exit(1);
}

const crypto   = require('crypto');
const http     = require('http');
const readline = require('readline');

const app  = require('../index');
const pool = require('../db/client');
const PORT = 3099;

// Numéro WhatsApp Business du merchant existant en DB
const FAKE_PHONE_NUMBER_ID = '+33600000001';
// Numéro fictif simulant un client qui envoie un message
const FAKE_CUSTOMER_PHONE  = '33699999999';

// ── Collecte des logs ──────────────────────────────────────────────────────────
const collectedLogs = [];
const originalLog   = console.log.bind(console);
const originalWarn  = console.warn.bind(console);
const originalError = console.error.bind(console);

function interceptLog(level, args) {
  (level === 'log' ? originalLog : level === 'warn' ? originalWarn : originalError)(...args);
  try {
    collectedLogs.push(JSON.parse(args[0]));
  } catch { /* non-JSON, ignoré */ }
}
console.log   = (...a) => interceptLog('log',   a);
console.warn  = (...a) => interceptLog('warn',  a);
console.error = (...a) => interceptLog('error', a);

// ── Helpers ────────────────────────────────────────────────────────────────────

function waitFor(fn, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv    = setInterval(() => {
      if (fn()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`waitFor timeout après ${timeoutMs} ms`));
      }
    }, 100);
  });
}

function assert(condition, label) {
  if (condition) originalLog(`  ✓ ${label}`);
  else { originalError(`  ✗ ${label}`); process.exitCode = 1; }
}

/** Demande une saisie à l'utilisateur et retourne la réponse. */
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/** Attend que l'utilisateur appuie sur Entrée. */
function pauseForUser(message) {
  return prompt(message);
}

/**
 * Envoie un POST webhook WhatsApp.
 * @param {string} messageText
 * @param {string} secret          - Secret HMAC pour la signature
 * @param {string} [phoneNumberId] - Numéro expéditeur (défaut : FAKE_PHONE_NUMBER_ID)
 */
function postWebhook(messageText, secret, phoneNumberId = FAKE_PHONE_NUMBER_ID) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'test-entry',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: phoneNumberId,
            phone_number_id:      phoneNumberId,
          },
          messages: [{
            id:        `test-msg-${Date.now()}`,
            from:      FAKE_CUSTOMER_PHONE,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type:      'text',
            text:      { body: messageText },
          }],
        },
        field: 'messages',
      }],
    }],
  };

  return new Promise((resolve, reject) => {
    const bodyStr   = JSON.stringify(payload);
    const signature = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(Buffer.from(bodyStr))
      .digest('hex');

    const req = http.request({
      hostname: 'localhost', port: PORT, path: '/webhook/whatsapp', method: 'POST',
      headers: {
        'Content-Type':        'application/json',
        'Content-Length':      Buffer.byteLength(bodyStr),
        'x-hub-signature-256': signature,
      },
    }, (res) => { res.resume(); resolve(res.statusCode); });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Fixtures DB ────────────────────────────────────────────────────────────────

let testMerchantId;

/** Récupère l'id du merchant existant via son numéro WhatsApp. */
async function setupTestMerchant() {
  const { rows } = await pool.query(
    'SELECT id, name, system_prompt FROM merchant WHERE whatsapp_number = $1',
    [FAKE_PHONE_NUMBER_ID],
  );
  if (!rows[0]) throw new Error(`Aucun merchant trouvé avec whatsapp_number = ${FAKE_PHONE_NUMBER_ID}`);
  testMerchantId = rows[0].id;
  originalLog(`[test] Merchant trouvé : "${rows[0].name}" (${testMerchantId})`);

  if (rows[0].system_prompt?.trim()) {
    originalLog(`[test] System prompt DB :\n${rows[0].system_prompt.trim()}\n`);
  } else {
    originalWarn('[test] system_prompt vide en DB → fallback sur DEFAULT_SYSTEM_PROMPT (Le Bouchon Test)');
  }
}

/**
 * Supprime uniquement les conversations et messages créés pendant le test.
 * Le merchant réel n'est pas touché.
 */
async function teardown() {
  if (!testMerchantId) return;
  await pool.query(
    `DELETE FROM message WHERE conversation_id IN (
       SELECT id FROM conversation
       WHERE merchant_id = $1 AND customer_phone = $2
     )`,
    [testMerchantId, FAKE_CUSTOMER_PHONE],
  );
  await pool.query(
    'DELETE FROM conversation WHERE merchant_id = $1 AND customer_phone = $2',
    [testMerchantId, FAKE_CUSTOMER_PHONE],
  );
  originalLog('[test] Conversation et messages de test nettoyés (merchant conservé)');
}

// ── Suite de tests ─────────────────────────────────────────────────────────────

async function runTests() {
  const server = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 300));

  if (!process.env.DATABASE_URL) {
    originalError('[test] DATABASE_URL manquante — impossible de continuer');
    server.close(); process.exit(1);
  }

  try {
    await setupTestMerchant();
  } catch (err) {
    originalError(`[test] Setup DB échoué : ${err.message}`);
    originalError('[test] Vérifie que le merchant avec whatsapp_number=33600000001 existe en DB.');
    server.close(); process.exit(1);
  }

  originalLog('\n═══════════════════════════════════════');
  originalLog('  Test sprint 1 — Flux WhatsApp complet');
  originalLog('═══════════════════════════════════════\n');

  // ── Test 1 : réponse 200 immédiate ──────────────────────────────────────────
  // phoneNumberId inconnu → merchant introuvable → pas d'appel Claude, pas de pollution de contexte
  originalLog('[ 1 ] Réponse HTTP immédiate');
  const statusCode = await postWebhook('ping', process.env.META_APP_SECRET, 'unknown-number');
  assert(statusCode === 200, `Statut HTTP : ${statusCode} (attendu 200)`);

  // ── Test 2 : signature invalide → 403 ───────────────────────────────────────
  originalLog('\n[ 2 ] Rejet signature invalide');
  const badStatus = await postWebhook('ping', 'mauvais-secret', 'unknown-number');
  assert(badStatus === 403, `Statut HTTP : ${badStatus} (attendu 403)`);

  // ── Saisie interactive du message ──────────────────────────────────────────
  // Les tests 1 & 2 n'appellent pas Claude (merchant inconnu) → pas de logs async à attendre
  originalLog('\n───────────────────────────────────────');
  collectedLogs.length = 0;

  const userMessage = await prompt('[ → ] Ton message pour Le Bouchon Lyonnais : ');
  if (!userMessage) {
    originalWarn('[test] Message vide — abandon');
    await teardown(); server.close(); await pool.end(); return;
  }

  originalLog('\n[ 3 ] Envoi du message et attente de la réponse Claude...');
  await postWebhook(userMessage, process.env.META_APP_SECRET);

  // ── Attente + affichage de la réponse ─────────────────────────────────────
  try {
    await waitFor(
      () => collectedLogs.some((l) => l.event === 'message_saved' && l.role === 'assistant'),
      25_000,
    );
  } catch {
    originalError('  ✗ Timeout — Claude n\'a pas répondu dans les temps');
    process.exitCode = 1;
  }

  const claudeLog    = collectedLogs.find((l) => l.event === 'claude_call_success');
  const assistantMsg = collectedLogs.find((l) => l.event === 'message_saved' && l.role === 'assistant');

  // Récupère le contenu exact de la réponse depuis la DB
  let responseText = '(non disponible)';
  if (assistantMsg?.messageId) {
    try {
      const { rows } = await pool.query(
        'SELECT content FROM message WHERE id = $1',
        [assistantMsg.messageId],
      );
      if (rows[0]) responseText = rows[0].content;
    } catch { /* on affiche ce qu'on a */ }
  }

  originalLog('\n┌─ Réponse de Claude ───────────────────');
  originalLog(`│ ${responseText.replace(/\n/g, '\n│ ')}`);
  originalLog('└───────────────────────────────────────');
  if (claudeLog) {
    originalLog(`  (${claudeLog.tokensUsed} tokens, ${claudeLog.durationMs} ms)`);
  }

  // ── Assertions ────────────────────────────────────────────────────────────
  originalLog('\n[ 4 ] Vérifications');
  assert(!!claudeLog, 'Claude a répondu');
  assert(claudeLog?.tokensUsed > 0, `tokensUsed = ${claudeLog?.tokensUsed}`);
  const savedMessages = collectedLogs.filter((l) => l.event === 'message_saved');
  assert(savedMessages.length >= 2, `${savedMessages.length} message(s) sauvegardé(s) en DB (attendu ≥ 2)`);
  assert(!!assistantMsg, 'Réponse assistant persistée en DB');

  // ── Pause avant nettoyage ─────────────────────────────────────────────────
  originalLog('\n───────────────────────────────────────');
  await pauseForUser('Appuie sur Entrée pour nettoyer les données de test...');

  // ── Résumé ────────────────────────────────────────────────────────────────
  if (process.exitCode === 1) originalError('  Résultat : ÉCHEC\n');
  else originalLog('  Résultat : OK\n');

  await teardown();
  server.close();
  await pool.end();
}

runTests().catch((err) => {
  originalError('[test] Erreur inattendue :', err);
  process.exit(1);
});
