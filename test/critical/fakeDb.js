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
  processedAdTx: [],
  dailyRewards: [], // { userId, claimed }
  walletTransactions: [], // { userId, amount, type, description }
  styles: [],
  styleFields: [], // rows in DB shape: { style_id, field_key, label, type, required, placeholder, options, config, sort_order }
  notifications: [], // { user_id, type, title, body, is_read }
};

function reset() {
  state.users = [];
  state.processedAdTx = [];
  state.dailyRewards = [];
  state.walletTransactions = [];
  state.styles = [];
  state.styleFields = [];
  state.notifications = [];
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
    created_at: new Date().toISOString(),
    full_name: "Test User",
    ...u,
  };
  state.users.push(user);
  return user;
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

  // ---- wallet_transactions ----
  if (q.includes("INSERT INTO wallet_transactions")) {
    const [id, userId, amount, type, description] = params;
    const row = { id, userId, amount, type, description, createdAt: new Date().toISOString() };
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
    // email_verified=false, verification_token_hash, provider='email')
    seedUser({
      id: params[0],
      full_name: params[1],
      email: params[2],
      password_hash: params[3],
      verification_token_hash: params[4],
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

  // ---- users: SELECT ----
  if (/FROM public\.users|FROM users/.test(q) && q.startsWith("SELECT")) {
    let user;
    if (q.includes("WHERE email = $1")) user = findUserBy((u) => u.email === params[0]);
    else if (q.includes("WHERE verification_token_hash = $1")) user = findUserBy((u) => u.verification_token_hash === params[0]);
    else if (q.includes("WHERE reset_token_hash = $1")) user = findUserBy((u) => u.reset_token_hash === params[0]);
    else if (q.includes("WHERE google_id = $1")) user = findUserBy((u) => u.google_id === params[0]);
    else if (q.includes("WHERE id = $1")) user = findUserBy((u) => u.id === params[0]);
    return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
  }

  // ---- users: UPDATE ----
  if (q.includes("UPDATE public.users")) {
    const user = findUserBy((u) => u.id === last);
    if (!user) return { rows: [], rowCount: 0 };
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
    } else if (q.includes("password_hash = $1, refresh_token_hash = $2")) {
      user.password_hash = params[0];
      user.refresh_token_hash = params[1]; // rotation on change-password
    } else if (q.includes("verification_token_hash = $1")) {
      user.verification_token_hash = params[0];
    } else if (q.includes("refresh_token_hash = $1")) {
      user.refresh_token_hash = params[0];
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

module.exports = { query, pool, buildSslConfig, state, reset, seedUser, seedStyle, seedWalletTx };
