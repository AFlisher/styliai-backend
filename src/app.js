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
const walletRoutes = require("./routes/walletRoutes");
const creditPackRoutes = require("./routes/creditPackRoutes");
const favoritesRoutes = require("./routes/favoritesRoutes");
const creationsRoutes = require("./routes/creationsRoutes");
const notificationRoutes = require("./routes/notificationRoutes");

const app = express();

// Configure helmet with custom CSP for our forms
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"]
    }
  }
}));

// Comma-separated list of allowed origins, configurable per-environment so new
// preview/staging deployments don't require a backend code change.
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://styliai-admin-dashboard-z8it.vercel.app",
  "https://styliai-admin-dashboard.vercel.app",
];

const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;

app.use(cors({
  origin: function (origin, callback) {
    // السماح للطلبات بدون Origin (مثل Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
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