// Migration : ajoute la table notification si elle n'existe pas
require('dotenv').config();

const pool = require('../db/client');

async function run() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        merchant_id UUID        REFERENCES merchant(id),
        type        TEXT,
        message     TEXT,
        data        JSONB       NOT NULL DEFAULT '{}',
        read        BOOLEAN     NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('[migration] Table notification prête (créée ou déjà existante).');
  } catch (err) {
    console.error('[migration] Erreur :', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
