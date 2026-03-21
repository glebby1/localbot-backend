-- Script d'initialisation des tables LocalBot
-- Idempotent : IF NOT EXISTS sur chaque CREATE TABLE

-- ── merchant ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merchant (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT,
  plan                  TEXT        NOT NULL DEFAULT 'trial',
  whatsapp_number       TEXT        UNIQUE,
  instagram_id          TEXT,
  system_prompt         TEXT,
  google_refresh_token  TEXT,
  google_calendar_id    TEXT,
  stripe_subscription_id TEXT,
  email                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── conversation ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    UUID        REFERENCES merchant(id),
  channel        TEXT,
  customer_phone TEXT,
  status         TEXT        NOT NULL DEFAULT 'active',
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── message ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID        REFERENCES conversation(id),
  role             TEXT,
  content          TEXT,
  tokens_used      INT         NOT NULL DEFAULT 0,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── reservation ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservation (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID        REFERENCES conversation(id),
  customer_name    TEXT,
  customer_phone   TEXT,
  party_size       INT,
  booked_for       TIMESTAMPTZ,
  status           TEXT        NOT NULL DEFAULT 'confirmed',
  google_event_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── faq ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS faq (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID        REFERENCES merchant(id),
  question    TEXT,
  answer      TEXT,
  hit_count   INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── notification ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID        REFERENCES merchant(id),
  type        TEXT,
  message     TEXT,
  data        JSONB       NOT NULL DEFAULT '{}',
  read        BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
