-- Migration: Fix wallet_transactions type CHECK constraint.
-- The live constraint allowed 'generate' but every application code path
-- (walletService.js, generateController.js) uses 'generation' - every real
-- generation's credit deduction was failing with a check-constraint
-- violation, rolling back the whole transaction (balance never deducted).
-- Safe to run multiple times.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'wallet_transactions'
      AND constraint_name = 'wallet_transaction_type_check'
  ) THEN
    ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transaction_type_check;
  END IF;

  ALTER TABLE wallet_transactions
    ADD CONSTRAINT wallet_transaction_type_check
    CHECK (type IN ('reward', 'purchase', 'generation', 'refund', 'admin'));
END $$;
