# Releases and Rollback

**SEC-21.4.** Companion to `DISASTER_RECOVERY.md`.

> The capability was never missing — Railway and Vercel both retain prior
> deployments with one-click rollback. What was missing is knowing **what the
> last known-good version is** and **whether rolling back also needs a data
> step**. This document exists to remove both questions from an incident.

---

## 1. The problem this solves

At the time of the audit: **zero git tags across all three repositories.** A
rollback decision therefore started with finding a commit hash by inspection —
during an outage, which is the worst possible moment to be reading `git log`.

---

## 2. Versioning

Semver, tagged in each repository independently. They deploy independently, so
they version independently.

| Repo | Deploys to | Tag prefix |
|---|---|---|
| `styliai-backend` | Railway (auto from `main`) | `v` |
| `prompt_app` | Play Store / TestFlight | `v` |
| `admin_dashboard` | Vercel (auto) | `v` |

- **MAJOR** — a breaking API change. Phases 6–9 deliberately shipped none.
- **MINOR** — additive features or a security phase.
- **PATCH** — fixes with no contract change.

## 3. Cutting a release

Tagging is a **human decision** — naming a release asserts what it contains —
so it is not scripted.

```bash
git checkout main && git pull
npm test                       # must be green
npm run verify:restore         # schema matches the repository

git tag -a v1.1.0 -m "Phase 9: disaster recovery and operational resilience

Migrations included since v1.0.0:
  - migration_generation_idempotency.sql   (SEC-3.1)
  - migration_abuse_detection.sql          (SEC-18.1/18.3/18.5)
  - migration_schema_migrations.sql        (SEC-21.1 ledger)
"
git push origin v1.1.0
```

**Always list the migrations in the tag message.** That single habit is what
makes §4's rollback question answerable in seconds instead of by archaeology.
The authoritative record of what a given database actually received is the
`schema_migrations` ledger:

```sql
SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at;
```

---

## 4. Rollback

### Code

Railway → Deployments → the previous deployment → **Redeploy**. Vercel is
equivalent. This is the fast path and is almost always the right first move.

### Does the database need rolling back too?

**Almost never — and that is a property of how migrations are written here, not
luck.** Every migration in this repository is **additive and idempotent**
(`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, guarded `DO $$`
blocks). Older code against a newer schema simply ignores the columns it does
not know about.

| Change in the release | Rollback needs a data step? |
|---|---|
| New table / new nullable column | **No** — older code ignores it |
| New index | **No** |
| New constraint on existing data | **Maybe** — if older code writes rows the constraint rejects |
| Column dropped or renamed | **Yes** — none exist; the project does not do this |
| Data backfill | **Maybe** — depends on whether older code misreads it |

**There are no `DOWN` migrations, deliberately.** A reverse migration is code
that runs exactly once, under maximum pressure, having never been tested. For
an additive schema the safe reverse operation is *nothing*, and the honest
answer to a genuinely irreversible change is a restore (`DISASTER_RECOVERY.md`
§3), not a script nobody has run.

### Rolling back across a migration

1. Roll the code back first, and confirm service is restored.
2. Leave the schema alone unless the table above says otherwise.
3. If it does say otherwise: stop writes, restore, then redeploy.

---

## 5. Pre-release checklist

- [ ] `npm test` green
- [ ] `npm run migrate` clean, **no checksum-drift warning**
- [ ] `npm run verify:restore` exits 0
- [ ] New env vars documented in `SECURITY_OPERATIONS.md` (the config guard enforces this)
- [ ] Migrations for this release listed in the tag message
- [ ] A recent backup exists (`npm run backup:db`, `npm run backup:storage`)

**Store-submission gates** (Sprint 1 / B-1, B-2 — only for a build going to a store)

- [ ] `grep -rn "\[\[PLACEHOLDER" public/legal/` returns **nothing**. The hosted legal documents ship as drafts; publishing one that still names a placeholder is worse than publishing none.
- [ ] Every document in `public/legal/` carries a real **effective date**, not the drafting date.
- [ ] `/legal/privacy-policy.html` and `/legal/account-deletion.html` return 200 from a signed-out browser against the **production** origin.
- [ ] The URLs entered in the Play Console and App Store Connect match those live URLs exactly.
- [ ] Account deletion has been exercised end-to-end against a throwaway account on the build being shipped.

---

## 6. Retention

**Unverified** — worth confirming before relying on it:

- Railway deployment history: retention window **unconfirmed**
- Vercel: keeps prior production deployments; window **unconfirmed**
- Git tags: permanent, which is why they are the durable anchor

If a platform's window turns out to be short, the tag plus a rebuild is the
fallback — which is the reason to tag at all.
