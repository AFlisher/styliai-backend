const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

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

const app = express();

// Railway puts the app behind two hops (a public edge, then an internal
// load balancer connecting over its own 100.64.0.0/10 CGNAT range) - without
// this, req.ip resolves to one of those internal addresses rather than the
// real client IP. `trust proxy: 1` was tried first but only strips one hop,
// so it resolved to Railway's own edge IP - confirmed via a temporary
// diagnostic endpoint, e.g. X-Forwarded-For: "<real client ip>, <railway edge ip>"
// with req.ip landing on the second (wrong) entry. Since the app is only
// ever reached through Railway's own network (never directly exposed),
// `true` (trust the whole forwarded chain) is safe and doesn't hardcode a
// hop count that could change as Railway's infra evolves.
app.set('trust proxy', true);

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

// Using the per-request delegate form (instead of a static options object)
// only so the TEMPORARY DEBUG LOGGING below can see the full request - the
// plain origin-function form the cors package normally takes only receives
// the Origin header value, not req.
app.use(cors(function (req, callback) {
  const origin = req.headers.origin;

  // TEMPORARY DEBUG LOGGING - remove after CORS issue is confirmed fixed
  console.log("typeof origin:", typeof origin);
  console.log("JSON.stringify(origin):", JSON.stringify(origin));
  console.log("req.headers.origin:", req.headers.origin);
  console.log("req.headers.referer:", req.headers.referer);
  console.log("req.headers.host:", req.headers.host);
  console.log("req.method:", req.method);
  console.log("req.path:", req.path);
  console.log("Allowed Origins:", allowedOrigins);

  let isAllowed;

  // السماح للطلبات بدون Origin (مثل Postman)
  if (!origin) {
    isAllowed = true;
  } else {
    // origin is intentionally matched only against the explicit whitelist -
    // the literal string "null" (sent by browsers on same-origin POSTs when
    // Referrer-Policy suppresses the referrer, see helmet() config above) is
    // NOT special-cased here, since a sandboxed iframe or file:// page can
    // trivially forge that same literal value.
    isAllowed = allowedOrigins.includes(origin);
  }

  if (!isAllowed) {
    return callback(new Error("Not allowed by CORS"));
  }

  callback(null, { origin: true, credentials: true });
}));

app.use(morgan("dev"));
app.use(express.json());

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