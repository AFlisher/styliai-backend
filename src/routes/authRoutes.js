const express = require('express');
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');
const {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  emailVerificationLimiter,
  statusPollLimiter,
  refreshLimiter,
  googleSignInLimiter,
  accountActionLimiter,
} = require('../middleware/rateLimiters');

const router = express.Router();

router.post('/register', registerLimiter, authController.register);
router.get('/verify', emailVerificationLimiter, authController.verifyEmail);
router.post('/login', loginLimiter, authController.login);
router.post('/refresh', refreshLimiter, authController.refreshToken);
router.post('/logout', accountActionLimiter, authMiddleware, authController.logout);
router.post('/google', googleSignInLimiter, authController.googleSignIn);
router.post('/change-password', accountActionLimiter, authMiddleware, authController.changePassword);
router.post('/forgot-password', forgotPasswordLimiter, authController.forgotPassword);
router.get('/status', statusPollLimiter, authController.checkVerificationStatus);
router.post('/resend-verification', emailVerificationLimiter, authController.resendVerification);

// Password reset routes (GET to display form, POST to submit new password) -
// share resetPasswordLimiter's budget, see rateLimiters.js for why.
router.get('/reset-password', resetPasswordLimiter, authController.renderResetPassword);
router.post('/reset-password', resetPasswordLimiter, express.urlencoded({ extended: true }), authController.postResetPassword);

module.exports = router;
