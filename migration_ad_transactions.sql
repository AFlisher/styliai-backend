-- Migration: processed_ad_transactions table for AdMob SSV replay protection.
-- Moved out of walletController.js's request handler (was previously created
-- via CREATE TABLE IF NOT EXISTS on every /api/wallet/reward/verify call).
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS processed_ad_transactions (
  transaction_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL,
  reward_amount INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
