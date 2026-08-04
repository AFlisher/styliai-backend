# StyliAI — QA Execution Report

**Latest run:** 2026-08-04
**Previous run:** 2026-07-30 (backend + client only)
**Original run:** 2026-07-15 (preserved below)
**Source of truth:** [`QA_TEST_PLAN.md`](QA_TEST_PLAN.md)
**Scope:** Execute every automatable test; mark the rest as manual or external.

---

## Headline — 2026-08-04

Every figure below was produced by executing the suites on 2026-08-04, not carried forward.

| Metric | Value |
|--------|-------|
| **Total automated tests** | **2,178** (1,718 backend + 391 Flutter + 69 admin dashboard) |
| **Total suites** | **153** (103 backend + 41 Flutter files + 9 dashboard files) |
| **Pass rate** | **100%** (2,178 / 2,178) |
| **Failures / skipped** | 0 / 0 |
| **Backend wall time** | ~9 s |
| **Flutter wall time** | ~18 s |
| **Dashboard wall time** | ~4 s |
| **Coverage** | **Not measured** — no coverage tooling is configured in any of the three repositories. See §Known limitations. |

Growth since the original run: **+1,732 tests (4.9×)** and **+105 suites**, almost entirely from the security remediation programme, where each closed finding that could silently regress was pinned by a test.

**What changed since 2026-07-30:** the **admin dashboard's suite is counted for the first time** — it has existed for some time, but every prior headline in this file described two repositories out of three. The Flutter count reproduced exactly (391). Backend moved 1,717 → 1,718 for the reason below.

> ### Why the backend count moves when no test is written
>
> `test/medium/secrets.medium.test.js` generates **one test per git-tracked file** (`git ls-files`, 264 today) to assert no hardcoded secret is present. **Adding any tracked file of any type adds a test.** The 1,717 → 1,718 change between the two runs on 2026-08-04 is exactly this: `backend/README.md` was committed between them, taking tracked files from 263 to 264. No test was written, and `test/medium` moved 302 → 303 accordingly.
>
> This is worth knowing before treating a changed total as meaningful: the backend figure is a function of the repository's file count as well as its test count.

### Backend breakdown

| Location | Suites | Tests |
|---|---|---|
| `src/**/__tests__/` | 78 | 1,207 |
| `test/critical/` | 8 | 77 |
| `test/high/` | 6 | 71 |
| `test/medium/` | 6 | 303 |
| `test/feature/` | 5 | 60 |
| **Total** | **103** | **1,718** |

`test/manual/` and `test/mocks/` contain no test suites — a manual script and a `uuid` ESM shim respectively.

### Flutter breakdown

41 test files / 391 tests across `services` (8 files), `data` (7), `widgets` (6), `screens` (10 across auth, home, profile, upload, preview, creations), `utils` (3), `models` (2), `regression` (1) and `android` (1).

### Admin dashboard breakdown

9 test files / 69 tests (Vitest 4 + Testing Library): `src/__tests__/AppTabGating`, `src/utils/__tests__/adminRoles`, `src/pages/__tests__/` (LoginPage, StyleManagerPage, GenerationAnalyticsPage, UsersByCountryPage) and `src/components/__tests__/` (FieldsEditor, ImageUploader, PromptPreview).

> ⚠ **Measured with `npx vitest run --dir src`.** Bare `npm test` in `admin_dashboard` reports **19 files / 127 tests** on this machine because Vitest's include pattern is not scoped to `src` and it also collects the duplicated copies inside `admin_dashboard/.claude/worktrees/`. All 127 pass, but the count varies with which local worktrees happen to exist, so it is not a property of the code. Backend Jest is immune to this — its `roots` are pinned. Scoping the Vitest config would fix it and is a code change, deliberately not made by this documentation pass.

### Execution environment

| | |
|---|---|
| **Backend** | Node 24.18.0 · Jest 30.4.2 · Supertest 7.2.2 · `testEnvironment: node` |
| **Client** | Flutter 3.44.4 stable · Dart `>=3.2.0 <4.0.0` |
| **Dashboard** | Vitest 4.1.10 + Testing Library · jsdom environment |
| **Database** | **Mocked.** No suite requires a live database or writes to production. |
| **Supabase / AI providers / email** | Mocked at the module boundary |
| **Platform** | Windows 11, local developer machine |
| **CI** | GitHub Actions runs **gitleaks secret scanning only** on all three repositories. **The test suites do not run in CI** — they are executed locally before push. |

### How the suites are run

```bash
cd backend         && npm test                    # 103 suites / 1,718 tests
cd prompt_app      && flutter test                # 41 files   /   391 tests
cd admin_dashboard && npx vitest run --dir src    #  9 files   /    69 tests
```

Jest's `roots` are pinned to `src` and `test`, so a linked git worktree cannot inflate the backend's discovered suite count — that number is deterministic regardless of which checkout it runs from. The dashboard's Vitest config has no equivalent scoping, which is why `--dir src` appears above instead of `npm test`.

---

## Known limitations (2026-08-04)

Stated plainly, because a 100% pass rate on 2,178 tests can read as more assurance than it is:

1. **No coverage measurement.** None of the three repositories configures `--coverage` or a threshold gate. Test *count* is a measure of volume, not of coverage; no percentage is claimed anywhere in this project.
2. **The test suites do not run in CI.** Only secret scanning does. A push whose tests were never run locally would not be caught.
3. **The database is mocked everywhere.** Real SQL behaviour — constraints, triggers, transaction semantics, RLS — is not exercised by the automated suites. RLS was verified separately by owner-run live probes (SEC-10.1), not by these tests.
4. **No load, stress, performance or soak testing has been executed.** Plan sections §6–§8 remain unimplemented.
5. **No end-to-end test on a real device.** Certificate pinning, network security config, root detection and Play Integrity each require hardware or an external console; they are listed as manual in the plan and remain unverified in that sense.
6. **No accessibility or localization automation.** Plan §12–§13 are unimplemented; Arabic/RTL is verified by eye.
7. **Backup restore has never been drilled** — there are no backups to drill (SEC-21.1/21.2/21.3).
8. **Flutter widget tests assert structure, not rendering.** Screenshot protection, for example, is asserted by widget presence and reference-count behaviour, not by inspecting a captured frame.
9. **The dashboard's suite count is environment-dependent.** `npm test` there collects any `.claude/worktrees/` copies alongside `src`, so the reported file/test count changes with the local working tree. Use `--dir src` for a reproducible figure (see §Admin dashboard breakdown).

---

<details>
<summary><strong>Original run — 2026-07-15 (preserved verbatim)</strong></summary>

**Date:** 2026-07-15
**Source of truth:** `QA_TEST_PLAN.md`
**Scope:** Implement and execute every automatable test in the plan; mark the rest as manual or external.

## Headline

| Metric | Value |
|--------|-------|
| **Total automated tests** | **446** (336 backend + 110 Flutter) |
| **Total suites** | **48** (36 backend + 12 Flutter) |
| **Pass rate** | **100%** (446 / 446) |
| **Real defects found by tests** | 2 (both fixed — see below) |
| **Application behavior changes required by this QA phase** | 0 |

Backend runs on Jest + Supertest against the **real Express app** (routes, middleware, controllers, models, wallet service) with only the storage layer (in-memory Postgres double) and external services faked. Flutter runs on `flutter_test`.

> **Everything from here to the end of the file is the 2026-07-15 report, preserved verbatim.** Its counts (36 suites / 336 tests, 12 suites / 110 tests) and its readiness assessment describe the project as it was on that date and are **superseded** by the 2026-07-30 headline above. It is retained because it records the two real defects the original QA phase found, and the manual/external gates it identified — several of which are still open.

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

</details>
