// Tests sprint 4 — Google Calendar, saveReservation, confirmation client
// Lancement : node tests/test_sprint4.js

require('dotenv').config();

if (!process.env.META_APP_SECRET)   process.env.META_APP_SECRET   = 'test-secret-sprint4';
if (!process.env.META_VERIFY_TOKEN) process.env.META_VERIFY_TOKEN = 'test-verify-token';
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[test] ERREUR : ANTHROPIC_API_KEY manquante dans .env');
  process.exit(1);
}

// Chargement des modules après injection des variables d'env
const app  = require('../index');
const pool = require('../db/client');
const { createReservationEvent }      = require('../calendar/create_event');
const { saveReservation }             = require('../calendar/save_reservation');
const { sendReservationConfirmation,
        formatDateFr }                = require('../notifications/send_confirmation');
const { handleMessage }               = require('../claude/message_handler');
const { invalidateCache }             = require('../claude/merchant_cache');

const PORT = 3096;

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

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { originalLog(`  ✓ ${label}`); passed++; }
  else           { originalError(`  ✗ ${label}`); failed++; }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let testMerchantId;
let testMerchant;
const TEST_WA_NUMBER = '+33644444444';

// System prompt qui force Claude à générer le tag [RESERVATION:...] complet
// dès que toutes les infos sont présentes
const RESERVATION_SYSTEM_PROMPT =
  "Tu es un assistant de restaurant de test. " +
  "RÈGLE ABSOLUE : dès que le client fournit un nom, une date (format YYYY-MM-DD), " +
  "une heure et un nombre de personnes, tu DOIS OBLIGATOIREMENT confirmer avec le tag exact : " +
  "[RESERVATION: nom=X, date=YYYY-MM-DD, heure=HH:MM, personnes=N] " +
  "où X est le nom tel que donné par le client. " +
  "Exemple : [RESERVATION: nom=Jean Martin, date=2026-03-28, heure=19:00, personnes=2]";

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
  const { rows: old } = await pool.query(
    'SELECT id FROM merchant WHERE whatsapp_number = $1',
    [TEST_WA_NUMBER],
  );
  if (old.length > 0) {
    await cleanupTestData(old.map((r) => r.id));
    old.forEach((r) => invalidateCache(r.id));
  }

  const { rows: [m] } = await pool.query(
    `INSERT INTO merchant (name, whatsapp_number, plan, system_prompt)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    ['Restaurant Sprint4', TEST_WA_NUMBER, 'active', RESERVATION_SYSTEM_PROMPT],
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

// ── Insère une conversation de test et retourne son id ────────────────────────
async function insertTestConversation(customerPhone = '33600001001') {
  const { rows: [conv] } = await pool.query(
    `INSERT INTO conversation (merchant_id, customer_phone, channel, status)
     VALUES ($1, $2, 'whatsapp', 'active') RETURNING id`,
    [testMerchantId, customerPhone],
  );
  return conv.id;
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
  originalLog('  Test sprint 4');
  originalLog('═══════════════════════════════════════\n');

  // ── TEST 1 — createReservationEvent sans refresh_token ────────────────────
  originalLog('[ 1 ] createReservationEvent — merchant sans Google Calendar');
  {
    collectedLogs.length = 0;
    const merchantNoCalendar = { ...testMerchant, google_refresh_token: null };
    const result = await createReservationEvent(merchantNoCalendar, {
      customerName:   'Test Client',
      customerPhone:  '33600000001',
      date:           '2026-03-28',
      time:           '19:00',
      partySize:      '2',
      conversationId: 'fake-conv-id',
    });

    assert(result === null, 'Retourne null sans refresh_token');
    assert(
      collectedLogs.some((l) => l.event === 'google_calendar_skipped'),
      'Event google_calendar_skipped loggé',
    );
  }

  // ── TEST 2 — saveReservation insère en base ────────────────────────────────
  originalLog('\n[ 2 ] saveReservation — insertion complète');
  {
    const convId = await insertTestConversation('33600001002');
    const reservId = await saveReservation(
      convId,
      { customerName: 'Marie Dupont', customerPhone: '33600001002', date: '2026-03-28', time: '20:00', partySize: '4' },
      'google-event-abc123',
    );

    const { rows } = await pool.query('SELECT * FROM reservation WHERE id = $1', [reservId]);
    const r = rows[0];

    assert(r?.customer_name  === 'Marie Dupont',      `customer_name = '${r?.customer_name}'`);
    assert(parseInt(r?.party_size, 10) === 4,          `party_size = ${r?.party_size}`);
    assert(r?.status         === 'confirmed',          `status = '${r?.status}'`);
    assert(r?.google_event_id === 'google-event-abc123', `google_event_id présent`);
    assert(r?.booked_for !== null,                     'booked_for renseigné');
  }

  // ── TEST 3 — saveReservation avec google_event_id null ────────────────────
  originalLog('\n[ 3 ] saveReservation — sans google_event_id');
  {
    const convId  = await insertTestConversation('33600001003');
    const reservId = await saveReservation(
      convId,
      { customerName: 'Paul Test', customerPhone: '33600001003', date: '2026-03-29', time: '12:00', partySize: '2' },
      null,
    );

    const { rows } = await pool.query('SELECT google_event_id FROM reservation WHERE id = $1', [reservId]);
    assert(rows.length === 1,               'Insertion réussie malgré google_event_id null');
    assert(rows[0]?.google_event_id === null, 'google_event_id IS NULL en base');
  }

  // ── TEST 4 — sendReservationConfirmation format français ──────────────────
  originalLog('\n[ 4 ] sendReservationConfirmation — format de date français');
  {
    let capturedText = null;
    const mockSendFn = async (_phoneId, _to, text) => { capturedText = text; return true; };

    // 2026-03-20 est un vendredi (vérifié : 01/01/2026 = jeudi → 20/03/2026 = vendredi)
    await sendReservationConfirmation({
      channel:       'whatsapp',
      phoneNumberId: TEST_WA_NUMBER,
      customerPhone: '33600001004',
      merchantName:  'Le Bouchon Test',
      date:          '2026-03-20',
      time:          '19:00',
      partySize:     '3',
      customerName:  'Sophie',
      sendFn:        mockSendFn,
    });

    assert(capturedText !== null,                        'sendFn appelé');
    assert(capturedText.includes('vendredi 20 mars'),    "Date formatée 'vendredi 20 mars'");
    assert(capturedText.includes('Le Bouchon Test'),     'Nom du merchant présent');
    assert(capturedText.includes('Sophie'),              'Prénom du client présent');
  }

  // ── TEST 5 & 6 — Flux complet handleMessage avec réservation ──────────────
  originalLog('\n[ 5 ] handleMessage — flux complet avec réservation (appel Claude réel)');
  originalLog('[ 6 ] handleMessage — tags absents du message client');
  {
    collectedLogs.length = 0;
    const sentMessages = [];  // capture TOUTES les calls à sendFunction

    const mockSend = async (_phoneId, to, text) => {
      sentMessages.push({ to, text });
      return true;
    };

    await handleMessage({
      merchantId:   testMerchantId,
      merchant:     testMerchant,
      customerPhone: '33600001005',
      messageText:  'Je veux réserver pour Jean Martin, le 2026-03-28 à 19h00 pour 2 personnes.',
      channel:      'whatsapp',
      sendFunction: mockSend,
      phoneNumberId: TEST_WA_NUMBER,
    });

    // TEST 5 — Vérifications flux complet
    assert(
      collectedLogs.some((l) => l.event === 'reservation_detected'),
      'Event reservation_detected loggé',
    );
    assert(
      collectedLogs.some((l) => l.event === 'reservation_saved'),
      'reservation_saved loggé (réservation en base)',
    );

    // Vérification DB
    const { rows: convRows } = await pool.query(
      `SELECT id, status FROM conversation WHERE merchant_id = $1 AND customer_phone = $2`,
      [testMerchantId, '33600001005'],
    );
    assert(convRows.length > 0, 'Conversation créée');
    assert(convRows[0]?.status === 'active', `Status reste 'active' (actuel: '${convRows[0]?.status}')`);

    const { rows: reservRows } = await pool.query(
      `SELECT id FROM reservation WHERE conversation_id = $1`,
      [convRows[0]?.id],
    );
    assert(reservRows.length > 0, 'Réservation sauvegardée en base');

    // TEST 6 — Le premier message envoyé au client ne contient pas les tags
    const mainResponseText = sentMessages[0]?.text ?? '';
    assert(!mainResponseText.includes('[RESERVATION'), "Pas de tag [RESERVATION dans le message client");
    assert(!mainResponseText.includes('[NEEDS_HUMAN]'), 'Pas de [NEEDS_HUMAN] dans le message client');
  }

  // ── TEST 7 — booked_for correct en base ───────────────────────────────────
  originalLog('\n[ 7 ] saveReservation — format booked_for correct');
  {
    const convId   = await insertTestConversation('33600001007');
    const reservId = await saveReservation(
      convId,
      { customerName: 'Test Horaire', customerPhone: '33600001007', date: '2026-03-21', time: '19:00', partySize: '2' },
      null,
    );

    const { rows } = await pool.query(
      `SELECT to_char(booked_for AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS bf
       FROM reservation WHERE id = $1`,
      [reservId],
    );
    const bf = rows[0]?.bf ?? '';
    assert(bf.startsWith('2026-03-21') && bf.includes('19:00'), `booked_for = '${bf}' (contient 2026-03-21 et 19:00)`);
  }

  // ── Résultat ───────────────────────────────────────────────────────────────
  originalLog('\n═══════════════════════════════════════');
  if (failed === 0) {
    originalLog(`  Sprint 4 validé (${passed}/${passed + failed} tests passés)\n`);
  } else {
    originalError(`  Sprint 4 — ${failed} test(s) en échec\n`);
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
