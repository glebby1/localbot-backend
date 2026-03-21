// Authentification Google Calendar via OAuth2
// Retourne un client authentifié à partir du refresh_token stocké en DB

const { google } = require('googleapis');

/**
 * Crée et configure un client OAuth2 Google pour un merchant.
 *
 * @param {object} merchant - Objet merchant (doit avoir id et google_refresh_token)
 * @returns {import('googleapis').Auth.OAuth2Client|null}
 */
function getGoogleAuthClient(merchant) {
  if (!merchant.google_refresh_token) {
    console.log(JSON.stringify({
      event:      'google_auth_missing',
      merchantId: merchant.id,
    }));
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob',
  );

  oauth2Client.setCredentials({ refresh_token: merchant.google_refresh_token });
  return oauth2Client;
}

module.exports = { getGoogleAuthClient };
