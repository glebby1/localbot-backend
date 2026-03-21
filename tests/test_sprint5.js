// Tests sprint 5 — API REST dashboard, notifications, email quotidien
// Lancement : node tests/test_sprint5.js

require('dotenv').config();

if (!process.env.META_APP_SECRET)   process.env.META_APP_SECRET   = 'test-secret-sprint5';
if (!process.env.META_VERIFY_TOKEN) process.env.META_VERIFY_TOKEN = 'test-verify-token';
if (!process.env.BUBBLE_API_KEY)    process.env.BUBBLE_API_KEY    = 'test-bubble-key-sprint5';
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[test] ERREUR : ANTHROPIC_API_KEY manquante dans .env');
  process.exit(1);
}

const app  = require('../index');
const pool = require('../db/client');
const { sendPushAlert } = require('../notifications/push_alert');
const { invalidateCache } = require('../claude/merchant_cache');

const PORT              = 3097;
const BASE_URL          = `http://localhost:${PORT}`;
const AUTH_HEADER       = { Authorization: `Bearer ${process.env.BUBBLE_API_KEY}` };
const TEST_WA_NUMBER    = '+33655555555';

// ── Collecte des logs ──────────────────────────────────────────────────────────
const originalLog   = console.log.bind(console);
const originalWarn  = console.warn.bind(console);
const originalError = console.error.bind(console);
console.log   = (...a) => originalLog(...a);
console.warn  = (...a) => originalWarn(...a);
console.error = (...a) => originalError(...a);

// ── Helpers ────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { originalLog(`  ✓ ${label}`); passed++; }
  else           { originalError(`  ✗ ${label}`); failed++; }
}

async function fetchJson(path, options = {}) {
  const http  = require('http');
  const url   = new URL(path, BASE_URL);
  const body  = options.body ? JSON.stringify(options.body) : undefined;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port:     url.port,
      path:     url.pathname + url.search,
      method:   options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────────
let testMerchantId;
let convActiveId;
let convNeedsHumanId;
let notifId;

async function cleanupTestData(ids) {
  const arr = ids.filter(Boolean);
  if (arr.length === 0) return;
  await pool.query(
    `DELETE FROM notification WHERE merchant_id = ANY($1::uuid[])`, [arr],
  ).catch(() => {});
  await pool.query(
    `DELETE FROM message WHERE conversation_id IN (
       SELECT id FROM conversation WHERE merchant_id = ANY($1::uuid[])
     )`, [arr],
  ).catch(() => {});
  await pool.query(
    `DELETE FROM reservation WHERE conversation_id IN (
       SELECT id FROM conversation WHERE merchant_id = ANY($1::uuid[])
     )`, [arr],
  ).catch(() => {});
  await pool.query('DELETE FROM conversation WHERE merchant_id = ANY($1::uuid[])', [arr]).catch(() => {});
  await pool.query('DELETE FROM faq WHERE merchant_id = ANY($1::uuid[])', [arr]).catch(() => {});
  await pool.query('DELETE FROM merchant WHERE id = ANY($1::uuid[])', [arr]).catch(() => {});
}

async function setup() {
  // Nettoyer d'éventuels restes
  const { rows: old } = await pool.query(
    'SELECT id FROM merchant WHERE whatsapp_number = $1',
    [TEST_WA_NUMBER],
  );
  if (old.length > 0) {
    await cleanupTestData(old.map((r) => r.id));
    old.forEach((r) => invalidateCache(r.id));
  }

  // Créer le merchant de test
  const { rows: [m] } = await pool.query(
    `INSERT INTO merchant (name, whatsapp_number, plan, email)
     VALUES ($1, $2, 'active', $3) RETURNING *`,
    ['Restaurant Sprint5', TEST_WA_NUMBER, 'test-sprint5@localbot.fr'],
  );
  testMerchantId = m.id;
  originalLog(`[test] Merchant créé : ${testMerchantId}`);

  // Créer 2 conversations
  const { rows: [c1] } = await pool.query(
    `INSERT INTO conversation (merchant_id, customer_phone, channel, status)
     VALUES ($1, '33600002001', 'whatsapp', 'active') RETURNING id`,
    [testMerchantId],
  );
  convActiveId = c1.id;

  const { rows: [c2] } = await pool.query(
    `INSERT INTO conversation (merchant_id, customer_phone, channel, status)
     VALUES ($1, '33600002002', 'whatsapp', 'needs_human') RETURNING id`,
    [testMerchantId],
  );
  convNeedsHumanId = c2.id;

  // Insérer 3 messages
  await pool.query(
    `INSERT INTO message (conversation_id, role, content)
     VALUES ($1, 'user', 'Bonjour'),
            ($1, 'assistant', 'Bonjour, en quoi puis-je vous aider ?'),
            ($2, 'user', 'Question complexe')`,
    [convActiveId, convNeedsHumanId],
  );

  // Insérer 1 réservation pour aujourd'hui
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  await pool.query(
    `INSERT INTO reservation (conversation_id, customer_name, customer_phone, party_size, booked_for, status)
     VALUES ($1, 'Test Client Sprint5', '33600002001', 2, $2, 'confirmed')`,
    [convActiveId, `${todayStr} 19:00:00`],
  );
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
  originalLog('  Test sprint 5');
  originalLog('═══════════════════════════════════════\n');

  // ── TEST 1 — GET /stats?period=today ─────────────────────────────────────────
  originalLog('[ 1 ] GET /stats?period=today');
  {
    const res = await fetchJson(
      `/api/merchant/${testMerchantId}/stats?period=today`,
      { headers: AUTH_HEADER },
    );
    assert(res.status === 200, `HTTP 200 (reçu: ${res.status})`);
    const s = res.body?.stats;
    assert(s?.messages_count >= 3,                          `messages_count >= 3 (${s?.messages_count})`);
    assert(s?.needs_human_count >= 1,                       `needs_human_count >= 1 (${s?.needs_human_count})`);
    assert(typeof s?.auto_rate_pct === 'number'
      && s.auto_rate_pct >= 0 && s.auto_rate_pct <= 100,   `auto_rate_pct in [0,100] (${s?.auto_rate_pct})`);
  }

  // ── TEST 2 — Authentification ────────────────────────────────────────────────
  originalLog('\n[ 2 ] GET /stats — authentification');
  {
    const r1 = await fetchJson(`/api/merchant/${testMerchantId}/stats`);
    assert(r1.status === 401, `Sans token → 401 (${r1.status})`);

    const r2 = await fetchJson(
      `/api/merchant/${testMerchantId}/stats`,
      { headers: { Authorization: 'Bearer mauvais-token' } },
    );
    assert(r2.status === 401, `Mauvais token → 401 (${r2.status})`);
  }

  // ── TEST 3 — GET /reservations?date=demain ───────────────────────────────────
  originalLog('\n[ 3 ] GET /reservations?date=demain');
  {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}`;

    // Insérer une réservation pour demain
    await pool.query(
      `INSERT INTO reservation (conversation_id, customer_name, customer_phone, party_size, booked_for, status)
       VALUES ($1, 'Demain Client', '33600002003', 3, $2, 'confirmed')`,
      [convActiveId, `${tomorrowStr} 20:00:00`],
    );

    const res = await fetchJson(
      `/api/merchant/${testMerchantId}/reservations?date=${tomorrowStr}`,
      { headers: AUTH_HEADER },
    );
    assert(res.status === 200, `HTTP 200 (${res.status})`);
    const reservations = res.body?.reservations ?? [];
    assert(
      reservations.some((r) => r.customer_name === 'Demain Client'),
      'Réservation de demain présente dans les résultats',
    );
  }

  // ── TEST 4 — GET /conversations?status=needs_human ───────────────────────────
  originalLog('\n[ 4 ] GET /conversations?status=needs_human');
  {
    const res = await fetchJson(
      `/api/merchant/${testMerchantId}/conversations?status=needs_human`,
      { headers: AUTH_HEADER },
    );
    assert(res.status === 200, `HTTP 200 (${res.status})`);
    const convs = res.body?.conversations ?? [];
    assert(convs.length > 0,                             'Au moins 1 conversation needs_human');
    assert(convs.every((c) => c.status === 'needs_human'), 'Toutes les conv sont needs_human');
    assert(
      convs.some((c) => c.last_message_content !== undefined && c.last_message_content !== null),
      'Dernier message inclus',
    );
  }

  // ── TEST 5 — GET /conversations/:id (détail) ─────────────────────────────────
  originalLog('\n[ 5 ] GET /conversations/:id — détail');
  {
    const res = await fetchJson(
      `/api/merchant/${testMerchantId}/conversations/${convActiveId}`,
      { headers: AUTH_HEADER },
    );
    assert(res.status === 200, `HTTP 200 (${res.status})`);
    const msgs = res.body?.messages ?? [];
    assert(msgs.length >= 2, `Au moins 2 messages (${msgs.length})`);
    // Vérifie ORDER BY sent_at ASC
    const sorted = [...msgs].sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
    assert(
      JSON.stringify(msgs.map((m) => m.id)) === JSON.stringify(sorted.map((m) => m.id)),
      'Messages triés par sent_at ASC',
    );
  }

  // ── TEST 6 — POST /conversations/:id/reply ───────────────────────────────────
  originalLog('\n[ 6 ] POST /conversations/:id/reply');
  {
    // Mock de sendWhatsAppMessage pour ne pas appeler Meta
    const wh = require('../webhooks/webhook_whatsapp');
    const origSend = wh.sendWhatsAppMessage;
    wh.sendWhatsAppMessage = async () => true;

    const res = await fetchJson(
      `/api/merchant/${testMerchantId}/conversations/${convNeedsHumanId}/reply`,
      {
        method:  'POST',
        headers: AUTH_HEADER,
        body:    { text: 'Réponse test du commerçant' },
      },
    );
    assert(res.status === 200, `HTTP 200 (${res.status})`);
    assert(res.body?.success === true, 'success: true');

    // Vérifier en base : message sauvegardé
    const { rows: msgs } = await pool.query(
      `SELECT * FROM message WHERE conversation_id = $1 AND role = 'assistant' AND content = $2`,
      [convNeedsHumanId, 'Réponse test du commerçant'],
    );
    assert(msgs.length > 0, 'Message sauvegardé en base (role=assistant)');

    // Vérifier status repassé à 'active'
    const { rows: [conv] } = await pool.query(
      `SELECT status FROM conversation WHERE id = $1`,
      [convNeedsHumanId],
    );
    assert(conv?.status === 'active', `Status repassé 'active' (${conv?.status})`);

    // Restaurer
    wh.sendWhatsAppMessage = origSend;
  }

  // ── TEST 7 — sendPushAlert crée une notification ──────────────────────────────
  originalLog('\n[ 7 ] sendPushAlert — création en base');
  {
    await sendPushAlert(testMerchantId, 'new_reservation', 'Test notif sprint5', { foo: 'bar' });

    const { rows } = await pool.query(
      `SELECT * FROM notification WHERE merchant_id = $1 AND type = 'new_reservation' ORDER BY created_at DESC LIMIT 1`,
      [testMerchantId],
    );
    assert(rows.length > 0,                     'Notification insérée en base');
    assert(rows[0]?.type === 'new_reservation',  `type = 'new_reservation'`);
    assert(rows[0]?.message === 'Test notif sprint5', 'message correct');
    assert(rows[0]?.read === false,              'read = false');
    notifId = rows[0]?.id;
  }

  // ── TEST 8 — GET /notifications?unread=true ───────────────────────────────────
  originalLog('\n[ 8 ] GET /notifications?unread=true');
  {
    const res = await fetchJson(
      `/api/merchant/${testMerchantId}/notifications?unread=true`,
      { headers: AUTH_HEADER },
    );
    assert(res.status === 200, `HTTP 200 (${res.status})`);
    const notifs = res.body?.notifications ?? [];
    assert(notifs.length > 0,                             'Au moins 1 notification non lue');
    assert(notifs.every((n) => n.read === false),          'Toutes read = false');
    assert(typeof res.body?.unread_count === 'number'
           && res.body.unread_count > 0,                   `unread_count > 0 (${res.body?.unread_count})`);
  }

  // ── TEST 9 — PATCH /notifications/:id ────────────────────────────────────────
  originalLog('\n[ 9 ] PATCH /notifications/:id — marquer lu');
  {
    assert(notifId != null, 'notifId disponible pour le test');

    const res = await fetchJson(
      `/api/merchant/${testMerchantId}/notifications/${notifId}`,
      {
        method:  'PATCH',
        headers: AUTH_HEADER,
        body:    { read: true },
      },
    );
    assert(res.status === 200, `HTTP 200 (${res.status})`);
    assert(res.body?.success === true, 'success: true');

    const { rows: [n] } = await pool.query(
      `SELECT read FROM notification WHERE id = $1`,
      [notifId],
    );
    assert(n?.read === true, 'read = true en base');
  }

  // ── TEST 10 — GET /health ─────────────────────────────────────────────────────
  originalLog('\n[ 10 ] GET /health');
  {
    const res = await fetchJson('/health');
    assert(res.status === 200,              `HTTP 200 (${res.status})`);
    assert(res.body?.status === 'ok',       'status: ok');
    assert(res.body?.db === 'ok',           `db: ok (${res.body?.db})`);
    assert(typeof res.body?.uptime_seconds === 'number', 'uptime_seconds présent');
  }

  // ── Résultat ───────────────────────────────────────────────────────────────────
  originalLog('\n═══════════════════════════════════════');
  if (failed === 0) {
    originalLog(`  Sprint 5 validé (${passed}/${passed + failed} tests passés)\n`);
  } else {
    originalError(`  Sprint 5 — ${failed} test(s) en échec\n`);
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
