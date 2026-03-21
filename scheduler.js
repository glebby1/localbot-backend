// Planificateur de tâches — récapitulatifs email quotidiens

const cron               = require('node-cron');
const pool               = require('./db/client');
const { sendDailySummary } = require('./notifications/daily_summary');

/**
 * Démarre le scheduler.
 * Cron '0 8 * * *' → chaque matin à 8h00.
 */
function startScheduler() {
  cron.schedule('0 8 * * *', async () => {
    console.log(JSON.stringify({ event: 'daily_summary_job_started', timestamp: new Date().toISOString() }));

    try {
      const { rows: merchants } = await pool.query(
        `SELECT id FROM merchant WHERE plan != 'inactive' AND email IS NOT NULL AND email != ''`,
      );

      let count = 0;
      for (const merchant of merchants) {
        try {
          await sendDailySummary(merchant.id);
          count++;
        } catch (err) {
          console.error(JSON.stringify({
            event:      'daily_summary_merchant_error',
            merchantId: merchant.id,
            error:      err.message,
          }));
        }
      }

      console.log(JSON.stringify({ event: 'daily_summary_sent', count }));
    } catch (err) {
      console.error(JSON.stringify({ event: 'daily_summary_job_error', error: err.message }));
    }
  });

  console.log(JSON.stringify({ event: 'scheduler_started', cron: '0 8 * * *' }));
}

module.exports = { startScheduler };
