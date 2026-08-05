# StyliAI — Security & Operations

Operational reference for running the backend in production. Companion to
`prompt_app/RELEASE.md`, which covers the mobile release build.

---

## 1. Production deployment checklist

Run through this before promoting a build.

**Configuration**
- [ ] Every **Required** variable in §2 is set in Railway.
- [ ] `NODE_ENV=production` — several controls are production-strict (see §2 notes).
- [ ] `ADMIN_JWT_SECRET` ≥ 32 bytes and not a placeholder — the app refuses to boot otherwise.
- [ ] `MFA_ENCRYPTION_KEY` set **before** any admin enrols. Losing it locks out every enrolled admin; rotating it requires decrypt-and-re-encrypt of every stored `mfa_secret`.
- [ ] `BACKEND_URL` matches the public origin — delivery URLs and the CORS allow-list are built from it.

**Verification after deploy**
- [ ] `GET /healthz` → `200 {"status":"ok"}`
- [ ] `GET /readyz` → `200 {"status":"ready","checks":{"database":true,"storage":true}}`
- [ ] `GET /api/creations` → `401` (auth wired)
- [ ] Any 4xx response carries an `X-Request-Id` header.
- [ ] `GET /legal/privacy-policy.html` → `200` **from a signed-out browser** (Sprint 1 / B-2). This is the URL submitted to both stores; a 404 here is a rejected submission, and it is not exercised by any user-facing flow, so nothing else will notice it broke.
- [ ] `GET /legal/account-deletion.html` → `200` (Google Play requires this as a public URL).
- [ ] `POST /api/auth/delete-account` with no `Authorization` header → `401`.

**Storage posture** (verify, do not assume)
- [ ] `creations` — private
- [ ] `avatars` — private
- [ ] `style-images` — public (admin catalog; intentional)
- [ ] `storage.objects` has **zero** RLS policies — service-role-only access.

---

## 2. Environment variable reference

Values are **never** recorded here. Development values are what a local
`.env` needs to boot, not real credentials.

### Required in production

| Variable | Purpose | Dev value | Production requirement |
|---|---|---|---|
| `DATABASE_URL` | Postgres connection (Supabase pooler) | local/pooler URL | Real connection string; TLS on |
| `SUPABASE_URL` | Supabase project origin | project URL | Real project URL |
| `SUPABASE_SERVICE_KEY` | Service role — bypasses RLS and bucket privacy | project service key | **Highest-value secret in the system.** Server-only; never in a client build |
| `SUPABASE_JWT_SECRET` | Verifies user access tokens | project JWT secret | Must match the Supabase project |
| `ADMIN_JWT_SECRET` | Signs/verifies admin tokens | any ≥32-byte string | ≥32 bytes, high entropy. Boot fails if absent, short, or a placeholder |
| `BACKEND_URL` | Public origin; builds delivery URLs and CORS | `http://localhost:3000` | Exact public HTTPS origin |
| `NODE_ENV` | Enables production-strict checks | `development` | `production` |

### Required for features in use

| Variable | Purpose | Required? | Production requirement |
|---|---|---|---|
| `IMAGE_PROVIDER` | `gemini` \| `fal` \| stability path | Optional (default `gemini`) | Set explicitly |
| `GEMINI_API_KEY` | Gemini generation | If provider is gemini | Real key |
| `FAL_API_KEY` | fal generation | If provider is fal | Real key |
| `STABILITY_API_KEY` | Stability text-to-image | If `/api/ai/generate` used | Real key |
| `RESEND_API_KEY` | Transactional email | Yes for verification/reset | Real key. **Absent ⇒ emails are logged, not sent** |
| `EMAIL_FROM` | Sender identity | With Resend | Verified sender |
| `GOOGLE_WEB_CLIENT_ID` | Verifies Google sign-in tokens | For Google sign-in | Real client id |
| `MFA_ENCRYPTION_KEY` | AES-256-GCM for admin TOTP secrets | Before any enrolment | `openssl rand -base64 32`; distinct from `ADMIN_JWT_SECRET` |

### In-app purchases (Sprint 2 / B-3)

Credits are granted **only** after the platform's own API confirms a purchase.
With these unset the verifier reports `not_configured` and every redemption
answers **503 retryable** — the buyer keeps their purchase and nothing is
credited. That is the intended failure mode; it is never "assume valid".

| Variable | Purpose | Required? | Production requirement |
|---|---|---|---|
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Service-account JSON, **whole**, for the Android Publisher API. Railway has no file mounts, so it is passed as a variable. | For Android purchases | A service account granted "View financial data" **and** "Manage orders and subscriptions" in Play Console, linked to the app. Contains a private key — treat as a top-tier secret. |
| `ANDROID_PACKAGE_NAME` | The package the purchase belongs to | For Android purchases | Must equal `applicationId` in `android/app/build.gradle.kts` |
| `PLAY_VERIFY_TIMEOUT_MS` | Outbound timeout for verify/acknowledge | Optional | Default `10000`. A buyer is watching a spinner; the DB statement timeout does not cover outbound HTTP. |
| `APPLE_IAP_KEY_ID` | App Store Connect API key id | For iOS purchases | **Apple verification is prepared, not active** — see `src/services/purchases/appleVerifier.js` |
| `APPLE_IAP_ISSUER_ID` | App Store Connect issuer id | For iOS purchases | as above |
| `APPLE_IAP_PRIVATE_KEY` | The `.p8` contents | For iOS purchases | as above |
| `APPLE_BUNDLE_ID` | Bundle id as Apple records it | For iOS purchases | as above |

**Setting the four Apple variables is not sufficient** to enable iOS purchases.
The JWS signature-chain verification is deliberately unimplemented, and the
verifier logs `apple_verify_not_implemented` and refuses rather than granting.
That refusal is the point: a half-finished verifier that decodes a payload
without checking its signature accepts anything an attacker types.

**SKU mapping.** `credit_packs.product_id` is `NULL` for every seeded pack and
must be set to the real store SKUs before any purchase can be credited — an
unmatched product id is refused (`unknown_product`, HTTP 422) rather than
defaulted to a guess. `GET /api/purchases/config` reports which platforms are
live; the app uses it to hide the purchase UI rather than take money it cannot
credit.

### Optional / tuning

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Listen port | `3000` |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error` | `info` (`error` under test) |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allow-list | Built-in dashboard + `BACKEND_URL` |
| `DATABASE_CA_CERT` | Pins the Postgres TLS chain | Unset ⇒ cert **not** verified (warns) |
| `GENERATION_TIMEOUT_MS` / `GENERATION_DOWNLOAD_TIMEOUT_MS` | Provider budgets (SEC-7.2) | 60s / 20s |
| `MAX_CONCURRENT_GENERATIONS` | Per-user in-flight cap | see config |
| `STABILITY_GENERATION_COST` | Credit cost | see config |
| `ENABLE_CLIENT_AD_REWARD` | Client-side ad reward path | off |
| `ADMIN_JWT_EXPIRES_IN` | Admin token lifetime | see config |
| `REFRESH_TOKEN_TTL_DAYS` | Refresh-token lifetime, Phase 6 (SEC-1.4). Sets both the JWT `exp` and the `refresh_tokens.expires_at` row | **14** (was 30 pre-Phase-6) |
| `GEMINI_MODEL` | Generation model id | see config |
| `RATE_LIMIT_<LIMITER>_LIMIT` / `_WINDOW_MS` | Per-limiter override (§6) | Built-in defaults |

### Request limits, pool bounds and idempotency (Phase 7)

Every value below is a **bound**, not a feature switch. Each defaults to a safe
value, and an unparseable or non-positive override is **ignored with a warning**
rather than applied — a typo must not produce a pool of 0 connections or a 0 ms
statement timeout. Same convention as the rate-limiter overrides above.

| Variable | Purpose | Default |
|---|---|---|
| `JSON_BODY_LIMIT` | Max JSON request body (SEC-9.4). Previously body-parser's implicit default; now stated. Exceeding it ⇒ **413** | `100kb` (identical to the prior implicit value) |
| `DB_POOL_MAX` | Max pooled Postgres connections (SEC-19.3) | `10` (pg's own default, now explicit) |
| `DB_POOL_IDLE_TIMEOUT_MS` | Idle connection reclaim | `30000` |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | Wait for a free connection before failing fast rather than queueing invisibly | `5000` |
| `DB_STATEMENT_TIMEOUT_MS` | **Server-side** ceiling on any single statement (SEC-19.3). Firing ⇒ Postgres `57014` ⇒ **503**, not 500 | `10000` |
| `DB_QUERY_TIMEOUT_MS` | Client-side companion; deliberately longer so the server-side cancel wins | `15000` |
| `DB_ANALYTICS_STATEMENT_TIMEOUT_MS` | Separate, larger budget scoped to admin analytics via `SET LOCAL` — so the wider aggregates do not require raising the global default for every endpoint | `30000` |
| `DB_APPLICATION_NAME` | Shows in `pg_stat_activity` for session attribution | `styliai-backend` |
| `CREATIONS_PAGE_SIZE_DEFAULT` / `CREATIONS_PAGE_SIZE_MAX` | Keyset page size for `GET /api/creations` (SEC-19.2) | `50` / `100` |
| `CATALOG_PAGE_SIZE_MAX` | Server-enforced ceiling on catalog reads (SEC-19.2) | `500` |
| `FAVORITES_PAGE_SIZE_MAX` | Ceiling on `GET /api/favorites` (SEC-19.2) | `1000` |
| `RECOMMENDATION_LIMIT_MAX` | Clamp on `?limit` for `/similar` (SEC-9.3) | `50` |
| `ADMIN_STORAGE_STATS_TTL_MS` | Cache lifetime for the storage figure (SEC-19.1). `asOf` in the response says how stale it is | `3600000` (1h) |
| `ADMIN_STORAGE_STATS_MAX_PAGES` | Hard cap on bucket-listing round-trips per refresh; hitting it sets `truncated: true` | `200` (≈20k objects) |
| `ADMIN_STORAGE_STATS_DEADLINE_MS` | Wall-clock deadline for one refresh | `20000` |
| `IDEMPOTENCY_TTL_HOURS` | How long a generation `Idempotency-Key` is remembered and replayable (SEC-3.1) | `24` |

> **`DB_STATEMENT_TIMEOUT_MS` is the one to think about before changing.** It is
> the control that stops a single pathological query from holding a connection
> until the pool is exhausted and *every* endpoint — including `/healthz` and
> login — starts failing. Raising it widens that window; setting it very low
> will start cancelling legitimate admin aggregates (give those headroom via
> `DB_ANALYTICS_STATEMENT_TIMEOUT_MS` instead).

### Disaster recovery (Phase 9)

Full procedures live in **`DISASTER_RECOVERY.md`** (runbook, RPO/RTO, restore
steps) and **`RELEASE.md`** (versioning, rollback). These are the variables they
use.

| Variable | Purpose | Default |
|---|---|---|
| `BACKUP_DIR` | Where `npm run backup:db` writes dumps and manifests | `./backups` |
| `STORAGE_BACKUP_DIR` | Where `npm run backup:storage` writes objects and its manifest | `./backups/storage` |
| `BACKUP_BUCKETS` | Comma-separated buckets to back up | `creations,style-images,avatars` |

`PGUSER`, `PGPASSWORD`, `PGHOST`, `PGPORT`, `PGDATABASE` and `PGSSLMODE` are
**not configured by you** — `backup:db` derives them from `DATABASE_URL` and
passes them to `pg_dump` in its environment. That indirection is deliberate:
passing a connection string in argv would expose the database password to every
other user on the host via the process list, for the whole duration of the dump.
`PGSSLMODE` defaults to `require` rather than libpq's `prefer`, because `prefer`
silently falls back to an unencrypted connection and a backup is the largest
bulk transfer of user data this system performs.

**Operational notes:**

- **`pg_dump` is a prerequisite and is currently NOT installed** on the operator
  workstation (verified). `npm run backup:db` detects this and says so rather
  than failing cryptically — but it cannot back up without it.
  Install: `winget install PostgreSQL.PostgreSQL` / `apt install postgresql-client`.
- **`npm run verify:restore` is read-only** and safe to point at production; "is
  the live schema complete?" is the same question it answers about a restore.
- **Restore is deliberately not automated.** A script that can overwrite a
  database eventually overwrites the wrong one, so the destructive step requires
  a human to type the target. See `DISASTER_RECOVERY.md` §3.
- **The database and storage backups are ONE recovery unit.** A database restore
  does not restore Supabase Storage; restoring only the database gives you
  creation rows pointing at objects that no longer exist.
- **There is no scheduler** (SEC-20.x). These commands must be driven by an
  external cron, a CI schedule, or a human.

### Abuse detection and signup controls (Phase 8)

> **The two settings that matter most are `IP_HASH_SALT` and `ABUSE_AUTO_SUSPEND`.**
> Everything else is a threshold.

| Variable | Purpose | Default |
|---|---|---|
| `IP_HASH_SALT` | **HMAC key for the SEC-18.3 origin correlation key.** Must be ≥16 chars. **Unset ⇒ correlation is DISABLED** (logged once at boot) and multi-account detection degrades to country granularity — it is never silently faked with a random or constant key, because a per-boot salt would appear to work while grouping nothing, and a constant would make the hash reversible by enumerating the IPv4 space | *unset* — **set this to activate SEC-18.3** |
| `ABUSE_AUTO_SUSPEND` | Arms **automatic** suspension. `false` ⇒ detectors flag and score, humans decide | **`false`** |
| `ABUSE_SWEEP_ENABLED` | Whether the request-triggered sweep runs at all | `true` (`false` under `NODE_ENV=test`) |
| `ABUSE_SWEEP_INTERVAL_MS` | Minimum gap between opportunistic sweeps | `900000` (15 min) |
| `ABUSE_MAX_FINDINGS_PER_SWEEP` | Per-detector row cap, so a sweep can never become SEC-19.1's failure mode | `200` |
| `ABUSE_REG_WINDOW_HOURS` / `ABUSE_REG_PER_ORIGIN` / `ABUSE_REG_PER_ORIGIN_HIGH` | Registration velocity per origin | `1` / `6` / `20` |
| `ABUSE_GEN_WINDOW_HOURS` / `ABUSE_GEN_PER_USER` / `ABUSE_GEN_PER_USER_HIGH` | Generation velocity per user | `1` / `30` / `100` |
| `ABUSE_WALLET_WINDOW_HOURS` / `ABUSE_REWARDS_PER_ORIGIN` / `ABUSE_REWARDS_PER_ORIGIN_HIGH` | Reward-farming accounts sharing one origin | `24` / `10` / `30` |
| `ABUSE_ADMIN_ADJUSTMENTS` | Admin balance-adjustment volume in the window | `25` |
| `ABUSE_SESSION_ORIGINS` / `ABUSE_SESSION_ORIGINS_HIGH` / `ABUSE_SESSION_WINDOW_HOURS` | Concurrent distinct session origins per account (SEC-18.5) | `3` / `6` / `24` |
| `BLOCK_DISPOSABLE_EMAILS` | Reject throwaway email providers at signup | `true` |
| `DISPOSABLE_EMAIL_DOMAINS` | Comma-separated domains appended to the built-in list | *unset* |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret. **Unset ⇒ the CAPTCHA is entirely inert** (same posture as Play Integrity) | *unset* |

**Operational notes that are not obvious from the table:**

- **`IP_HASH_SALT` rotation IS the retention control.** Rotating it invalidates every stored origin hash at once, so correlation ability decays to zero with no data migration and no way to re-derive the old values. Rotate it if you want to forget origins; do not rotate it casually, because in-flight detection loses its join key.
- **Automatic suspension is deliberately off.** Today a firing detector is more likely a false positive than an attack — the audit's own economics analysis (§18 Item 18.2) is that farming is currently self-limiting — and the cost of being wrong is locking a real user out of an account they watched ads to fund. Turn it on **after** watching what the detectors actually flag, and expect to tune thresholds first. Even when armed, only `high`-severity, **user-scoped** findings can act: the origin-scoped detectors (`registration_velocity`, `reward_farming_origin`) can never auto-suspend, because an origin implicates everyone behind a shared NAT.
- **Rollback for any automatic suspension is `POST /api/admin/users/:id/reinstate`** (superadmin, Phase 6). Nothing about automatic enforcement is destructive: no data is deleted, no balance changes, and one existing endpoint fully restores the account.
- **The alert drain is still missing.** Detectors emit structured `abuse_sweep` / `abuse_auto_suspend` events through the Phase 5 logging architecture, but there is nowhere for them to be *routed* until **SEC-16.5** lands. Until then, the review queue (`GET /api/admin/abuse/findings`) is the surface — it is pull, not push.

### Session revocation and account suspension (Phase 6)

**Everything below takes effect on the user's NEXT request**, not at their next login — that is the point of the phase.

| Task | How |
|---|---|
| Suspend an account | `POST /api/admin/users/:id/suspend` (superadmin). Body: `{"status":"suspended"\|"banned","reason":"..."}`. Bumps `token_version`, revokes every refresh family. |
| Reinstate | `POST /api/admin/users/:id/reinstate` (superadmin). Also bumps the epoch, so the user signs in fresh. |
| Force-logout one user | Suspend then reinstate, or `UPDATE public.users SET token_version = token_version + 1 WHERE id = ...`. |
| Revoke an admin's dashboard token | `UPDATE admins SET token_version = token_version + 1 WHERE id = ...`. Takes effect immediately; the admin re-logs in. |
| User self-service | `POST /api/auth/logout-all` — signs the caller out of every device **including the one calling**. |
| Prune dead refresh rows | `sessionService.purgeDeadRefreshTokens()` from an operator shell. Retention only; expired and revoked rows are already refused. |

**Two failure modes worth knowing before an incident:**

- **`authMiddleware` fails CLOSED.** If the session-state read throws, it answers **503**, not 401 and not success. A database outage therefore looks like an outage rather than silently restoring every revoked and suspended session. `/readyz` reports the same condition.
- **`optionalAdminAuth` fails open as *anonymous*, never as admin.** A blip on the `admins` table degrades a dashboard user to the public response on shared catalog reads; it never grants privilege.

**Log lines to alert on** (`event` field): `refresh_token_reuse_detected` — a refresh token was presented twice, meaning two parties held it. This is the strongest available signal of a stolen session and always revokes the family. Also `token_version_mismatch` in volume (a client not handling `SESSION_REVOKED`) and `account_not_active`.

### Auto-tagging (offline catalog tooling)

Used by the tag backfill script, not by the request path. Safe to leave unset
in production unless the script is being run.

| Variable | Purpose |
|---|---|
| `GEMINI_TAGGING_API_KEY` | Key for the tagging model (may differ from generation) |
| `GEMINI_TAGGING_MODEL` | Primary tagging model id |
| `GEMINI_TAGGING_FALLBACK_MODEL` | Model used when the primary is unavailable |
| `AUTOTAG_BACKFILL_CONCURRENCY` | Parallel tagging requests |
| `AUTOTAG_BACKFILL_DELAY_MS` | Delay between batches |

### Play Integrity (inert until all are set)

`PLAY_INTEGRITY_PACKAGE_NAME`, `PLAY_INTEGRITY_CERT_SHA256`,
`PLAY_INTEGRITY_ENFORCEMENT` (`off`\|`log`\|`enforce`),
`PLAY_INTEGRITY_MAX_AGE_MS`, `PLAY_INTEGRITY_DECODE_RATE_LIMIT`,
`PLAY_INTEGRITY_POLICY_OVERRIDES`, `PLAY_INTEGRITY_POLL_ATTEMPTS`,
`PLAY_INTEGRITY_POLL_INTERVAL_MS`, `PLAY_INTEGRITY_SWEEP_INTERVAL_MS`.

Ship at `log` first. `enforce` before a real verdict has ever been observed
will reject legitimate users.

### Secret handling rules

- No secret is committed. No `.env` is tracked in either repo.
- `SUPABASE_ANON_KEY` in the client is **publishable by design** — it is not a secret, and RLS is what protects data behind it.
- `android/app/google-services.json` carries a live Firebase API key. It must stay untracked (SEC-17.3); it is gitignored.
- Rotation: `ADMIN_JWT_SECRET` invalidates all admin sessions. `SUPABASE_SERVICE_KEY` requires a coordinated backend redeploy. `MFA_ENCRYPTION_KEY` is **not** a config change — see §1.

---

## 3. Logging overview

One JSON object per line, from `src/utils/logger.js`. Every line carries
`ts`, `level`, `event`, and — for anything request-scoped — `requestId`.

| Event | Level | Meaning |
|---|---|---|
| `http_request` | info | One per completed request: method, redacted path, status, duration, user/admin id, ip, user agent |
| `auth_failure` | warn | Bad/absent credential, with a fixed `reason` |
| `authz_failure` | warn | Authenticated but not permitted; `required` vs `actual` role |
| `validation_failure` | info | Client-caused 4xx |
| `upload_failure` | warn | Refused or unstorable upload, with `stage` |
| `audit_event` | info | login, logout, registration, email_verification, password_reset, password_change, avatar_upload |
| `unhandled_error` | error | Unexpected exception, truncated stack (server-side only) |
| `health_check_failed` | warn | Dependency probe failed, with the reason |

**Never logged:** passwords, JWTs, refresh tokens, API keys, verification or
reset tokens, image bytes, email addresses in security events.

Two mechanisms enforce that: helpers accept metadata only (no parameter takes
a body, header map or error object), and a key-pattern redactor strips
credential-shaped keys at every depth — matching on key names, never values,
so no crafted value can evade it. URLs pass through `redactUrl` (SEC-16.1),
so `?token=…` becomes `token=[REDACTED]`.

`warn`/`error` go to stderr; everything else to stdout.

**Correlation.** `X-Request-Id` is set on *every* response and echoed in
globally-handled error bodies. A well-formed inbound value is honoured
(8–64 chars of `[A-Za-z0-9_-]`); anything else is replaced.

---

## 4. Observability overview

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness. No dependency checks — a DB blip must not restart the container |
| `GET /readyz` | none | Readiness. Database + storage; `503` when degraded |
| `GET /api/admin/metrics` | admin (viewer) | Request counts, status classes, error rates, latency buckets, event counters |

Health endpoints report **bare booleans**. A failure reason names
infrastructure and goes to the log stream, not to a public response.

**Metrics are per-process and reset on restart** — the payload says so
(`scope: "single_process_since_restart"`). Railway's replica count is unknown,
so these are a single instance's view, not a fleet view. External aggregation
is not yet implemented.

---

## 5. Rate limiting overview

`express-rate-limit` with `standardHeaders: true`, so `RateLimit-*` and
`Retry-After` are returned on a 429. All limiters are declared in
`src/middleware/rateLimiters.js`; `LIMIT_VALUES` is the single source of truth
that tests and this document read from.

| Endpoint | Limiter | Budget |
|---|---|---|
| Login | `loginLimiter` | 10 / 15 min |
| Register | `registerLimiter` | 5 / hour |
| Forgot password | `forgotPasswordLimiter` | per hour |
| Reset password | `resetPasswordLimiter` | per hour |
| Email verification | `emailVerificationLimiter` | per hour |
| Avatar upload | `avatarUploadLimiter` | 10 / 15 min, **per user** |
| Generation | `generationLimiter` | per minute + per-user concurrency cap |
| Admin login | `adminLoginLimiter` | 15 min window |

**Overrides.** `RATE_LIMIT_<LIMITER_NAME>_LIMIT` and `_WINDOW_MS`, upper-snake
from the limiter name (`loginLimiter` → `RATE_LIMIT_LOGIN_LIMITER_LIMIT`).
An unparseable or non-positive value is **ignored and logged**, never clamped
and never fatal — a typo must not produce a limit of 0 (locking everyone out)
nor stop the app booting.

**Ordering matters.** An identity-keyed limiter must run *after* the auth
middleware, or `req.user` does not exist when the key is computed and it
silently falls back to IP — putting everyone behind one NAT into a shared
budget. Pinned by a test.

**Stores are in-memory**, so budgets are per-process and reset on restart.
They bound a burst, not a determined actor across restarts.

---

## 6. Avatar security architecture

End state after R-2.

```
upload   client → POST /api/profile/avatar (Bearer)
                → magic-byte check → sharp decode → format/pages/dimension gates
                → unconditional JPEG re-encode → SEC-8.3 sanitize
                → service-role upload to avatars/<uid>.jpg
                → backend writes profiles.avatar_url

delivery client → GET /api/profile/avatar (Bearer) → 302 → 300s signed URL
                  (Google OAuth pictures pass through, allow-listed hosts only)

bucket   private · zero RLS policies · service-role only
cleanup  npm run reconcile-avatars   (dry-run default)
```

Properties worth restating because they are easy to undo:

- The delivery route takes **no user id** — enumeration is structurally impossible.
- External redirect targets are **allow-listed**; `profiles.avatar_url` is still client-writable via PostgREST, so without the list the endpoint is an open redirect.
- A private bucket's stored URL still contains `/storage/v1/object/public/`. Three subsystems parse that marker. **Do not "tidy" it.**
- `avatars` is deliberately **not** in `DELETABLE_BUCKETS`: object names are user UUIDs, so a crafted row plus a delete would be a targeted erasure. Cleanup is the operator script instead.

---

## 7. Backup recommendations

Not yet implemented — this is the recommendation, not a description.

- **Database:** enable Supabase PITR. Verify a restore into a scratch project quarterly; an untested backup is a hypothesis.
- **Storage:** `creations` and `avatars` hold user content that exists nowhere else. No backup exists today; object versioning or a scheduled copy to a second bucket is the minimum.
- **Secrets:** keep `ADMIN_JWT_SECRET` and especially `MFA_ENCRYPTION_KEY` in a password manager or secret store outside Railway. Losing the MFA key locks out every enrolled admin permanently.
- **Retention:** define one before enabling backups — copies of user photos are copies of personal data.

---

## 7b. Account deletion (Sprint 1 / B-1)

`POST /api/auth/delete-account` — authenticated, irreversible, and the only
deletion path. There is no admin-initiated equivalent and no id parameter: the
account erased is always the caller's own.

**What it removes.** The `public.users` row, and by `ON DELETE CASCADE`:
`profiles`, `creations`, `favorites`, `notifications`, `wallet_transactions`,
`daily_rewards`, `refresh_tokens`, `generation_events`, `generation_feedback`,
`generation_idempotency`, `abuse_findings`, `user_risk_scores`. Then, after the
commit, the stored objects: every creation image and thumbnail (via the shared
`creationAssetCleanup` guard) and the avatar object.

**Session revocation is the row deletion.** `authMiddleware` reads session state
from `public.users` on every authenticated request and refuses when the row is
absent, so every outstanding access token dies at commit time. There is no
denylist and no window to wait out.

**What deliberately survives, and why.**

| Kept | Rationale |
|---|---|
| `account_deletions` row | PII-free attestation that the erasure happened. Holds a dangling UUID, timestamp, counts. No FK to `users` — an FK would destroy the evidence with the account. |
| `integrity_verdicts` row, `user_id` set to `NULL` | Anti-replay ledger. Deleting inside the reuse window would let a spent Play Integrity token be presented again. Self-evicts on `PLAY_INTEGRITY_LEDGER_TTL_MS` (24h default). |
| `admin_audit_log` | Admin accountability trail. Records who acted on whom; an account is not an audit trail. |

`processed_ad_transactions` rows **are** deleted: with the user row gone there is
nobody for a replayed AdMob callback to credit.

**Operating notes.**
- A partial storage erasure sets `account_deletions.storage_erasure_complete = FALSE`. Find them with:
  ```sql
  SELECT user_id, deleted_at FROM account_deletions WHERE NOT storage_erasure_complete;
  ```
  and reclaim the objects with `npm run reconcile-creations`. The database rows are already gone in this state — only objects are outstanding.
- A failed deletion returns **500 and leaves the account intact**; the transaction rolls back as a unit. It is safe for the client to retry.
- Audit events: `audit_event` with `action: "account_deletion"` and outcome `started` → `success` / `failure` / `already_deleted`.

**The limit worth knowing.** Under `IMAGE_PROVIDER=fal` (the current production
setting) source photos are uploaded to fal's CDN under a public URL with
retention outside our control and **no delete call available to us**. Deletion
erases every copy we hold; it cannot retract those. This is disclosed in the
hosted Privacy Policy §4 and Account Deletion Policy, and is the reason those
documents carry a placeholder to name the provider and link its retention terms
before publication.

---

## 7c. Hosted legal documents (Sprint 1 / B-2)

Served as static files from `public/legal/`, mounted at `/legal` **above** the
global rate limiter — a store reviewer must never be throttled into believing
the policy is unavailable.

| URL | Required by |
|---|---|
| `/legal/privacy-policy.html` | Google Play **and** App Store, at submission |
| `/legal/terms-of-service.html` | Store listings; referenced from the paywall |
| `/legal/account-deletion.html` | Google Play, as a public deletion URL |
| `/legal/` | Index with versions and changelog |

**They are drafts.** Every company-specific or jurisdictional value is marked
`[[PLACEHOLDER: …]]`. Before submission:

```bash
grep -rn "\[\[PLACEHOLDER" public/legal/
```

must return **nothing**. There are 20 distinct placeholders today. This is a
release gate, not a suggestion — publishing a policy that still says
`[[PLACEHOLDER: legal entity name]]` is worse than publishing none.

When a marketing domain exists, point it at these URLs by redirect rather than
copying the text, so there is exactly one canonical version.

---

## 8. Incident response basics

**1 — Contain.** Rotate the exposed credential first; analysis comes second.
- Admin secret → rotate `ADMIN_JWT_SECRET` (invalidates all admin sessions).
- Service key → rotate in Supabase, redeploy backend. Everything server-side breaks until it lands.
- Under active abuse → tighten the relevant limiter via env override and restart; no build required.

**2 — Assess.** Pull the correlation id from the report and grep the log
stream for `requestId`. `auth_failure` / `authz_failure` counts in
`/api/admin/metrics` show whether probing is broad or targeted.
`admin_audit_log` is the durable record of admin mutations — logs can be lost,
that table cannot.

**3 — Eradicate.** Suspected account compromise: clear
`users.refresh_token_hash` for the account (kills the refresh chain; access
tokens still expire ≤1h). There is **no `token_version`**, so an access token
cannot be revoked before expiry.

**4 — Recover.** `/readyz` must return `ready` before declaring recovery. If
storage objects were deleted, they are gone — see §7.

**5 — Learn.** Known limits that will shape any incident:
- Metrics are per-process and lost on restart.
- Rate-limit stores are in-memory.
- No log sink or retention — the stream is whatever Railway holds.
- No account-deletion path exists.
