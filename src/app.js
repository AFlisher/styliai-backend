const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { redactUrl } = require('./utils/redactUrl');
const auditAdminAction = require('./middleware/auditAdminAction');

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const categoryRoutes = require("./routes/categoryRoutes");
const styleRoutes = require("./routes/styleRoutes");
const tagRoutes = require("./routes/tagRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const generateRoutes = require("./routes/generateRoutes");
const stabilityRoutes = require("./routes/stabilityRoutes");
const walletRoutes = require("./routes/walletRoutes");
const creditPackRoutes = require("./routes/creditPackRoutes");
const favoritesRoutes = require("./routes/favoritesRoutes");
const creationsRoutes = require("./routes/creationsRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const generationFeedbackRoutes = require("./routes/generationFeedbackRoutes");

const app = express();

// Railway puts the app behind two real hops: a public edge (a genuine
// public-facing IP, NOT inside any private range) and an internal load
// balancer that connects to the container over its own 100.64.0.0/10 CGNAT
// range. Confirmed against live production traffic via a temporary
// diagnostic endpoint, cross-checked against the caller's real public IP
// from two independent external services:
//   socketRemoteAddress: 100.64.0.3            (internal LB - private)
//   X-Forwarded-For:      "<real client>, <edge's public IP>"
//
// This is the second time this exact failure mode has bitten this setting.
// First: `trust proxy: 1`, assuming only one hop existed - it stripped only
// the LB and landed on the edge's IP. Second: a CIDR-based trust list
// (['loopback', '100.64.0.0/10']), assuming both hops sit in a private
// range - the edge's IP is public, so that config also only matched the LB
// and stopped one hop too early, landing on the edge's IP again, just
// reached a different way. Both were caught only by checking the resolved
// IP against production traffic, not by trusting a local simulation.
//
// `true` was tried in between: it trusts the whole X-Forwarded-For chain
// with no boundary, which is exactly what express-rate-limit's
// ERR_ERL_PERMISSIVE_TRUST_PROXY guards against (see
// node_modules/express-rate-limit/dist/index.cjs, validations.trustProxy):
// a client can prepend arbitrary fake hops and have the leftmost one -
// fully attacker-controlled - accepted as req.ip, letting them mint a "new"
// IP on every request and bypass IP-based rate limits.
//
// `2` is the verified-correct hop count: it walks past both real hops (the
// LB via the socket address, then the edge via the first X-Forwarded-For
// entry) and lands on the real client. It's still not spoofable - an
// attacker can only ever prepend fake entries *before* the two genuinely
// proxy-appended ones, never in their place, so however many fake entries
// they add, position 2 always resolves to their real IP (verified against
// the actual proxy-addr package with 1 and 3 prepended fake entries: both
// still resolved to the attacker's real IP, never their spoofed one). This
// does assume the app is only ever reached through Railway's two hops and
// never directly exposed to the internet, same as the codebase already
// assumed with `true` - if that ever changes, so does this number.
app.set('trust proxy', 2);

// Configure helmet with custom CSP for our forms
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      // The served pages (verify / reset-password) contain no scripts at
      // all, so inline script execution stays blocked (XSS defense-in-depth).
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"]
    }
  },
  // helmet's default is Referrer-Policy: no-referrer. For a plain HTML form
  // POST (navigation, not fetch/XHR), browsers derive the Origin header from
  // the page's referrer policy just like they do the Referer header: under
  // no-referrer, an unsafe-method request sends the literal string "null" as
  // Origin instead of the real page origin, which the CORS whitelist below
  // correctly - but unhelpfully - rejects even for the reset-password page's
  // own same-origin form. "same-origin" fixes that (full referrer/origin is
  // sent to same-origin destinations) while still sending nothing to actual
  // cross-origin destinations (e.g. the Google Fonts/cdnjs <link> tags below),
  // so no page URL or token ever leaks to a third party either way.
  referrerPolicy: { policy: "same-origin" }
}));

// Comma-separated list of allowed origins, configurable per-environment so new
// preview/staging deployments don't require a backend code change.
//
// BACKEND_URL is included because the email-verification and reset-password
// pages are server-rendered by this same app (src/utils/htmlTemplates.js) and
// the reset-password page submits a plain HTML form back to this origin.
// Browsers still attach an Origin header to that POST even though it's
// same-origin, so the cors() origin check below sees it like any other
// caller and rejects it unless the backend's own origin is whitelisted.
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://styliai-admin-dashboard-z8it.vercel.app",
  "https://styliai-admin-dashboard.vercel.app",
  process.env.BACKEND_URL,
].filter(Boolean);

const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;

app.use(cors({
  origin: function (origin, callback) {
    // السماح للطلبات بدون Origin (مثل Postman)
    if (!origin) return callback(null, true);

    // origin is intentionally matched only against the explicit whitelist -
    // the literal string "null" (sent by browsers on same-origin POSTs when
    // Referrer-Policy suppresses the referrer, see helmet() config above) is
    // NOT special-cased here, since a sandboxed iframe or file:// page can
    // trivially forge that same literal value.
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

// SEC-16.1: override morgan's built-in `url` token so credential-bearing query
// parameters are redacted before anything is written. Overriding the built-in
// rather than adding a `:safe-url` token to a hand-rolled format string means
// redaction is the default for *every* morgan format - so switching this
// logger to `combined` or a structured format later (SEC-16.4) cannot silently
// reintroduce the leak.
morgan.token("url", (req) => redactUrl(req.originalUrl || req.url));

app.use(morgan("dev"));
// SEC-0.2: keep the raw body alongside the parsed one. The Play Integrity
// request hash from SEC-0.1 is computed over the exact bytes the client sent,
// and JSON.stringify(req.body) would not reproduce its key order or spacing -
// so without this, every /api/ai/generate token would report a request
// mismatch. The buffer is the one express.json already allocated; this just
// keeps a reference instead of dropping it.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// SEC-15.1: admin-action accountability. Mounted once here rather than on each
// admin route so it cannot miss an endpoint - it self-gates on a verified
// `req.admin`, a mutating method and a 2xx response. Registered after
// express.json() because it records the parsed body as the intended
// after-state. See middleware/auditAdminAction.js for the fail-open rationale.
app.use(auditAdminAction);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/styles', styleRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/ai', stabilityRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/credit-packs', creditPackRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/creations', creationsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/feedback', generationFeedbackRoutes);

// Default endpoint
app.get('/', (req, res) => {
  res.json({ message: "StyliAI Auth Server is running 🚀" });
});

// Unhandled Route Handler (404)
app.use((req, res, next) => {
  res.status(404).json({ message: "Resource not found." });
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  if (err && err.isAppError) {
    return res.status(err.statusCode).json({ code: err.code, message: err.message });
  }

  console.error("Internal Server Error:", err);
  res.status(500).json({ code: "INTERNAL_ERROR", message: "An internal server error occurred." });
});

module.exports = app;