require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sql = `SELECT id, name FROM merchant;`;

pool.query(sql)
  .then(r => {
    console.log('Merchants :');
    console.table(r.rows);
  })
  .catch(e => console.log('Erreur:', e.message))
  .finally(() => pool.end());