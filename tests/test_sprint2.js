// Tests sprint 2 — routage multi-marchands + system prompt dynamique
// Lancement : node tests/test_sprint2.js

require('dotenv').config();

if (!process.env.META_APP_SECRET)   process.env.META_APP_SECRET   = 'test-secret-sprint2';
if (!process.env.META_VERIFY_TOKEN) process.env.META_VERIFY_TOKEN = 'test-verify-token';
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[test] ERREUR : ANTHROPIC_API_KEY manquante dans .env');
  process.exit(1);
}

const crypto = require('crypto');
const http   = require('http');

const app  = require('../index');
const pool = require('../db/client');
const { getOrCreateConversation } = require('../claude/conversation_manager');
const { getMerchantByWhatsappNumber, invalidateCache } = require('../claude/merchant_cache');
const { generateSystemPrompt } = require('../claude/generate_system_prompt');

const PORT = 3098;

// ── Collecte des logs ──────────────────────────────────────────────────────────
const collectedLogs = [];
const originalLog   = console.log.bind(console);
const originalWarn  = console.warn.bind(console);
const originalError = console.error.bind(console);

function interceptLog(level, args) {
  (level === 'log' ? originalLog : level === 'warn' ? originalWarn : originalError)(...args);
  try { collectedLogs.push(JSON.parse(args[0])); } catch { /* non-JSON */ }
}
console.log   = (...a) => interceptLog('log',   a);
console.warn  = (...a) => interceptLog('warn',  a);
console.error = (...a) => interceptLog('error', a);

// ── Helpers ────────────────────────────────────────────────────────────────────

function waitFor(fn, timeoutMs = 8_000) {
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

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { originalLog(`  ✓ ${label}`); passed++; }
  else           { originalError(`  ✗ ${label}`); failed++; }
}

function postWebhook(messageText, secret, phoneNumberId) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'test-entry',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: phoneNumberId, phone_number_id: phoneNumberId },
          messages: [{
            id:        `test-msg-${Date.now()}`,
            from:      '33699000000',
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

let merchantAId, merchantBId;

async function cleanupTestData(ids) {
  if (!ids || ids.length === 0) return;
  const arr = ids.filter(Boolean);
  if (arr.length === 0) return;
  await pool.query(
    `DELETE FROM message WHERE conversation_id IN (
       SELECT id FROM conversation WHERE merchant_id = ANY($1::uuid[])
     )`,
    [arr],
  ).catch(() => {});
  await pool.query(
    `DELETE FROM reservation WHERE conversation_id IN (
       SELECT id FROM conversation WHERE merchant_id = ANY($1::uuid[])
     )`,
    [arr],
  ).catch(() => {});
  await pool.query('DELETE FROM conversation WHERE merchant_id = ANY($1::uuid[])', [arr]).catch(() => {});
  await pool.query('DELETE FROM faq WHERE merchant_id = ANY($1::uuid[])', [arr]).catch(() => {});
  await pool.query('DELETE FROM merchant WHERE id = ANY($1::uuid[])', [arr]).catch(() => {});
}

async function setup() {
  // Ajouter les colonnes de profil merchant si elles n'existent pas encore
  await pool.query('ALTER TABLE merchant ADD COLUMN IF NOT EXISTS type    TEXT');
  await pool.query('ALTER TABLE merchant ADD COLUMN IF NOT EXISTS address TEXT');
  await pool.query('ALTER TABLE merchant ADD COLUMN IF NOT EXISTS hours   TEXT');
  await pool.query('ALTER TABLE merchant ADD COLUMN IF NOT EXISTS services TEXT');
  await pool.query('ALTER TABLE merchant ADD COLUMN IF NOT EXISTS rules   TEXT');

  // Nettoyer d'éventuels restes d'un run précédent
  const { rows: old } = await pool.query(
    `SELECT id FROM merchant WHERE whatsapp_number = ANY($1)`,
    [['+33611111111', '+33622222222']],
  );
  if (old.length > 0) {
    await cleanupTestData(old.map((r) => r.id));
    old.forEach((r) => invalidateCache(r.id));
  }

  // Merchant A — system_prompt défini
  const { rows: [a] } = await pool.query(
    `INSERT INTO merchant (name, whatsapp_number, plan, system_prompt)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['Restaurant Test', '+33611111111', 'active', "Tu es l'assistant du Restaurant Test."],
  );
  merchantAId = a.id;

  // Merchant B — system_prompt vide, champs de profil renseignés
  const { rows: [b] } = await pool.query(
    `INSERT INTO merchant (name, whatsapp_number, plan, system_prompt, type, hours, services)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    ['Salon Test', '+33622222222', 'active', '', 'salon de coiffure', 'lun-sam 9h-19h', 'Coupe femme 45€, coupe homme 25€'],
  );
  merchantBId = b.id;

  originalLog(`[test] Merchants créés : A=${merchantAId} | B=${merchantBId}`);
}

async function teardown() {
  // Invalider le cache avant suppression
  if (merchantAId) invalidateCache(merchantAId);
  if (merchantBId) invalidateCache(merchantBId);
  await cleanupTestData([merchantAId, merchantBId]);
  originalLog('[test] Données de test nettoyées');
}

// ── Suite de tests ─────────────────────────────────────────────────────────────

async function runTests() {
  const server = app.listen(PORT);
  await new Promise((r) => setTimeout(r, 300));

  if (!process.env.DATABASE_URL) {
    originalError('[test] DATABASE_URL manquante');
    server.close(); process.exit(1);
  }

  try {
    await setup();
  } catch (err) {
    originalError(`[test] Setup échoué : ${err.message}`);
    server.close(); process.exit(1);
  }

  originalLog('\n═══════════════════════════════════════');
  originalLog('  Test sprint 2');
  originalLog('═══════════════════════════════════════\n');

  // ── TEST 1 : getOrCreateConversation — conversation existante ──────────────
  originalLog('[ 1 ] getOrCreateConversation — conversation existante');
  {
    const { rows: [conv] } = await pool.query(
      `INSERT INTO conversation (merchant_id, customer_phone, channel, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [merchantAId, '33600000001', 'whatsapp'],
    );
    const existingId = conv.id;

    const returnedId = await getOrCreateConversation(merchantAId, '33600000001', 'whatsapp');
    assert(returnedId === existingId, `Conversation existante retournée (${existingId})`);

    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM conversation WHERE merchant_id = $1 AND customer_phone = $2`,
      [merchantAId, '33600000001'],
    );
    assert(parseInt(rows[0].count, 10) === 1, 'Une seule conversation en base');
  }

  // ── TEST 2 : getOrCreateConversation — nouvelle conversation ───────────────
  originalLog('\n[ 2 ] getOrCreateConversation — nouvelle conversation');
  {
    const newPhone = '33688888888';
    const newId = await getOrCreateConversation(merchantAId, newPhone, 'whatsapp');
    assert(typeof newId === 'string' && newId.length > 0, `Nouvel ID retourné (${newId})`);

    const { rows } = await pool.query('SELECT id FROM conversation WHERE id = $1', [newId]);
    assert(rows.length === 1, 'Conversation créée en base');
  }

  // ── TEST 3 : Cache merchant ────────────────────────────────────────────────
  originalLog('\n[ 3 ] Cache merchant');
  {
    collectedLogs.length = 0;

    const result1 = await getMerchantByWhatsappNumber('+33611111111');
    const result2 = await getMerchantByWhatsappNumber('+33611111111');

    assert(result1?.id === result2?.id, 'Résultats identiques');
    const cacheHit = collectedLogs.some((l) => l.event === 'merchant_cache_hit');
    assert(cacheHit, 'Deuxième appel depuis le cache (merchant_cache_hit loggé)');
  }

  // ── TEST 4 : Numéro WhatsApp inconnu ──────────────────────────────────────
  originalLog('\n[ 4 ] Numéro WhatsApp inconnu');
  {
    collectedLogs.length = 0;

    const status = await postWebhook('test', process.env.META_APP_SECRET, '+33699999999');
    assert(status === 200, `HTTP 200 reçu (statut : ${status})`);

    try {
      await waitFor(
        () => collectedLogs.some((l) => l.event === 'unknown_whatsapp_number'),
        5_000,
      );
    } catch { /* timeout → assertion ci-dessous échouera */ }

    assert(
      collectedLogs.some((l) => l.event === 'unknown_whatsapp_number'),
      'Event unknown_whatsapp_number loggé',
    );
    assert(
      !collectedLogs.some((l) => l.event === 'claude_call_success'),
      'Pas d\'appel Claude pour numéro inconnu',
    );
  }

  // ── TEST 5 : generateSystemPrompt — system_prompt existant ────────────────
  originalLog('\n[ 5 ] generateSystemPrompt — system_prompt défini');
  {
    const prompt = generateSystemPrompt({ system_prompt: 'Prompt custom' });
    assert(prompt === 'Prompt custom', 'Retourne exactement le system_prompt sans modification');
  }

  // ── TEST 6 : generateSystemPrompt — génération automatique ────────────────
  originalLog('\n[ 6 ] generateSystemPrompt — génération automatique');
  {
    const merchantB = await getMerchantByWhatsappNumber('+33622222222');
    const prompt    = generateSystemPrompt(merchantB);

    assert(prompt.includes('Salon Test'),       'Contient le nom du commerce');
    assert(prompt.includes('lun-sam 9h-19h'),   'Contient les horaires');
    assert(prompt.includes('Coupe femme 45€'),  'Contient les services');
    assert(prompt.includes('[RESERVATION:'),    'Contient le tag [RESERVATION:');
    assert(prompt.includes('[NEEDS_HUMAN]'),    'Contient [NEEDS_HUMAN]');
  }

  // ── Résultat ───────────────────────────────────────────────────────────────
  originalLog('\n═══════════════════════════════════════');
  if (failed === 0) {
    originalLog(`  Sprint 2 validé (${passed}/${passed + failed} tests passés)\n`);
  } else {
    originalError(`  Sprint 2 — ${failed} test(s) en échec\n`);
  }

  await teardown();
  server.close();
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  originalError('[test] Erreur inattendue :', err);
  process.exit(1);
});
