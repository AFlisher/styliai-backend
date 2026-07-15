# Full Application Security Audit — 2026-07-15

**Scope:** `backend/` (Express API), `admin_dashboard/` (React/Vite), `prompt_app/` (Flutter). Verified directly against source. No code was modified.

## Status of the Phase 1 endpoint audit (2026-07-11)

All 9 **Critical** and both **High** findings from `PHASE1_ENDPOINT_SECURITY_AUDIT.md` are now fixed:

- All category, style, tag, credit-pack, and upload write endpoints now require `adminAuthMiddleware` (dedicated `ADMIN_JWT_SECRET`, role check).
- `/api/upload` now uses a strict image MIME allowlist (`adminImageUpload.js`) and requires an admin token; a DELETE route was added, also admin-guarded.
- AdMob SSV (`POST /api/wallet/reward/verify`) now **rejects** callbacks missing `signature`/`key_id` and verifies the signature against Google's published keys, with a `processed_ad_transactions` replay check.
- `/api/auth/refresh` and `/api/auth/status` are now rate-limited (100/15min).
- `/api/admin/stats` is mounted and admin-guarded; `forgot-password`, `status`, and `resend-verification` responses are now enumeration-safe.

## What's healthy

- **SQL injection:** every query in controllers/models/services uses parameterized placeholders; dynamic WHERE/VALUES fragments only interpolate placeholder indexes, never user input.
- **Passwords:** bcrypt (cost 10); login responses don't distinguish wrong-email from wrong-password.
- **Refresh tokens:** SHA-256-hashed at rest, rotated on every refresh, revocable via hash comparison.
- **Wallet integrity:** all balance mutations run in transactions with `SELECT ... FOR UPDATE` row locks; generation deducts before calling the AI provider and refunds on failure, with loud logging if the refund itself fails.
- **Reward abuse:** daily-limit check runs under the user row lock (concurrency-safe), 1 free credit/day cap.
- **HTTP hardening:** helmet with CSP, CORS origin allowlist (env-configurable), rate limits on all auth routes (admin login 20/15min).
- **Mobile tokens:** stored in `FlutterSecureStorage` (Keychain/Keystore), with migration off plaintext `SharedPreferences`.
- **Secrets:** none hardcoded in source; all via `.env`/env vars. `npm audit --omit=dev` → **0 vulnerabilities** in both backend and admin dashboard.
- **Reset/verify pages:** user-controlled values are only echoed after a server-side token-hash match, so the unescaped template interpolation is not practically reachable by an attacker.

## Findings

| # | Severity | Area | Finding | Recommendation |
|---|----------|------|---------|----------------|
| 1 | **Medium** | `backend/src/config/db.js` | Production TLS uses `rejectUnauthorized: false` — the Postgres connection accepts any certificate, so a network MITM could read/modify all DB traffic (including password hashes and tokens). | Pin the provider CA (`ssl: { ca }`) or use `sslmode=verify-full` in `DATABASE_URL`. |
| 2 | **Medium** | `authController.postResetPassword` / `changePassword` | Password reset/change does **not** clear `refresh_token_hash`. If an account is compromised and the owner resets the password, the attacker's refresh token keeps working for up to 30 days. | Set `refresh_token_hash = NULL` in both queries; mobile app already handles re-login. |
| 3 | **Medium** | `POST /api/wallet/reward` | The authenticated (non-SSV) reward path trusts the client's claim of having watched an ad — a user can script 2 calls/day for a free credit without watching anything. Bounded by the daily cap, but it bypasses the SSV verification you built. | Remove or feature-flag the client-trusted path once the SSV callback is confirmed working in production. |
| 4 | **Medium** | `backend/src/middleware/upload.js` (`/api/generate`) | No file-type filter — any 10MB payload is accepted and forwarded to storage/the AI provider. Authenticated and credit-charged, so abuse is bounded, but junk uploads still incur storage and provider handling. | Reuse the same image MIME allowlist as `adminImageUpload.js`. |
| 5 | Low | `admin_dashboard` AuthContext | Admin JWT (12h) lives in `localStorage` with no server-side revocation — any XSS in the dashboard yields a long-lived admin token. React's escaping and the clean dep audit make XSS unlikely today. | Acceptable for now; consider shorter expiry (1–2h). Optional: httpOnly-cookie session if the dashboard grows. |
| 6 | Low | `users.verification_token` | Email-verification tokens are stored in **plaintext** (reset tokens are hashed). A DB/backup leak would let an attacker verify arbitrary accounts. | Hash it like `reset_token_hash`, and consider an expiry. |
| 7 | Low | `authController.register` | Returns a distinct "Email is already registered" (enumeration at registration). Rate-limited, and the other auth endpoints were made enumeration-safe — this is the remaining gap. | Accept as UX trade-off or switch to the "verification email sent" neutral response. |
| 8 | Low | Password policy | Inconsistent: register allows 6 chars with no complexity; reset-password demands 8 + upper/lower/digit/special; change-password demands 8 only. | Centralize one policy (e.g. a shared Zod schema). |
| 9 | Low | `walletController.verifyRewardedAd` | Duplicate-transaction check and the `processed_ad_transactions` insert are not in one transaction — two concurrent identical callbacks could both pass the dup check. The per-user daily-limit row lock caps the damage at the daily max. | Wrap dup-check + reward + insert in one transaction, or add a unique constraint and insert first. |
| 10 | Low | Emails | `full_name` is interpolated unescaped into verification/reset email HTML. Recipient is the account owner (self-injection only), so impact is minimal. | Escape it anyway when touching this code. |
| 11 | Low | Robustness (500s) | `login` for a Google-only account (`password_hash` NULL) makes `bcrypt.compare` throw → 500; `admin/login` and `googleSignIn` call `.toLowerCase()` on possibly-missing fields → 500. Not exploitable, but 500s leak "something differs here". | Guard for NULL hash (return generic 401) and validate bodies with Zod like the other endpoints. |
| 12 | Info | `app.js` CSP | `scriptSrc 'unsafe-inline'` is enabled but the served HTML pages contain no scripts. | Drop `'unsafe-inline'` from `scriptSrc`. |
| 13 | Info | `prompt_app` | `.env` (Supabase URL + **anon key** + backend URL) is bundled into the APK via `flutter_dotenv`. This is normal for anon keys, but it means **Supabase RLS must be enabled on every table/bucket** — the backend uses the service key, so any RLS gap is directly reachable from the shipped key. | Audit RLS policies in Supabase; treat the anon key as public. |
| 14 | Info | Secrets hygiene | `D:\StyliAI` is not a git repository; all three `.env` files sit in the tree (backend one holds DB URL, service key, JWT secrets, AI keys). | Before ever running `git init`, add a `.gitignore` covering `.env*` first. Rotate any key that has been pasted into chats/docs. |

## Summary

No critical or high-severity issues remain. The Phase-1 criticals (open admin writes, unauthenticated upload, bypassable AdMob signature) are all verifiably fixed. The four Medium items worth scheduling next: DB TLS certificate validation (#1), refresh-token revocation on password reset (#2), retiring the client-trusted reward path (#3), and an image filter on `/api/generate` (#4).

---

## Resolution status — 2026-07-15 (branch `security-audit-hardening`)

All findings are resolved. Backend changes live on the `security-audit-hardening` branch of `styliai-backend` (16 files, 7 new test suites; full suite **164 tests / 21 suites passing**). Open the PR here: <https://github.com/AFlisher/styliai-backend/pull/new/security-audit-hardening>

| # | Resolution |
|---|------------|
| 1 | **Fixed (code) + ops step.** `db.js` verifies the server certificate whenever `DATABASE_CA_CERT` is set (accepts PEM content or a file path) and logs a boot warning if production runs without it. **Action:** download the CA cert from the Supabase dashboard and set `DATABASE_CA_CERT` in the production environment. |
| 2 | **Fixed.** Password reset nulls `refresh_token_hash`; change-password rotates it and returns a fresh token pair (the app stores it — `auth_service.dart` updated), so all *other* sessions are revoked immediately. |
| 3 | **Fixed (flagged).** Set `ENABLE_CLIENT_AD_REWARD=false` to retire the client-trusted path once AdMob SSV is confirmed in production; default keeps current mobile behavior. Testing also exposed and fixed an SSV bug: the numeric-vs-string `keyId` comparison meant **no legitimate Google callback could ever verify**. |
| 4 | **Fixed.** `/api/generate` enforces the same JPEG/PNG/WEBP/GIF allow-list as the admin upload, answering 400 (not 500) on violations. |
| 5 | **Fixed.** Admin JWT default expiry is now 2h (`ADMIN_JWT_EXPIRES_IN` to tune). |
| 6 | **Fixed.** Verification tokens stored as SHA-256 hashes. **Action:** run `migration_verification_token_hash.sql` (idempotent; hashes pending tokens in place so already-sent links keep working). |
| 7 | **Accepted (documented).** Register keeps the distinct "Email is already registered" response: the app's registration UX needs it, the endpoint is rate-limited (100/15min), and every other auth endpoint is enumeration-safe. Revisit if abuse is observed. |
| 8 | **Fixed.** One shared policy (`src/utils/passwordPolicy.js`, min 8 + upper/lower/digit/special) now governs register, change-password, and reset-password; the app's change-password form mirrors it (register already did). |
| 9 | **Fixed.** The SSV handler claims `transaction_id` atomically (`INSERT … ON CONFLICT DO NOTHING`, primary key) *before* granting, with a compensating delete if the grant fails so AdMob's retry isn't swallowed. |
| 10 | **Fixed.** `full_name` is HTML-escaped in all email bodies (`src/utils/escapeHtml.js`). |
| 11 | **Fixed.** Google-only accounts get a generic 401 on password login; email-less Google tokens get a clean 401; admin login validates its body (400, not 500). Bonus: all zod catch-blocks read `.issues` (zod v4 removed `.errors`), so validation failures now return their intended 400s instead of 500s. |
| 12 | **Fixed.** CSP `scriptSrc` no longer includes `'unsafe-inline'`. |
| 13 | **External action.** Supabase RLS can't be verified from this codebase. **Action:** in the Supabase dashboard, confirm RLS is enabled with policies on every table and storage bucket reachable by the anon key. |
| 14 | **Fixed / clarified.** The workspace root turned out to hold three separate git repos. `backend/.env` (the one with real secrets) is untracked and gitignored ✓. A root `.gitignore` was added as a safety net. Note: `prompt_app/.env` and `admin_dashboard/.env` **are tracked** in their repos — neither holds a real secret (Supabase anon key is public-by-design; `VITE_API_BASE_URL` ships in the built JS), but if you ever add secrets to them, `git rm --cached` them first. |
