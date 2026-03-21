// Récapitulatif email quotidien envoyé aux commerçants via SendGrid

const sgMail  = require('@sendgrid/mail');
const pool    = require('../db/client');

const DAYS_FR   = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
                   'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function formatDateFr(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return `${DAYS_FR[d.getDay()]} ${day} ${MONTHS_FR[month - 1]}`;
}

/**
 * Calcule les stats du jour pour un merchant (appel direct PostgreSQL).
 */
async function fetchTodayStats(merchantId) {
  const interval = '1 day';

  const { rows: [msgRow] } = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM message m
     JOIN conversation c ON c.id = m.conversation_id
     WHERE c.merchant_id = $1 AND m.sent_at >= now() - INTERVAL '${interval}'`,
    [merchantId],
  );

  const { rows: convRows } = await pool.query(
    `SELECT id, status FROM conversation
     WHERE merchant_id = $1 AND started_at >= now() - INTERVAL '${interval}'`,
    [merchantId],
  );

  const totalConvs     = convRows.length;
  const needsHumanConvs = convRows.filter((c) => c.status === 'needs_human').length;

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

  const { rows: [resRow] } = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM reservation r
     JOIN conversation c ON c.id = r.conversation_id
     WHERE c.merchant_id = $1 AND r.created_at >= now() - INTERVAL '${interval}'`,
    [merchantId],
  );

  return {
    messages_count:     parseInt(msgRow.cnt, 10),
    reservations_count: parseInt(resRow.cnt, 10),
    auto_rate_pct:      autoRatePct,
    needs_human_count:  needsHumanConvs,
  };
}

/**
 * Charge les réservations du lendemain pour un merchant.
 */
async function fetchTomorrowReservations(merchantId) {
  const { rows } = await pool.query(
    `SELECT r.customer_name, r.customer_phone, r.party_size, r.booked_for
     FROM reservation r
     JOIN conversation c ON c.id = r.conversation_id
     WHERE c.merchant_id = $1
       AND booked_for::date = (now() + INTERVAL '1 day')::date
     ORDER BY r.booked_for ASC`,
    [merchantId],
  );
  return rows;
}

/**
 * Envoie le récapitulatif email quotidien à un merchant.
 *
 * @param {string} merchantId
 */
async function sendDailySummary(merchantId) {
  // 1. Charger le merchant
  const { rows: [merchant] } = await pool.query(
    `SELECT id, name, email FROM merchant WHERE id = $1`,
    [merchantId],
  );
  if (!merchant || !merchant.email) return;

  // 2. Stats du jour
  const stats = await fetchTodayStats(merchantId);

  // 3. Réservations du lendemain
  const tomorrowReservations = await fetchTomorrowReservations(merchantId);

  // 4. Composer l'email
  const today       = new Date();
  const dateStr     = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const dateLong    = formatDateFr(dateStr);
  const subject     = `[${merchant.name}] — Récap LocalBot du ${dateLong}`;

  const tomorrowDate = new Date(today);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr  = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`;

  const reservationsHtml = tomorrowReservations.length > 0
    ? tomorrowReservations.map((r) => {
        const timeStr = new Date(r.booked_for).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        return `<li><strong>${timeStr}</strong> — ${r.customer_name}, ${r.party_size} pers. (${r.customer_phone || 'tél. non renseigné'})</li>`;
      }).join('\n')
    : '<li>Aucune réservation</li>';

  const dashboardUrl = process.env.DASHBOARD_URL || 'https://localbot.fr/dashboard';

  const html = `
<!DOCTYPE html>
<html lang="fr">
<body style="font-family: sans-serif; color: #333; max-width: 600px; margin: auto; padding: 24px;">
  <h2 style="color: #1a56db;">Récapitulatif du jour — ${dateLong}</h2>

  <h3>📊 Activité d'aujourd'hui</h3>
  <ul>
    <li>Messages traités : <strong>${stats.messages_count}</strong></li>
    <li>Réservations reçues : <strong>${stats.reservations_count}</strong></li>
    <li>Taux de résolution automatique : <strong>${stats.auto_rate_pct} %</strong></li>
    <li>Questions en attente de réponse manuelle : <strong>${stats.needs_human_count}</strong></li>
  </ul>

  <h3>📅 Réservations du ${formatDateFr(tomorrowStr)}</h3>
  <ul>
    ${reservationsHtml}
  </ul>

  <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;" />
  <p style="font-size: 12px; color: #888;">
    Gérez vos conversations et réservations depuis votre
    <a href="${dashboardUrl}">dashboard LocalBot</a>.
  </p>
</body>
</html>`;

  // 5. Envoyer via SendGrid
  if (!process.env.SENDGRID_API_KEY) {
    console.warn(JSON.stringify({ event: 'sendgrid_key_missing', merchantId }));
    return;
  }

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  await sgMail.send({
    to:      merchant.email,
    from:    process.env.SENDGRID_FROM_EMAIL || 'noreply@localbot.fr',
    subject,
    html,
  });

  console.log(JSON.stringify({
    event:      'daily_summary_email_sent',
    merchantId,
    to:         merchant.email,
  }));
}

module.exports = { sendDailySummary };
