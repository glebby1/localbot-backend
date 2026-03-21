// Persistance des réservations confirmées dans PostgreSQL

const pool = require('../db/client');

/**
 * Insère une réservation confirmée en base.
 *
 * @param {string}      conversationId
 * @param {object}      reservationData - { customerName, customerPhone, date, time, partySize }
 * @param {string|null} googleEventId   - ID de l'événement Google Calendar (null si Calendar non configuré)
 * @returns {Promise<string>} reservationId (UUID)
 */
async function saveReservation(conversationId, reservationData, googleEventId) {
  const { customerName, customerPhone, date, time, partySize } = reservationData;
  const bookedFor = `${date} ${time}:00`;

  try {
    const { rows } = await pool.query(
      `INSERT INTO reservation
         (conversation_id, customer_name, customer_phone, party_size, booked_for, status, google_event_id)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', $6)
       RETURNING id`,
      [
        conversationId,
        customerName,
        customerPhone || null,
        parseInt(partySize, 10),
        bookedFor,
        googleEventId || null,
      ],
    );

    console.log(JSON.stringify({
      event:         'reservation_saved',
      reservationId: rows[0].id,
      conversationId,
    }));

    return rows[0].id;

  } catch (err) {
    console.error(JSON.stringify({
      event:         'db_save_reservation_error',
      conversationId,
      error:         err.message,
    }));
    throw err;
  }
}

module.exports = { saveReservation };
