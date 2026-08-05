"use strict";

const db = require("../config/db");
const avatarService = require("./avatarService");
const creationAssetCleanup = require("./creationAssetCleanup");
const { logger } = require("../utils/logger");

/**
 * Sprint 1 / Release Blocker B-1 - irreversible self-service account deletion.
 *
 * ─── Why a hard DELETE and not a soft one ───────────────────────────────────
 *
 * This codebase already has a soft mechanism: `users.status` drives suspension
 * (SEC-15.3), and reusing it here would have been less code. It is the wrong
 * answer. A suspended row still holds the email, the password hash, the Google
 * id, the country and the avatar URL - so a "deleted" account under that scheme
 * is a fully intact personal record with a flag on it, which satisfies neither
 * GDPR Art. 17 nor the plain-language promise the deletion screen makes. The
 * row goes.
 *
 * ─── Why that is also the session revocation mechanism ──────────────────────
 *
 * authMiddleware calls sessionService.getUserSessionState() on EVERY
 * authenticated request and 401s when it returns null (authMiddleware.js:75).
 * Removing the row makes that lookup return null, so every outstanding access
 * token - including ones minted seconds earlier and not yet expired - fails on
 * its next use. There is no denylist to maintain and no window to reason about.
 * refresh_tokens cascade away in the same statement, so the refresh path is
 * closed at the same instant. This is why the service does not separately call
 * revokeAllUserRefreshTokens(): the cascade already did, and a redundant
 * DELETE would only suggest the cascade was not trusted.
 *
 * ─── Ordering ───────────────────────────────────────────────────────────────
 *
 *   1. Read the asset URLs   - they live in rows that step 3 destroys.
 *   2. De-link the two tables that do NOT cascade.
 *   3. Write the attestation, then DELETE the user (one transaction).
 *   4. Erase storage objects - AFTER commit, and never throwing.
 *
 * Step 4 must follow the commit, not precede it: creationAssetCleanup refuses
 * to remove an object that any surviving row still references, so running it
 * first would correctly skip every single object. Running it after means the
 * referential guard sees no references and proceeds - the same order
 * creationsController already uses for single-creation deletes.
 *
 * The failure mode of that ordering is an orphaned object, not a deleted live
 * one, and it is recorded (`storage_erasure_complete = FALSE`) and reclaimable
 * via `npm run reconcile-creations`. The opposite ordering's failure mode is a
 * user whose images were destroyed by a deletion that then rolled back.
 */

/**
 * Tables holding this user's data that do NOT cascade from public.users.
 * Everything else is reached by ON DELETE CASCADE - see the FK inventory in
 * PRODUCTION_READINESS_REVIEW.md §5 and the per-table reasoning below.
 */

/**
 * Collects the storage URLs owned by this account before its rows are removed.
 *
 * Reads creations only. The avatar is addressed by user id rather than by URL
 * (see avatarService.deleteAvatar for why), so it needs no lookup here.
 */
async function collectCreationAssets(userId) {
  const { rows } = await db.query(
    "SELECT id, image_url, thumbnail_url FROM creations WHERE user_id = $1",
    [userId]
  );
  return rows;
}

/**
 * Deletes the account and everything cascading from it, atomically.
 *
 * Returns the counts the caller needs for the attestation row; throws only on a
 * genuine database failure, in which case the transaction is rolled back and
 * NOTHING has been deleted - the account is intact and the caller may retry.
 */
async function eraseDatabaseRows(userId, creationCount) {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    // Re-read the row inside the transaction and lock it. Two concurrent
    // deletion requests for the same account (a double-tap, or a retry racing
    // the original) would otherwise both pass the controller's existence check
    // and both try to write an attestation. The second one finds no row and
    // returns `already_deleted` instead, which is what makes this endpoint
    // idempotent rather than merely tolerant.
    const existing = await client.query(
      "SELECT id FROM public.users WHERE id = $1 FOR UPDATE",
      [userId]
    );

    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return { deleted: false, reason: "already_deleted" };
    }

    // ── The two tables that do not cascade ──────────────────────────────────

    // integrity_verdicts has no FK to users (migration_integrity_verdicts.sql:53)
    // because it is keyed by token digest, not by account. The ROW is an
    // anti-replay ledger and must survive - dropping it inside its reuse window
    // would let a token this user already spent be presented again. Only the
    // personal link is removed. The row self-evicts on
    // PLAY_INTEGRITY_LEDGER_TTL_MS (24h by default) regardless.
    await client.query(
      "UPDATE integrity_verdicts SET user_id = NULL WHERE user_id = $1",
      [userId]
    );

    // processed_ad_transactions also has no FK (migration_ad_transactions.sql:8).
    // Unlike the verdict ledger, these rows are deleted outright: their only
    // purpose is to stop one AdMob transaction_id crediting the same user
    // twice, and with the user row gone walletService.rewardAd() has nobody to
    // credit - a replayed callback claims the id, fails to reward, and releases
    // it again (walletController.js:186-192). Keeping them would retain a
    // per-user reward history for an account that no longer exists.
    await client.query(
      "DELETE FROM processed_ad_transactions WHERE user_id = $1",
      [userId]
    );

    // ── Attestation before erasure ──────────────────────────────────────────
    //
    // Written inside the same transaction as the DELETE so the two cannot
    // disagree: either the account is gone AND the record of it exists, or
    // neither happened. A record written afterwards, outside the transaction,
    // is exactly the record that goes missing when the process dies between the
    // two - which is the case it exists for.
    const attestation = await client.query(
      `INSERT INTO account_deletions (user_id, requested_via, creations_deleted)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [userId, "self_service_api", creationCount]
    );

    // Cascades to: profiles, creations, favorites, notifications,
    // wallet_transactions, daily_rewards, refresh_tokens, generation_events,
    // generation_feedback, generation_idempotency, abuse_findings,
    // user_risk_scores. All are user-owned; none is shared system data.
    //
    // NOT touched, deliberately: styles, categories, tags, credit_packs (shared
    // catalogue), and admin_audit_log (an admin accountability trail that
    // records who acted on whom - migration_admin_audit_log.sql:20 already
    // states that an account is not an audit trail).
    const removed = await client.query("DELETE FROM public.users WHERE id = $1", [userId]);

    await client.query("COMMIT");

    return {
      deleted: removed.rowCount === 1,
      attestationId: attestation.rows[0] && attestation.rows[0].id,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.error("account_deletion_rollback_failed", {
        userId,
        error: (rollbackErr && rollbackErr.message) || "unknown",
      });
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Erases the account's storage objects. Runs after the commit and never throws.
 *
 * Creation objects go through creationAssetCleanup so the bucket allow-list and
 * the still-referenced guard apply unchanged - a creation whose image is also
 * referenced by a row belonging to somebody else (possible via the legacy
 * `migrateCreations` path) is skipped rather than destroyed.
 */
async function eraseStorage({ userId, creations }) {
  let objectsDeleted = 0;
  let complete = true;

  for (const creation of creations) {
    // eslint-disable-next-line no-await-in-loop
    const result = await creationAssetCleanup.deleteCreationAssets({
      creationId: creation.id,
      urls: [creation.image_url, creation.thumbnail_url],
    });

    objectsDeleted += (result && result.deleted) || 0;

    // deleteCreationAssets never throws; it reports a failure as deleted: 0
    // with the reason logged. Anything it refused or could not remove leaves an
    // orphan worth flagging on the attestation row.
    if (result && Array.isArray(result.skipped) && result.skipped.length > 0) {
      complete = false;
    }
  }

  const avatar = await avatarService.deleteAvatar(userId);
  objectsDeleted += (avatar && avatar.deleted) || 0;

  return { objectsDeleted, complete };
}

/**
 * The whole flow. See the header for ordering and rationale.
 *
 * @param {string} userId
 * @returns {Promise<{deleted: boolean, reason?: string, creationsDeleted: number,
 *                    storageObjectsDeleted: number, storageErasureComplete: boolean}>}
 */
async function deleteAccount(userId) {
  // 1. Asset inventory, taken while the rows still exist.
  const creations = await collectCreationAssets(userId);

  // 2-3. Everything relational, atomically.
  const dbResult = await eraseDatabaseRows(userId, creations.length);

  if (!dbResult.deleted) {
    return {
      deleted: false,
      reason: dbResult.reason || "not_found",
      creationsDeleted: 0,
      storageObjectsDeleted: 0,
      storageErasureComplete: true,
    };
  }

  // 4. Objects, post-commit, best-effort.
  const storage = await eraseStorage({ userId, creations });

  if (!storage.complete) {
    // Best-effort flag update. The account is already erased; failing to mark
    // the attestation must not turn a completed deletion into an error, so this
    // is logged and dropped rather than thrown.
    try {
      await db.query(
        `UPDATE account_deletions
         SET storage_erasure_complete = FALSE, storage_objects_deleted = $2
         WHERE id = $1`,
        [dbResult.attestationId, storage.objectsDeleted]
      );
    } catch (err) {
      logger.error("account_deletion_attestation_update_failed", {
        userId,
        error: (err && err.message) || "unknown",
      });
    }
  } else if (storage.objectsDeleted > 0) {
    try {
      await db.query(
        "UPDATE account_deletions SET storage_objects_deleted = $2 WHERE id = $1",
        [dbResult.attestationId, storage.objectsDeleted]
      );
    } catch (err) {
      logger.error("account_deletion_attestation_update_failed", {
        userId,
        error: (err && err.message) || "unknown",
      });
    }
  }

  return {
    deleted: true,
    creationsDeleted: creations.length,
    storageObjectsDeleted: storage.objectsDeleted,
    storageErasureComplete: storage.complete,
  };
}

module.exports = {
  deleteAccount,
  // Exported for tests: the ordering guarantees above are the security
  // property, so they are asserted directly rather than inferred end to end.
  collectCreationAssets,
  eraseDatabaseRows,
  eraseStorage,
};
