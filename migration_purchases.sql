-- Migration: server-verified in-app purchases (Sprint 2 / B-3).
--
-- Replaces the simulated paywall, which granted credits in device memory and
-- never contacted this server at all. Credits are now granted only after the
-- platform's own API confirms the purchase, and this table is what stops the
-- same confirmed purchase being redeemed twice.
--
-- WHY THIS IS ITS OWN TABLE AND NOT A wallet_transactions COLUMN
--
-- wallet_transactions is an append-only ledger of balance movements; it has no
-- uniqueness constraint on anything a store could give us, and adding one would
-- change the meaning of a table every other credit path already writes to. The
-- claim has to be a PRIMARY KEY on the store's own identifier so that two
-- concurrent redemptions of one purchase resolve in the database rather than in
-- application logic - the same shape processed_ad_transactions already uses for
-- AdMob callbacks, and for the same reason.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS processed_purchases (
  -- The platform's identifier for this purchase:
  --   Google Play: purchaseToken (unique per purchase, not per product)
  --   Apple:       transactionId from the decoded JWS
  -- Both are opaque to us and are never parsed - only compared and stored.
  --
  -- PRIMARY KEY is the replay control. A second redemption attempt with the
  -- same value fails the INSERT rather than reaching the grant.
  purchase_id TEXT PRIMARY KEY,

  -- 'google' | 'apple'. Kept so a purchase_id collision across platforms is
  -- diagnosable, and so a platform can be reconciled independently.
  platform TEXT NOT NULL CHECK (platform IN ('google', 'apple')),

  -- No FK, deliberately, matching processed_ad_transactions: the replay guard
  -- must keep working after the buyer deletes their account (Sprint 1 / B-1),
  -- and a cascade would delete the very rows that stop a refunded-then-replayed
  -- purchase being redeemed again by a new account.
  user_id UUID NOT NULL,

  -- The store SKU, resolved to a credit_packs row at grant time. Stored as the
  -- store reported it, so a mismatch between what was bought and what was
  -- granted is visible after the fact rather than inferred.
  product_id TEXT NOT NULL,

  -- What we actually credited. Not derived from the client, and not re-derived
  -- from credit_packs later: the pack's `credits` can be edited in the admin
  -- dashboard, and this row must record what this buyer received.
  credits_granted INTEGER NOT NULL CHECK (credits_granted > 0),

  -- Google returns an orderId; Apple an originalTransactionId. Nullable because
  -- neither is guaranteed, and neither is load-bearing - purchase_id is.
  order_id TEXT,

  -- Google Play requires a purchase be acknowledged within three days or it is
  -- automatically refunded. Recorded so an unacknowledged purchase is
  -- queryable rather than silently expiring into a refund.
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "What did this user buy" (support enquiries, restore) and "what has not been
-- acknowledged yet" (the three-day refund window) are the two real queries.
CREATE INDEX IF NOT EXISTS idx_processed_purchases_user
  ON processed_purchases (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_processed_purchases_unacknowledged
  ON processed_purchases (created_at)
  WHERE NOT acknowledged;

COMMENT ON TABLE processed_purchases IS
  'Sprint 2 / B-3: one row per store-verified purchase. purchase_id is the '
  'store''s own identifier and is the PRIMARY KEY, which is what makes '
  'redemption idempotent. No FK to users - the replay guard must outlive '
  'account deletion.';

COMMENT ON COLUMN processed_purchases.acknowledged IS
  'Google Play auto-refunds purchases not acknowledged within three days. '
  'FALSE here past that window means money was returned to the buyer.';

-- Store SKUs live on credit_packs.product_id, which already exists but is NULL
-- for every seeded pack. It is intentionally NOT populated here: the SKU is
-- created in the Play Console and App Store Connect by an operator, and
-- inventing values would produce a catalogue that silently fails verification
-- against every real purchase. Purchases of a product_id that matches no
-- enabled pack are refused (see purchaseService), which is the correct
-- behaviour while these are unset.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_packs_product_id
  ON credit_packs (product_id)
  WHERE product_id IS NOT NULL;
