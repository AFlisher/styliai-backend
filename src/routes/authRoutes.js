const express = require('express');
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController');

const router = express.Router();

// Rate limiting for auth routes to prevent brute-force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many authentication requests, please try again in 15 minutes." }
});

router.post('/register', authLimiter, authController.register);
router.get('/verify', authController.verifyEmail);
router.post('/login', authLimiter, authController.login);
router.post('/refresh', authController.refreshToken);
router.post('/forgot-password', authLimiter, authController.forgotPassword);
router.get('/status', authController.checkVerificationStatus);
router.post('/resend-verification', authLimiter, authController.resendVerification);

// Password reset routes (GET to display form, POST to submit new password)
router.get('/reset-password', authController.renderResetPassword);
router.post('/reset-password', authLimiter, express.urlencoded({ extended: true }), authController.postResetPassword);

module.exports = router;
