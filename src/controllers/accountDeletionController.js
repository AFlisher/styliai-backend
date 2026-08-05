"use strict";

const bcrypt = require("bcrypt");

const db = require("../config/db");
const accountDeletionService = require("../services/accountDeletionService");
const { AppError, ErrorCodes } = require("../utils/errors");
const { logAuditEvent, logAuthFailure, logUnexpectedError } = require("../utils/securityEvents");

/**
 * Sprint 1 / Release Blocker B-1 - POST /api/auth/delete-account.
 *
 * Google Play (Data deletion policy, in-app path required) and App Store
 * Guideline 5.1.1(v) both require this to exist and to be reachable from inside
 * the app. Neither accepts "email support and we'll do it manually".
 *
 * ─── The confirmation phrase, and why it is not security theatre ────────────
 *
 * `confirmation` must be the exact string "DELETE". It is not an authentication
 * factor and is not treated as one - authMiddleware has already established WHO
 * is calling. It establishes THAT THEY MEANT IT, which is a different property
 * and the one that matters for an irreversible action reachable from a settings
 * screen. It also makes the endpoint safe against a stray client retry of a
 * malformed body, which a bare POST would not be.
 *
 * ─── Re-authentication ──────────────────────────────────────────────────────
 *
 * Password accounts must supply `currentPassword`, verified with bcrypt exactly
 * as changePassword does. This is the "recent authentication" control: an
 * access token lives an hour, so an unlocked phone left on a table is enough to
 * reach this endpoint otherwise, and the action cannot be undone.
 *
 * Google accounts have no local password to verify - `password_hash` holds a
 * placeholder, and changePassword already refuses them for the same reason
 * (authController.js:1085). Demanding one would make deletion IMPOSSIBLE for
 * every OAuth user, which fails the store requirement outright. They are
 * therefore gated on the confirmation phrase alone. This is a deliberate,
 * documented asymmetry: re-authentication is applied wherever it is technically
 * possible, and the alternative - a re-consent round trip through Google - is a
 * larger change than this sprint, tracked rather than silently skipped.
 */

/** The exact phrase the client must echo back. Compared case-sensitively. */
const CONFIRMATION_PHRASE = "DELETE";

async function deleteAccount(req, res, next) {
  const userId = req.user && req.user.id;

  try {
    const { confirmation, currentPassword } = req.body || {};

    if (confirmation !== CONFIRMATION_PHRASE) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Account deletion must be confirmed by sending confirmation: "${CONFIRMATION_PHRASE}".`,
        400
      );
    }

    // Read the provider and hash under the caller's own id only. There is no
    // id in the request body anywhere in this flow, so there is nothing to
    // tamper with and no other account this endpoint can be pointed at.
    const { rows } = await db.query(
      "SELECT id, provider, password_hash FROM public.users WHERE id = $1",
      [userId]
    );

    if (rows.length === 0) {
      // Effectively unreachable: authMiddleware 401s once the row is gone. Kept
      // because "the row vanished between auth and here" is a real race with a
      // concurrent deletion, and the honest answer to it is that the account is
      // already deleted - which is a success from the caller's point of view.
      logAuditEvent(req, {
        action: "account_deletion",
        outcome: "already_deleted",
        subject: userId,
      });
      return res.status(200).json({
        message: "Account deleted.",
        deleted: true,
        alreadyDeleted: true,
      });
    }

    const user = rows[0];
    const isOAuthOnly = user.provider === "google";

    if (!isOAuthOnly) {
      if (typeof currentPassword !== "string" || currentPassword.length === 0) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          "Your current password is required to delete this account.",
          400
        );
      }

      const match = await bcrypt.compare(currentPassword, user.password_hash);
      if (!match) {
        // Logged as an auth failure rather than a validation failure: a wrong
        // password on an irreversible action is the signal worth alerting on,
        // and it is the same event shape the login path emits.
        logAuthFailure(req, { reason: "delete_account_bad_password" });
        throw new AppError(ErrorCodes.FORBIDDEN, "Incorrect password.", 403);
      }
    }

    // Audited BEFORE the erasure as well as after: if the process dies mid-flow,
    // the attempt is still on record. The durable attestation row is written
    // inside the service's transaction (see accountDeletionService).
    logAuditEvent(req, {
      action: "account_deletion",
      outcome: "started",
      subject: userId,
      details: { reauth: isOAuthOnly ? "oauth_confirmation_only" : "password" },
    });

    const result = await accountDeletionService.deleteAccount(userId);

    if (!result.deleted) {
      logAuditEvent(req, {
        action: "account_deletion",
        outcome: "already_deleted",
        subject: userId,
      });
      return res.status(200).json({
        message: "Account deleted.",
        deleted: true,
        alreadyDeleted: true,
      });
    }

    logAuditEvent(req, {
      action: "account_deletion",
      outcome: "success",
      subject: userId,
      details: {
        creationsDeleted: result.creationsDeleted,
        storageObjectsDeleted: result.storageObjectsDeleted,
        storageErasureComplete: result.storageErasureComplete,
      },
    });

    // Counts are returned so the client can show an honest confirmation, and
    // deliberately nothing else - the caller's session is dead as of the
    // transaction that answered this request, so there is no token to rotate
    // and nothing further to say.
    return res.status(200).json({
      message: "Account deleted.",
      deleted: true,
      creationsDeleted: result.creationsDeleted,
      storageObjectsDeleted: result.storageObjectsDeleted,
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        logAuditEvent(req, {
          action: "account_deletion",
          outcome: "failure",
          subject: userId,
        });
      }
      return next(err);
    }

    // A database failure here means the transaction rolled back and the account
    // is intact, so the honest answer is a 500 the caller may retry - never a
    // 200 that would tell them their data is gone when it is not.
    logUnexpectedError(req, err, { where: "deleteAccount" });
    logAuditEvent(req, {
      action: "account_deletion",
      outcome: "failure",
      subject: userId,
    });
    return next(
      new AppError(
        ErrorCodes.INTERNAL_ERROR,
        "Account deletion could not be completed. Your account has not been changed.",
        500
      )
    );
  }
}

module.exports = { deleteAccount, CONFIRMATION_PHRASE };
