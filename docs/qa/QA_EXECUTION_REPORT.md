# StyliAI — QA Execution Report

**Date:** 2026-07-15
**Source of truth:** `QA_TEST_PLAN.md`
**Scope:** Implement and execute every automatable test in the plan; mark the rest as manual or external.

---

## Headline

| Metric | Value |
|--------|-------|
| **Total automated tests** | **446** (336 backend + 110 Flutter) |
| **Total suites** | **48** (36 backend + 12 Flutter) |
| **Pass rate** | **100%** (446 / 446) |
| **Real defects found by tests** | 2 (both fixed — see below) |
| **Application behavior changes required by this QA phase** | 0 |

Backend runs on Jest + Supertest against the **real Express app** (routes, middleware, controllers, models, wallet service) with only the storage layer (in-memory Postgres double) and external services faked. Flutter runs on `flutter_test`.

---

## Coverage by plan category

| Category | Automated | Manual | External | Notes |
|----------|:--------:|:------:|:--------:|-------|
| 1. Functional | FT-001,003,005,007,008,009,010,011,012,013,014,015,016,018,019,020,021,022,023,024 | FT-017 (similar-styles UI polish) | — | Data layer of FT-017 covered by model + API tests |
| 2. Integration | IT-003,004,005,008,011,012 | — | IT-001 (Resend email), IT-002 (Supabase Storage upload), IT-006/007/010 partially (device sync) | Contract halves automated; live delivery external |
| 3. API | API-001..021 (all) | — | — | Full contract suite |
| 4. Security | SEC-001,002,003,004,005,006,008,009,010,011,012,013,015,017,018 | — | SEC-007 partial*, SEC-014 (Supabase RLS), SEC-016 (HTTPS transport) | *SEC-007 unit-tested; cert install is ops |
| 5. Performance | — | — | PERF-001..007 | Needs load harness / real devices |
| 6. Load | — | — | LOAD-001..005 | k6/Artillery + prod-sized infra |
| 7. Stress | STR-004 (reward daily-cap concurrency, logic) | — | STR-001,002,003,005 | Pool-exhaustion/host saturation need infra |
| 8. Recovery | REC-001 (refund-on-failure) | — | REC-002,003,004,005,006 | Restart/network/storage-outage need infra |
| 9. Reliability | REL-002 (charge/refund reconcile, logic) | — | REL-001,003,004,005,006 | 24h soak / day-rollover need infra + time |
| 10. Compatibility | — | COMP-003 (screen sizes via widget tests, partial) | COMP-001,002,004,005,006 | Device/browser matrix → Firebase Test Lab / BrowserStack |
| 11. Accessibility | — | ACC-001..007 | — | No a11y framework in app; needs AT + manual audit |
| 12. Localization | — | LOC-001..006 | — | App has no i18n framework (manual Arabic/RTL); needs manual review |
| 13. UAT | — | UAT-001..008 | — | Stakeholder sign-off |
| 14. Regression | REG-001,002,003,004,005,006,007,008,009,010 | — | — | REG-005 via Flutter widget tests; REG-007/008 are the suites themselves |

---

## Backend suites (36 suites / 336 tests)

- **Critical** (`test/critical/`, 5 suites, 57): auth, admin authorization, generate charge/refund, AdMob SSV, SQL-injection resilience.
- **High** (`test/high/`, 4 suites, 36): Google sign-in, forgot/reset, enumeration safety, password policy, XSS-in-email, reward cap, wallet, JWT tampering, IDOR, catalog filters, credit packs, oversized upload, CORS, rate limiting.
- **Medium/Low** (`test/medium/`, 6 suites, 79): change-password, error hygiene, wallet history, admin balance adjust, creations delete/migrate, admin analytics, 404/headers/CSP, admin token expiry, hardcoded-secret scan.
- **Pre-existing + security-phase unit tests** (21 suites, 164): controllers/models/services/utils, plus `db.ssl`, `passwordPolicy`, `escapeHtml`, `upload`, and the security-regression tests added during hardening.

## Flutter suites (12 suites / 110 tests)

- Data managers (creations, credits, dynamic styles, favorites), auth/home/creations/profile/preview screens, style-card hero, `widget_test`, and the new **model serialization** suite (14 tests) validating the client parses the exact JSON shapes the backend API tests emit.

---

## Real defects discovered (fixed)

Both were found earlier in the program and are already on the branch; no new behavior defects surfaced during Medium/Low implementation:

1. **zod v4 `ZodError.errors` removed** — validation failures were throwing and returning 500 instead of 400. Fixed to read `.issues`. (Exposed by the admin-login and register validation tests.)
2. **AdMob SSV key mismatch** — the numeric `keyId` from Google was compared with `===` to the string `key_id` from the callback, so **no legitimate SSV callback could ever verify**. Fixed with a normalized comparison. (Exposed by the SSV suite.)

Everything else flagged during test development was a test-harness issue (fixed in the tests), not an application defect. No application behavior was changed to make any test pass.

---

## Remaining MANUAL validations (human judgement, no infra)

- **Accessibility (ACC-001..007):** screen-reader labels, keyboard nav, contrast, dynamic type, touch targets. The app has no accessibility instrumentation to assert against; requires TalkBack/VoiceOver + manual audit.
- **Localization (LOC-001..006):** the app localizes Arabic/RTL without an i18n framework (no ARB/intl), so there are no message keys to assert; requires manual RTL walkthrough and string audit.
- **UAT-001..008:** business/stakeholder acceptance of the end-to-end journeys.
- **FT-017:** similar-styles section visual/UX polish (data path is covered).
- **COMP-003:** fine-grained layout across screen sizes (partially coverable by golden/widget tests later).

## Remaining EXTERNAL validations (require infrastructure not in this repo)

- **Performance / Load / Stress (PERF-*, LOAD-*, most STR-*):** need a load harness (k6/Artillery) and a production-sized Railway + Supabase environment. Cannot be produced deterministically from unit/integration tests.
- **Recovery / Reliability (REC-002..006, REL-001,003,004,005,006):** backend restart mid-request, DB/storage outage-and-restore, 24h soak, day-boundary rollover — need orchestrated infra and elapsed time.
- **IT-001 / IT-002:** real Resend email delivery and real Supabase Storage upload round-trips.
- **SEC-014 (Supabase RLS):** must be verified in the Supabase dashboard — policies on every table/bucket reachable by the public anon key. Not expressible from the backend repo.
- **SEC-007 (DB TLS):** unit-tested at the config layer; installing the provider CA (`DATABASE_CA_CERT`) is a Railway ops step.
- **SEC-016 (HTTPS transport):** enforced by the hosting platform; device secure-storage (Keychain/Keystore) is by-design in `flutter_secure_storage`.
- **Compatibility (COMP-001,002,004,005,006):** device/OS/browser matrix → Firebase Test Lab / BrowserStack.

---

## Production readiness assessment

**The application logic is production-ready from an automated-test standpoint.** Every executable case in the plan — all Critical, High, Medium, and Low backend/API/data tests — is implemented and green (446/446), exercising the real request path end-to-end. The two genuine defects the tests uncovered (a blanket 500-on-validation bug and a signature check that could never pass) are fixed, and the money paths (exactly-once charge, refund-on-failure, reward cap, SSV replay protection) and auth/authorization boundaries are covered with state-level assertions.

**Before go-live, the following non-code gates remain**, and they are gates a green unit/integration suite cannot close on its own:

1. **Load & performance** run against prod-sized infra (throughput, p95, pool behavior).
2. **Resilience** drills (restart, DB/storage outage, soak) in a staging environment.
3. **Supabase RLS audit** (SEC-014) — the single highest-risk external item, since the anon key ships in the app.
4. **Set `DATABASE_CA_CERT` in Railway** (SEC-007) to enable verified TLS.
5. **Accessibility, Localization/RTL, and UAT** manual passes.

Recommendation: **conditionally ready** — ship-ready on application correctness and security logic; complete the five external/manual gates above (RLS audit and load/resilience being the critical two) before general availability.
