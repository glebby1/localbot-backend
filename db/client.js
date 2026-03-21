// Pool de connexions PostgreSQL — partagé par toute l'application
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    // AWS RDS utilise un certificat auto-signé en dehors du bundle système
    rejectUnauthorized: false,
  },
});

// Vérification de la connexion au démarrage
pool.connect((err, client, release) => {
  if (err) {
    console.error(JSON.stringify({
      event:   'db_connection_error',
      error:   err.message,
    }));
    return;
  }
  release();
  console.log(JSON.stringify({ event: 'db_connected' }));
});

module.exports = pool;
