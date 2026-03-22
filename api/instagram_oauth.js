// OAuth Instagram — échange du code d'autorisation contre un access token
// Route : GET /api/instagram/callback

const express = require('express');
const axios   = require('axios');
const logger  = require('../utils/logger');

const router = express.Router();

router.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('<h2>Erreur : paramètre "code" manquant dans la requête.</h2>');
  }

  try {
    const params = new URLSearchParams({
      client_id:     process.env.INSTAGRAM_APP_ID     || '',
      client_secret: process.env.INSTAGRAM_APP_SECRET || '',
      grant_type:    'authorization_code',
      redirect_uri:  (process.env.PUBLIC_URL || '') + '/api/instagram/callback',
      code,
    });

    const { data } = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const { access_token, user_id: instagram_user_id } = data;

    logger.info('instagram_oauth_callback', { instagram_user_id, access_token });

    return res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Connexion Instagram réussie</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
    code { background: #f4f4f4; padding: 4px 8px; border-radius: 4px; word-break: break-all; }
    h2   { color: #2e7d32; }
  </style>
</head>
<body>
  <h2>Connexion Instagram réussie !</h2>
  <p><strong>Copiez votre token :</strong><br><code>${access_token}</code></p>
  <p><strong>Copiez votre instagram_id :</strong><br><code>${instagram_user_id}</code></p>
</body>
</html>`);
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;

    logger.error('instagram_oauth_error', err);

    return res.status(500).send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Erreur OAuth Instagram</title>
  <style>body { font-family: sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }</style>
</head>
<body>
  <h2 style="color:#c62828">Erreur lors de la connexion Instagram</h2>
  <pre>${detail}</pre>
</body>
</html>`);
  }
});

module.exports = { router };
