# StyliAI — Backend API

Express API for **StyliAI** (npm package name `backend`), an AI photo-styling product. This service owns authentication, the style catalog, AI generation orchestration, the credit ledger, and all user-content storage.

It is the **only trusted validator** in the system. The mobile client and the admin dashboard are both treated as compromised: every authorization, credit and content decision is made here.

---

## Architecture summary

Three independent repositories, each with its own git history — there is no monorepo tooling and no shared package workspace:

| Repo | Stack | Role |
|---|---|---|
| `backend/` | Node.js · Express 5 · PostgreSQL | This service |
| `prompt_app/` | Flutter | Mobile client |
| `admin_dashboard/` | React 18 · TypeScript · Vite | Internal admin console |

**Runtime shape**

```
Flutter app ─┐
             ├─→ Express (Railway, behind 2 proxy hops) ─→ PostgreSQL (Supabase, direct pg pool)
Dashboard  ──┘                    │
                                  ├─→ Supabase Storage (service-role key)
                                  └─→ AI providers: Gemini · fal · Stability
```

Two details that surprise people and are load-bearing:

- **The database is reached over a raw `pg` pool, not the Supabase client.** Supabase RLS is *not* bypassed by this — the Flutter app also talks to PostgREST directly for `profiles`, so RLS is a real boundary. It was audited under SEC-10.1 and confirmed enabled on all 17 public tables.
- **`app.set('trust proxy', 2)`** is a verified hop count, not a guess. Railway puts the app behind a public edge *and* an internal load balancer. `1` and CIDR-based lists both resolved to the edge's IP; `true` is unsafe with IP-keyed rate limiting. The reasoning is documented at length in `src/app.js`.

Full data model, request flows and API inventory: **[`../SYSTEM_ARCHITECTURE.md`](../SYSTEM_ARCHITECTURE.md)** (note its §10 inventory delta and superseded §12).

---

## Requirements

| | |
|---|---|
| **Node.js** | 20+ recommended; developed and tested on 24.x. There is no `engines` field — the runtime is not currently pinned. |
| **PostgreSQL** | Supabase-hosted. A connection string is required; the schema is not created automatically (see [Database migrations](#database-migrations)). |
| **Supabase project** | Storage buckets `creations`, `avatars` (both **private**) and `style-images` (public catalog). |
| **Native build tools** | `sharp` and `bcrypt` ship prebuilt binaries; a compiler toolchain is only needed if a prebuild is unavailable for your platform. |

---

## Installation

```bash
cd backend
npm install
cp .env.example .env   # if present; otherwise create .env — see below
```

`.env` is **git-ignored and must stay that way**. A test asserts that no `.env` file is ever tracked.

---

## Environment variables

**The complete reference is [`SECURITY_OPERATIONS.md` §2](SECURITY_OPERATIONS.md#2-environment-variable-reference)** — required vs optional, purpose, development value and production requirement for every variable. It is deliberately not duplicated here, and **no real values appear in any document**.

Minimum to boot locally: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `ADMIN_JWT_SECRET`, `BACKEND_URL`.

Two boot-time behaviours worth knowing:

- **`ADMIN_JWT_SECRET` is validated at startup.** In production the process **refuses to boot** if it is absent, shorter than the minimum, or a known placeholder. Outside production it warns.
- **A test enforces documentation parity** — every `process.env.X` the code reads must appear in `SECURITY_OPERATIONS.md`, or `configHardening.test.js` fails.

---

## Database migrations

Migrations are plain `.sql` files in the repository root (**32 of them**). There is no migration framework, no ledger table, and no down-migrations.

```bash
npm run migrate
```

`runMigration.js` holds an explicit, **dependency-ordered** schedule: 30 files to apply and 2 marked superseded with the reason. Before connecting to anything it diffs that schedule against the directory and **exits 1** if they disagree — an unlisted file, a scheduled file that is missing, a duplicate, or a file in both lists. Adding a migration without scheduling it is therefore a hard failure, not a silent omission.

> ### ⚠ Do not sort the schedule alphabetically
>
> The order in `MIGRATIONS` is the order these migrations were written and applied, and it encodes real dependencies. Alphabetically, `migration_admin_audit_log.sql` sorts **29 places before** `migration_wallet_ledger.sql`, so its `ALTER TABLE wallet_transactions ADD COLUMN admin_id` would run long before that table exists; `migration_auto_tags.sql` likewise sorts before `migration_catalog.sql`, which creates the `styles` table it reads. A glob-and-sort runner fails on a fresh database. **Append new migrations at the end; never reorder existing entries.**

Three things the runner deliberately does not do:

- **It is not transactional across files.** A mid-run failure leaves the database partially migrated; the error message says so, names the file, and reports how many applied. Every migration is guarded (`IF NOT EXISTS`, `DO $$` blocks), so re-running after a fix is a no-op for everything that already succeeded.
- **It does not track what has run.** There is no ledger table — idempotency comes from the guards, not from bookkeeping.
- **It does not provision Supabase Storage.** No migration creates the `creations`, `avatars` or `style-images` buckets. **A rebuilt database is not by itself a rebuilt system** — this remains part of **SEC-21.1**.

> **History:** until 2026-08-04 the runner applied a hand-maintained list of **18 of the 32** files, and nothing failed when the other 14 were added without being listed. A fresh database was missing the columns `POST /api/auth/register` inserts into (`verification_token_hash`, `country_code`, `country_name`), the entire admin security layer (roles, MFA, audit log, lockout), and every `ENABLE ROW LEVEL SECURITY` statement in the repository. The runner also swallowed errors — it logged a failure and exited **0**. Both are fixed; the completeness check is what prevents a recurrence.

**Convention used throughout this project:** a migration is written *and immediately applied* to the live database in the same change. There is no "pending migrations" state.

---

## Running locally

```bash
npm start          # if a start script is added; otherwise:
node server.js
```

Then:

```bash
curl localhost:3000/healthz   # {"status":"ok","uptimeSeconds":…}
curl localhost:3000/readyz    # {"status":"ready","checks":{"database":true,"storage":true}}
```

`/readyz` returns **503** when the database or storage is unreachable. `/healthz` deliberately checks nothing — liveness must not depend on a dependency, or a database blip becomes a restart loop.

### Operational scripts

All are safe by default; the destructive ones are dry-run unless told otherwise.

| Command | What it does |
|---|---|
| `npm run migrate` | Apply the migration schedule — fails fast if it has drifted from the directory |
| `npm run create-admin` | Provision an admin account |
| `npm run reconcile-creations` | Find (and with `--delete`, remove) orphaned creation objects — **dry-run by default** |
| `npm run reconcile-avatars` | Same, for avatars — **dry-run by default** |
| `npm run backfill-thumbnails` | Generate missing thumbnails for existing creations |
| `npm run strip-avatar-metadata` | One-time EXIF sweep of stored avatars — requires `--apply` |

---

## Railway deployment

Deployment is push-to-deploy from `main`. There is **no staging environment**.

1. Set every **Required** variable from `SECURITY_OPERATIONS.md` §2 in the Railway service.
2. Push to `main`.
3. Verify with the checklist in **[`SECURITY_OPERATIONS.md` §1](SECURITY_OPERATIONS.md#1-production-deployment-checklist)**.

Post-deploy smoke test:

```bash
curl -s https://<host>/healthz            # 200
curl -s https://<host>/readyz             # 200 + both checks true
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/api/creations   # 401
```

`/healthz` is also the **deploy marker** — before it existed there was no external way to tell which build was live.

---

## Testing

```bash
npm test                       # full suite
npx jest src/__tests__         # unit + integration against the real app
npx jest test/critical         # release-blocker tier
npx jest -t "avatar"           # by name
```

**103 suites · 1,718 tests**, all passing (re-run 2026-08-04). Across all three repositories the project totals **153 suites · 2,178 tests**. Structure and rationale: **[`docs/qa/QA_TEST_PLAN.md`](docs/qa/QA_TEST_PLAN.md)**; latest run: **[`docs/qa/QA_EXECUTION_REPORT.md`](docs/qa/QA_EXECUTION_REPORT.md)**.

Two conventions worth adopting before adding tests:

- **Vacuity probes.** After writing a test, break the control it covers and confirm the test fails. Several tests in this repo were found to pass with their control removed; each is now documented at the assertion.
- **Test against the real app.** Security tests use `supertest` against `src/app.js` rather than calling handlers directly, because most of what they assert lives in middleware ordering.

---

## Project structure

```
backend/
├── src/
│   ├── app.js              Express wiring: trust proxy, helmet, CORS, logging, routes, error handler
│   ├── config/     (8)     db, supabase, secret validation, admin route policy, integrity policy
│   ├── routes/     (15)    Route definitions; middleware ORDER here is security-relevant
│   ├── controllers/(19)    HTTP layer
│   ├── services/   (10)    Business logic: generation, wallet, avatars, asset cleanup
│   ├── models/     (13)    SQL, parameterized throughout
│   ├── middleware/ (13)    auth, admin auth + RBAC, rate limiters, upload, integrity, audit, logging
│   ├── utils/      (28)    logger, metrics, security events, sanitizers, operational scripts
│   └── __tests__/          Unit + integration suites
├── test/
│   ├── critical/           Release blockers
│   ├── high/ medium/ feature/
│   ├── manual/             Non-automated scripts
│   └── mocks/
├── docs/qa/                Test plan + execution report
├── docs/security/          Historical audit snapshot
├── migration*.sql   (32)   Schema, applied manually
├── SECURITY_OPERATIONS.md  Env reference, logging, rate limits, incident response
└── jest.config.js
```

---

## Security notes

This service has been through a full security audit (94 findings) and an extended remediation programme. **Do not treat the following as incidental** — each is a control that looks removable and is not:

- **Middleware order is a security property.** Identity-keyed rate limiters must run *after* authentication, or `req.user` does not exist at key time and the limiter silently falls back to IP — putting every user behind one NAT into a shared budget. Auth must run *before* multer, so unauthenticated requests are refused before a body is buffered.
- **Stored image URLs keep the literal `/storage/v1/object/public/` marker even though both buckets are private.** Three subsystems parse it: signed-URL delivery, erasure, and the orphan reconciler. Removing it because it "looks wrong" breaks all three at once — erasure silently stops deleting *and* the reconciler starts deleting live objects.
- **`avatars` is deliberately excluded from `DELETABLE_BUCKETS`.** Avatar object names are user UUIDs, so including it would let a crafted row plus a delete become a targeted erasure of someone else's photo. Cleanup runs from an operator shell instead.
- **Logging never receives an object.** Helpers take metadata only; there is deliberately no "log this error/body/headers" helper, because a provider SDK's error can carry the request that produced it.
- **Uploads are validated by decoding, not by labels.** The bucket's MIME allow-list checks a client-supplied header; magic bytes plus a real `sharp` decode are the actual gate.

**Read before changing anything security-adjacent:**

- **[`../SECURITY_REPORT.md`](../SECURITY_REPORT.md)** — the audit: findings, evidence, severities. Sections 0–15 are a **frozen baseline**: findings are never renumbered, rescored or rewritten; new discoveries get new IDs.
- **[`../SECURITY_FIXES.md`](../SECURITY_FIXES.md)** — current per-finding status with commits (the authoritative tally).
- **[`../REMEDIATION_ROADMAP_V2.md`](../REMEDIATION_ROADMAP_V2.md)** — what remains, in order.
- **[`SECURITY_OPERATIONS.md`](SECURITY_OPERATIONS.md)** — operating the shipped controls.

### Known gaps (not defects — tracked and open)

| Gap | Tracked as |
|---|---|
| No backups; storage holds the only copy of user content | SEC-21.1 / 21.2 / 21.3 |
| Logs are emitted structurally but never shipped, retained or alerted on | SEC-16.5 |
| No crash reporting; no AI-provider error rate | SEC-20.1 / 20.2 |
| No account-deletion path — a Google Play submission requirement | `../LEGAL_REQUIREMENTS.md` |
| Purchases/IAP unimplemented; must ship with server-side verification | SEC-6.1 |
