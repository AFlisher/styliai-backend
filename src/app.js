const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const categoryRoutes = require("./routes/categoryRoutes");
const styleRoutes = require("./routes/styleRoutes");
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

app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));app.use(morgan('dev'));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/styles", styleRoutes);

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
  console.error("Internal Server Error:", err);
  res.status(500).json({ message: "An internal server error occurred." });
});

module.exports = app;