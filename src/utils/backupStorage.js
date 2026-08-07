// dotenv FIRST, before config/supabase.
//
// `config/supabase.js` constructs its client at import time and reads
// SUPABASE_URL from process.env as it does so, so requiring it before the
// environment is loaded throws "supabaseUrl is required" - which is how this
// script failed the first time it was run. CommonJS requires execute in source
// order, so the order of these two lines is load-bearing, not cosmetic.
require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const supabase = require("../config/supabase");
const backupRunModel = require("../models/backupRunModel");

/**
 * SEC-21.3 - an independent copy of the object storage.
 *
 * THIS IS THE IRREPLACEABLE DATA, and that is the whole argument for the
 * finding. The audit puts it plainly: AI-generated images cannot be regenerated
 * identically - the same prompt on the same style produces a different output -
 * so a lost creation is lost permanently, along with the user's entire gallery.
 *
 * A database backup does NOT cover this. They are separate systems, so
 * restoring the database produces rows whose `image_url` / `thumbnail_url`
 * point at objects that no longer exist: a recovery that looks successful and
 * in which every gallery is broken. The two backups are ONE RECOVERY UNIT, and
 * the manifest written here records that pairing explicitly.
 *
 * The realistic loss vector is not hardware - object storage is durable - but
 * accidental or malicious deletion: a buggy admin bulk operation, a mistaken
 * bucket action, or misuse of the service key, which has full read/write over
 * every bucket. With no versioning and no backup, any of those is a one-way
 * door.
 *
 * NEVER DELETES ANYTHING. This script only lists, downloads and hashes. There
 * is no code path here that removes a local or remote object - a backup tool
 * with a delete path is a backup tool that can be turned into the incident.
 */

// The buckets that hold irreplaceable or hard-to-replace data. `creations` and
// `style-images` are the ones that matter most: user galleries and the admin
// catalog art. `avatars` is recoverable in principle (users can re-upload) but
// is cheap to include.
const DEFAULT_BUCKETS = (process.env.BACKUP_BUCKETS || "creations,style-images,avatars")
  .split(",")
  .map((b) => b.trim())
  .filter(Boolean);

const DEFAULT_DIR = process.env.STORAGE_BACKUP_DIR || path.join(process.cwd(), "backups", "storage");

const PAGE_SIZE = 100;

/**
 * Lists every object in a bucket, page by page.
 *
 * Bounded by `maxPages` for the same reason SEC-19.1's storage walk is: an
 * unbounded `while (true)` over a bucket that grows with total platform usage
 * is a job that works in testing and gets slower every day. Hitting the cap is
 * reported as `truncated`, never silently ignored - a partial backup presented
 * as complete is worse than an obvious failure.
 */
async function listBucket(bucket, { maxPages = 500, prefix = "" } = {}) {
  const objects = [];
  let offset = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: PAGE_SIZE, offset });

    if (error) throw new Error(`list ${bucket}: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const obj of data) {
      // Supabase returns pseudo-directories with a null id; recurse into them
      // rather than treating them as files, or nested objects are missed
      // entirely and the backup is quietly incomplete.
      if (obj.id === null) {
        const nested = await listBucket(bucket, {
          maxPages,
          prefix: prefix ? `${prefix}/${obj.name}` : obj.name,
        });
        objects.push(...nested.objects);
        if (nested.truncated) truncated = true;
        continue;
      }
      objects.push({
        path: prefix ? `${prefix}/${obj.name}` : obj.name,
        size: (obj.metadata && obj.metadata.size) || 0,
      });
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (page === maxPages - 1) truncated = true;
  }

  return { objects, truncated };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Downloads every object and records its hash.
 *
 * The hash is what makes this a BACKUP rather than a copy: without it, a
 * truncated download is indistinguishable from a good one until someone tries
 * to open the image, which is to say until the recovery has already failed.
 */
async function backupStorage({
  buckets = DEFAULT_BUCKETS,
  outputDir = DEFAULT_DIR,
  now = new Date(),
  onProgress = () => {},
} = {}) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const root = path.join(outputDir, `styliai-storage-${stamp}`);

  if (fs.existsSync(root)) {
    throw new Error(`Refusing to overwrite an existing storage backup: ${root}`);
  }
  fs.mkdirSync(root, { recursive: true });

  const manifest = {
    kind: "styliai-storage-backup",
    createdAt: new Date(now).toISOString(),
    buckets: {},
    totalObjects: 0,
    totalBytes: 0,
    // The other half of the recovery unit. Restoring a database without the
    // matching object backup produces galleries full of 404s.
    pairWith: "the styliai-db-*.manifest.json taken at the same point in time",
  };

  const failures = [];

  for (const bucket of buckets) {
    const { objects, truncated } = await listBucket(bucket);
    const bucketDir = path.join(root, bucket);
    fs.mkdirSync(bucketDir, { recursive: true });

    const entries = [];
    for (const obj of objects) {
      const { data, error } = await supabase.storage.from(bucket).download(obj.path);
      if (error || !data) {
        // Recorded rather than thrown: one unreadable object must not abandon
        // the other nine thousand. The manifest carries the failure so the
        // backup is honestly described as incomplete.
        failures.push({ bucket, path: obj.path, error: error ? error.message : "no data" });
        continue;
      }

      const buffer = Buffer.from(await data.arrayBuffer());
      const dest = path.join(bucketDir, obj.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);

      entries.push({ path: obj.path, bytes: buffer.length, sha256: sha256(buffer) });
      manifest.totalObjects += 1;
      manifest.totalBytes += buffer.length;
      onProgress({ bucket, path: obj.path, done: manifest.totalObjects });
    }

    manifest.buckets[bucket] = { objectCount: entries.length, truncated, objects: entries };
  }

  if (failures.length) manifest.failures = failures;
  manifest.complete = failures.length === 0 &&
    Object.values(manifest.buckets).every((b) => !b.truncated);

  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  // System Health module (SEC-21.1/21.3): status reflects manifest.complete,
  // not just "did the script finish" - an incomplete backup (truncated
  // listing, unreadable objects) must not read as a success on the dashboard.
  // Never allowed to turn a written manifest into a reported failure.
  try {
    await backupRunModel.record({
      kind: "storage",
      status: manifest.complete ? "success" : "failed",
      bytes: manifest.totalBytes,
      objectCount: manifest.totalObjects,
      detail: {
        buckets: Object.keys(manifest.buckets),
        failureCount: manifest.failures ? manifest.failures.length : 0,
      },
    });
  } catch (err) {
    console.error(`[backupStorage] failed to record backup run: ${err.message}`);
  }

  return { root, manifest };
}

/**
 * Re-hashes a local storage backup against its manifest.
 *
 * This is the SEC-21.2 discipline applied to objects: an unverified backup is a
 * hypothesis. Running it costs one pass over local files and converts "we have
 * a backup" into "we have a backup that is intact".
 */
async function verifyStorageBackup(root) {
  const manifestPath = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: "manifest_missing" };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const problems = [];
  let checked = 0;

  for (const [bucket, info] of Object.entries(manifest.buckets || {})) {
    for (const entry of info.objects || []) {
      const file = path.join(root, bucket, entry.path);
      if (!fs.existsSync(file)) {
        problems.push({ bucket, path: entry.path, reason: "missing" });
        continue;
      }
      const buffer = fs.readFileSync(file);
      if (buffer.length !== entry.bytes) {
        problems.push({ bucket, path: entry.path, reason: "size_mismatch" });
        continue;
      }
      if (sha256(buffer) !== entry.sha256) {
        problems.push({ bucket, path: entry.path, reason: "checksum_mismatch" });
        continue;
      }
      checked += 1;
    }
  }

  return {
    ok: problems.length === 0,
    checked,
    problems,
    // A backup that was incomplete when taken cannot become complete by
    // verifying it. Surfaced separately from integrity so the two are not
    // confused: intact-but-partial and corrupt are different problems.
    completeWhenTaken: manifest.complete !== false,
  };
}

if (require.main === module) {
  const arg = process.argv[2];
  const run = arg
    ? verifyStorageBackup(arg).then((r) => {
        if (r.ok) {
          console.log(`✅ Storage backup intact — ${r.checked} objects verified.`);
          if (!r.completeWhenTaken) {
            console.warn("⚠️  ...but it was INCOMPLETE when taken (see manifest.failures / truncated).");
            process.exitCode = 1;
          }
        } else {
          console.error(`❌ Storage backup INVALID — ${r.problems.length} problem(s):`);
          r.problems.slice(0, 10).forEach((p) => console.error(`   ${p.reason}: ${p.bucket}/${p.path}`));
          process.exitCode = 1;
        }
      })
    : backupStorage({
        onProgress: ({ done }) => {
          if (done % 25 === 0) process.stdout.write(`   ...${done} objects\n`);
        },
      }).then(({ root, manifest }) => {
        console.log(`✅ Storage backup written — ${root}`);
        console.log(`   ${manifest.totalObjects} objects · ${(manifest.totalBytes / 1024 / 1024).toFixed(2)} MB`);
        if (!manifest.complete) {
          console.warn(`   ⚠️  INCOMPLETE — see manifest.failures / truncated flags.`);
          process.exitCode = 1;
        }
        console.log(`   Verify with: node src/utils/backupStorage.js "${root}"`);
        console.log(`   ⚠️  Pair this with a database backup from the same moment.`);
      });

  run.catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  backupStorage,
  verifyStorageBackup,
  listBucket,
  sha256,
  DEFAULT_BUCKETS,
  DEFAULT_DIR,
};
