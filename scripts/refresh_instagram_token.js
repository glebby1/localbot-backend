// Échange un User Access Token court contre un Page Access Token permanent.
//
// Flux en 2 étapes :
//  1. User Token court  →  User Token long (~60 jours) via fb_exchange_token
//  2. User Token long   →  Page Access Token permanent via /me/accounts
//
// Variables requises dans .env :
//   INSTAGRAM_APP_ID      — App ID Meta
//   INSTAGRAM_APP_SECRET  — App Secret Meta
//   INSTAGRAM_USER_TOKEN  — User Access Token court (depuis Graph API Explorer)
//   INSTAGRAM_PAGE_ID     — ID de la Page Facebook liée au compte Instagram Business

require('dotenv').config();
const axios = require('axios');

async function run() {
  const { INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_USER_TOKEN, INSTAGRAM_PAGE_ID } = process.env;

  if (!INSTAGRAM_APP_ID || !INSTAGRAM_APP_SECRET || !INSTAGRAM_USER_TOKEN || !INSTAGRAM_PAGE_ID) {
    console.error('Variables manquantes. Requis dans .env :');
    console.error('  INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_USER_TOKEN, INSTAGRAM_PAGE_ID');
    process.exit(1);
  }

  // ── Étape 1 : User Token court → User Token long (~60 jours) ──────────────
  console.log('\n⏳ Étape 1 : échange User Token court → long...');
  let longUserToken;
  try {
    const { data } = await axios.get('https://graph.facebook.com/oauth/access_token', {
      params: {
        grant_type:        'fb_exchange_token',
        client_id:         INSTAGRAM_APP_ID,
        client_secret:     INSTAGRAM_APP_SECRET,
        fb_exchange_token: INSTAGRAM_USER_TOKEN,
      },
    });
    longUserToken = data.access_token;
    const expiresIn = data.expires_in;
    console.log('✅ User Token long obtenu');
    console.log(`   expires_in   : ${expiresIn}s (~${Math.round(expiresIn / 86400)} jours)`);
    console.log(`   access_token : ${longUserToken}`);
  } catch (err) {
    console.error('❌ Échec étape 1 :');
    console.error('  status :', err.response?.status);
    console.error('  data   :', JSON.stringify(err.response?.data, null, 2));
    process.exit(1);
  }

  // ── Étape 2 : User Token long → Page Access Token permanent ───────────────
  console.log('\n⏳ Étape 2 : récupération des pages Facebook liées...');
  try {
    const { data } = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
      params: {
        access_token: longUserToken,
        fields:       'id,name,access_token,instagram_business_account',
      },
    });

    const pages = data.data || [];

    if (pages.length === 0) {
      console.error('❌ Aucune page Facebook trouvée pour cet utilisateur.');
      console.error('   Assure-toi que ton compte Instagram Business est bien lié à une Page Facebook.');
      process.exit(1);
    }

    console.log(`\n✅ ${pages.length} page(s) trouvée(s) :\n`);
    for (const page of pages) {
      const igId = page.instagram_business_account?.id ?? 'N/A';
      console.log(`  Page : ${page.name} (Facebook Page ID: ${page.id})`);
      console.log(`         Instagram Business ID : ${igId}`);
      console.log(`         access_token : ${page.access_token}`);

      if (igId === INSTAGRAM_PAGE_ID) {
        console.log('\n  ⭐ Cette page correspond à ton INSTAGRAM_PAGE_ID.');
        console.log('\n👉 Mets à jour INSTAGRAM_TOKEN dans Railway (et dans .env) avec cette valeur.');
        console.log('   Ce token est permanent — il n\'expire pas.\n');
      }
      console.log('');
    }
  } catch (err) {
    console.error('❌ Échec étape 2 :');
    console.error('  status :', err.response?.status);
    console.error('  data   :', JSON.stringify(err.response?.data, null, 2));
    process.exit(1);
  }
}

run();
