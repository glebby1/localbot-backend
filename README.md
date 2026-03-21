# LocalBot

SaaS B2B de chatbot IA pour commerces locaux (restaurants, salons, boutiques).
Reçoit les messages WhatsApp & Instagram, répond via Claude, gère les réservations Google Calendar.

---

## Prérequis

- Node.js >= 18
- Un compte [Anthropic](https://console.anthropic.com) avec une clé API
- Une application Meta Business (WhatsApp Business API + Instagram Graph API)
- Un projet Google Cloud avec l'API Calendar activée
- Un compte SendGrid, Stripe, et une application Bubble.io

---

## Installation

```bash
# 1. Cloner le dépôt
git clone <url-du-repo> localbot
cd localbot

# 2. Installer les dépendances
npm install

# 3. Créer le fichier d'environnement
cp .env.example .env
```

---

## Configuration `.env`

Ouvrir `.env` et renseigner chaque variable :

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Clé API Anthropic |
| `META_VERIFY_TOKEN` | Token libre choisi lors du setup webhook Meta |
| `META_APP_SECRET` | Secret de l'app Meta (validation signature webhook) |
| `WHATSAPP_TOKEN` | Token d'accès WhatsApp Business API |
| `INSTAGRAM_TOKEN` | Token d'accès Instagram Graph API |
| `GOOGLE_CLIENT_ID` | Client ID OAuth2 Google Cloud |
| `GOOGLE_CLIENT_SECRET` | Client Secret OAuth2 Google Cloud |
| `SENDGRID_API_KEY` | Clé API SendGrid |
| `SENDGRID_FROM_EMAIL` | Adresse expéditeur vérifiée dans SendGrid |
| `STRIPE_SECRET_KEY` | Clé secrète Stripe (`sk_test_...` en dev) |
| `STRIPE_WEBHOOK_SECRET` | Secret webhook Stripe (`whsec_...`) |
| `BUBBLE_API_KEY` | Clé API Bubble (Data API) |
| `BUBBLE_APP_URL` | URL de base Bubble (`https://monapp.bubbleapps.io/api/1.1`) |
| `PORT` | Port du serveur (défaut : `3000`) |
| `NODE_ENV` | `development` ou `production` |

---

## Lancement

### Développement (rechargement automatique)

```bash
npm run dev
```

### Production

```bash
npm start
```

Le serveur démarre sur `http://localhost:3000`.

---

## Endpoints disponibles

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/health` | Healthcheck |
| `GET` | `/webhook/whatsapp` | Vérification webhook Meta |
| `POST` | `/webhook/whatsapp` | Réception messages WhatsApp |
| `GET` | `/webhook/instagram` | Vérification webhook Meta |
| `POST` | `/webhook/instagram` | Réception messages Instagram |

---

## Structure du projet

```
localbot/
├── index.js                  # Point d'entrée Express
├── config/
│   └── constants.js          # Constantes globales
├── webhooks/
│   ├── webhook_whatsapp.js   # Webhook WhatsApp
│   └── webhook_instagram.js  # Webhook Instagram
├── claude/                   # Appels Claude API + contexte conversationnel
├── calendar/                 # Intégration Google Calendar
├── notifications/            # Alertes et emails commerçant
├── payments/                 # Vérification abonnements Stripe
├── api/                      # Endpoints REST pour dashboard Bubble
├── utils/                    # Logger, error handler
├── tests/                    # Scripts de test
├── scripts/                  # Outils de setup et déploiement
├── .env.example              # Template variables d'environnement
└── package.json
```
