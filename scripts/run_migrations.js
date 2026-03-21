// Exécute init_database.sql sur la base PostgreSQL configurée dans .env
// Lancement : npm run migrate

require('dotenv').config();

const path = require('path');
const fs   = require('fs');
const pool = require('../db/client');

async function runMigrations() {
  const sqlPath = path.join(__dirname, 'init_database.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log(JSON.stringify({ event: 'migrations_success', message: 'Tables créées avec succès' }));
  } catch (err) {
    console.error(JSON.stringify({ event: 'migrations_error', error: err.message }));
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
