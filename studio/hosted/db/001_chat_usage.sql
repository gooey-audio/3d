CREATE SCHEMA IF NOT EXISTS studio;

CREATE TABLE IF NOT EXISTS studio.chat_turns (
  day date NOT NULL,
  account_id text NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_turns_day_account_idx
  ON studio.chat_turns (day, account_id);
