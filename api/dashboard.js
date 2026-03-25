// API REST dashboard LocalBot — endpoints consommés par le frontend React/Bubble

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const pool       = require('../db/client');

const router = express.Router();

// ── Authentification ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token !== process.env.BUBBLE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Rate limiting (100 req/min par merchantId) ────────────────────────────────

function merchantRateLimiter() {
  return rateLimit({
    windowMs:     60_000,
    max:          100,
    keyGenerator: (req) => req.params.merchantId || 'unknown',
    validate:     { xForwardedForHeader: false },
    handler:      (_req, res) => res.status(429).json({ error: 'Too many requests' }),
  });
}

router.use(requireAuth);

// ── Helpers date ───────────────────────────────────────────────────────────────

function periodToInterval(period) {
  switch (period) {
    case 'week':  return '7 days';
    case 'month': return '30 days';
    default:      return '1 day';  // today
  }
}

// ── GET /api/merchant/:merchantId/stats ────────────────────────────────────────

router.get('/merchant/:merchantId/stats', merchantRateLimiter(), async (req, res) => {
  const { merchantId } = req.params;
  const period         = req.query.period || 'today';
  const interval       = periodToInterval(period);

  try {
    // Messages count
    const { rows: [msgRow] } = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM message m
       JOIN conversation c ON c.id = m.conversation_id
       WHERE c.merchant_id = $1
         AND m.sent_at >= now() - INTERVAL '${interval}'`,
      [merchantId],
    );

    // Conversations du merchant sur la période
    const { rows: convRows } = await pool.query(
      `SELECT id, status FROM conversation
       WHERE merchant_id = $1
         AND started_at >= now() - INTERVAL '${interval}'`,
      [merchantId],
    );

    const totalConvs     = convRows.length;
    const needsHumanConvs = convRows.filter((c) => c.status === 'needs_human').length;

    // Auto-resolved : conversations avec au moins 1 message assistant et status != needs_human
    const { rows: [autoRow] } = await pool.query(
      `SELECT COUNT(DISTINCT c.id) AS cnt
       FROM conversation c
       JOIN message m ON m.conversation_id = c.id AND m.role = 'assistant'
       WHERE c.merchant_id = $1
         AND c.status != 'needs_human'
         AND c.started_at >= now() - INTERVAL '${interval}'`,
      [merchantId],
    );

    const autoResolved = parseInt(autoRow.cnt, 10);
    const autoRatePct  = totalConvs > 0
      ? Math.round((autoResolved / totalConvs) * 1000) / 10
      : 0;

    // Reservations count
    const { rows: [resRow] } = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM reservation r
       JOIN conversation c ON c.id = r.conversation_id
       WHERE c.merchant_id = $1
         AND r.created_at >= now() - INTERVAL '${interval}'`,
      [merchantId],
    );

    // Avg response time (ms) entre message user et le message assistant qui suit
    const { rows: [avgRow] } = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (a.sent_at - u.sent_at)) * 1000) AS avg_ms
       FROM message u
       JOIN LATERAL (
         SELECT sent_at FROM message
         WHERE conversation_id = u.conversation_id
           AND role = 'assistant'
           AND sent_at > u.sent_at
         ORDER BY sent_at ASC
         LIMIT 1
       ) a ON true
       JOIN conversation c ON c.id = u.conversation_id
       WHERE u.role = 'user'
         AND c.merchant_id = $1
         AND u.sent_at >= now() - INTERVAL '${interval}'`,
      [merchantId],
    );

    res.json({
      period,
      stats: {
        messages_count:      parseInt(msgRow.cnt, 10),
        auto_resolved_count: autoResolved,
        auto_rate_pct:       autoRatePct,
        reservations_count:  parseInt(resRow.cnt, 10),
        needs_human_count:   needsHumanConvs,
        avg_response_ms:     avgRow.avg_ms !== null ? Math.round(parseFloat(avgRow.avg_ms)) : null,
      },
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_stats_error', merchantId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/merchant/:merchantId/reservations ────────────────────────────────

router.get('/merchant/:merchantId/reservations', merchantRateLimiter(), async (req, res) => {
  const { merchantId }    = req.params;
  const { date, from, to } = req.query;

  try {
    let rows;

    if (from && to) {
      // Plage de dates (vue semaine / mois)
      ({ rows } = await pool.query(
        `SELECT r.*, c.channel
         FROM reservation r
         JOIN conversation c ON c.id = r.conversation_id
         WHERE c.merchant_id = $1
           AND booked_for::date >= $2::date
           AND booked_for::date <= $3::date
         ORDER BY booked_for ASC`,
        [merchantId, from, to],
      ));
    } else if (date) {
      // Jour exact
      ({ rows } = await pool.query(
        `SELECT r.*, c.channel
         FROM reservation r
         JOIN conversation c ON c.id = r.conversation_id
         WHERE c.merchant_id = $1
           AND booked_for::date = $2::date
         ORDER BY booked_for ASC`,
        [merchantId, date],
      ));
    } else {
      // 7 prochains jours (défaut)
      ({ rows } = await pool.query(
        `SELECT r.*, c.channel
         FROM reservation r
         JOIN conversation c ON c.id = r.conversation_id
         WHERE c.merchant_id = $1
           AND booked_for >= now()
           AND booked_for < now() + INTERVAL '7 days'
         ORDER BY booked_for ASC`,
        [merchantId],
      ));
    }

    res.json({ reservations: rows });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_reservations_error', merchantId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/merchant/:merchantId/conversations ───────────────────────────────

router.get('/merchant/:merchantId/conversations', merchantRateLimiter(), async (req, res) => {
  const { merchantId }    = req.params;
  const { status, channel, period } = req.query;
  const limit             = parseInt(req.query.limit  ?? '20', 10);
  const offset            = parseInt(req.query.offset ?? '0',  10);

  try {
    const conditions = ['c.merchant_id = $1'];
    const params     = [merchantId];

    if (status) {
      conditions.push(`c.status = $${params.length + 1}`);
      params.push(status);
    }

    if (channel) {
      conditions.push(`c.channel = $${params.length + 1}`);
      params.push(channel);
    }

    if (period) {
      const interval = periodToInterval(period);
      conditions.push(`c.started_at >= now() - INTERVAL '${interval}'`);
    }

    const where = conditions.join(' AND ');

    // Total
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) AS total FROM conversation c WHERE ${where}`,
      params,
    );

    // Conversations avec dernier message
    const { rows } = await pool.query(
      `SELECT c.*,
              lm.content AS last_message_content,
              lm.role    AS last_message_role,
              lm.sent_at AS last_message_at
       FROM conversation c
       LEFT JOIN LATERAL (
         SELECT content, role, sent_at FROM message
         WHERE conversation_id = c.id
         ORDER BY sent_at DESC
         LIMIT 1
       ) lm ON true
       WHERE ${where}
       ORDER BY c.started_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    res.json({ conversations: rows, total: parseInt(countRow.total, 10) });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_conversations_error', merchantId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/merchant/:merchantId/conversations/:conversationId ───────────────

router.get('/merchant/:merchantId/conversations/:conversationId', merchantRateLimiter(), async (req, res) => {
  const { merchantId, conversationId } = req.params;

  try {
    const { rows: [conv] } = await pool.query(
      `SELECT * FROM conversation WHERE id = $1 AND merchant_id = $2`,
      [conversationId, merchantId],
    );
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const { rows: messages } = await pool.query(
      `SELECT * FROM message WHERE conversation_id = $1 ORDER BY sent_at ASC`,
      [conversationId],
    );

    res.json({ conversation: conv, messages });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_conversation_detail_error', conversationId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/merchant/:merchantId/conversations/:conversationId ─────────────

router.patch('/merchant/:merchantId/conversations/:conversationId', merchantRateLimiter(), async (req, res) => {
  const { merchantId, conversationId } = req.params;
  const { status } = req.body;

  const ALLOWED = ['active', 'closed', 'needs_human'];
  if (!ALLOWED.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  try {
    const { rowCount } = await pool.query(
      `UPDATE conversation SET status = $1 WHERE id = $2 AND merchant_id = $3`,
      [status, conversationId, merchantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Conversation introuvable' });
    res.json({ ok: true });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_conversation_patch_error', conversationId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/merchant/:merchantId/conversations/:conversationId/reply ────────

router.post('/merchant/:merchantId/conversations/:conversationId/reply', merchantRateLimiter(), async (req, res) => {
  const { merchantId, conversationId } = req.params;
  const { text } = req.body;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    // Vérifier que la conversation appartient au merchant
    const { rows: [conv] } = await pool.query(
      `SELECT * FROM conversation WHERE id = $1 AND merchant_id = $2`,
      [conversationId, merchantId],
    );
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // Sauvegarder le message
    const { rows: [msg] } = await pool.query(
      `INSERT INTO message (conversation_id, role, content, tokens_used)
       VALUES ($1, 'assistant', $2, 0) RETURNING id`,
      [conversationId, text],
    );

    // Envoyer via le bon canal
    const { channel, customer_phone } = conv;
    if (channel === 'whatsapp') {
      const { sendWhatsAppMessage } = require('../webhooks/webhook_whatsapp');
      // Obtenir le phoneNumberId depuis le merchant
      const { rows: [merchant] } = await pool.query(
        `SELECT whatsapp_number FROM merchant WHERE id = $1`,
        [merchantId],
      );
      await sendWhatsAppMessage(merchant.whatsapp_number, customer_phone, text);
    } else if (channel === 'instagram') {
      const { sendInstagramMessage } = require('../webhooks/webhook_instagram');
      const { rows: [merchant] } = await pool.query(
        `SELECT instagram_id FROM merchant WHERE id = $1`,
        [merchantId],
      );
      await sendInstagramMessage(merchant.instagram_id, customer_phone, text);
    }

    // Repasser le status en 'active'
    await pool.query(
      `UPDATE conversation SET status = 'active' WHERE id = $1`,
      [conversationId],
    );

    res.json({ success: true, messageId: msg.id });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_reply_error', conversationId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/merchant/:merchantId/faq ─────────────────────────────────────────

router.get('/merchant/:merchantId/faq', merchantRateLimiter(), async (req, res) => {
  const { merchantId } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM faq WHERE merchant_id = $1 ORDER BY hit_count DESC`,
      [merchantId],
    );
    res.json({ faq: rows });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_faq_error', merchantId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/merchant/:merchantId/faq ────────────────────────────────────────

router.post('/merchant/:merchantId/faq', merchantRateLimiter(), async (req, res) => {
  const { merchantId }  = req.params;
  const { question, answer } = req.body;

  if (!question || !answer) {
    return res.status(400).json({ error: 'question and answer are required' });
  }

  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO faq (merchant_id, question, answer) VALUES ($1, $2, $3) RETURNING id`,
      [merchantId, question, answer],
    );
    res.json({ id: row.id });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_faq_create_error', merchantId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/merchant/:merchantId/notifications ───────────────────────────────

router.get('/merchant/:merchantId/notifications', merchantRateLimiter(), async (req, res) => {
  const { merchantId } = req.params;
  const unreadOnly     = req.query.unread === 'true';

  try {
    const conditions = ['merchant_id = $1'];
    const params     = [merchantId];

    if (unreadOnly) {
      conditions.push('read = false');
    }

    const where = conditions.join(' AND ');

    const { rows } = await pool.query(
      `SELECT * FROM notification WHERE ${where} ORDER BY created_at DESC LIMIT 50`,
      params,
    );

    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM notification WHERE merchant_id = $1 AND read = false`,
      [merchantId],
    );

    res.json({ notifications: rows, unread_count: parseInt(countRow.cnt, 10) });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_notifications_error', merchantId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/merchant/:merchantId/notifications/:notificationId ─────────────

router.patch('/merchant/:merchantId/notifications/:notificationId', merchantRateLimiter(), async (req, res) => {
  const { merchantId, notificationId } = req.params;
  const { read } = req.body;

  if (read !== true) {
    return res.status(400).json({ error: 'Only { read: true } is supported' });
  }

  try {
    await pool.query(
      `UPDATE notification SET read = true WHERE id = $1 AND merchant_id = $2`,
      [notificationId, merchantId],
    );
    res.json({ success: true });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_notification_patch_error', notificationId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/merchant/:merchantId ─────────────────────────────────────────────

router.get('/merchant/:merchantId', merchantRateLimiter(), async (req, res) => {
  const { merchantId } = req.params;

  try {
    const { rows: [merchant] } = await pool.query(
      `SELECT id, name, type, address, email, phone, hours, services, rules,
              capacity, tone, use_emoji, vouvoyer, auto_reminder, system_prompt, plan
       FROM merchant WHERE id = $1`,
      [merchantId],
    );
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });
    res.json({ merchant });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_merchant_get_error', merchantId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/merchant/:merchantId ───────────────────────────────────────────

router.patch('/merchant/:merchantId', merchantRateLimiter(), async (req, res) => {
  const { merchantId } = req.params;
  const {
    name, type, address, email, phone,
    hours, services, rules, capacity,
    tone, use_emoji, vouvoyer, auto_reminder,
    system_prompt,
  } = req.body;

  const ALLOWED_TONES = ['chaleureux', 'neutre', 'professionnel'];
  if (tone && !ALLOWED_TONES.includes(tone)) {
    return res.status(400).json({ error: 'Ton invalide' });
  }

  try {
    const { rowCount } = await pool.query(
      `UPDATE merchant SET
         name           = COALESCE($1,  name),
         type           = COALESCE($2,  type),
         address        = COALESCE($3,  address),
         email          = COALESCE($4,  email),
         phone          = COALESCE($5,  phone),
         hours          = COALESCE($6,  hours),
         services       = COALESCE($7,  services),
         rules          = COALESCE($8,  rules),
         capacity       = COALESCE($9,  capacity),
         tone           = COALESCE($10, tone),
         use_emoji      = COALESCE($11, use_emoji),
         vouvoyer       = COALESCE($12, vouvoyer),
         auto_reminder  = COALESCE($13, auto_reminder),
         system_prompt  = COALESCE($14, system_prompt)
       WHERE id = $15`,
      [
        name ?? null, type ?? null, address ?? null, email ?? null, phone ?? null,
        hours ?? null, services ?? null, rules ?? null, capacity ?? null,
        tone ?? null, use_emoji ?? null, vouvoyer ?? null, auto_reminder ?? null,
        system_prompt ?? null,
        merchantId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Merchant introuvable' });
    res.json({ ok: true });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_merchant_patch_error', merchantId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/merchant/:merchantId/reservations/:reservationId ───────────────

router.patch('/merchant/:merchantId/reservations/:reservationId', merchantRateLimiter(), async (req, res) => {
  const { merchantId, reservationId } = req.params;
  const { status } = req.body;

  const ALLOWED = ['confirmed', 'cancelled'];
  if (!ALLOWED.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  try {
    const { rowCount } = await pool.query(
      `UPDATE reservation SET status = $1
       WHERE id = $2
         AND conversation_id IN (
           SELECT id FROM conversation WHERE merchant_id = $3
         )`,
      [status, reservationId, merchantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Réservation introuvable' });
    res.json({ ok: true });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_reservation_patch_error', reservationId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/merchant/:merchantId/faq/:faqId ───────────────────────────────

router.delete('/merchant/:merchantId/faq/:faqId', merchantRateLimiter(), async (req, res) => {
  const { merchantId, faqId } = req.params;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM faq WHERE id = $1 AND merchant_id = $2`,
      [faqId, merchantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'FAQ introuvable' });
    res.json({ ok: true });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_faq_delete_error', faqId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/merchant/:merchantId/faq/:faqId ────────────────────────────────

router.patch('/merchant/:merchantId/faq/:faqId', merchantRateLimiter(), async (req, res) => {
  const { merchantId, faqId } = req.params;
  const { question, answer }  = req.body;

  if (!question || !answer) {
    return res.status(400).json({ error: 'question and answer are required' });
  }

  try {
    const { rowCount } = await pool.query(
      `UPDATE faq SET question = $1, answer = $2 WHERE id = $3 AND merchant_id = $4`,
      [question, answer, faqId, merchantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'FAQ introuvable' });
    res.json({ ok: true });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_faq_patch_error', faqId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/merchant/:merchantId/faq-suggestions ─────────────────────────────

router.get('/merchant/:merchantId/faq-suggestions', merchantRateLimiter(), async (req, res) => {
  const { merchantId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, question, conversation_id, created_at
       FROM faq_suggestion
       WHERE merchant_id = $1
       ORDER BY created_at DESC`,
      [merchantId],
    );
    res.json({ suggestions: rows });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_faq_suggestions_error', merchantId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/merchant/:merchantId/faq-suggestions/:suggestionId ────────────

router.delete('/merchant/:merchantId/faq-suggestions/:suggestionId', merchantRateLimiter(), async (req, res) => {
  const { merchantId, suggestionId } = req.params;
  try {
    await pool.query(
      `DELETE FROM faq_suggestion WHERE id = $1 AND merchant_id = $2`,
      [suggestionId, merchantId],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(JSON.stringify({ event: 'api_faq_suggestion_delete_error', suggestionId, error: err.message }));
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = { router };
