-- Migration : ajout des champs configuration merchant
-- Idempotent grâce à IF NOT EXISTS / DO $$

ALTER TABLE merchant
  ADD COLUMN IF NOT EXISTS type          TEXT,
  ADD COLUMN IF NOT EXISTS address       TEXT,
  ADD COLUMN IF NOT EXISTS phone         TEXT,
  ADD COLUMN IF NOT EXISTS hours         TEXT,
  ADD COLUMN IF NOT EXISTS services      TEXT,
  ADD COLUMN IF NOT EXISTS rules         TEXT,
  ADD COLUMN IF NOT EXISTS capacity      INT,
  ADD COLUMN IF NOT EXISTS tone          TEXT    NOT NULL DEFAULT 'chaleureux',
  ADD COLUMN IF NOT EXISTS use_emoji     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vouvoyer      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_reminder BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_name TEXT;

-- Ajout customer_name sur conversation si absent
ALTER TABLE conversation
  ADD COLUMN IF NOT EXISTS customer_name TEXT;
