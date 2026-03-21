require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name")
  .then(r => {
    console.log('Tables trouvées :');
    r.rows.forEach(row => console.log(' -', row.table_name));
  })
  .catch(e => console.log('Erreur:', e.message))
  .finally(() => pool.end());