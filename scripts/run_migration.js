// Lance la migration migrate_merchant_fields.sql via le pool existant
require('dotenv').config();
const pool = require('../db/client');

const SQL = `
ALTER TABLE merchant
  ADD COLUMN IF NOT EXISTS type          TEXT,
  ADD COLUMN IF NOT EXISTS address       TEXT,
  ADD COLUMN IF NOT EXISTS phone         TEXT,
  ADD COLUMN IF NOT EXISTS hours         TEXT,
  ADD COLUMN IF NOT EXISTS services      TEXT,
  ADD COLUMN IF NOT EXISTS rules         TEXT,
  ADD COLUMN IF NOT EXISTS capacity      INT,
  ADD COLUMN IF NOT EXISTS tone          TEXT    NOT NULL DEFAULT 'chaleureux',
  ADD COLUMN IF NOT EXISTS use_emoji     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vouvoyer      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_reminder BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE conversation
  ADD COLUMN IF NOT EXISTS customer_name TEXT;
`;

async function run() {
  try {
    await pool.query(SQL);
    console.log('✓ Migration réussie');
  } catch (err) {
    console.error('✗ Erreur migration :', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
