// Création d'un événement de réservation dans Google Calendar

const { google }                             = require('googleapis');
const { getGoogleAuthClient }                = require('./google_auth');
const { DEFAULT_RESERVATION_DURATION_MINUTES } = require('../config/constants');

/**
 * Calcule la datetime de fin en ajoutant une durée à une heure donnée.
 * Gère le débordement à minuit.
 *
 * @param {string} date            - 'YYYY-MM-DD'
 * @param {string} time            - 'HH:MM'
 * @param {number} durationMinutes
 * @returns {string} - 'YYYY-MM-DDTHH:MM:00'
 */
function computeEndDateTime(date, time, durationMinutes) {
  const [h, m]        = time.split(':').map(Number);
  const totalMinutes  = h * 60 + m + durationMinutes;
  const endH          = Math.floor(totalMinutes / 60);
  const endM          = totalMinutes % 60;

  if (endH >= 24) {
    // Débordement sur le jour suivant
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const nextDate = d.toISOString().slice(0, 10);
    return `${nextDate}T${String(endH - 24).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;
  }

  return `${date}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;
}

/**
 * Crée un événement Google Calendar pour une réservation confirmée.
 *
 * @param {object} merchant         - Objet merchant (id, name, google_calendar_id, google_refresh_token)
 * @param {object} reservationData  - { customerName, customerPhone, date, time, partySize, conversationId }
 * @returns {Promise<string|null>}  - eventId Google ou null si Calendar non configuré
 */
async function createReservationEvent(merchant, reservationData) {
  const auth = getGoogleAuthClient(merchant);
  if (!auth) {
    console.log(JSON.stringify({
      event:      'google_calendar_skipped',
      reason:     'no_refresh_token',
      merchantId: merchant.id,
    }));
    return null;
  }

  const { customerName, customerPhone, date, time, partySize, conversationId } = reservationData;

  const startDateTime = `${date}T${time}:00`;
  const endDateTime   = computeEndDateTime(date, time, DEFAULT_RESERVATION_DURATION_MINUTES);

  try {
    const calendar = google.calendar({ version: 'v3', auth });

    const response = await calendar.events.insert({
      calendarId: merchant.google_calendar_id || 'primary',
      requestBody: {
        summary: `${merchant.name} — ${customerName} x${partySize}`,
        start:   { dateTime: startDateTime, timeZone: 'Europe/Paris' },
        end:     { dateTime: endDateTime,   timeZone: 'Europe/Paris' },
        description: `Tél: ${customerPhone || 'non renseigné'}` +
                     ` | Réservé via LocalBot` +
                     ` | Conv: ${conversationId}`,
      },
    });

    const eventId = response.data.id;

    console.log(JSON.stringify({
      event:      'google_calendar_created',
      eventId,
      merchantId: merchant.id,
      date,
      time,
    }));

    return eventId;

  } catch (err) {
    console.error(JSON.stringify({
      event:      'google_calendar_error',
      merchantId: merchant.id,
      error:      err.message,
    }));
    return null;
  }
}

module.exports = { createReservationEvent };
