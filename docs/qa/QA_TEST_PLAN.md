# StyliAI — Production QA Test Plan

**Author:** QA Engineering
**Version:** 1.0
**Date:** 2026-07-15
**Status:** Planning (no tests executed)

---

## 1. Scope & System Under Test

| Component | Stack | Key surfaces |
|-----------|-------|--------------|
| **Flutter App** (`prompt_app`) | Flutter / Dart | Auth, Home (categories/trending/recommended), Style Details (similar), Upload + AI Generate, Wallet/Paywall, Creations, Favorites, Profile, Change Password, Arabic localization, light/dark theme |
| **Express Backend** (`backend`) | Node/Express 5, PostgreSQL (Supabase), Supabase Storage | `/api/auth/*`, `/api/admin/*`, `/api/categories`, `/api/styles`, `/api/tags`, `/api/upload`, `/api/generate`, `/api/wallet/*`, `/api/credit-packs`, `/api/favorites`, `/api/creations` |
| **Admin Dashboard** (`admin_dashboard`) | React + Vite + TypeScript | Login, Style Manager, Credit Packs, Analytics, User Credits |

**External dependencies:** Supabase (Postgres + Storage + JWT), Google OAuth, Google AdMob SSV, Resend (email), FAL / Gemini image providers, Railway (backend host), Vercel (dashboard host).

### Priority definitions
- **Critical** — Blocks release. Money, auth, data integrity, security, or total feature failure.
- **High** — Core user journey degraded; must pass before GA.
- **Medium** — Important but with workarounds or limited blast radius.
- **Low** — Cosmetic, edge, or nice-to-have.

### Entry / Exit criteria
- **Entry:** Feature-complete build deployed to staging; migrations applied; seed data present; test accounts provisioned.
- **Exit:** 100% of Critical + High pass; ≥95% Medium pass; no open Critical/High defects; performance and security gates met.

### Test environments
- **DEV** — local, mock providers.
- **STAGING** — production-like; real Supabase (test project), AdMob test callbacks, sandbox payment.
- **PROD-SMOKE** — post-deploy read-only smoke subset only.

---

## 2. Functional Tests

Validates each feature behaves per spec in isolation.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| FT-001 | Critical | App installed; no session | 1. Open Register. 2. Enter valid name/email + password `Str0ng!pass`. 3. Submit. | 201; "verify your email" message; verification email sent; user row created with `email_verified=false`. |
| FT-002 | High | Register screen | 1. Enter password `abc123`. 2. Submit. | Client + server reject: min 8 chars incl. upper/lower/digit/special. No user created. |
| FT-003 | Critical | Unverified account exists; verification email received | 1. Open verification link. | Success page; `email_verified=true`; `verification_token_hash` cleared. |
| FT-004 | High | Verified account | 1. Login with correct credentials. | 200; access + refresh tokens returned; lands on Home. |
| FT-005 | Critical | Unverified account | 1. Login. | 403 "verify your email"; no tokens issued. |
| FT-006 | High | Valid account | 1. Login with wrong password. | 401 "Invalid email or password" (identical to unknown-email response). |
| FT-007 | High | Google configured | 1. Tap "Continue with Google". 2. Complete consent. | Account created/linked; `email_verified=true`; session established. |
| FT-008 | High | Verified account, email provider | 1. Forgot password. 2. Open reset link. 3. Set `NewP@ss1`. | Password updated; all other sessions revoked (refresh token cleared); can log in with new password. |
| FT-009 | Medium | Logged in, email provider | 1. Change Password with correct current + valid new. | 200; new token pair returned and stored; other sessions revoked; this session stays active. |
| FT-010 | Medium | Logged in via Google | 1. Attempt Change Password. | 400 "cannot be changed for Google accounts". |
| FT-011 | Critical | Logged in; balance ≥ style cost | 1. Home → pick style. 2. Upload photo. 3. Generate. | Credits deducted once; generated image returned; creation saved; `generated_images` incremented. |
| FT-012 | Critical | Logged in; balance < style cost | 1. Attempt generate. | Blocked before provider call; paywall shown; no deduction. |
| FT-013 | High | Generation fails at provider | 1. Trigger provider error mid-generation. | Full refund recorded; user balance unchanged net; error surfaced. |
| FT-014 | High | Categories exist | 1. Open Home. | Enabled categories listed in `sortOrder`; styles lazy-load per category. |
| FT-015 | High | ≥1 style flagged trending | 1. Open Home. | "Trending Styles" section renders with trending styles; hidden when none. |
| FT-016 | High | Personalization ON; has history | 1. Open Home. | "Recommended For You" renders server-ranked styles; hidden when empty/personalization off. |
| FT-017 | Medium | On Style Details | 1. Open a style. | "You may also like" shows similar styles; collapses on empty/error. |
| FT-018 | High | Logged in | 1. Favorite a style. 2. Reopen app. | Favorite persists; appears in Favorites; unfavorite removes it. |
| FT-019 | Medium | Has creations | 1. Open Creations. 2. Delete one. | Removed from list and backend (204). |
| FT-020 | High | Watched rewarded ad (2/day rule) | 1. Complete 2 ads. | +1 credit granted; daily cap enforced (max 1 free credit/day). |
| FT-021 | Medium | Logged in | 1. Open Wallet history. | Ledger newest-first; types (purchase/reward/generation/refund/admin) correct signs. |
| FT-022 | Medium | Admin logged in (dashboard) | 1. Create/edit/reorder/delete a style. | Change persists; reflected in app catalog after refresh. |
| FT-023 | Medium | Admin logged in | 1. Search user by email. 2. Adjust balance +/-. | Balance updated; `admin`-type ledger entry with required reason. |
| FT-024 | Low | Admin logged in | 1. Open Analytics. | Stats render from `/api/admin/stats`. |

---

## 3. Integration Tests

Validates cross-component contracts and end-to-end flows.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| IT-001 | Critical | App + backend + Supabase up | 1. Register in app. 2. Verify via emailed link (Resend). 3. Login. | Full loop succeeds across app→backend→DB→email→backend. |
| IT-002 | Critical | Logged in; Supabase Storage reachable | 1. Generate image. | File uploaded to `style-images`; provider called; URL returned and rendered; creation persisted. |
| IT-003 | Critical | AdMob SSV configured | 1. Trigger server-to-server reward callback with valid signature + transaction_id. | Signature verified against Google keys; credit granted; transaction_id recorded. |
| IT-004 | Critical | IT-003 done | 1. Replay identical callback. | "Duplicate transaction ignored"; no second grant. |
| IT-005 | High | Admin edits style | 1. Toggle Trending in dashboard. 2. Refresh app Home. | App reflects updated trending set via `/api/styles?trending=true`. |
| IT-006 | High | Access token expired, refresh valid | 1. Call protected endpoint from app. | App transparently refreshes; request succeeds; refresh token rotated. |
| IT-007 | High | Password reset performed | 1. Reset password. 2. Use old refresh token. | Old refresh rejected (revoked); user must re-auth. |
| IT-008 | Medium | Dashboard + backend | 1. Admin login. 2. Load Style Manager. | Admin JWT (`ADMIN_JWT_SECRET`) accepted; CRUD authorized. |
| IT-009 | Medium | Style has tags | 1. Set tags on style (dashboard). 2. Fetch style. | `style_tags` updated atomically; tags returned. |
| IT-010 | High | Favorites/creations synced | 1. Favorite on device A. 2. Login device B. | State consistent across devices via backend. |
| IT-011 | Medium | Local-only legacy creations | 1. Trigger `/api/creations/migrate`. | Legacy creations uploaded once; count returned; idempotent on retry. |
| IT-012 | High | Paywall + credit packs | 1. Open Paywall. | Packs load from `/api/credit-packs`; purchase flow updates balance. |

---

## 4. API Tests

Contract-level tests against the Express backend (Postman/Newman or Jest supertest).

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| API-001 | Critical | — | POST `/api/auth/register` valid body | 201; JSON `{message}`; no secrets leaked. |
| API-002 | High | — | POST `/api/auth/register` malformed/missing fields | 400 with zod validation message (not 500). |
| API-003 | Critical | Verified user | POST `/api/auth/login` valid | 200; `accessToken`,`refreshToken`,`user`. |
| API-004 | High | Google-only account (null hash) | POST `/api/auth/login` | 401 generic (no 500 / stack). |
| API-005 | Critical | Valid refresh token | POST `/api/auth/refresh` | 200; new token pair; old refresh hash replaced. |
| API-006 | High | Revoked/invalid refresh | POST `/api/auth/refresh` | 401; no token issued. |
| API-007 | High | — | GET `/api/auth/status?email=` unknown | `{verified:false}` (no enumeration via 404). |
| API-008 | Critical | No admin token | POST `/api/styles` (and PUT/DELETE, categories, tags, credit-packs, upload) | 401/403; write blocked. |
| API-009 | Critical | Valid admin token | POST `/api/styles` valid | 201; style created. |
| API-010 | High | Admin token wrong role/secret | Any admin route | 403 "Admin privileges required" / 401. |
| API-011 | Critical | Auth user | POST `/api/generate` no file | 400 "Source image required". |
| API-012 | High | Auth user | POST `/api/generate` non-image (e.g. PDF) | 400 invalid file type (MIME allowlist). |
| API-013 | High | Auth user | POST `/api/generate` file > 10MB | 400 file too large. |
| API-014 | Critical | — | POST `/api/wallet/reward/verify` missing signature/key_id | 400; no grant. |
| API-015 | Critical | — | POST `/api/wallet/reward/verify` invalid signature | 400 "Invalid AdMob SSV signature". |
| API-016 | High | — | GET `/api/styles?trending=true` / `?recommended=true` / `:id/similar` | 200; enabled styles only; correct filtering/ranking. |
| API-017 | High | Auth user | GET `/api/wallet` | 200; balance, adsProgress, dailyLimitReached. |
| API-018 | Medium | — | Any route, unknown path | 404 `{message:"Resource not found."}`. |
| API-019 | High | — | CORS: request from disallowed origin | Rejected by CORS; allowed origins pass. |
| API-020 | Medium | — | Response headers | Helmet headers present; CSP has no `unsafe-inline` script. |
| API-021 | High | — | Rate limit auth routes (>100/15min) | 429 after threshold. |

---

## 5. Security Tests

Maps to `FULL_APP_SECURITY_AUDIT.md` findings and OWASP.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| SEC-001 | Critical | — | Attempt all admin writes without/with forged token | Blocked; only valid `ADMIN_JWT_SECRET` + role `admin` passes. |
| SEC-002 | Critical | — | SQLi payloads in email, styleId, category filters, search | Parameterized queries; no injection; inputs treated as data. |
| SEC-003 | Critical | — | AdMob SSV: omit signature / tamper params / replay | Rejected (400) / duplicate ignored; atomic `INSERT ... ON CONFLICT` claim holds under concurrency. |
| SEC-004 | Critical | Compromised session | Reset password, then use attacker's old refresh token | Revoked; access denied. |
| SEC-005 | High | — | Verify tokens stored hashed | `verification_token_hash` and `reset_token_hash` are SHA-256; no plaintext tokens in DB. |
| SEC-006 | High | — | Password policy enforced on register/change/reset | Weak passwords rejected consistently server-side. |
| SEC-007 | High | Prod config | Inspect DB TLS | With `DATABASE_CA_CERT` set → cert verified (`rejectUnauthorized:true`); boot warns if unset in prod. |
| SEC-008 | High | — | Enumeration on forgot-password / status / resend | Identical responses regardless of account existence. |
| SEC-009 | Critical | — | Upload endpoints: non-image, oversized, double-extension | MIME allowlist enforced (admin + generate); rejected. |
| SEC-010 | High | — | XSS: inject `<script>` into full_name, then trigger emails/pages | Escaped in email HTML; React auto-escapes dashboard; no execution. |
| SEC-011 | High | — | JWT tampering: alter payload/role, none-alg, expired | All rejected; signature + expiry enforced. |
| SEC-012 | High | — | IDOR: user A requests user B's wallet/creations/favorites | Scoped to `req.user.id`; cross-user access denied. |
| SEC-013 | Medium | — | Admin token lifetime | Default 2h expiry; expired token rejected. |
| SEC-014 | High | Supabase | Verify RLS on every table + storage bucket reachable by anon key | RLS enabled with policies; anon key cannot read/write unauthorized rows/objects. |
| SEC-015 | Medium | Secrets | Scan repos + built artifacts | No secrets committed; `.env` gitignored; anon key public-by-design only. |
| SEC-016 | Medium | — | Transport | HTTPS enforced end-to-end; no cleartext; secure token storage on device (Keychain/Keystore). |
| SEC-017 | Medium | — | Rate limiting / brute force on login | Throttled; lockout/backoff behavior verified. |
| SEC-018 | Low | — | Error responses | No stack traces / internal details leaked to clients. |

---

## 6. Performance Tests

Single-user / low-concurrency latency and responsiveness. **Targets are gates.**

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| PERF-001 | High | Warm backend | Measure p95 for `/api/auth/login` | p95 < 500ms (excl. bcrypt-inherent cost). |
| PERF-002 | High | Seeded catalog | Measure `/api/styles` list + per-category | p95 < 400ms; payload reasonable. |
| PERF-003 | High | — | Measure `/api/generate` end-to-end (excl. provider) | Backend overhead < 800ms; provider time reported separately. |
| PERF-004 | Medium | App on mid-tier device | Cold start to interactive Home | < 3s on reference device; cached categories render immediately. |
| PERF-005 | Medium | — | Home scroll with lazy style loading | 60fps target; no jank on section load; dedupe prevents duplicate fetches. |
| PERF-006 | Medium | Dashboard | Style Manager initial load with N styles | < 2s to interactive; images lazy-loaded. |
| PERF-007 | Low | — | Wallet history with large ledger | Paginated/bounded; renders < 1s. |

---

## 7. Load Tests

Expected concurrent volume sustained.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| LOAD-001 | High | Staging sized like prod | 500 concurrent users browsing catalog for 15 min | Error rate < 1%; p95 within targets; no memory growth trend. |
| LOAD-002 | Critical | — | 100 concurrent `/api/generate` (mock provider) | Correct per-user deduction; no double-charge; DB pool not exhausted. |
| LOAD-003 | High | — | 200 concurrent logins | Rate limiter behaves; no connection leaks; stable latency. |
| LOAD-004 | High | — | Burst of AdMob SSV callbacks (mixed unique/duplicate) | Exactly-once grants; duplicates ignored; no lost legitimate rewards. |
| LOAD-005 | Medium | — | Sustained wallet reads at 300 rps | Stable; connection pool healthy. |

---

## 8. Stress Tests

Beyond expected capacity — find the breaking point and failure mode.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| STR-001 | High | — | Ramp traffic until failure | Graceful degradation (429/503), not crash; recovers when load drops. |
| STR-002 | Critical | — | Exhaust DB connection pool | Requests queue/timeout cleanly; no data corruption; pool recovers. |
| STR-003 | High | — | Oversized/malformed payload flood on `/api/generate`, `/api/upload` | Rejected fast (size/MIME) before heavy work; server stays up. |
| STR-004 | Medium | — | Rapid concurrent reward claims for one user | Row-lock serializes; daily cap never exceeded (no over-credit). |
| STR-005 | Medium | — | Memory/CPU saturation on backend host | Host limits respected; process restarts cleanly (Railway) with no ledger inconsistency. |

---

## 9. Recovery Tests

Behavior around failures and restoration.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| REC-001 | Critical | Mid-generation | Kill provider/network after charge, before image | Automatic refund; if refund fails, loud log + surfaced error; no silent loss. |
| REC-002 | Critical | — | Backend restart during active requests | In-flight fail cleanly; retries succeed; no partial DB writes (transactions roll back). |
| REC-003 | High | — | DB briefly unavailable then restored | Requests error gracefully; recover automatically; pool re-establishes. |
| REC-004 | High | App offline | Lose connectivity mid-session | Cached catalog/creations still viewable; queued actions retried or clearly failed. |
| REC-005 | Medium | — | Supabase Storage upload fails | Generation aborts pre-charge or refunds; no orphaned charge. |
| REC-006 | Medium | — | AdMob callback arrives after transient reward failure | Compensating delete releases transaction_id so Google's retry succeeds. |

---

## 10. Reliability Tests

Stability over time.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| REL-001 | High | — | 24h soak at moderate load | No memory leak, no FD/connection leak, stable latency. |
| REL-002 | High | — | 10,000 sequential generate+refund cycles (mock) | Ledger balances reconcile exactly; no drift. |
| REL-003 | Medium | — | Token refresh loop over long-lived session | Continuous rotation works; no lockout; no unbounded DB writes. |
| REL-004 | Medium | App | Repeated navigation across all screens for 1h | No accumulating rebuilds/timers (widget dispose clean — cf. home section loaders). |
| REL-005 | Medium | — | Daily reward cap over multiple day rollovers | Cap resets correctly at `CURRENT_DATE` boundary; no double-claim across midnight. |
| REL-006 | Low | — | Scheduled/backfill jobs (tags) repeated runs | Idempotent; no duplicate side effects. |

---

## 11. Compatibility Tests

Devices, OS, browsers.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| COMP-001 | High | — | Android app on min supported → latest (e.g. 8–15), varied densities | Layouts correct; features work; secure storage via Keystore. |
| COMP-002 | High | — | iOS app on min supported → latest, notch/dynamic-island devices | Layouts correct; Keychain storage; Google sign-in works. |
| COMP-003 | Medium | — | Small (SE) vs large/tablet screens | No overflow; responsive; home sections render (regression-sensitive). |
| COMP-004 | High | — | Dashboard on Chrome, Edge, Firefox, Safari (latest) | Full functionality; consistent rendering. |
| COMP-005 | Medium | — | Dashboard responsive at 1280/1440/1920 + mobile width | Usable; no broken layout. |
| COMP-006 | Low | — | Network types (Wi-Fi, 4G, throttled 3G) | Graceful loading states; timeouts handled. |

---

## 12. Accessibility Tests

WCAG 2.1 AA target.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| ACC-001 | High | — | Screen reader (TalkBack/VoiceOver) across core flows | All actionable elements labeled; flow navigable. |
| ACC-002 | High | — | Dashboard keyboard-only navigation | All controls reachable/operable; visible focus. |
| ACC-003 | High | — | Color contrast (app dark/light + dashboard) | Text/controls meet AA contrast. |
| ACC-004 | Medium | — | Dynamic font scaling / OS large text | No truncation/overlap; layouts adapt. |
| ACC-005 | Medium | — | Touch target sizes | ≥ 44x44pt/48dp for interactive elements. |
| ACC-006 | Medium | — | Form errors (auth) announced | Errors programmatically associated + announced. |
| ACC-007 | Low | — | Images/icons alt text | Meaningful labels; decorative marked as such. |

---

## 13. Localization Tests

Arabic (RTL) is a first-class locale (`arabic_styles_screen`).

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| LOC-001 | High | Device set to Arabic | Navigate all app screens | UI fully RTL-mirrored; no clipped/overflowing text. |
| LOC-002 | High | Arabic locale | Auth + emails (verify/reset) | Correct language; no untranslated keys; links work. |
| LOC-003 | Medium | Arabic | Numbers, dates, currency in wallet/history | Locale-appropriate formatting. |
| LOC-004 | Medium | Switch locale at runtime | Toggle language | UI updates without restart artifacts. |
| LOC-005 | Medium | Arabic | Style names / dynamic backend content | Renders correctly incl. mixed LTR/RTL. |
| LOC-006 | Low | English/Arabic | String audit | No hardcoded strings bypassing i18n; no missing translations. |

---

## 14. User Acceptance Tests (UAT)

Business-stakeholder validation of real journeys.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| UAT-001 | Critical | Fresh user | Sign up → verify → first generation | New user reaches a generated image with minimal friction. |
| UAT-002 | Critical | Low balance user | Hit paywall → acquire credits → generate | Monetization path works; balance reflects purchase/reward. |
| UAT-003 | High | Returning user | Login → browse trending/recommended → favorite → generate | Personalized, coherent experience. |
| UAT-004 | High | User with history | View creations, re-download/share | History accurate; assets accessible. |
| UAT-005 | High | Ad-supported user | Watch ads → earn credit → generate | Reward loop matches product rules (2 ads = 1 credit, 1/day). |
| UAT-006 | Medium | Admin | Curate catalog: add style, set trending, set price | Changes appear correctly to end users. |
| UAT-007 | Medium | Admin | Adjust a user's balance with reason | Support workflow functions; audit entry created. |
| UAT-008 | Medium | Arabic-speaking user | Full journey in Arabic | Culturally/linguistically correct; RTL solid. |

---

## 15. Regression Tests

Run every release; anchored to shipped fixes and high-churn areas.

| Test ID | Priority | Preconditions | Test Steps | Expected Result |
|---------|----------|---------------|------------|-----------------|
| REG-001 | Critical | — | Full auth suite (register/verify/login/refresh/reset/change/google) | All pass; matches FT/API auth cases. |
| REG-002 | Critical | — | Generate charge/refund correctness | Exactly-once deduction; refund on failure. |
| REG-003 | Critical | — | AdMob SSV verify + replay protection | Signature enforced; duplicates ignored (post-fix behavior). |
| REG-004 | High | — | Admin authz on all write endpoints | Still blocked without valid admin token. |
| REG-005 | High | — | Home sections (trending/recommended/similar) render + hide correctly | Post-merge-repair behavior intact; no duplicate sections; no build-phase setState. |
| REG-006 | High | — | Password policy consistency across 3 flows | Uniform enforcement. |
| REG-007 | High | — | Backend unit/integration suite | `jest` green (all suites/tests pass). |
| REG-008 | Medium | — | Flutter analyze + widget tests | 0 errors; test suite green. |
| REG-009 | Medium | — | Enumeration-safe auth responses | No regression to distinct 404s. |
| REG-010 | Medium | — | CORS + Helmet/CSP headers | Unchanged from hardened config. |

---

## 16. Priority Rollup

### Critical Tests (release blockers)
FT-001, FT-003, FT-005, FT-011, FT-012 · IT-001, IT-002, IT-003, IT-004 · API-001, API-003, API-005, API-008, API-009, API-011, API-014, API-015 · SEC-001, SEC-002, SEC-003, SEC-004, SEC-009 · LOAD-002 · STR-002 · REC-001, REC-002 · UAT-001, UAT-002 · REG-001, REG-002, REG-003

### High Priority Tests
FT-002, FT-004, FT-006, FT-007, FT-008, FT-013, FT-014, FT-015, FT-016, FT-018, FT-020, FT-022 · IT-005, IT-006, IT-007, IT-010, IT-012 · API-002, API-004, API-006, API-007, API-010, API-012, API-013, API-016, API-017, API-019, API-021 · SEC-005, SEC-006, SEC-007, SEC-008, SEC-010, SEC-011, SEC-012, SEC-014, SEC-017 · PERF-001, PERF-002, PERF-003 · LOAD-001, LOAD-003, LOAD-004 · STR-001, STR-003 · REC-003, REC-004 · REL-001, REL-002 · COMP-001, COMP-002, COMP-004 · ACC-001, ACC-002, ACC-003 · LOC-001, LOC-002 · UAT-003, UAT-004, UAT-005 · REG-004, REG-005, REG-006, REG-007

### Medium Priority Tests
FT-009, FT-010, FT-017, FT-019, FT-021, FT-023 · IT-008, IT-009, IT-011 · API-018, API-020 · SEC-013, SEC-015, SEC-016 · PERF-004, PERF-005, PERF-006 · LOAD-005 · STR-004, STR-005 · REC-005, REC-006 · REL-003, REL-004, REL-005 · COMP-003, COMP-005 · ACC-004, ACC-005, ACC-006 · LOC-003, LOC-004, LOC-005 · UAT-006, UAT-007, UAT-008 · REG-008, REG-009, REG-010

### Low Priority Tests
FT-024 · SEC-018 · PERF-007 · COMP-006 · ACC-007 · LOC-006 · REL-006

---

## 17. Traceability Summary

| Category | # Tests | Critical | High | Medium | Low |
|----------|:------:|:-------:|:----:|:------:|:---:|
| Functional | 24 | 5 | 12 | 6 | 1 |
| Integration | 12 | 4 | 5 | 3 | 0 |
| API | 21 | 6 | 11 | 2 | 0 |
| Security | 18 | 5 | 9 | 3 | 1 |
| Performance | 7 | 0 | 3 | 3 | 1 |
| Load | 5 | 1 | 3 | 1 | 0 |
| Stress | 5 | 1 | 2 | 2 | 0 |
| Recovery | 6 | 2 | 2 | 2 | 0 |
| Reliability | 6 | 0 | 2 | 3 | 1 |
| Compatibility | 6 | 0 | 3 | 2 | 1 |
| Accessibility | 7 | 0 | 3 | 3 | 1 |
| Localization | 6 | 0 | 2 | 3 | 1 |
| UAT | 8 | 2 | 3 | 3 | 0 |
| Regression | 10 | 3 | 4 | 3 | 0 |
| **Total** | **141** | **34** | **64** | **39** | **7** |

**Recommended tooling:** Jest/supertest (backend), Postman/Newman (API contract), `flutter test` + integration_test (app), k6/Artillery (load/stress), OWASP ZAP + manual (security), axe/Lighthouse + manual AT (accessibility), Detox/Appium or Firebase Test Lab (device matrix).

**Production-readiness gate:** all Critical + High green, security gate clear (SEC + REG-001..003), performance targets met, and a clean UAT sign-off.
