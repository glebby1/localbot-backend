// Script interactif d'onboarding Google Calendar pour un merchant
// Lancement : node scripts/google_oauth_setup.js
//
// Prérequis : GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env

require('dotenv').config();

const readline = require('readline');
const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob',
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/calendar.events'],
});

function askQuestion(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function main() {
  console.log('\nOuvre ce lien dans ton navigateur :');
  console.log(authUrl);
  console.log('');

  const code = await askQuestion('Colle le code ici : ');

  const { tokens } = await oauth2Client.getToken(code);

  console.log('\nRefresh token :', tokens.refresh_token);
  console.log('Copie ce token dans le champ google_refresh_token du merchant en base.');
}

main().catch((err) => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
