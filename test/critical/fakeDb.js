/**
 * In-memory Postgres double for the Critical Supertest suites.
 *
 * It is a drop-in for `src/config/db` (`{ query, pool, buildSslConfig }`) so
 * the *real* Express app, routes, middleware, controllers, models, and
 * wallet service run unchanged end-to-end - only the storage layer is faked.
 * State mutations (charge/refund, reward claims, token revocation) are
 * observable via `state`, so tests assert on real side effects rather than
 * on mock call sequences.
 *
 * The router matches on normalized SQL. It deliberately throws on an
 * unrecognized query so a drifted query string surfaces loudly instead of
 * silently returning empty rows.
 */

const state = {
  users: [],
  admins: [],
  processedAdTx: [],
  dailyRewards: [], // { userId, claimed }
  walletTransactions: [], // { userId, amount, type, description }
  styles: [],
  styleFields: [], // rows in DB shape: { style_id, field_key, label, type, required, placeholder, options, config, sort_order }
  notifications: [], // { user_id, type, title, body, is_read }
  adminAuditLog: [], // SEC-15.1: { adminId, action, targetId, before, after }
  integrityVerdicts: new Map(), // SEC-0.2: token_sha256 -> { status, verdict, ... }
  // Phase 6 (SEC-1.4): one row per issued refresh token.
  // { token_hash, user_id, family_id, expires_at, used_at, revoked_at, revoked_reason }
  refreshTokens: [],
};

function reset() {
  state.users = [];
  state.admins = [];
  state.processedAdTx = [];
  state.dailyRewards = [];
  state.walletTransactions = [];
  state.styles = [];
  state.styleFields = [];
  state.notifications = [];
  state.adminAuditLog = [];
  state.integrityVerdicts = new Map();
  state.refreshTokens = [];
}

function seedAdmin(a) {
  const admin = {
    id: a.id,
    email: a.email,
    full_name: a.fullName || a.full_name || "Test Admin",
    password_hash: a.password_hash,
    failed_login_attempts: 0,
    locked_until: null,
    token_version: 0,
    ...a,
  };
  state.admins.push(admin);
  return admin;
}

function seedUser(u) {
  const user = {
    balance: 0,
    ads_progress: 0,
    generated_images: 0,
    email_verified: false,
    provider: "email",
    password_hash: null,
    refresh_token_hash: null,
    verification_token_hash: null,
    reset_token_hash: null,
    reset_token_expires_at: null,
    failed_login_attempts: 0,
    locked_until: null,
    // Phase 6 columns, defaulted to match migration_session_revocation.sql so
    // a seeded user behaves like a freshly migrated row.
    token_version: 0,
    status: "active",
    status_reason: null,
    verification_token_expires_at: null,
    created_at: new Date().toISOString(),
    full_name: "Test User",
    ...u,
  };
  state.users.push(user);
  return user;
}

// Mirrors the SEC-1.3 lockout SQL semantics: the login SELECTs project a
// DB-computed is_locked, and the atomic failure UPDATE increments the
// counter, locks at the threshold, and grants a fresh budget (count = 1,
// lock cleared) when an expired lock is hit. Constants must match the
// controllers (5 attempts / 15 minutes).
function isLocked(row) {
  return row.locked_until != null && new Date(row.locked_until) > new Date();
}

function applyFailedLogin(row) {
  if (row.locked_until != null && new Date(row.locked_until) <= new Date()) {
    row.failed_login_attempts = 1;
    row.locked_until = null;
  } else {
    row.failed_login_attempts = (row.failed_login_attempts || 0) + 1;
    if (row.failed_login_attempts >= 5) {
      row.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    }
  }
  return { rows: [{ failed_login_attempts: row.failed_login_attempts, locked_until: row.locked_until }], rowCount: 1 };
}

function seedWalletTx(userId, { amount, type, description = "", createdAt }) {
  const row = {
    id: `tx-${state.walletTransactions.length + 1}`,
    userId,
    amount,
    type,
    description,
    createdAt: createdAt || new Date().toISOString(),
  };
  state.walletTransactions.push(row);
  return row;
}

function seedStyle(s) {
  const style = {
    id: s.id,
    categoryId: s.categoryId || "cat-1",
    name: s.name || "Test Style",
    prompt: s.prompt || "a prompt",
    negativePrompt: null,
    coverImage: null,
    creditCost: s.creditCost ?? 1,
    isTrending: s.isTrending ?? false,
    isPremium: s.isPremium ?? false,
    isEnabled: s.isEnabled ?? true,
    sortOrder: s.sortOrder ?? 0,
    tagIds: [],
    ...s,
  };
  state.styles.push(style);
  // Optionally seed dynamic input fields (DB row shape) for this style.
  if (Array.isArray(s.fields)) {
    s.fields.forEach((f, i) => {
      state.styleFields.push({
        style_id: style.id,
        field_key: f.key ?? f.field_key,
        label: f.label ?? f.key,
        type: f.type ?? "text",
        required: Boolean(f.required),
        placeholder: f.placeholder ?? null,
        options: f.options ?? null,
        config: f.config ?? {},
        sort_order: f.sortOrder ?? i,
      });
    });
  }
  return style;
}

const findUserBy = (pred) => state.users.find(pred);

function norm(text) {
  return text.replace(/\s+/g, " ").trim();
}

async function query(text, params = []) {
  const q = norm(text);
  const last = params[params.length - 1];

  // Transaction control - no-ops for the double.
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(q)) return { rows: [], rowCount: 0 };

  // ---- processed_ad_transactions (SSV replay protection) ----
  if (q.includes("INSERT INTO processed_ad_transactions")) {
    const txId = params[0];
    if (state.processedAdTx.some((t) => t.transaction_id === txId)) {
      return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
    }
    state.processedAdTx.push({ transaction_id: txId, user_id: params[1], reward_amount: params[2] });
    return { rows: [], rowCount: 1 };
  }
  if (q.includes("DELETE FROM processed_ad_transactions")) {
    const before = state.processedAdTx.length;
    state.processedAdTx = state.processedAdTx.filter((t) => t.transaction_id !== params[0]);
    return { rows: [], rowCount: before - state.processedAdTx.length };
  }
  if (q.includes("FROM processed_ad_transactions")) {
    const rows = state.processedAdTx.filter((t) => t.transaction_id === params[0]);
    return { rows, rowCount: rows.length };
  }

  // ---- daily_rewards ----
  if (q.includes("INSERT INTO daily_rewards")) {
    const uid = params[0];
    const existing = state.dailyRewards.find((d) => d.userId === uid);
    if (existing) existing.claimed = 1;
    else state.dailyRewards.push({ userId: uid, claimed: 1 });
    return { rows: [], rowCount: 1 };
  }
  if (q.includes("FROM daily_rewards")) {
    const uid = params[0];
    const claimed = state.dailyRewards.find((d) => d.userId === uid && d.claimed >= 1);
    return { rows: claimed ? [{ id: "dr-1" }] : [], rowCount: claimed ? 1 : 0 };
  }

  // ---- admin_audit_log (SEC-15.1) ----
  // On the money path this INSERT runs inside walletService's transaction, so
  // an unhandled query here doesn't just fail the audit - it rolls the balance
  // change back and answers 500. That is the intended fail-closed behaviour,
  // which is exactly why the fake has to model the table.
  // SEC-0.2. Unlike the audit log above, verifyIntegrity is not inside anyone's
  // transaction and swallows its own failures - an unhandled query here would
  // annotate DECODE_UNAVAILABLE rather than 500 the request. The table is
  // modelled anyway so that a test which DOES configure Play Integrity exercises
  // the real claim/reuse path instead of silently taking the failure branch.
  if (q.includes("INSERT INTO integrity_verdicts")) {
    const [tokenSha256, requestHash, endpoint, userId] = params;
    if (state.integrityVerdicts.has(tokenSha256)) {
      return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
    }
    state.integrityVerdicts.set(tokenSha256, {
      token_sha256: tokenSha256,
      status: "decoding",
      verdict: null,
      outcome: null,
      request_hash: requestHash,
      endpoint,
      user_id: userId,
      claimed_at: new Date(),
      decoded_at: null,
    });
    return { rows: [{ token_sha256: tokenSha256 }], rowCount: 1 };
  }

  if (q.includes("UPDATE integrity_verdicts") && q.includes("SET status = 'done'")) {
    const [tokenSha256, verdict, outcome] = params;
    const row = state.integrityVerdicts.get(tokenSha256);
    if (row) {
      row.status = "done";
      row.verdict = verdict ? JSON.parse(verdict) : null;
      row.outcome = outcome;
      row.decoded_at = new Date();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  if (q.includes("FROM integrity_verdicts")) {
    const row = state.integrityVerdicts.get(params[0]);
    if (!row) return { rows: [], rowCount: 0 };
    return { rows: [{ ...row, verdict_usable: row.decoded_at !== null }], rowCount: 1 };
  }

  if (q.includes("integrity_verdicts")) {
    // Stale-claim recovery and eviction: no-ops for the fake's purposes.
    return { rows: [], rowCount: 0 };
  }

  if (q.includes("INSERT INTO admin_audit_log")) {
    const [adminId, adminEmail, action, targetType, targetId, before, after, ip, requestUrl, statusCode] = params;
    const row = {
      id: `audit-${state.adminAuditLog.length + 1}`,
      adminId, adminEmail, action, targetType, targetId,
      before: before ? JSON.parse(before) : null,
      after: after ? JSON.parse(after) : null,
      ip, requestUrl, statusCode,
      createdAt: new Date().toISOString(),
    };
    state.adminAuditLog.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // ---- wallet_transactions ----
  if (q.includes("INSERT INTO wallet_transactions")) {
    const [id, userId, amount, type, description, adminId] = params;
    const row = {
      id, userId, amount, type, description,
      adminId: adminId ?? null,
      createdAt: new Date().toISOString(),
    };
    state.walletTransactions.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (q.includes("FROM wallet_transactions")) {
    // Mirror the real query's "ORDER BY created_at DESC" (newest first).
    const rows = state.walletTransactions
      .filter((t) => t.userId === params[0])
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { rows, rowCount: rows.length };
  }

  // ---- style_fields (dynamic input field definitions) ----
  if (q.startsWith("SELECT") && q.includes("FROM style_fields")) {
    let rows;
    if (q.includes("= ANY($1)")) {
      const ids = params[0] || [];
      rows = state.styleFields.filter((f) => ids.includes(f.style_id));
    } else {
      rows = state.styleFields.filter((f) => f.style_id === params[0]);
    }
    rows = rows.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    return { rows, rowCount: rows.length };
  }
  if (q.includes("DELETE FROM style_fields")) {
    state.styleFields = state.styleFields.filter((f) => f.style_id !== params[0]);
    return { rows: [], rowCount: 0 };
  }
  if (q.includes("INSERT INTO style_fields")) {
    state.styleFields.push({
      style_id: params[0], field_key: params[1], label: params[2], type: params[3],
      required: params[4], placeholder: params[5],
      options: params[6] ? JSON.parse(params[6]) : null,
      config: params[7] ? JSON.parse(params[7]) : {}, sort_order: params[8],
    });
    return { rows: [], rowCount: 1 };
  }

  // ---- styles (getStyleById) ----
  if (q.includes("FROM styles s") && q.includes("WHERE s.id = $1")) {
    const style = state.styles.find((s) => s.id === params[0]);
    return { rows: style ? [style] : [], rowCount: style ? 1 : 0 };
  }

  // ---- creations (best-effort history write) ----
  if (q.includes("INTO creations") || q.includes("FROM creations")) {
    return { rows: [], rowCount: 0 };
  }

  // ---- profiles ----
  if (q.includes("public.profiles")) {
    return { rows: [], rowCount: 0 };
  }

  // ---- notifications (register/google sign-up seed a welcome row;
  // generation success adds an "image ready" row) ----
  if (q.includes("INSERT INTO notifications")) {
    state.notifications.push({
      id: `n-${state.notifications.length + 1}`,
      user_id: params[0],
      type: params[1],
      title: params[2],
      body: params[3],
      is_read: false,
    });
    return { rows: [], rowCount: 1 };
  }

  // ---- Phase 6 session-state reads ----
  //
  // authMiddleware and adminAuthMiddleware now read token_version (and status)
  // on EVERY authenticated request. Most suites here mint a JWT for a synthetic
  // identity and never seed a row, because what they are asserting is what the
  // endpoint does once authenticated - not authentication itself.
  //
  // Rather than force ten unrelated suites into identity bookkeeping that
  // tests nothing, an unseeded identity reads as a live, active session at
  // epoch 0. The properties this papers over - that a DELETED user or admin is
  // refused, and that a version mismatch is refused - are asserted directly,
  // against seeded rows, in test/critical/sessionRevocation.critical.test.js.
  // Seeded rows always win, so any suite that wants the real behaviour gets it
  // by seeding.
  // Matched on the exact projection, not merely "mentions token_version": the
  // refresh endpoint also selects token_version by id, and intercepting that
  // would strip the id/email/status columns it needs.
  if (/^SELECT token_version(, status)? FROM/.test(q) && q.includes("WHERE id = $1")) {
    if (q.includes("FROM admins")) {
      const admin = state.admins.find((a) => a.id === params[0]);
      return admin
        ? { rows: [{ token_version: admin.token_version || 0 }], rowCount: 1 }
        : { rows: [{ token_version: 0 }], rowCount: 1 };
    }
    if (/FROM public\.users|FROM users/.test(q)) {
      const u = findUserBy((x) => x.id === params[0]);
      return u
        ? { rows: [{ token_version: u.token_version || 0, status: u.status || "active" }], rowCount: 1 }
        : { rows: [{ token_version: 0, status: "active" }], rowCount: 1 };
    }
  }

  // ---- admins (admin login) ----
  if (q.startsWith("SELECT") && q.includes("FROM admins")) {
    // Phase 6 (SEC-15.3): adminAuthMiddleware reads session state by id on
    // every request; admin login still looks up by email.
    const admin = q.includes("WHERE id = $1")
      ? state.admins.find((a) => a.id === params[0])
      : state.admins.find((a) => a.email === params[0]);
    if (!admin) return { rows: [], rowCount: 0 };
    const row = q.includes("is_locked") ? { ...admin, is_locked: isLocked(admin) } : admin;
    return { rows: [row], rowCount: 1 };
  }
  if (q.startsWith("UPDATE admins")) {
    const admin = state.admins.find((a) => a.id === last);
    if (!admin) return { rows: [], rowCount: 0 };
    if (q.includes("failed_login_attempts = CASE")) {
      return applyFailedLogin(admin); // SEC-1.3 failure increment
    }
    if (q.includes("SET token_version = token_version + 1")) {
      admin.token_version = (admin.token_version || 0) + 1;
      return { rows: [{ token_version: admin.token_version }], rowCount: 1 };
    }
    if (q.includes("failed_login_attempts = 0")) {
      admin.failed_login_attempts = 0; // SEC-1.3 reset on successful login
      admin.locked_until = null;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`fakeDb: unhandled admins UPDATE -> ${q}`);
  }

  // ---- users: INSERT ----
  if (q.includes("INSERT INTO public.users")) {
    if (q.includes("google_id")) {
      // Google shape: (id, full_name, email, password_hash=NULL,
      // email_verified=true, google_id, provider='google', avatar_url)
      seedUser({
        id: params[0],
        full_name: params[1],
        email: params[2],
        password_hash: null,
        google_id: params[3],
        avatar_url: params[4],
        email_verified: true,
        provider: "google",
      });
      return { rows: [], rowCount: 1 };
    }
    // Register shape: (id, full_name, email, password_hash,
    // email_verified=false, verification_token_hash,
    // verification_token_expires_at, provider='email')  [Phase 6 added $6]
    seedUser({
      id: params[0],
      full_name: params[1],
      email: params[2],
      password_hash: params[3],
      verification_token_hash: params[4],
      verification_token_expires_at: params[5],
      email_verified: false,
      provider: "email",
    });
    return { rows: [], rowCount: 1 };
  }

  // ---- users: wallet-info projection (aliased columns) ----
  if (q.includes('ads_progress AS "adsProgress"')) {
    const user = findUserBy((u) => u.id === params[0]);
    return {
      rows: user ? [{ adsProgress: user.ads_progress ?? 0, generatedImages: user.generated_images ?? 0 }] : [],
      rowCount: user ? 1 : 0,
    };
  }

  // ---- refresh_tokens (Phase 6 / SEC-1.4) ----
  // Mirrors sessionService's SQL semantics, including the atomicity that makes
  // reuse detection work: the consuming UPDATE matches only an unused,
  // unrevoked, unexpired row, so a second consume of the same hash falls
  // through to the diagnostic SELECT exactly as it does in Postgres.
  if (q.includes("INSERT INTO refresh_tokens")) {
    state.refreshTokens.push({
      token_hash: params[0],
      user_id: params[1],
      family_id: params[2],
      expires_at: params[3],
      used_at: null,
      revoked_at: null,
      revoked_reason: null,
    });
    return { rows: [], rowCount: 1 };
  }

  if (q.includes("UPDATE refresh_tokens") && q.includes("SET used_at = now()")) {
    const row = state.refreshTokens.find(
      (r) =>
        r.token_hash === params[0] &&
        r.used_at === null &&
        r.revoked_at === null &&
        new Date(r.expires_at) > new Date()
    );
    if (!row) return { rows: [], rowCount: 0 };
    row.used_at = new Date().toISOString();
    return { rows: [{ user_id: row.user_id, family_id: row.family_id }], rowCount: 1 };
  }

  if (q.includes("UPDATE refresh_tokens") && q.includes("SET revoked_at = now()")) {
    const matches = q.includes("WHERE user_id = $1")
      ? state.refreshTokens.filter((r) => r.user_id === params[0] && r.revoked_at === null)
      : state.refreshTokens.filter((r) => r.family_id === params[0] && r.revoked_at === null);
    matches.forEach((r) => {
      r.revoked_at = new Date().toISOString();
      r.revoked_reason = params[1];
    });
    return { rows: [], rowCount: matches.length };
  }

  if (q.startsWith("SELECT") && q.includes("FROM refresh_tokens")) {
    const row = state.refreshTokens.find((r) => r.token_hash === params[0]);
    if (!row) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        user_id: row.user_id,
        family_id: row.family_id,
        used_at: row.used_at,
        revoked_at: row.revoked_at,
        is_expired: new Date(row.expires_at) <= new Date(),
      }],
      rowCount: 1,
    };
  }

  // ---- users: SELECT ----
  if (/FROM public\.users|FROM users/.test(q) && q.startsWith("SELECT")) {
    let user;
    if (q.includes("WHERE email = $1")) user = findUserBy((u) => u.email === params[0]);
    else if (q.includes("WHERE verification_token_hash = $1")) user = findUserBy((u) => u.verification_token_hash === params[0]);
    else if (q.includes("WHERE reset_token_hash = $1")) user = findUserBy((u) => u.reset_token_hash === params[0]);
    else if (q.includes("WHERE google_id = $1")) user = findUserBy((u) => u.google_id === params[0]);
    else if (q.includes("WHERE id = $1")) user = findUserBy((u) => u.id === params[0]);
    if (!user) return { rows: [], rowCount: 0 };
    const row = q.includes("is_locked") ? { ...user, is_locked: isLocked(user) } : user;
    return { rows: [row], rowCount: 1 };
  }

  // ---- users: UPDATE ----
  if (q.includes("UPDATE public.users")) {
    // Phase 6 (SEC-1.5): email verification is consumed by a single
    // conditional UPDATE keyed on the token hash, with expiry evaluated in
    // SQL. Routed first because it does not key on the user id.
    if (q.includes("SET email_verified = true") && q.includes("WHERE verification_token_hash = $1")) {
      const target = findUserBy(
        (u) =>
          u.verification_token_hash === params[0] &&
          u.verification_token_expires_at !== null &&
          u.verification_token_expires_at !== undefined &&
          new Date(u.verification_token_expires_at) > new Date()
      );
      if (!target) return { rows: [], rowCount: 0 };
      target.email_verified = true;
      target.verification_token_hash = null;
      target.verification_token_expires_at = null;
      return { rows: [{ id: target.id }], rowCount: 1 };
    }

    // Phase 6: password reset is consumed the same way - matched on the hash
    // inside the write, with expiry in SQL, so a replay finds nothing.
    if (q.includes("WHERE reset_token_hash = $2")) {
      const target = findUserBy(
        (u) =>
          u.reset_token_hash === params[1] &&
          u.reset_token_expires_at !== null &&
          u.reset_token_expires_at !== undefined &&
          new Date(u.reset_token_expires_at) > new Date()
      );
      if (!target) return { rows: [], rowCount: 0 };
      target.password_hash = params[0];
      target.reset_token_hash = null;
      target.reset_token_expires_at = null;
      target.refresh_token_hash = null;
      target.failed_login_attempts = 0;
      target.locked_until = null;
      target.token_version = (target.token_version || 0) + 1;
      return { rows: [{ id: target.id }], rowCount: 1 };
    }

    // Phase 6: legacy refresh migration - conditional on the stored hash.
    if (q.includes("SET refresh_token_hash = NULL") && q.includes("AND refresh_token_hash = $2")) {
      const target = findUserBy((u) => u.id === params[0] && u.refresh_token_hash === params[1]);
      if (!target) return { rows: [], rowCount: 0 };
      target.refresh_token_hash = null;
      return { rows: [{ id: target.id }], rowCount: 1 };
    }

    // Phase 6: transparent bcrypt upgrade - guarded on the hash just read.
    if (q.includes("SET password_hash = $1") && q.includes("AND password_hash = $3")) {
      const target = findUserBy((u) => u.id === params[1] && u.password_hash === params[2]);
      if (!target) return { rows: [], rowCount: 0 };
      target.password_hash = params[0];
      return { rows: [], rowCount: 1 };
    }

    // Phase 6: admin suspend/reinstate.
    if (q.includes("SET status = $1")) {
      const target = findUserBy((u) => u.id === params[3]);
      if (!target) return { rows: [], rowCount: 0 };
      target.status = params[0];
      target.status_reason = params[1];
      target.status_changed_at = new Date().toISOString();
      target.status_changed_by = params[2];
      target.token_version = (target.token_version || 0) + 1;
      target.refresh_token_hash = null;
      return {
        rows: [{ id: target.id, email: target.email, status: target.status, token_version: target.token_version }],
        rowCount: 1,
      };
    }

    const user = findUserBy((u) => u.id === last);
    if (!user) return { rows: [], rowCount: 0 };

    // Phase 6: standalone token_version bump (logout-all, reuse detection).
    if (q.includes("SET token_version = token_version + 1") && !q.includes("password_hash")) {
      user.token_version = (user.token_version || 0) + 1;
      return { rows: [{ token_version: user.token_version }], rowCount: 1 };
    }

    // Phase 6: change-password bumps the epoch in the same statement.
    if (q.includes("password_hash = $1") && q.includes("token_version = token_version + 1")) {
      user.password_hash = params[0];
      user.refresh_token_hash = null;
      user.token_version = (user.token_version || 0) + 1;
      return { rows: [{ token_version: user.token_version }], rowCount: 1 };
    }

    if (q.includes("failed_login_attempts = CASE")) {
      return applyFailedLogin(user); // SEC-1.3 failure increment
    }
    // Phase 6: atomic verification consume (matches on the hash, not the id).
    // Handled before the id lookup below because it is keyed differently.
    if (q.includes("google_id = $1")) {
      // Link an existing email account to Google.
      user.google_id = params[0];
      user.provider = "google";
      user.email_verified = true;
      user.avatar_url = params[1];
    } else if (q.includes("email_verified = true")) {
      user.email_verified = true;
      user.verification_token_hash = null;
    } else if (q.includes("reset_token_hash = $1, reset_token_expires_at = $2")) {
      user.reset_token_hash = params[0];
      user.reset_token_expires_at = params[1];
    } else if (q.includes("password_hash = $1") && q.includes("reset_token_hash = NULL")) {
      user.password_hash = params[0];
      user.reset_token_hash = null;
      user.reset_token_expires_at = null;
      user.refresh_token_hash = null; // revocation on reset
      user.failed_login_attempts = 0; // lockout cleared on reset (SEC-1.3)
      user.locked_until = null;
    } else if (q.includes("password_hash = $1, refresh_token_hash = $2")) {
      user.password_hash = params[0];
      user.refresh_token_hash = params[1]; // rotation on change-password
    } else if (q.includes("verification_token_hash = $1, verification_token_expires_at = $2")) {
      user.verification_token_hash = params[0];
      user.verification_token_expires_at = params[1];
    } else if (q.includes("verification_token_hash = $1")) {
      user.verification_token_hash = params[0];
    } else if (q.includes("SET refresh_token_hash = NULL")) {
      user.refresh_token_hash = null; // logout revocation
      if (q.includes("failed_login_attempts = 0")) {
        // Phase 6: login clears the legacy column AND restores the SEC-1.3
        // budget in one statement. Without this branch the lockout counter
        // would survive a successful login.
        user.failed_login_attempts = 0;
        user.locked_until = null;
      }
    } else if (q.includes("refresh_token_hash = $1")) {
      user.refresh_token_hash = params[0];
      if (q.includes("failed_login_attempts = 0")) {
        user.failed_login_attempts = 0; // budget restored on successful login (SEC-1.3)
        user.locked_until = null;
      }
    }
    return { rows: [], rowCount: 1 };
  }

  // ---- users: wallet UPDATE (no public. prefix) ----
  if (q.startsWith("UPDATE users")) {
    const user = findUserBy((u) => u.id === last);
    if (!user) return { rows: [], rowCount: 0 };
    if (q.includes("generated_images = generated_images + 1")) {
      user.balance = params[0];
      user.generated_images = (user.generated_images || 0) + 1;
    } else if (q.includes("ads_progress = 0")) {
      user.balance = params[0];
      user.ads_progress = 0;
    } else if (q.includes("SET ads_progress = $1")) {
      user.ads_progress = params[0];
    } else if (q.includes("SET balance = $1")) {
      user.balance = params[0];
    }
    return { rows: [], rowCount: 1 };
  }

  throw new Error(`fakeDb: unhandled query -> ${q}`);
}

const pool = {
  connect: async () => ({ query, release: () => {} }),
};

function buildSslConfig() {
  return false;
}

module.exports = { query, pool, buildSslConfig, state, reset, seedUser, seedAdmin, seedStyle, seedWalletTx };
