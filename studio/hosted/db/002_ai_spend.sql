-- The global monthly AI spend ledger (src/lib/ai-spend.ts). One row per admitted chat turn:
-- `reserved_usd` is held from admission until the turn settles `cost_usd`. A month's spend is
-- the sum of cost_usd, or reserved_usd for turns that never settled.
CREATE SCHEMA IF NOT EXISTS studio;

CREATE TABLE IF NOT EXISTS studio.ai_spend (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  month date NOT NULL,
  account_id text NOT NULL,
  model text NOT NULL,
  reserved_usd numeric(12, 6) NOT NULL,
  cost_usd numeric(12, 6),
  cost_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX IF NOT EXISTS ai_spend_month_idx
  ON studio.ai_spend (month);
