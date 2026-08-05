# Disaster Recovery Runbook

**SEC-21.5.** Lives in the repository so it versions with the system it describes.

> **Read this first, once, while nothing is on fire.** Under pressure the missing
> knowledge is never how Postgres works — it is which migrations the runner
> applies, whether PITR is on this plan, and where each secret is set.

---

## 0. What is honestly true right now

This section is deliberately first, because a runbook that overstates its own
guarantees is worse than none. **Bold = not yet verified by anyone.**

| Thing | State | Evidence |
|---|---|---|
| Schema is rebuildable from the repo | ✅ Yes | `npm run migrate` applies 34 migrations + ledger; `assertScheduleIsComplete()` fails on drift |
| Schema completeness is checkable | ✅ Yes | `npm run verify:restore` — read-only, exit 0/1 |
| Independent DB backup exists | ⚠️ Tooling yes, **runnable now, still not scheduled** | `npm run backup:db`. Sprint 3 added `.github/workflows/backup-verify.yml`, whose runner *does* have `pg_dump` — so the "cannot run it anywhere" problem is solved. The dump job is **manual-only on purpose**: uploading it as a build artifact puts every user's email, password hash and credit history into GitHub's storage, and that is an operator decision, not a default. |
| Schema drift is detected automatically | ✅ Yes (Sprint 3) | `backup-verify.yml` runs `verify:restore` against production **nightly**, read-only. On a project that applies migrations by hand, this is the most likely way `main` and production quietly diverge. |
| A deploy can outrun its schema | ✅ Detected (Sprint 3) | `/readyz` reports `migrations: false` and returns 503 when the ledger is missing a scheduled migration; boot raises a CRITICAL alert. |
| Independent storage backup exists | ✅ Tooling proven | `npm run backup:storage` — exercised against production: 91 objects / 82.64 MB, integrity verified, single-byte corruption detected |
| Supabase automated DB backups | **UNKNOWN** | Owner must confirm in the dashboard |
| Supabase backup retention window | **UNKNOWN** | Owner must confirm |
| Point-in-time recovery (PITR) | **UNKNOWN** | Paid-tier feature; owner must confirm |
| Object versioning on buckets | ❌ Not enabled | No versioning configuration exists |
| A restore has ever been performed | ❌ **Never** | This is SEC-21.2's core finding and it is still open |

**An untested backup is a hypothesis, not a control.** Until the drill in §5 has
been run once, every RTO number below is an estimate.

---

## 1. Recovery objectives (RPO / RTO)

The roadmap does not define these; they are proposed here and become real once
§5 is executed.

| | Target | Basis |
|---|---|---|
| **RPO** (acceptable data loss) | **24 hours** | Matches a daily backup cadence. If Supabase PITR turns out to be available, this drops to minutes and should be revised down. |
| **RTO** (time to service restored) | **4 hours** | Estimate, **not measured.** Composed of the parts below. |

**Measured components** (real numbers, from this repository):

| Step | Time | How known |
|---|---|---|
| Rebuild schema from migrations | **3.3 s** | Recorded in `schema_migrations.duration_ms`, summed |
| Verify restored schema | **~2 s** | `npm run verify:restore` against production |
| Restore storage (current volume) | ~minutes | 91 objects / 82.64 MB measured; scales with volume |
| Restore database from dump | **unmeasured** | Needs `pg_dump` installed and one real drill |
| Provision a new Supabase project | **unmeasured** | Owner-side; dominates the RTO |

The schema rebuild — historically the scariest step, and the one SEC-21.1 was
about — is now **3.3 seconds and one command**. The unmeasured steps are the
ones that will actually determine the RTO.

---

## 2. Recovery order (dependencies matter)

Restoring out of order produces a system that looks up and is wrong.

```
1. Provision Postgres (Supabase project, or restore the platform backup)
2. Rebuild schema        -> npm run migrate
3. Verify schema         -> npm run verify:restore     [STOP if it fails]
4. Restore data          -> pg_restore, or platform backup/PITR
5. Restore storage       -> §4    [SAME point in time as step 4]
6. Re-provision secrets  -> §6
7. Deploy code           -> RELEASE.md
8. Post-restore checks   -> §7
```

**Steps 4 and 5 are one unit.** A database restore does *not* restore Supabase
Storage — they are separate systems. Restoring the database alone gives you
`creations` rows whose `image_url` points at objects that no longer exist:
every user's gallery 404s, and nothing errors. `verify:restore` prints an
explicit warning about this for exactly that reason.

---

## 3. Restore the database

### Prerequisites

- `pg_dump` / `pg_restore` on PATH (**currently missing** — `winget install PostgreSQL.PostgreSQL`)
- The target connection string
- A backup: either `backups/styliai-db-*.dump` or a Supabase platform backup

### Validate the backup *before* restoring

```bash
node src/utils/backupDatabase.js backups/styliai-db-<stamp>.manifest.json
```

Re-hashes the dump against its manifest. A truncated or corrupted dump is
otherwise indistinguishable from a good one until the restore fails halfway.

### Restore

```bash
# NEVER against production. Point at the scratch/replacement target explicitly.
pg_restore --no-owner --no-privileges --dbname "$TARGET_URL" backups/styliai-db-<stamp>.dump
```

> **Restore is deliberately NOT automated in this repository.** A script that can
> overwrite a database is a script that will eventually overwrite the wrong one.
> The destructive step requires a human to type the target.

### Verify

```bash
npm run verify:restore "$TARGET_URL"
```

Checks tables, the migration ledger, migration checksums, the constraints whose
absence is *silent*, and the indexes that bound cost. **Exit 1 means do not
point the application at this database.**

The constraint check is the one that earns its place: a restore that loses a
table announces itself on the first request; a restore that loses
`daily_rewards`' UNIQUE constraint produces a system that runs perfectly and
hands out unlimited daily credits.

---

## 4. Restore storage

```bash
node src/utils/backupStorage.js "backups/storage/styliai-storage-<stamp>"   # verify first
```

Re-hashes every object against the manifest. Then re-upload with the service
key, into buckets that must exist first (`creations`, `style-images`,
`avatars`) — **the migration runner does not create buckets**, and says so.

Bucket privacy must be restored too, or a "successful" recovery silently
un-does R-2 and SEC-8.1B-2: `creations` and `avatars` are **private**,
`style-images` is public.

---

## 5. The drill (SEC-21.2 — never yet performed)

Run once, then quarterly. This is what converts every estimate above into a fact.

1. Confirm in the Supabase dashboard: **are daily backups on? what is the
   retention? is PITR available on this plan?** Write the answers into §0.
2. Provision a scratch project.
3. Restore the most recent backup into it. **Time it.**
4. `npm run verify:restore "$SCRATCH_URL"` — must exit 0.
5. Restore a storage sample; confirm images load.
6. Point a local app at the scratch target; log in; open a gallery.
7. Record the real RTO in §1. Destroy the scratch project.

**Nothing in step 1 can be answered from this repository.** It is 15 minutes of
dashboard reading with a large downside if the answer is unexpected.

---

## 6. Secrets and configuration

The full inventory is `SECURITY_OPERATIONS.md` §2 — that table is the recovery
list. Production configuration exists as Railway variables plus one plaintext
`.env` on a workstation (SEC-17.5), so **losing that workstation loses nothing
that Railway also holds, but there is no third copy.**

Values that cannot be regenerated without consequence:

| Secret | If lost |
|---|---|
| `MFA_ENCRYPTION_KEY` | Every enrolled admin is locked out permanently — stored TOTP secrets become undecryptable |
| `IP_HASH_SALT` | SEC-18.3 correlation history is void (by design — rotation *is* the retention control) |
| `ADMIN_JWT_SECRET` | All admin sessions end; regenerate freely |
| `SUPABASE_SERVICE_KEY` | Re-issue from the dashboard; highest-value secret in the system |

---

## 7. Post-restore checklist

- [ ] `npm run verify:restore` exits 0
- [ ] `/healthz` 200, `/readyz` reports `database: true`, `storage: true`
- [ ] Log in as a real user; gallery images load (proves the DB/storage pairing)
- [ ] Admin login works, including MFA (proves `MFA_ENCRYPTION_KEY` survived)
- [ ] A generation completes end to end (proves provider keys + storage writes)
- [ ] Wallet balance for a known user matches expectation
- [ ] Bucket privacy: `creations` and `avatars` private, `style-images` public
- [ ] Record actual RPO/RTO achieved in §1
- [ ] `/legal/privacy-policy.html` returns 200 (Sprint 1 / B-2 — the store-facing URLs are served by this app, so a restored backend that 404s them is a compliance outage, not just a cosmetic one)

> **A restore can resurrect a deleted account, and that is a compliance problem,
> not just a data problem.** Restoring a backup taken before a user exercised
> account deletion reinstates their personal data. `account_deletions` is the
> control: it is the one record that survives the erasure, so after any restore,
> re-apply every deletion recorded at or after the backup's timestamp.
>
> ```sql
> SELECT user_id, deleted_at FROM account_deletions
> WHERE deleted_at >= '<backup taken at>' ORDER BY deleted_at;
> ```
>
> If `account_deletions` itself was restored from the same backup it will not
> list deletions made after that point — export it from the live database
> *before* overwriting, whenever the live database is still readable.

---

## 8. Emergency response

| Situation | First action |
|---|---|
| Bad deploy | Roll back in Railway (`RELEASE.md` §4). Additive migrations need no revert. |
| Data corruption / bad migration | **Stop writes first.** Then restore per §3 — do not fix forward under pressure. |
| Suspected key compromise | Rotate `SUPABASE_SERVICE_KEY` and `ADMIN_JWT_SECRET`; bump `token_version` (Phase 6) to end every session. |
| Abusive account | `POST /api/admin/users/:id/suspend` — mid-session, reversible via `/reinstate`. |
| Storage deleted | Restore per §4. **There is no versioning**, so the backup is the only copy. |

**Escalation:** single-operator project. There is no second person, which is
itself the largest operational risk here and the reason this document exists.

---

## 9. What this repository cannot do

Stated explicitly so nobody assumes coverage that is absent:

- **Cannot enable** Supabase automated backups, retention, or PITR — dashboard only.
- **Cannot enable** bucket versioning — dashboard/API, plan-dependent.
- ~~**Cannot schedule** anything.~~ **Partly resolved (Sprint 3).** GitHub
  Actions `schedule:` is a scheduler, and its runner has `pg_dump`.
  `backup-verify.yml` now runs `verify:restore` nightly against production.
  What is still *not* scheduled is the dump itself — deliberately, because the
  only destination a workflow can reach without further setup is GitHub's
  artifact storage, and a nightly copy of every user's personal data into a
  third party is a decision the owner has to make rather than inherit. The
  right destination is object storage the owner controls; until that exists,
  the dump job is manual.
- **Still no in-process scheduler.** The abuse sweep and ledger eviction remain
  traffic-driven (SEC-20.x), so they stop when traffic does.
- **Cannot perform** the restore drill. §5 is a human procedure.
- **Does not automate restore.** Deliberate — see §3.
