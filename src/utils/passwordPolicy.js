const { z } = require('zod');

/**
 * Single source of truth for the password policy (audit finding #8).
 * Applied to register, change-password, and reset-password so the three
 * flows can never drift apart again: at least 8 characters with one
 * uppercase letter, one lowercase letter, one digit, and one special
 * character. The mobile client mirrors the same rules in its form
 * validators.
 */
const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 8 characters and contain at least 1 uppercase letter, 1 lowercase letter, 1 digit, and 1 special character (!@#$&*~).";

const passwordSchema = z
  .string()
  .min(8, PASSWORD_POLICY_MESSAGE)
  .regex(/[A-Z]/, PASSWORD_POLICY_MESSAGE)
  .regex(/[a-z]/, PASSWORD_POLICY_MESSAGE)
  .regex(/[0-9]/, PASSWORD_POLICY_MESSAGE)
  .regex(/[!@#$&*~]/, PASSWORD_POLICY_MESSAGE);

module.exports = { passwordSchema, PASSWORD_POLICY_MESSAGE };
