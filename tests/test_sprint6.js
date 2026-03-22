// Tests sprint 6 — Logger, Stripe check, error handler, déploiement
// Lancement : node tests/test_sprint6.js

require('dotenv').config();

// ── Variables d'env de test ────────────────────────────────────────────────────
if (!process.env.META_APP_SECRET)        process.env.META_APP_SECRET        = 'test-secret-sprint6';
if (!process.env.META_VERIFY_TOKEN)      process.env.META_VERIFY_TOKEN      = 'test-verify-token';
if (!process.env.BUBBLE_API_KEY)         process.env.BUBBLE_API_KEY         = 'test-bubble-key-sprint6';
if (!process.env.STRIPE_WEBHOOK_SECRET)  process.env.STRIPE_WEBHOOK_SECRET  = 'whsec_test_sprint6_localbot';
if (!process.env.STRIPE_SECRET_KEY)      process.env.STRIPE_SECRET_KEY      = 'sk_test_fake_sprint6';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[test] ERREUR : ANTHROPIC_API_KEY manquante dans .env');
  process.exit(1);
}

const app           = require('../index');
const pool          = require('../db/client');
const logger        = require('../utils/logger');
const stripeCheck   = require('../payments/stripe_check');
const { handleMessage } = require('../claude/message_handler');
const { invalidateCache } = require('../claude/merchant_cache');

const PORT         = 3098;
const BASE_URL     = `http://localhost:${PORT}`;
const TEST_WA_NUM  = '+33666666666';

// ── Capture des logs ───────────────────────────────────────────────────────────
const collectedLogs  = [];
const originalLog    = console.log.bind(console);
const originalWarn   = console.warn.bind(console);
const originalError  = console.error.bind(console);

function interceptLog(args) {
  try { collectedLogs.push(JSON.parse(args[0])); } catch { /* non-JSON */ }
}
console.log   = (...a) => { originalLog(...a);   interceptLog(a); };
console.warn  = (...a) => { originalWarn(...a);  interceptLog(a); };
console.error = (...a) => { originalError(...a); interceptLog(a); };

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
  const body  = options.body !== undefined ? JSON.stringify(options.body) : undefined;

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
let testMerchant;
const testStripeSubId = `sub_test_sprint6_${Date.now()}`;

async function cleanupTestData(ids) {
  const arr = ids.filter(Boolean);
  if (arr.length === 0) return;
  await pool.query(`DELETE FROM notification WHERE merchant_id = ANY($1::uuid[])`, [arr]).catch(() => {});
  await pool.query(`DELETE FROM message WHERE conversation_id IN (SELECT id FROM conversation WHERE merchant_id = ANY($1::uuid[]))`, [arr]).catch(() => {});
  await pool.query(`DELETE FROM reservation WHERE conversation_id IN (SELECT id FROM conversation WHERE merchant_id = ANY($1::uuid[]))`, [arr]).catch(() => {});
  await pool.query('DELETE FROM conversation WHERE merchant_id = ANY($1::uuid[])', [arr]).catch(() => {});
  await pool.query('DELETE FROM faq WHERE merchant_id = ANY($1::uuid[])', [arr]).catch(() => {});
  await pool.query('DELETE FROM merchant WHERE id = ANY($1::uuid[])', [arr]).catch(() => {});
}

async function setup() {
  const { rows: old } = await pool.query('SELECT id FROM merchant WHERE whatsapp_number = $1', [TEST_WA_NUM]);
  if (old.length > 0) {
    await cleanupTestData(old.map((r) => r.id));
    old.forEach((r) => invalidateCache(r.id));
  }

  const { rows: [m] } = await pool.query(
    `INSERT INTO merchant (name, whatsapp_number, plan, stripe_subscription_id, system_prompt)
     VALUES ($1, $2, 'active', $3, $4) RETURNING *`,
    ['Restaurant Sprint6', TEST_WA_NUM, testStripeSubId,
     'Tu es un assistant. Réponds OK.'],
  );
  testMerchantId = m.id;
  testMerchant   = m;
  originalLog(`[test] Merchant créé : ${testMerchantId} (sub: ${testStripeSubId})`);
}

async function teardown() {
  if (testMerchantId) invalidateCache(testMerchantId);
  await cleanupTestData([testMerchantId]);
  stripeCheck._clearCache();
  stripeCheck._clearRetrieveFn();
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
  originalLog('  Test sprint 6');
  originalLog('═══════════════════════════════════════\n');

  // ── TEST 1 — isMerchantActive plan trial ──────────────────────────────────────
  originalLog('[ 1 ] isMerchantActive — plan trial');
  {
    stripeCheck._clearCache();
    let stripeCalled = false;
    stripeCheck._setRetrieveFn(() => { stripeCalled = true; return { status: 'active' }; });

    const result = await stripeCheck.isMerchantActive({ plan: 'trial', stripe_subscription_id: null });
    assert(result === true,   'isMerchantActive retourne true pour plan trial');
    assert(!stripeCalled,     'Stripe non appelé pour plan trial');

    stripeCheck._clearRetrieveFn();
  }

  // ── TEST 2 — isMerchantActive sans subscription_id ────────────────────────────
  originalLog('\n[ 2 ] isMerchantActive — sans stripe_subscription_id');
  {
    stripeCheck._clearCache();
    let stripeCalled = false;
    stripeCheck._setRetrieveFn(() => { stripeCalled = true; return { status: 'active' }; });

    const result = await stripeCheck.isMerchantActive({ plan: 'active', stripe_subscription_id: null });
    assert(result === true, 'isMerchantActive retourne true sans subscription_id');
    assert(!stripeCalled,   'Stripe non appelé sans subscription_id');

    stripeCheck._clearRetrieveFn();
  }

  // ── TEST 3 — isMerchantActive erreur Stripe (fail open) ──────────────────────
  originalLog('\n[ 3 ] isMerchantActive — fail open sur erreur Stripe');
  {
    stripeCheck._clearCache();
    collectedLogs.length = 0;

    stripeCheck._setRetrieveFn(async () => {
      throw new Error('Network timeout');
    });

    const result = await stripeCheck.isMerchantActive({
      plan: 'active',
      stripe_subscription_id: 'sub_test_fail_open',
    });

    assert(result === true, 'isMerchantActive retourne true en cas d\'erreur Stripe (fail open)');
    assert(
      collectedLogs.some((l) => l.event === 'stripe_check_error'),
      'WARN stripe_check_error loggé',
    );

    stripeCheck._clearRetrieveFn();
    stripeCheck._clearCache();
  }

  // ── TEST 4 — Cache stripe_check TTL ───────────────────────────────────────────
  originalLog('\n[ 4 ] stripe_check — cache TTL (2e appel depuis cache)');
  {
    stripeCheck._clearCache();
    let callCount = 0;

    stripeCheck._setRetrieveFn(async (_subId) => {
      callCount++;
      return { status: 'active' };
    });

    const merchant = { plan: 'active', stripe_subscription_id: 'sub_cache_test_sprint6' };
    await stripeCheck.isMerchantActive(merchant);
    await stripeCheck.isMerchantActive(merchant); // doit venir du cache

    assert(callCount === 1, `Stripe appelé 1 seule fois (appelé ${callCount} fois)`);

    stripeCheck._clearRetrieveFn();
    stripeCheck._clearCache();
  }

  // ── TEST 5 — handleMessage merchant inactif ───────────────────────────────────
  originalLog('\n[ 5 ] handleMessage — merchant inactif (Stripe check = false)');
  {
    collectedLogs.length = 0;
    const sentMessages = [];
    const mockSend = async (_phoneId, to, text) => { sentMessages.push({ to, text }); return true; };

    // Mock isMerchantActive pour retourner false
    const origFn = stripeCheck.isMerchantActive;
    stripeCheck.isMerchantActive = async () => false;

    await handleMessage({
      merchantId:    testMerchantId,
      merchant:      testMerchant,
      customerPhone: '33600003005',
      messageText:   'Bonjour',
      channel:       'whatsapp',
      sendFunction:  mockSend,
      phoneNumberId: TEST_WA_NUM,
    });

    stripeCheck.isMerchantActive = origFn;

    assert(
      !collectedLogs.some((l) => l.event === 'claude_call_success'),
      'claude_call_success absent des logs (Claude non appelé)',
    );
    assert(sentMessages.length === 1, '1 message envoyé');
    assert(
      sentMessages[0]?.text?.includes('suspendu'),
      `Message de suspension envoyé : "${sentMessages[0]?.text}"`,
    );
  }

  // ── TEST 6 — logger.info format JSON en production ────────────────────────────
  originalLog('\n[ 6 ] logger.info — format JSON en production');
  {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const captured = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = (str) => {
      captured.push(str);
      return true;
    };

    logger.info('test_event', { foo: 'bar' });

    process.stdout.write = origStdout;
    process.env.NODE_ENV = savedEnv;

    const output = captured.join('');
    let parsed;
    try { parsed = JSON.parse(output.trim()); } catch { parsed = null; }

    assert(parsed !== null,                     'Sortie est du JSON valide');
    assert(typeof parsed?.timestamp === 'string', 'timestamp présent');
    assert(parsed?.level === 'INFO',             'level = INFO');
    assert(parsed?.event === 'test_event',       'event = test_event');
  }

  // ── TEST 7 — deploy_checklist détecte variable manquante ─────────────────────
  originalLog('\n[ 7 ] deploy_checklist — exit code 1 si ANTHROPIC_API_KEY manquante');
  {
    const { spawn } = require('child_process');
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const exitCode = await new Promise((resolve) => {
      const child = spawn('node', ['scripts/deploy_checklist.js'], {
        env,
        cwd:   require('path').resolve(__dirname, '..'),
        stdio: 'pipe',  // supprime l'output du sous-processus
      });
      child.on('exit', (code) => resolve(code ?? -1));
      child.on('error', () => resolve(-1));
    });

    assert(exitCode === 1, `Exit code 1 (reçu: ${exitCode})`);
  }

  // ── TEST 8 — Stripe webhook customer.subscription.deleted ─────────────────────
  originalLog('\n[ 8 ] Stripe webhook — customer.subscription.deleted → plan=inactive');
  {
    const Stripe = require('stripe');
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    const eventObj = {
      type: 'customer.subscription.deleted',
      data: { object: { id: testStripeSubId, status: 'canceled' } },
    };
    const payload = JSON.stringify(eventObj);
    const timestamp = Math.floor(Date.now() / 1000);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });

    const res = await fetchJson('/api/stripe/webhook', {
      method:  'POST',
      headers: { 'stripe-signature': header },
      body:    eventObj,  // fetchJson fera JSON.stringify(eventObj) = payload
    });

    assert(res.status === 200,           `HTTP 200 (${res.status})`);
    assert(res.body?.received === true,  'received: true');

    // Attendre le traitement asynchrone
    await new Promise((r) => setTimeout(r, 300));

    const { rows: [m] } = await pool.query('SELECT plan FROM merchant WHERE id = $1', [testMerchantId]);
    assert(m?.plan === 'inactive', `plan = 'inactive' en base (actuel: '${m?.plan}')`);
  }

  // ── TEST 9 — Stripe webhook invoice.paid ─────────────────────────────────────
  originalLog('\n[ 9 ] Stripe webhook — invoice.paid → plan=active');
  {
    const Stripe = require('stripe');
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    const eventObj = {
      type: 'invoice.paid',
      data: { object: { subscription: testStripeSubId, amount_paid: 2900 } },
    };
    const payload   = JSON.stringify(eventObj);
    const timestamp = Math.floor(Date.now() / 1000);
    const header    = stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });

    const res = await fetchJson('/api/stripe/webhook', {
      method:  'POST',
      headers: { 'stripe-signature': header },
      body:    eventObj,
    });

    assert(res.status === 200,          `HTTP 200 (${res.status})`);
    assert(res.body?.received === true, 'received: true');

    await new Promise((r) => setTimeout(r, 300));

    const { rows: [m] } = await pool.query('SELECT plan FROM merchant WHERE id = $1', [testMerchantId]);
    assert(m?.plan === 'active', `plan = 'active' en base (actuel: '${m?.plan}')`);
  }

  // ── TEST 10 — GET /health ─────────────────────────────────────────────────────
  originalLog('\n[ 10 ] GET /health');
  {
    const res = await fetchJson('/health');
    assert(res.status === 200,                               `HTTP 200 (${res.status})`);
    assert(res.body?.status === 'ok',                        'status: ok');
    assert(res.body?.db === 'ok',                            `db: ok (${res.body?.db})`);
    assert(typeof res.body?.uptime_seconds === 'number'
           && res.body.uptime_seconds > 0,                   `uptime_seconds > 0 (${res.body?.uptime_seconds})`);
  }

  // ── Résultat ───────────────────────────────────────────────────────────────────
  originalLog('\n═══════════════════════════════════════');
  if (failed === 0) {
    originalLog(`  Sprint 6 validé (${passed}/${passed + failed} tests passés)\n`);
  } else {
    originalError(`  Sprint 6 — ${failed} test(s) en échec\n`);
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
