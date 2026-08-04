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
