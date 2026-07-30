/**
 * R-2 phase 6 — reconciliation of avatar objects nothing points at any more.
 *
 * Usage:
 *   node src/utils/reconcileOrphanedAvatars.js [--delete] [--min-age-hours=N] [--limit=N]
 *
 * Measured motivation: three of the four objects in the `avatars` bucket
 * belonged to users that no longer exist. Nothing has ever deleted from this
 * bucket - there is no account-deletion path in the codebase at all - so an
 * avatar outlives its owner, publicly readable, named after their user id.
 *
 * ─── Why this is a separate script and not `avatars` in DELETABLE_BUCKETS ──
 *
 * The obvious change is to add `avatars` to creationAssetCleanup's bucket
 * allow-list and let the existing reconciler handle it. That would be wrong,
 * and the reason is worth stating plainly because it will look like an
 * oversight otherwise.
 *
 * DELETABLE_BUCKETS gates the deletion path reached from `deleteCreation`, and
 * a creation row's URL can be client-supplied through `migrateCreations`. An
 * avatar object's name IS its owner's user UUID - it is the one storage object
 * in this system an attacker can name without guessing. Putting `avatars` on
 * that list would let a crafted row plus a delete become a targeted erasure of
 * someone else's profile photo. The bucket is excluded there on purpose, and it
 * stays excluded.
 *
 * This script reaches storage directly with the service role instead, and is
 * only ever run by an operator. No request path can invoke it.
 *
 * ─── Safety properties ────────────────────────────────────────────────────
 *
 * DRY RUN IS THE DEFAULT. Deleting requires `--delete`, spelled out. There is
 * no undo: a deleted avatar is gone and the user must re-upload one.
 *
 * An object is a candidate only when BOTH hold:
 *
 *   1. `isReferenced` says no column anywhere in the schema points at it. This
 *      is the same predicate the creations delete path uses, checked against
 *      profiles.avatar_url and users.avatar_url among the rest. SEC-8.4B is
 *      what makes it usable here at all: avatar URLs carry a `?v=` cache-buster,
 *      and before that fix the suffix match returned false for every live
 *      avatar - this script would have deleted all of them.
 *
 *   2. No user row exists with that id. An avatar is named `<uuid>.jpg`, so the
 *      owner is readable from the object name. This is the belt to (1)'s
 *      braces: a live user whose avatar_url is momentarily null or mid-write
 *      is protected by the second check even if the first says "unreferenced".
 *
 * A MINIMUM AGE (24h by default) sits on top. An avatar object is written
 * before `profiles.avatar_url` is updated, so an upload in flight is briefly
 * indistinguishable from an orphan. Do not set it to 0 on a live system.
 */

require("dotenv").config();

const db = require("../config/db");
const supabase = require("../config/supabase");
const { isReferenced } = require("../services/creationAssetCleanup");
const { AVATAR_BUCKET } = require("../services/avatarService");

const DEFAULT_MIN_AGE_HOURS = 24;
const DEFAULT_LIMIT = 1000;

function parseArgs(argv) {
  const args = { delete: false, minAgeHours: DEFAULT_MIN_AGE_HOURS, limit: DEFAULT_LIMIT };
  for (const arg of argv) {
    if (arg === "--delete") args.delete = true;
    else if (arg.startsWith("--min-age-hours=")) args.minAgeHours = Number(arg.split("=")[1]);
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.split("=")[1]);
  }
  return args;
}

/** `<uuid>.jpg` -> `<uuid>`, or null for a name that is not an avatar's. */
function ownerIdFromObjectName(name) {
  const match = /^([0-9a-fA-F-]{36})\.jpg$/.exec(name);
  return match ? match[1] : null;
}

async function userExists(userId) {
  const { rows } = await db.query("SELECT 1 FROM public.users WHERE id = $1", [userId]);
  return rows.length > 0;
}

/**
 * Decides one object's fate. Exported so the tests exercise the real predicate
 * rather than a restatement of it.
 *
 * Anything whose name is not `<uuid>.jpg` is KEPT, not deleted: an unexpected
 * name means an assumption has changed, and the safe response to that is to
 * leave it alone and report it.
 */
async function classifyAvatarObject({ name, createdAt, minAgeHours, now = Date.now() }) {
  const ownerId = ownerIdFromObjectName(name);
  if (!ownerId) return { verdict: "keep", reason: "unrecognized_name" };

  const ageHours = (now - new Date(createdAt).getTime()) / 36e5;
  if (!Number.isFinite(ageHours) || ageHours < minAgeHours) {
    return { verdict: "keep", reason: "too_new" };
  }

  if (await isReferenced({ bucket: AVATAR_BUCKET, path: name })) {
    return { verdict: "keep", reason: "referenced" };
  }

  if (await userExists(ownerId)) {
    return { verdict: "keep", reason: "owner_exists" };
  }

  return { verdict: "orphan", reason: "unreferenced_and_no_owner", ownerId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(
    `[reconcile-avatars] bucket=${AVATAR_BUCKET} ${
      args.delete ? "*** DELETING ***" : "DRY RUN (no deletions)"
    } min-age=${args.minAgeHours}h limit=${args.limit}`
  );

  const { data: objects, error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .list("", { limit: args.limit });

  if (error) {
    console.error(`[reconcile-avatars] list failed: ${error.message}`);
    process.exit(1);
  }

  console.log(`[reconcile-avatars] ${objects.length} objects in ${AVATAR_BUCKET}.`);

  const orphans = [];
  const kept = {};

  for (const object of objects) {
    const result = await classifyAvatarObject({
      name: object.name,
      createdAt: object.created_at,
      minAgeHours: args.minAgeHours,
    });

    if (result.verdict === "orphan") {
      orphans.push(object.name);
      console.log(`[reconcile-avatars]   orphan: ${object.name} (owner ${result.ownerId} no longer exists)`);
    } else {
      kept[result.reason] = (kept[result.reason] || 0) + 1;
    }
  }

  for (const [reason, count] of Object.entries(kept)) {
    console.log(`[reconcile-avatars] kept (${reason}): ${count}`);
  }
  console.log(`[reconcile-avatars] orphans: ${orphans.length}`);

  if (orphans.length === 0) {
    console.log("[reconcile-avatars] nothing to do.");
    return;
  }

  if (!args.delete) {
    console.log("[reconcile-avatars] Dry run only. Re-run with --delete to remove the objects listed above.");
    return;
  }

  const { error: removeError } = await supabase.storage.from(AVATAR_BUCKET).remove(orphans);
  if (removeError) {
    console.error(`[reconcile-avatars] delete failed: ${removeError.message}`);
    process.exit(1);
  }

  console.log(`[reconcile-avatars] ==== deleted ${orphans.length} orphaned avatar(s). ====`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[reconcile-avatars] failed:", err.message);
      process.exit(1);
    });
}

module.exports = { classifyAvatarObject, ownerIdFromObjectName };
