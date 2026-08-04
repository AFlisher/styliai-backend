const { z } = require("zod");

/**
 * SEC-9.1 - explicit body schemas for the admin catalog CRUD surface.
 *
 * WHY
 * ---
 * These handlers validated by writing `name?.trim()` and letting the database
 * column types do the rest. That has two distinct failure modes, and only the
 * first is obvious:
 *
 *   1. `name?.trim()` throws TypeError when `name` is a number or an object,
 *      because optional chaining guards against null/undefined and nothing
 *      else. The throw escapes the handler's own validation branch, lands in
 *      the generic catch, and answers 500 - so sending `{"name": 123}` to
 *      POST /api/categories produced a server error rather than a 400.
 *
 *   2. Fields the handler forwards without inspecting (`sortOrder`, `badge`,
 *      `description`, `isEnabled`) were bounded only by the column type. That
 *      is real enforcement, but it means the API's contract lives in the
 *      schema rather than in the code, and any column widened later silently
 *      widens the accepted input with it.
 *
 * ATTACK PREVENTED
 * ----------------
 * No privilege escalation and no mass assignment - Section 2 of the audit
 * confirmed no controller spreads req.body into a DB write and no
 * client-supplied identity or privilege field is honoured anywhere, which is
 * why the audit rated this Low and hardening rather than a hole. What is
 * actually closed: type-confusion crashes on an authenticated endpoint being
 * reported as 500s, which both pollutes the error stream that real faults have
 * to be spotted in and hands a caller a cheap way to generate them. Length
 * caps additionally stop an admin token being used to write unbounded text
 * into catalog columns.
 *
 * COMPATIBILITY
 * -------------
 * Every payload the Admin Dashboard currently sends was read out of
 * admin_dashboard/src/services/api.ts and its call sites before these schemas
 * were written, and each is accepted unchanged:
 *   - addCategory      -> { name, isEnabled }
 *   - updateCategory   -> { name, isEnabled, sortOrder }
 *   - addTag/updateTag -> { name, isEnabled }
 *   - add/updateCreditPack -> { name, credits, priceDisplay, badge,
 *                              description, isEnabled, sortOrder }
 *
 * `.strict()` is applied HERE and deliberately nowhere else - see the note on
 * strictness at the bottom of this file.
 */

// Shared field builders, so "a catalog name" means one thing across all three
// resources rather than three slightly different things.
const catalogName = (label) =>
  z
    .string({ message: `${label} must be a string.` })
    .trim()
    .min(1, `${label} is required.`)
    // Comfortably above the longest name in the live catalog and at or below
    // every backing column (VARCHAR(255)), so this rejects locally what the
    // database would otherwise reject as a write error.
    .max(255, `${label} must be at most 255 characters.`);

// Accepts a real boolean only. Deliberately NOT coercing: z.coerce.boolean()
// maps every non-empty string to true, so the string "false" would enable a
// disabled style - a coercion that silently inverts an operator's intent is
// worse than a 400 that tells them to send a boolean.
const enabledFlag = z.boolean({ message: "isEnabled must be a boolean." });

// sortOrder arrives from a numeric input, so a numeric string is a plausible
// and harmless client encoding; coercion is safe here in a way it is not for
// booleans. Bounded on both sides because the column is a signed int and
// nothing in the UI can meaningfully use values beyond this.
const sortOrder = z.coerce
  .number({ message: "sortOrder must be a number." })
  .int("sortOrder must be a whole number.")
  .min(0, "sortOrder must not be negative.")
  .max(1_000_000, "sortOrder is out of range.");

// Optional free text that may legitimately be cleared by sending null.
const optionalText = (label, max) =>
  z
    .string({ message: `${label} must be a string.` })
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .nullish();

const categoryCreateSchema = z
  .object({
    name: catalogName("Category name"),
    isEnabled: enabledFlag.optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict();

const categoryUpdateSchema = categoryCreateSchema;

const tagCreateSchema = z
  .object({
    name: catalogName("Tag name"),
    isEnabled: enabledFlag.optional(),
  })
  .strict();

const tagUpdateSchema = tagCreateSchema;

const creditPackCreateSchema = z
  .object({
    name: catalogName("Pack name"),
    // Kept as a strict positive integer, matching the check the handler
    // already performed by hand - this replaces that check rather than
    // layering on top of it, so the accepted set is unchanged.
    credits: z.coerce
      .number({ message: "Credits must be a number." })
      .int("Credits must be a positive whole number.")
      .positive("Credits must be a positive whole number.")
      .max(1_000_000, "Credits is out of range."),
    priceDisplay: z
      .string({ message: "Price display text must be a string." })
      .trim()
      .min(1, "Price display text is required.")
      .max(64, "Price display text must be at most 64 characters."),
    badge: optionalText("Badge", 64),
    description: optionalText("Description", 500),
    isEnabled: enabledFlag.optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict();

const creditPackUpdateSchema = creditPackCreateSchema;

/**
 * WHY `.strict()` IS SCOPED TO THIS FILE
 * --------------------------------------
 * SEC-9.4 raises rejecting unknown fields as optional hardening ("consider
 * .strict() ... for clearer contracts"), and the audit is explicit that
 * stripping them is already safe here because there is no mass-assignment
 * path. So strictness buys contract clarity, not a closed hole - which makes
 * its compatibility cost the deciding factor, and that cost differs sharply by
 * client:
 *
 *   - The Admin Dashboard is a web app served fresh on every load, and the
 *     exact bodies it sends are enumerated above and all accepted. If a future
 *     build adds a field, the failure is an immediate, named 400 in a staff-
 *     only tool. Strict is affordable, so it is applied.
 *
 *   - The mobile client is an INSTALLED BINARY. Versions in the field cannot
 *     be updated in lockstep with a backend deploy, so making its schemas
 *     strict would convert "old app sends a field the server no longer knows"
 *     from a silently-ignored non-event into a hard 400 on, say, login - for
 *     users who cannot fix it by refreshing. That is a breaking API change in
 *     exchange for clarity the audit already rates as optional, so the
 *     mobile-facing schemas in authController and elsewhere are deliberately
 *     left non-strict (Zod's default: unknown keys stripped).
 *
 * This split is the finding's intent - defence in depth where it is free -
 * without spending backward compatibility to buy it.
 */
module.exports = {
  categoryCreateSchema,
  categoryUpdateSchema,
  tagCreateSchema,
  tagUpdateSchema,
  creditPackCreateSchema,
  creditPackUpdateSchema,
};
