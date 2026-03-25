// Migration : création de la table faq_suggestion
require('dotenv').config();
const pool = require('../db/client');

const SQL = `
CREATE TABLE IF NOT EXISTS faq_suggestion (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID        NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  question        TEXT        NOT NULL,
  conversation_id UUID        REFERENCES conversation(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function run() {
  try {
    await pool.query(SQL);
    console.log('✓ Table faq_suggestion créée');
  } catch (err) {
    console.error('✗ Erreur migration :', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
