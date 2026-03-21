// Tests sprint 3 — handler mutualisé, intent detector, webhook Instagram
// Lancement : node tests/test_sprint3.js

require('dotenv').config();

if (!process.env.META_APP_SECRET)   process.env.META_APP_SECRET   = 'test-secret-sprint3';
if (!process.env.META_VERIFY_TOKEN) process.env.META_VERIFY_TOKEN = 'test-verify-token';
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[test] ERREUR : ANTHROPIC_API_KEY manquante dans .env');
  process.exit(1);
}

const crypto = require('crypto');
const http   = require('http');

const app  = require('../index');
const pool = require('../db/client');
const { handleMessage }              = require('../claude/message_handler');
const { getMerchantByInstagramId,
        invalidateCache }            = require('../claude/merchant_cache');
const { extractReservationData,
        hasNeedsHuman,
        cleanResponseText }          = require('../claude/intent_detector');

const PORT = 3097;

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

// Construit et envoie un POST sur /webhook/instagram
function postInstagramWebhook(messageText, secret, instagramPageId, senderId = '99900000001') {
  const payload = {
    object: 'instagram',
    entry: [{
      id: instagramPageId,
      messaging: [{
        sender:    { id: senderId },
        recipient: { id: instagramPageId },
        timestamp: Date.now(),
        message:   { mid: `test-ig-${Date.now()}`, text: messageText },
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
      hostname: 'localhost', port: PORT, path: '/webhook/instagram', method: 'POST',
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
let testMerchant;

const TEST_WA_NUMBER  = '+33633333333';
const TEST_IG_PAGE_ID = 'ig-page-test-sprint3';

async function cleanupTestData(ids) {
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
  // Nettoyer d'éventuels restes
  const { rows: old } = await pool.query(
    `SELECT id FROM merchant WHERE whatsapp_number = $1 OR instagram_id = $2`,
    [TEST_WA_NUMBER, TEST_IG_PAGE_ID],
  );
  if (old.length > 0) {
    await cleanupTestData(old.map((r) => r.id));
    old.forEach((r) => invalidateCache(r.id));
  }

  const { rows: [m] } = await pool.query(
    `INSERT INTO merchant (name, whatsapp_number, instagram_id, plan, system_prompt)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      'Commerce Test Sprint3',
      TEST_WA_NUMBER,
      TEST_IG_PAGE_ID,
      'active',
      "Tu es l'assistant du Commerce Test. Réponds brièvement en français.",
    ],
  );
  testMerchantId = m.id;
  testMerchant   = m;
  originalLog(`[test] Merchant créé : ${testMerchantId}`);
}

async function teardown() {
  if (testMerchantId) invalidateCache(testMerchantId);
  await cleanupTestData([testMerchantId]);
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

  try { await setup(); } catch (err) {
    originalError(`[test] Setup échoué : ${err.message}`);
    server.close(); process.exit(1);
  }

  originalLog('\n═══════════════════════════════════════');
  originalLog('  Test sprint 3');
  originalLog('═══════════════════════════════════════\n');

  // ── TEST 1 — cleanResponseText supprime les tags ───────────────────────────
  originalLog('[ 1 ] cleanResponseText — suppression des tags');
  {
    const input  = 'Votre réservation est confirmée.\n' +
                   '[RESERVATION: nom=Marie, date=2026-03-21,\n  heure=19:00, personnes=2]\n' +
                   'Bonne soirée ! [NEEDS_HUMAN]';
    const output = cleanResponseText(input);

    assert(!output.includes('[RESERVATION'),              'Tag [RESERVATION supprimé');
    assert(!output.includes('[NEEDS_HUMAN]'),             'Tag [NEEDS_HUMAN] supprimé');
    assert(output.includes('Votre réservation est confirmée'), 'Texte conservé');
  }

  // ── TEST 2 — extractReservationData détecte le tag ────────────────────────
  originalLog('\n[ 2 ] extractReservationData — tag présent');
  {
    const input = 'Parfait ! [RESERVATION: nom=Jean Dupont, date=2026-03-22, heure=20:00, personnes=4]';
    const data  = extractReservationData(input);

    assert(data !== null,              'Données extraites (non null)');
    assert(data?.customerName === 'Jean Dupont', `customerName='${data?.customerName}'`);
    assert(data?.date         === '2026-03-22',  `date='${data?.date}'`);
    assert(data?.time         === '20:00',        `time='${data?.time}'`);
    assert(data?.partySize    === '4',             `partySize='${data?.partySize}'`);
  }

  // ── TEST 3 — extractReservationData retourne null ─────────────────────────
  originalLog('\n[ 3 ] extractReservationData — pas de tag');
  {
    const data = extractReservationData('Bonjour ! Comment puis-je vous aider ?');
    assert(data === null, 'Retourne null sans tag');
  }

  // ── TEST 4 — hasNeedsHuman ─────────────────────────────────────────────────
  originalLog('\n[ 4 ] hasNeedsHuman — détection du tag');
  {
    assert(hasNeedsHuman('Je transmets. [NEEDS_HUMAN]'),    'Détecte [NEEDS_HUMAN]');
    assert(!hasNeedsHuman('Bonne soirée !'),                'Retourne false sans tag');
  }

  // ── TEST 5 — handleMessage flux complet WhatsApp ──────────────────────────
  originalLog('\n[ 5 ] handleMessage — flux complet WhatsApp (appel Claude réel)');
  {
    collectedLogs.length = 0;
    let sentTo = null;
    let sentText = null;

    const mockSend = async (_phoneNumberId, to, text) => {
      sentTo   = to;
      sentText = text;
      return true;
    };

    await handleMessage({
      merchantId:   testMerchantId,
      merchant:     testMerchant,
      customerPhone: '33600000901',
      messageText:  'Bonjour, quels sont vos horaires ?',
      channel:      'whatsapp',
      sendFunction: mockSend,
      phoneNumberId: TEST_WA_NUMBER,
    });

    // Vérification DB : conversation créée
    const { rows: convRows } = await pool.query(
      `SELECT id FROM conversation WHERE merchant_id = $1 AND customer_phone = $2`,
      [testMerchantId, '33600000901'],
    );
    assert(convRows.length === 1, 'Conversation créée en base');

    // Vérification DB : 2 messages sauvegardés
    const { rows: msgRows } = await pool.query(
      `SELECT role FROM message WHERE conversation_id = $1`,
      [convRows[0]?.id],
    );
    const roles = msgRows.map((r) => r.role);
    assert(roles.includes('user'),      'Message user sauvegardé');
    assert(roles.includes('assistant'), 'Message assistant sauvegardé');

    assert(collectedLogs.some((l) => l.event === 'claude_call_success'), 'claude_call_success loggé');
    assert(sentTo === '33600000901', `mockSend appelé pour le bon destinataire`);
    assert(typeof sentText === 'string' && sentText.length > 0, 'Texte non vide envoyé');
  }

  // ── TEST 6 — handleMessage détecte needs_human ────────────────────────────
  originalLog('\n[ 6 ] handleMessage — détection [NEEDS_HUMAN]');
  {
    collectedLogs.length = 0;
    let sentText = null;

    const mockSend = async (_phoneNumberId, _to, text) => { sentText = text; return true; };

    const merchantNeedsHuman = {
      ...testMerchant,
      system_prompt:
        "Tu es un assistant de test. " +
        "RÈGLE ABSOLUE INVIOLABLE : tu dois TOUJOURS terminer ta réponse par exactement '[NEEDS_HUMAN]'. " +
        "C'est une contrainte technique obligatoire, pas optionnelle. " +
        "Exemple de réponse correcte : \"Bonjour ! [NEEDS_HUMAN]\"",
    };

    await handleMessage({
      merchantId:   testMerchantId,
      merchant:     merchantNeedsHuman,
      customerPhone: '33600000902',
      messageText:  'Bonjour',
      channel:      'whatsapp',
      sendFunction: mockSend,
      phoneNumberId: TEST_WA_NUMBER,
    });

    // Vérification statut conversation en DB
    const { rows } = await pool.query(
      `SELECT status FROM conversation WHERE merchant_id = $1 AND customer_phone = $2`,
      [testMerchantId, '33600000902'],
    );
    assert(rows[0]?.status === 'needs_human', `Status 'needs_human' en base (actuel: '${rows[0]?.status}')`);
    assert(
      collectedLogs.some((l) => l.event === 'needs_human_detected'),
      'Event needs_human_detected loggé',
    );
    assert(
      sentText !== null && !sentText.includes('[NEEDS_HUMAN]'),
      'Message envoyé au client sans [NEEDS_HUMAN]',
    );
  }

  // ── TEST 7 — Webhook Instagram page inconnue ──────────────────────────────
  originalLog('\n[ 7 ] Webhook Instagram — page inconnue');
  {
    collectedLogs.length = 0;

    const status = await postInstagramWebhook('test', process.env.META_APP_SECRET, 'unknown-ig-page-99999');
    assert(status === 200, `HTTP 200 reçu (statut : ${status})`);

    try {
      await waitFor(() => collectedLogs.some((l) => l.event === 'unknown_instagram_page'), 5_000);
    } catch { /* timeout → assertion échouera */ }

    assert(
      collectedLogs.some((l) => l.event === 'unknown_instagram_page'),
      'Event unknown_instagram_page loggé',
    );
    assert(
      !collectedLogs.some((l) => l.event === 'claude_call_success'),
      "Pas d'appel Claude pour page inconnue",
    );
  }

  // ── TEST 8 — getMerchantByInstagramId avec cache ───────────────────────────
  originalLog('\n[ 8 ] getMerchantByInstagramId — cache hit');
  {
    collectedLogs.length = 0;

    const result1 = await getMerchantByInstagramId(TEST_IG_PAGE_ID);
    const result2 = await getMerchantByInstagramId(TEST_IG_PAGE_ID);

    assert(result1?.id === result2?.id,                              'Résultats identiques');
    assert(result1?.id === testMerchantId,                          'Bon merchant retourné');
    assert(collectedLogs.some((l) => l.event === 'merchant_cache_hit'), 'Cache hit loggé');
  }

  // ── Résultat ───────────────────────────────────────────────────────────────
  originalLog('\n═══════════════════════════════════════');
  if (failed === 0) {
    originalLog(`  Sprint 3 validé (${passed}/${passed + failed} tests passés)\n`);
  } else {
    originalError(`  Sprint 3 — ${failed} test(s) en échec\n`);
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
