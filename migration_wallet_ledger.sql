-- Migration: wallet_transactions and daily_rewards tables.
-- Both exist in production but were never captured in a checked-in migration.
-- wallet_transactions is created here with the correct 'generation' type
-- already included, so a fresh install never needs the separate
-- migration_fix_wallet_transaction_type.sql correction.
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  type VARCHAR(30) NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT wallet_transaction_amount_non_zero CHECK (amount <> 0),
  CONSTRAINT wallet_transaction_type_check CHECK (type IN ('reward', 'purchase', 'generation', 'refund', 'admin'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON wallet_transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_user_created ON wallet_transactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_date DATE NOT NULL,
  credits_claimed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  CONSTRAINT credits_claimed_non_negative CHECK (credits_claimed >= 0),
  CONSTRAINT daily_rewards_user_id_reward_date_key UNIQUE (user_id, reward_date)
);
