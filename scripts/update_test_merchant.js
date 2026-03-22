require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  // Mise à jour du instagram_id
  const updateResult = await pool.query(`
    UPDATE merchant
    SET instagram_id = '17841438133782012'
    WHERE name = 'Restaurant Demo LocalBot'
    RETURNING id, name, instagram_id
  `);

  if (updateResult.rowCount === 0) {
    console.log('Aucun merchant trouvé avec ce nom.');
    console.log('Merchants existants :');
    const all = await pool.query('SELECT id, name, instagram_id FROM merchant');
    console.table(all.rows);
  } else {
    console.log('Merchant mis à jour :');
    console.table(updateResult.rows);
  }

  await pool.end();
}

run().catch(e => {
  console.error('Erreur:', e.message);
  process.exit(1);
});
