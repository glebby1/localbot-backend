// Point d'entrée LocalBot — serveur Express
require('dotenv').config();

const express            = require('express');
const webhookWhatsapp    = require('./webhooks/webhook_whatsapp');
const webhookInstagram   = require('./webhooks/webhook_instagram');
const { router: dashboardRouter } = require('./api/dashboard');
const { startScheduler } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middlewares ────────────────────────────────────────────────────────────────
// Capture du body brut (Buffer) avant parsing JSON.
// Nécessaire pour valider la signature HMAC-SHA256 des webhooks Meta.
// Le Buffer est exposé sur req.rawBody pour être lu dans les webhooks.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

// ── Routes ─────────────────────────────────────────────────────────────────────
// webhook_whatsapp exporte { router, ... } depuis sprint 1 ; on monte uniquement le router
app.use('/webhook/whatsapp', webhookWhatsapp.router || webhookWhatsapp);
app.use('/webhook',         webhookInstagram.router);
app.use('/api',             dashboardRouter);

// Healthcheck — utilisé par les outils de monitoring et déploiement
app.get('/health', async (req, res) => {
  let dbStatus = 'ok';
  try {
    await require('./db/client').query('SELECT 1');
  } catch {
    dbStatus = 'error';
  }
  res.json({
    status:          'ok',
    uptime_seconds:  Math.floor(process.uptime()),
    version:         '1.0.0',
    db:              dbStatus,
  });
});

// ── Gestion des routes inconnues ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

// ── Démarrage ──────────────────────────────────────────────────────────────────
// require.main === module : vrai quand lancé directement (node index.js / nodemon)
// faux quand importé par les tests, ce qui évite un double listen sur le même port
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(JSON.stringify({
      event:       'server_started',
      port:        PORT,
      environment: process.env.NODE_ENV || 'development',
      timestamp:   new Date().toISOString(),
    }));
  });
  startScheduler();
}

module.exports = app;
